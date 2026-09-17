"""Reproducible synthetic training and frozen independent evaluation."""
from __future__ import annotations

import argparse, base64, hashlib, io, json, platform, subprocess
from datetime import datetime, timezone
from pathlib import Path

import joblib, numpy as np, pandas as pd, scipy, sklearn
from scipy.optimize import minimize_scalar
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from threadpoolctl import threadpool_limits

from .evaluation import bootstrap_f1, calibration_metrics, coverage_curve, metrics
from .external_benchmark import EXTERNAL_BENCHMARK_VERSION, make_external_ambiguous, make_external_pure
from .features import DEFINITIONS, FEATURE_NAMES, FEATURE_VERSION, MODEL_FEATURE_NAMES, extract_features, feature_frame
from .inference import ARTIFACT_DIR, SCOPE, mixed_signal_reasons, probability, range_eligible, sufficiency_reasons
from .models import POLICY, temperature_scale
from .simulator import CLASSES, SIMULATOR_VERSION, SPLIT_SEEDS, make_split


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def sha(value): return hashlib.sha256(value).hexdigest()

def git_commit():
    try: return subprocess.check_output(["git", "rev-parse", "HEAD"], stderr=subprocess.DEVNULL, text=True).strip()
    except (OSError, subprocess.CalledProcessError): return None


def candidates():
    for c in (0.1, 1.0):
        yield "Logistic regression", {"C": c}, make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(C=c, max_iter=2000, random_state=7101))
    for leaf in (3, 8):
        yield "Random Forest", {"min_samples_leaf": leaf, "n_estimators": 160}, make_pipeline(SimpleImputer(strategy="median"), RandomForestClassifier(n_estimators=160, min_samples_leaf=leaf, random_state=7101, n_jobs=1, class_weight="balanced"))
    for leaves in (7, 15):
        yield "Histogram gradient boosting", {"max_leaf_nodes": leaves, "max_iter": 120}, make_pipeline(SimpleImputer(strategy="median"), HistGradientBoostingClassifier(max_leaf_nodes=leaves, max_iter=120, learning_rate=0.08, early_stopping=False, random_state=7101))


def model_frame(frame): return frame.loc[:, MODEL_FEATURE_NAMES]


def fit_bounds(frame):
    q = frame.quantile([0.005, 0.25, 0.75, 0.995])
    pad = np.maximum(1.5 * (q.loc[0.75] - q.loc[0.25]), np.maximum(abs(frame.median()) * 0.1, 0.01))
    return {"lower": (q.loc[0.005] - pad).tolist(), "upper": (q.loc[0.995] + pad).tolist()}


def eligibility(histories, full_frame, bundle):
    in_range = range_eligible(model_frame(full_frame), bundle["bounds"])
    sufficient = np.asarray([not sufficiency_reasons(df, extract_features(df)) for df in histories])
    unmixed = np.asarray([not mixed_signal_reasons(row, bundle) for row in full_frame.to_dict(orient="records")])
    return in_range & sufficient & unmixed


def policy_mask(probabilities):
    ordered = np.sort(probabilities, axis=1)
    return (ordered[:, -1] >= POLICY["confidence_threshold"]) & ((ordered[:, -1] - ordered[:, -2]) >= POLICY["margin_threshold"])


