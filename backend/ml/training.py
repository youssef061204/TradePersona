"""Explicit, reproducible, single-holdout synthetic benchmark training."""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import scipy
import sklearn
from scipy.optimize import minimize_scalar
from sklearn.dummy import DummyClassifier
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from threadpoolctl import threadpool_limits

from .evaluation import bootstrap_f1, calibration_metrics, coverage_curve, metrics
from .features import (DEFINITIONS, FEATURE_NAMES, FEATURE_VERSION, extract_features,
                       feature_frame, validate_csv)
from .inference import (ARTIFACT_DIR, SCOPE, predict_history, probability, range_eligible,
                        sufficiency_reasons)
from .models import POLICY, legacy_probabilities, temperature_scale
from .simulator import CLASSES, SIMULATOR_VERSION, SPLIT_COUNTS, SPLIT_SEEDS, make_split


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def sha(value):
    return hashlib.sha256(value).hexdigest()


def git_commit():
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], stderr=subprocess.DEVNULL, text=True).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def source_hashes():
    return {p.name: sha(p.read_bytes()) for p in sorted(Path(__file__).parent.glob("*.py"))}


def candidates():
    for c in (0.1, 1.0):
        yield "Logistic regression", {"C": c}, make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(C=c, max_iter=2000, random_state=7101))
    for leaf in (3, 8):
        yield "Random Forest", {"min_samples_leaf": leaf, "n_estimators": 160}, make_pipeline(SimpleImputer(strategy="median"), RandomForestClassifier(n_estimators=160, min_samples_leaf=leaf, random_state=7101, n_jobs=1, class_weight="balanced"))
    for leaves in (7, 15):
        yield "Histogram gradient boosting", {"max_leaf_nodes": leaves, "max_iter": 120}, make_pipeline(SimpleImputer(strategy="median"), HistGradientBoostingClassifier(max_leaf_nodes=leaves, max_iter=120, learning_rate=0.08, early_stopping=False, random_state=7101))


def fit_bounds(X):
    q = X.quantile([0.005, 0.25, 0.75, 0.995])
    padding = np.maximum(1.5 * (q.loc[0.75] - q.loc[0.25]), np.maximum(abs(X.median()) * 0.1, 0.01))
    return dict(lower=(q.loc[0.005] - padding).tolist(), upper=(q.loc[0.995] + padding).tolist())


def eligible_histories(histories, X, bounds):
    return range_eligible(X, bounds) & np.asarray([not sufficiency_reasons(df, extract_features(df)) for df in histories])


