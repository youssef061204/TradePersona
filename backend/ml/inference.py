"""Artifact-only inference. Never fits a model in the request path."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
import base64
import io

import joblib
import numpy as np
import pandas as pd

from .features import (DEFINITIONS, FEATURE_NAMES, FEATURE_VERSION, MODEL_FEATURE_NAMES,
                       extract_features, json_features, validate_csv)
from .models import POLICY, temperature_scale
from .simulator import CLASSES

ARTIFACT_DIR = Path(__file__).parent / "artifacts" / "v1"
SCOPE = "Synthetic benchmark only; classification has not been validated on real traders."


@lru_cache(maxsize=2)
def load_artifact(directory=str(ARTIFACT_DIR)):
    # Only trusted, locally deployed artifacts; never deserialize uploaded model files.
    directory = Path(directory)
    encoded = directory / "model.joblib.b64"
    if encoded.exists():
        bundle = joblib.load(io.BytesIO(base64.b64decode(encoded.read_text(encoding="ascii"))))
    else:
        bundle = joblib.load(directory / "model.joblib")
    if bundle["feature_version"] != FEATURE_VERSION or bundle["feature_names"] != FEATURE_NAMES:
        raise ValueError("Model artifact feature schema mismatch")
    if bundle.get("model_feature_names", MODEL_FEATURE_NAMES) != MODEL_FEATURE_NAMES:
        raise ValueError("Model artifact classification feature schema mismatch")
    if list(bundle["model"].classes_) != CLASSES:
        raise ValueError("Model artifact class order mismatch")
    return bundle


def _model_frame(bundle, frame):
    if list(frame.columns) != FEATURE_NAMES:
        raise ValueError("Inference feature order differs from artifact schema")
    names = bundle.get("model_feature_names", FEATURE_NAMES)
    return frame.loc[:, names]


def probability(bundle, frame):
    model_frame = _model_frame(bundle, frame)
    raw = bundle["model"].predict_proba(model_frame)
    return temperature_scale(raw, bundle["temperature"])


def range_eligible(frame, bounds):
    lower, upper = np.asarray(bounds["lower"]), np.asarray(bounds["upper"])
    values = frame.to_numpy(float)
    return np.isfinite(values).all(axis=1) & ((values >= lower) & (values <= upper)).all(axis=1)


def sufficiency_reasons(df, features):
    reasons = []
    if len(df) < POLICY["min_trades"]:
        reasons.append("At least 30 completed trades are needed.")
    if int((df.profit_loss < 0).sum()) < POLICY["min_losses"] or int((df.profit_loss > 0).sum()) < POLICY["min_wins"]:
        reasons.append("At least five realized wins and five realized losses are needed.")
    if df.timestamp.duplicated().any():
        reasons.append("Simultaneous completions make post-loss sequence order ambiguous.")
    if "holding_minutes" in df and df.holding_minutes.notna().all():
        gaps = df.timestamp.diff().dt.total_seconds().iloc[1:] / 60
        if (df.holding_minutes.iloc[1:].to_numpy() > gaps.to_numpy() + 1e-6).any():
            reasons.append("Overlapping positions are unsupported: a prior outcome may not have been known at the next entry.")
    if any(not np.isfinite(v) for v in features.values()):
        reasons.append("Required behavioral evidence is unavailable; provide complete holding durations and enough outcome transitions.")
    return reasons


def mixed_signal_reasons(features, bundle):
    """Detect strong evidence for more than one mutually exclusive pure regime.

    Thresholds are learned from the training partition and frozen in the artifact.
    This is an abstention guard only; it never creates or changes probabilities.
    """
    thresholds = bundle.get("signal_thresholds")
    if not thresholds:
        return []
    active = []
    if features["median_gap_minutes"] <= thresholds["activity_median_gap_max"]:
        active.append("high activity")
    if features["loss_win_holding_ratio"] >= thresholds["loss_holding_ratio_min"]:
        active.append("longer loss holding")
    if (features["post_loss_size_ratio"] >= thresholds["revenge_size_ratio_min"] and
            features["post_loss_gap_ratio"] <= thresholds["revenge_gap_ratio_max"]):
        active.append("post-loss escalation")
    if len(active) >= 2:
        return ["Multiple strong synthetic behavior signals are present (" + ", ".join(active) + "); a pure-class label is withheld."]
    return []


def predict_history(df, bundle, features=None):
    features = features if features is not None else extract_features(df)
    reasons = sufficiency_reasons(df, features)
    result = dict(status="abstained", label=None, probabilities={}, confidence=None, margin=None,
                  reasons=reasons, model_version=bundle["model_version"], calibration=bundle["calibration_method"])
    if reasons:
        return result
    frame = pd.DataFrame([features], columns=FEATURE_NAMES)
    p = probability(bundle, frame)[0]
    ordered = np.sort(p)
    result.update(probabilities=dict(zip(CLASSES, map(float, p))), confidence=float(ordered[-1]),
                  margin=float(ordered[-1] - ordered[-2]))
    if not range_eligible(_model_frame(bundle, frame), bundle["bounds"])[0]:
        reasons.append("Behavioral features fall outside the supported synthetic training ranges.")
    reasons.extend(mixed_signal_reasons(features, bundle))
    if ordered[-1] < POLICY["confidence_threshold"]:
        reasons.append("The strongest model probability is below the 55% threshold.")
    if ordered[-1] - ordered[-2] < POLICY["margin_threshold"]:
        reasons.append("The two leading patterns are less than 10 percentage points apart.")
    if not reasons:
        result.update(status="classified", label=CLASSES[int(p.argmax())])
    return result


def explain(features, bundle, label):
    frame = pd.DataFrame([features], columns=FEATURE_NAMES)
    idx = CLASSES.index(label)
    original = probability(bundle, frame)[0, idx]
    names = bundle.get("model_feature_names", FEATURE_NAMES)
    probes = pd.concat([frame] * len(names), ignore_index=True)
    medians = bundle["medians"]
    for i, name in enumerate(names):
        probes.loc[i, name] = medians[i]
    changed = probability(bundle, probes)[:, idx]
    values = [dict(feature=name, value=float(features[name]), reference=float(medians[i]),
                   probability_delta=float(original - changed[i])) for i, name in enumerate(names)]
    return sorted(values, key=lambda v: abs(v["probability_delta"]), reverse=True)[:6]


def counterfactuals(df, bundle, label):
    original = extract_features(df)
    idx = CLASSES.index(label)
    original_p = float(probability(bundle, pd.DataFrame([original], columns=FEATURE_NAMES))[0, idx])
    scenarios = []
    after_loss = df.profit_loss.shift(1).lt(0)
    size = df.quantity * df.entry_price
    reference = float(size[~after_loss].median())
    reduced = df.copy()
    scale = np.minimum(1, reference / size.loc[after_loss])
    reduced.loc[after_loss, "quantity"] *= scale
    reduced.loc[after_loss, "profit_loss"] *= scale
    scenarios.append(("Keep post-loss size near baseline", "Cap post-loss notionals at the median of other positions, holding simulated percentage returns fixed.", reduced))
    if df.holding_minutes.notna().all() and (df.profit_loss > 0).any():
        shorter = df.copy()
        loss = shorter.profit_loss < 0
        shorter.loc[loss, "holding_minutes"] = np.minimum(shorter.loc[loss, "holding_minutes"], df.loc[df.profit_loss > 0, "holding_minutes"].median())
        scenarios.append(("Shorten losing-position holding", "Cap loss holding duration at the winner median while holding recorded outcomes and completion times fixed.", shorter))
    output = []
    for title, description, modified in scenarios:
        features = extract_features(modified)
        frame = pd.DataFrame([features], columns=FEATURE_NAMES)
        changed = [name for name in FEATURE_NAMES if not np.isclose(original[name], features[name], equal_nan=True)]
        if changed and range_eligible(_model_frame(bundle, frame), bundle["bounds"])[0]:
            output.append(dict(title=title, description=description + " Hypothetical model sensitivity, not a causal or financial forecast.",
                               original_probability=original_p, counterfactual_probability=float(probability(bundle, frame)[0, idx]),
                               label=label, changed_features=changed))
    return output


def analyze_csv(text, directory=str(ARTIFACT_DIR)):
    df, quality = validate_csv(text)
    features = extract_features(df)
    try:
        bundle = load_artifact(directory)
    except FileNotFoundError:
        bundle = None
    if bundle:
        prediction = predict_history(df, bundle, features)
    else:
        prediction = dict(status="unavailable", label=None, probabilities={}, confidence=None, margin=None,
                          reasons=["No trained artifact is installed. Run the explicit training command."],
                          model_version="unavailable", calibration="unavailable")
    classified = prediction["status"] == "classified"
    evidence = [dict(feature=name, label=DEFINITIONS[name][0], value=json_features(features)[name], unit=DEFINITIONS[name][1])
                for name in ("trades_per_day", "post_loss_size_ratio", "post_loss_increase_fraction",
                             "post_loss_gap_ratio", "loss_win_holding_ratio", "size_cv")]
    trends = []
    if bundle and (df.timestamp.max() - df.timestamp.min()).days >= 14:
        # Nonoverlapping weekly summaries avoid presenting overlapping windows as independent evidence.
        window = ((df.timestamp - df.timestamp.min()).dt.total_seconds() // (7 * 86400)).astype(int)
        for _, group in list(df.groupby(window))[-12:]:
            if len(group) >= POLICY["min_trades"]:
                f = extract_features(group)
                trends.append(dict(start=group.timestamp.min().isoformat(), end=group.timestamp.max().isoformat(),
                                   trades=len(group), features=json_features(f), prediction=predict_history(group, bundle, f)))
    actions = [
        f"Your history averaged {features['trades_per_day']:.2f} completed trades per day. Compare that pace with the trading frequency you intended before each session.",
        f"Your median next/prior position-size ratio after losses was {features['post_loss_size_ratio']:.2f}×. Review whether those size changes were planned before the preceding outcome was known.",
        f"Your loss/win holding-duration ratio was {features['loss_win_holding_ratio']:.2f}×. Compare the written exit criteria used for losing and winning positions.",
        f"Your post-loss completion-interval ratio was {features['post_loss_gap_ratio']:.2f}× relative to your overall pace. Check whether faster or slower re-entry after losses was intentional.",
        "Review a consistent period of completed trades and record the reason, planned size, and exit rule before comparing patterns.",
    ]
    summary = ("The experimental model found a supported simulated pattern. Use the measured evidence to guide a trading-journal review."
               if classified else "Insufficient evidence for a confident behavioral classification. The available measurements can still support a journal review.")
    return dict(schema_version="1.0", scope=SCOPE, quality=quality, features=json_features(features),
                prediction=prediction, evidence=evidence,
                explanations=explain(features, bundle, prediction["label"]) if classified else [],
                explanation_method="One-feature replacement by training median: actual probability sensitivity, not additive attribution or a causal explanation. Correlated-feature probes may be unrealistic.",
                counterfactuals=counterfactuals(df, bundle, prediction["label"]) if classified else [], trends=trends,
                coaching=dict(source="deterministic", summary=summary, actions=actions),
                alignment=dict(source="Manually chosen illustrative reference; no famous-investor or psychological inference.",
                               dimensions=[dict(dimension="Post-loss size ratio", value=json_features(features)["post_loss_size_ratio"], target=1),
                                           dict(dimension="Loser/winner holding ratio", value=json_features(features)["loss_win_holding_ratio"], target=1)],
                               disclaimer="Reference values illustrate equal sizing and holding durations. They are not empirically optimal targets or financial advice."))