def external_report(bundle, small=False):
    pure_h, pure_y, _ = make_external_pure(80 if small else 500)
    pure_x = feature_frame(pure_h); pure_p = probability(bundle, pure_x)
    pure = metrics(pure_y, pure_p); pure["calibration"] = calibration_metrics(pure_y, pure_p)
    accepted = eligibility(pure_h, pure_x, bundle) & policy_mask(pure_p)
    pred = np.asarray(CLASSES)[pure_p.argmax(axis=1)]
    pure.update(coverage=float(accepted.mean()), retained_accuracy=float((pred[accepted] == pure_y[accepted]).mean()) if accepted.any() else None, abstained=int((~accepted).sum()))

    mixed_h, descriptors, _ = make_external_ambiguous(40 if small else 250)
    mixed_x = feature_frame(mixed_h); mixed_p = probability(bundle, mixed_x)
    accepted_mixed = eligibility(mixed_h, mixed_x, bundle) & policy_mask(mixed_p)
    mixed_pred = np.asarray(CLASSES)[mixed_p.argmax(axis=1)]
    mixed = {
        "histories": len(mixed_h), "abstention_rate": float((~accepted_mixed).mean()),
        "classified": int(accepted_mixed.sum()), "mean_top_probability": float(mixed_p.max(axis=1).mean()),
        "class_counts": {c: int(np.sum(mixed_pred[accepted_mixed] == c)) for c in CLASSES},
        "mixtures": {name: int(np.sum(descriptors == name)) for name in sorted(set(descriptors))},
    }
    return {"version": EXTERNAL_BENCHMARK_VERSION, "methodology": "Separately implemented generator with different timing and size distributions. Never used for fitting, feature selection, calibration, thresholds or model selection.", "pure": pure, "mixed": mixed}