def robustness(histories, bundle):
    # Fixed 80 trajectories, balanced by interleaved generation order.
    base = histories[:80]
    base_p = probability(bundle, feature_frame(base))
    output = []
    for name in ("Remove 10% of trades", "Jitter timestamps by 30 seconds", "2% position-size noise", "First half of history", "Duplicate 10% of trades", "Missing holding duration"):
        rng = np.random.default_rng(9101)
        agreements, changes, accepted = [], [], []
        for i, original in enumerate(base):
            df = original.copy()
            if name.startswith("Remove"):
                df = df.drop(rng.choice(df.index, max(1, len(df) // 10), replace=False))
            elif name.startswith("Jitter"):
                df["timestamp"] += pd.to_timedelta(rng.uniform(-30, 30, len(df)), unit="s")
            elif name.startswith("2%"):
                df["quantity"] *= rng.lognormal(0, 0.02, len(df))
            elif name.startswith("First"):
                df = df.iloc[:len(df) // 2]
            elif name.startswith("Duplicate"):
                df = pd.concat([df, df.iloc[:len(df) // 10]])
            else:
                df = df.drop(columns=["holding_minutes"])
            df, _ = validate_csv(df.to_csv(index=False))
            f = extract_features(df)
            pred = predict_history(df, bundle, f)
            accepted.append(pred["status"] == "classified")
            if pred["probabilities"]:
                p = np.array([pred["probabilities"][c] for c in CLASSES])
                agreements.append(bool(base_p[i].argmax() == p.argmax()))
                changes.append(float(np.abs(base_p[i] - p).mean()))
        output.append(dict(perturbation=name, histories=len(base), comparable_predictions=len(changes),
                           agreement=float(np.mean(agreements)) if agreements else None,
                           mean_probability_change=float(np.mean(changes)) if changes else None,
                           coverage=float(np.mean(accepted))))
    return output


def train(output, small=False):
    output = Path(output)
    if (output / "frozen_selection.json").exists() or (output / "evaluation.json").exists():
        raise ValueError("Experiment already exists. Use a NEW --output directory for reproduction; never overwrite a held-out result.")
    output.mkdir(parents=True, exist_ok=True)
    partitions, manifest, all_hashes = {}, {}, set()

    def partition(name):
        count = 32 if small else None
        histories, y, groups = make_split(name, count, seed_offset=100_000 if small else 0)
        # Include record-level inputs, not just transformed feature vectors.
        fingerprints = [sha(df.to_csv(index=False, float_format="%.12g").encode()) for df in histories]
        if len(set(fingerprints)) != len(fingerprints) or all_hashes.intersection(fingerprints):
            raise ValueError("Duplicate trajectory fingerprint across benchmark groups")
        all_hashes.update(fingerprints)
        manifest[name] = [dict(group=group, label=str(label), fingerprint=fp, rows=len(df))
                          for group, label, fp, df in zip(groups, y, fingerprints, histories)]
        partitions[name] = (histories, y, feature_frame(histories))
        print(f"Prepared {name}: {len(histories)} independent trajectories", flush=True)
        return partitions[name]

    _, train_y, train_X = partition("train")
    selection_h, selection_y, selection_X = partition("selection")
    _, cal_y, cal_X = partition("calibration")
    policy_h, policy_y, policy_X = partition("policy")
    dummy = DummyClassifier(strategy="most_frequent").fit(train_X, train_y)
    comparisons = [dict(name="Legacy deterministic heuristic", validation=metrics(selection_y, legacy_probabilities(selection_h))),
                   dict(name="Majority class", validation=metrics(selection_y, dummy.predict_proba(selection_X)))]
    winner, best_score, best_name, best_params = None, -1, None, None
    experiments, best_by_family = [], {}
    for name, params, model in candidates():
        model.fit(train_X, train_y)
        score = metrics(selection_y, model.predict_proba(selection_X))
        experiments.append(dict(name=name, hyperparameters=params, validation=score))
        if name not in best_by_family or score["macro_f1"] > best_by_family[name]["validation"]["macro_f1"]:
            best_by_family[name] = dict(name=name, hyperparameters=params, validation=score)
        if score["macro_f1"] > best_score:
            winner, best_score, best_name, best_params = model, score["macro_f1"], name, params
        print(f"Selection {name} {params}: macro F1 {score['macro_f1']:.3f}", flush=True)
    comparisons.extend(best_by_family.values())
    cal_raw = winner.predict_proba(cal_X)
    fit = minimize_scalar(lambda t: log_loss(cal_y, temperature_scale(cal_raw, t), labels=CLASSES), bounds=(0.25, 4), method="bounded", options={"xatol": 1e-8})
    fitted_temperature = float(fit.x)
    policy_raw = winner.predict_proba(policy_X)
    policy_scaled = temperature_scale(policy_raw, fitted_temperature)
    use_scaling = log_loss(policy_y, policy_scaled, labels=CLASSES) < log_loss(policy_y, policy_raw, labels=CLASSES)
    temperature = fitted_temperature if use_scaling else 1.0
    method = "Temperature scaling" if use_scaling else "Raw probabilities (temperature scaling did not improve policy-validation log loss)"
    bundle = dict(model=winner, model_version="synthetic-v1", feature_version=FEATURE_VERSION,
                  feature_names=FEATURE_NAMES, medians=train_X.median().tolist(), bounds=fit_bounds(train_X),
                  temperature=temperature, fitted_temperature=fitted_temperature, calibration_method=method,
                  policy=POLICY, scope=SCOPE)
    importance = permutation_importance(winner, selection_X, selection_y, scoring="f1_macro", n_repeats=5, random_state=10101, n_jobs=1)
    frozen = dict(timestamp=datetime.now(timezone.utc).isoformat(), git_commit=git_commit(), source_sha256=source_hashes(),
                  feature_version=FEATURE_VERSION, simulator_version=SIMULATOR_VERSION, seeds={k: v + (100_000 if small else 0) for k, v in SPLIT_SEEDS.items()}, smoke_test=small,
                  selected_model=best_name, hyperparameters=best_params, candidates=experiments,
                  calibration_method=method, temperature=temperature, fitted_temperature=fitted_temperature,
                  policy=POLICY, selection_rule="Maximum selection macro F1; first/simplest wins exact ties; no refit.",
                  versions=dict(python=platform.python_version(), numpy=np.__version__, pandas=pd.__version__, sklearn=sklearn.__version__, scipy=scipy.__version__),
                  policy_validation=dict(raw=calibration_metrics(policy_y, policy_raw), scaled=calibration_metrics(policy_y, policy_scaled)))
    write_json(output / "frozen_selection.json", frozen)
    joblib.dump(bundle, output / "model.joblib", compress=3)
    # Test and shift are first materialized ONLY after decisions and artifact are frozen.
    test_h, test_y, test_X = partition("test")
    shift_h, shift_y, shift_X = partition("shift")
    raw_p = winner.predict_proba(test_X)
    scaled_p = temperature_scale(raw_p, fitted_temperature)
    p = probability(bundle, test_X)
    test_scores = metrics(test_y, p)
    test_scores["macro_f1_ci95"] = bootstrap_f1(test_y, p, repeats=100 if small else 1000)
    eligible = eligible_histories(test_h, test_X, bundle["bounds"])
    shift_p = probability(bundle, shift_X)
    shift_scores = metrics(shift_y, shift_p)
    shift_scores["coverage"] = coverage_curve(shift_y, shift_p, eligible_histories(shift_h, shift_X, bundle["bounds"]))
    write_json(output / "split_manifest.json", manifest)
    fingerprint = sha(json.dumps(manifest, sort_keys=True).encode())
    feature_importance = sorted([dict(feature=name, importance=float(importance.importances_mean[i]), std=float(importance.importances_std[i])) for i, name in enumerate(FEATURE_NAMES)], key=lambda v: v["importance"], reverse=True)
    report = dict(schema_version="1.0", scope=SCOPE, selected_model=best_name, feature_version=FEATURE_VERSION,
                  dataset=dict(origin="Versioned independent synthetic trajectory simulator; legacy CSVs excluded.", unit="One independent simulated trader trajectory", split_counts={k: len(v) for k, v in manifest.items()}, classes=CLASSES, fingerprint=fingerprint,
                               total_trades=sum(v["rows"] for rows in manifest.values() for v in rows)),
                  methodology="Separate whole-trajectory train/selection/calibration/policy/test partitions. Models table uses selection validation. Selected model alone evaluated once on the final synthetic holdout. Stratified trajectory bootstrap, not trade resampling.",
                  models=comparisons, test=test_scores,
                  calibration=dict(method=method, temperature=temperature, fitted_temperature=fitted_temperature,
                                   raw=calibration_metrics(test_y, raw_p), calibrated=calibration_metrics(test_y, scaled_p),
                                   deployed=calibration_metrics(test_y, p)),
                  coverage=coverage_curve(test_y, p, eligible),
                  policy_validation_coverage=coverage_curve(policy_y, probability(bundle, policy_X), eligible_histories(policy_h, policy_X, bundle["bounds"])),
                  feature_importance=feature_importance, robustness=robustness(test_h, bundle), shift=shift_scores,
                  limitations=["Synthetic regime recovery is not real-world psychological or financial validity.",
                               "Same generator family underlies in-distribution training and test; latent regimes overlap but simplify people.",
                               "Balanced class priors are artificial. Uncertainty intervals condition on this simulator and class mixture.",
                               "Selection-set model comparisons are not independent final-test estimates.",
                               "Holding evidence and completion-time semantics are required; arbitrary broker executions are unsupported.",
                               "Range checks cannot detect all joint distribution shift; calibration need not transfer to real users.",
                               "Counterfactual and median-replacement sensitivities do not imply causal effects or better returns."],
                  experiment=dict(**{k: v for k, v in frozen.items() if k not in ("candidates", "policy_validation")}, artifact_sha256=sha((output / "model.joblib").read_bytes())))
    write_json(output / "evaluation.json", report)
    write_json(output / "test_predictions.json", dict(labels=test_y.tolist(), probabilities=p.tolist(), raw_probabilities=raw_p.tolist(), scaled_probabilities=scaled_p.tolist(), features=test_X.astype(object).where(pd.notna(test_X), None).to_dict(orient="records")))
    write_json(output / "feature_schema.json", dict(version=FEATURE_VERSION, features=[dict(name=k, label=v[0], unit=v[1], definition=v[2]) for k, v in DEFINITIONS.items()]))
    print(f"Final {best_name}: synthetic test macro F1 {test_scores['macro_f1']:.3f}; artifacts at {output}")
    return report


def evaluate(directory):
    """Recompute the published result from frozen predictions; no fitting/selection."""
    directory = Path(directory)
    report = json.loads((directory / "evaluation.json").read_text())
    predictions = json.loads((directory / "test_predictions.json").read_text())
    if sha((directory / "model.joblib").read_bytes()) != report["experiment"]["artifact_sha256"]:
        raise ValueError("Model artifact fingerprint mismatch")
    bundle = joblib.load(directory / "model.joblib")
    frame = pd.DataFrame(predictions["features"], columns=FEATURE_NAMES)
    actual = probability(bundle, frame)
    if not np.allclose(actual, predictions["probabilities"], atol=1e-12):
        raise ValueError("Frozen predictions no longer match model artifact")
    result = metrics(np.asarray(predictions["labels"]), actual)
    if not np.isclose(result["macro_f1"], report["test"]["macro_f1"]):
        raise ValueError("Reported macro F1 differs from saved predictions")
    print(json.dumps(dict(selected_model=report["selected_model"], scope=report["scope"], verified=True, **result), indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["train", "evaluate"])
    parser.add_argument("--output", default=str(ARTIFACT_DIR))
    parser.add_argument("--small", action="store_true", help="32 trajectories per partition for smoke checks, never headline reporting")
    args = parser.parse_args()
    with threadpool_limits(limits=1):
        if args.command == "train":
            train(args.output, args.small)
        else:
            evaluate(args.output)


if __name__ == "__main__":
    main()
