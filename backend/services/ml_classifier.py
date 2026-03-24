import os
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline

_MODEL = None
_LABELS = ["overtrader", "loss_aversion", "revenge_trader", "calm_trader"]


def _build_features(df):
    df = df.copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
    df = df.sort_values("timestamp")

    df["quantity"] = pd.to_numeric(df["quantity"], errors="coerce")
    df["entry_price"] = pd.to_numeric(df["entry_price"], errors="coerce")
    df["profit_loss"] = pd.to_numeric(df["profit_loss"], errors="coerce")

    df["trade_value"] = (df["quantity"] * df["entry_price"]).fillna(0.0)
    df["time_diff"] = df["timestamp"].diff().dt.total_seconds().fillna(60)
    df["prev_pl"] = df["profit_loss"].shift(1).fillna(0)
    df["size_change"] = (df["trade_value"] / df["trade_value"].shift(1)).replace([np.inf, -np.inf], np.nan).fillna(1)

    features = pd.DataFrame({
        "velocity": np.log1p(1 / df["time_diff"]),
        "revenge_signal": (df["prev_pl"] < 0).astype(int) * (1 / df["time_diff"]),
        "size_aggression": df["size_change"],
        "loss_magnitude": df["profit_loss"].clip(upper=0).abs(),
    })
    return features.replace([np.inf, -np.inf], np.nan).fillna(0.0)


def _load_training_data():
    base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "datasets"))
    sources = {
        "overtrader": "overtrader.csv",
        "loss_aversion": "loss_averse_trader.csv",
        "revenge_trader": "revenge_trader.csv",
        "calm_trader": "calm_trader.csv",
    }

    frames = []
    labels = []
    for label, filename in sources.items():
        path = os.path.join(base_dir, filename)
        if not os.path.exists(path):
            continue
        df = pd.read_csv(path)
        feats = _build_features(df)
        frames.append(feats)
        labels.extend([label] * len(feats))

    if not frames:
        return pd.DataFrame(), np.array([])

    return pd.concat(frames, ignore_index=True), np.array(labels)


def _get_model():
    global _MODEL
    if _MODEL is not None:
        return _MODEL

    X, y = _load_training_data()
    if X.empty or len(y) == 0:
        return None

    _MODEL = Pipeline([
        ("scaler", StandardScaler()),
        ("clf", RandomForestClassifier(
            n_estimators=200,
            random_state=42,
            class_weight="balanced",
        )),
    ])
    _MODEL.fit(X, y)
    return _MODEL


def classify_with_ml(df):
    model = _get_model()
    if model is None:
        return None

    features = _build_features(df)
    if features.empty:
        return None

    preds = model.predict(features)
    ratios = pd.Series(preds).value_counts(normalize=True) * 100

    return {
        "overtrader": round(float(ratios.get("overtrader", 0.0)), 2),
        "loss_aversion": round(float(ratios.get("loss_aversion", 0.0)), 2),
        "revenge_trader": round(float(ratios.get("revenge_trader", 0.0)), 2),
        "calm_trader": round(float(ratios.get("calm_trader", 0.0)), 2),
    }