def robustness(histories, bundle):
    base = histories[:40]; baseline = probability(bundle, feature_frame(base)); output = []
    for name in ("Remove 10% of trades", "Jitter timestamps by 30 seconds", "2% position-size noise", "First half of history", "Missing holding duration"):
        rng = np.random.default_rng(9101); agreements, changes, coverage = [], [], []
        for i, original in enumerate(base):
            df = original.copy()
            if name.startswith("Remove"): df = df.drop(rng.choice(df.index, max(1, len(df)//10), replace=False))
            elif name.startswith("Jitter"): df["timestamp"] += pd.to_timedelta(rng.uniform(-30, 30, len(df)), unit="s")
            elif name.startswith("2%"): df["quantity"] *= rng.lognormal(0, 0.02, len(df))
            elif name.startswith("First"): df = df.iloc[:len(df)//2]
            else: df = df.drop(columns=["holding_minutes"])
            f = extract_features(df); reasons = sufficiency_reasons(df, f)
            if reasons: coverage.append(False); continue
            p = probability(bundle, pd.DataFrame([f], columns=FEATURE_NAMES))[0]
            coverage.append(bool(policy_mask(p[None, :])[0])); agreements.append(bool(baseline[i].argmax() == p.argmax())); changes.append(float(np.abs(baseline[i]-p).mean()))
        output.append({"perturbation": name, "histories": len(base), "comparable_predictions": len(changes), "agreement": float(np.mean(agreements)) if agreements else None, "mean_probability_change": float(np.mean(changes)) if changes else None, "coverage": float(np.mean(coverage))})
    return output


def train(output, small=False):
    output = Path(output)
    if (output / "evaluation.json").exists(): raise ValueError("Use a new --output directory; held-out results are immutable.")
    output.mkdir(parents=True, exist_ok=True)
    count = 32 if small else None
    partitions = {name: make_split(name, count, seed_offset=100_000 if small else 0) for name in ("train", "selection", "calibration", "policy")}
    frames = {name: feature_frame(partitions[name][0]) for name in partitions}
    train_y, selection_y = partitions["train"][1], partitions["selection"][1]
    train_x, selection_x = model_frame(frames["train"]), model_frame(frames["selection"])

    experiments=[]; winner=None; best=-1; selected_name=None; selected_params=None
    for name, params, model in candidates():
        model.fit(train_x, train_y); score = metrics(selection_y, model.predict_proba(selection_x)); experiments.append({"name":name,"hyperparameters":params,"validation":score})
        if score["macro_f1"] > best: winner, best, selected_name, selected_params = model, score["macro_f1"], name, params

    cal_y = partitions["calibration"][1]; cal_x = model_frame(frames["calibration"]); cal_raw = winner.predict_proba(cal_x)
    fit = minimize_scalar(lambda t: log_loss(cal_y, temperature_scale(cal_raw, t), labels=CLASSES), bounds=(0.25,4), method="bounded")
    fitted_temperature=float(fit.x)
    policy_y=partitions["policy"][1]; policy_x=model_frame(frames["policy"]); raw_policy=winner.predict_proba(policy_x); scaled_policy=temperature_scale(raw_policy,fitted_temperature)
    temperature=fitted_temperature if log_loss(policy_y,scaled_policy,labels=CLASSES) < log_loss(policy_y,raw_policy,labels=CLASSES) else 1.0
    method="Temperature scaling" if temperature != 1.0 else "Raw probabilities"
    labeled=frames["train"].assign(_label=train_y)
    thresholds={
        "activity_median_gap_max": float(labeled.loc[labeled._label=="overtrader","median_gap_minutes"].quantile(.50)),
        "loss_holding_ratio_min": float(labeled.loc[labeled._label=="loss_aversion","loss_win_holding_ratio"].quantile(.25)),
        "revenge_size_ratio_min": float(labeled.loc[labeled._label=="revenge_trader","post_loss_size_ratio"].quantile(.25)),
        "revenge_gap_ratio_max": float(labeled.loc[labeled._label=="revenge_trader","post_loss_gap_ratio"].quantile(.75)),
    }
    bundle={"model":winner,"model_version":"synthetic-v2","feature_version":FEATURE_VERSION,"feature_names":FEATURE_NAMES,"model_feature_names":MODEL_FEATURE_NAMES,"medians":train_x.median().tolist(),"bounds":fit_bounds(train_x),"temperature":temperature,"fitted_temperature":fitted_temperature,"calibration_method":method,"policy":POLICY,"scope":SCOPE,"signal_thresholds":thresholds}
    joblib.dump(bundle, output/"model.joblib", compress=3); model_bytes=(output/"model.joblib").read_bytes(); (output/"model.joblib.b64").write_text(base64.b64encode(model_bytes).decode("ascii")+"\n",encoding="ascii")

    test_h,test_y,_=make_split("test",count,seed_offset=100_000 if small else 0); shift_h,shift_y,_=make_split("shift",count,seed_offset=100_000 if small else 0)
    test_x=feature_frame(test_h); shift_x=feature_frame(shift_h); test_p=probability(bundle,test_x); shift_p=probability(bundle,shift_x)
    test=metrics(test_y,test_p); test["macro_f1_ci95"]=bootstrap_f1(test_y,test_p,repeats=100 if small else 1000); test["coverage"]=coverage_curve(test_y,test_p,eligibility(test_h,test_x,bundle))
    shift=metrics(shift_y,shift_p); shift["coverage"]=coverage_curve(shift_y,shift_p,eligibility(shift_h,shift_x,bundle))
    external=external_report(bundle,small); importance=permutation_importance(winner,selection_x,selection_y,scoring="f1_macro",n_repeats=5,random_state=10101,n_jobs=1)
    frozen={"timestamp":datetime.now(timezone.utc).isoformat(),"git_commit":git_commit(),"feature_version":FEATURE_VERSION,"model_feature_names":MODEL_FEATURE_NAMES,"simulator_version":SIMULATOR_VERSION,"external_benchmark_version":EXTERNAL_BENCHMARK_VERSION,"seeds":{k:v+(100_000 if small else 0) for k,v in SPLIT_SEEDS.items()},"smoke_test":small,"selected_model":selected_name,"hyperparameters":selected_params,"candidates":experiments,"calibration_method":method,"temperature":temperature,"fitted_temperature":fitted_temperature,"policy":POLICY,"signal_thresholds":thresholds,"versions":{"python":platform.python_version(),"numpy":np.__version__,"pandas":pd.__version__,"sklearn":sklearn.__version__,"scipy":scipy.__version__}}
    write_json(output/"frozen_selection.json",frozen)
    report={"schema_version":"2.0","scope":SCOPE,"selected_model":selected_name,"feature_version":FEATURE_VERSION,"classification_features":MODEL_FEATURE_NAMES,"dataset":{"origin":"Versioned synthetic trajectory simulator with class-independent nuisance distributions; legacy CSVs excluded.","unit":"One independent simulated trader trajectory","split_counts":{"train":len(partitions['train'][0]),"selection":len(partitions['selection'][0]),"calibration":len(partitions['calibration'][0]),"policy":len(partitions['policy'][0]),"test":len(test_h),"shift":len(shift_h)},"classes":CLASSES,"fingerprint":sha(json.dumps({k:SPLIT_SEEDS[k] for k in SPLIT_SEEDS},sort_keys=True).encode()),"total_trades":sum(len(x) for h,_,_ in list(partitions.values())+[(test_h,test_y,None),(shift_h,shift_y,None)] for x in h)},"methodology":"Whole-trajectory train/selection/calibration/policy/test partitions. Descriptive nuisance features remain visible but do not drive classification. External evaluation uses a separately implemented generator never used for fitting, selection, calibration, or thresholds.","models":experiments,"test":test,"calibration":{"method":method,"temperature":temperature,"fitted_temperature":fitted_temperature,"deployed":calibration_metrics(test_y,test_p)},"coverage":test["coverage"],"feature_importance":sorted([{"feature":n,"importance":float(importance.importances_mean[i])} for i,n in enumerate(MODEL_FEATURE_NAMES)],key=lambda x:x["importance"],reverse=True),"robustness":robustness(test_h,bundle),"shift":shift,"external":external,"limitations":["Synthetic regime recovery is not real-world psychological or financial validity.","The external benchmark is independently implemented but remains synthetic.","Mixed synthetic histories are not fully rejected; their abstention rate is reported explicitly.","Calibration need not transfer to real users."],"experiment":{**{k:v for k,v in frozen.items() if k!="candidates"},"artifact_sha256":sha(model_bytes)}}
    write_json(output/"evaluation.json",report); write_json(output/"external_evaluation.json",external); write_json(output/"feature_schema.json",{"version":FEATURE_VERSION,"classification_features":MODEL_FEATURE_NAMES,"features":[{"name":k,"label":v[0],"unit":v[1],"definition":v[2]} for k,v in DEFINITIONS.items()]})
    print(f"Final {selected_name}: internal macro F1 {test['macro_f1']:.3f}; external macro F1 {external['pure']['macro_f1']:.3f}")


def _load_model(directory):
    directory=Path(directory); raw=base64.b64decode((directory/"model.joblib.b64").read_text()) if (directory/"model.joblib.b64").exists() else (directory/"model.joblib").read_bytes(); return raw,joblib.load(io.BytesIO(raw))


def evaluate(directory):
    directory=Path(directory); report=json.loads((directory/"evaluation.json").read_text()); raw,bundle=_load_model(directory)
    if sha(raw)!=report["experiment"]["artifact_sha256"]: raise ValueError("Model artifact fingerprint mismatch")
    h,y,_=make_split("test"); result=metrics(y,probability(bundle,feature_frame(h)))
    if not np.isclose(result["macro_f1"],report["test"]["macro_f1"]): raise ValueError("Reported macro F1 differs from regenerated holdout")
    print(json.dumps({"selected_model":report["selected_model"],"scope":report["scope"],"verified":True,**result},indent=2))


def external_evaluate(directory):
    _,bundle=_load_model(directory); print(json.dumps(external_report(bundle),indent=2))


def main():
    p=argparse.ArgumentParser(); p.add_argument("command",choices=["train","evaluate","external-evaluate"]); p.add_argument("--output",default=str(ARTIFACT_DIR)); p.add_argument("--small",action="store_true"); a=p.parse_args()
    with threadpool_limits(limits=1):
        if a.command=="train": train(a.output,a.small)
        elif a.command=="external-evaluate": external_evaluate(a.output)
        else: evaluate(a.output)

if __name__=="__main__": main()
