import sys
import json
import pandas as pd
import numpy as np
from pandas.api.types import is_datetime64_any_dtype

try:
    from services.ml_classifier import classify_with_ml
except Exception:
    try:
        from ml_classifier import classify_with_ml
    except Exception:
        classify_with_ml = None


def stride_sample(df, target_rows):
    """Downsample while preserving time order for very large datasets."""
    if len(df) <= target_rows:
        return df
    step = int(np.ceil(len(df) / target_rows))
    return df.iloc[::step].copy()

def safe_mean(series):
    return None if series.empty else float(series.mean())

def sigmoid_norm(x, midpoint, sensitivity=1.0):
    """Maps any value to a 0-1 scale using a logistic curve."""
    if x is None or np.isnan(x) or x <= 0: return 0.5
    return 1 / (1 + np.exp(-sensitivity * (np.log(x / midpoint))))

def clamp01(value):
    if value is None or pd.isna(value):
        return 0.0
    return max(0.0, min(1.0, float(value)))

def derive_bias_type_ratios(overtrading, loss_aversion, revenge_trading):
    avg_trades_per_hour = float(overtrading.get("avg_trades_per_hour") or 0.0)
    max_trades_in_one_hour = float(overtrading.get("max_trades_in_one_hour") or 0.0)
    disposition_ratio = float(loss_aversion.get("disposition_ratio") or 1.0)
    tilt_indicator_pct = float(revenge_trading.get("tilt_indicator_pct") or 0.0)
    martingale_stats = revenge_trading.get("martingale_stats") or {}

    baseline = float(martingale_stats.get(0) or martingale_stats.get("0") or 0.0)
    escalations = [
        float(value)
        for key, value in martingale_stats.items()
        if str(key) not in {"0", "0.0"} and pd.notna(value)
    ]
    max_escalation = max(escalations) if escalations else baseline
    martingale_ratio = (
        ((max_escalation - baseline) / baseline)
        if baseline and np.isfinite(baseline) and baseline > 0
        else 0.0
    )

    over_score = clamp01(max(avg_trades_per_hour / 3.0, max_trades_in_one_hour / 10.0))
    loss_score = clamp01((disposition_ratio - 1.0) / 1.5)
    revenge_score = clamp01(max(tilt_indicator_pct / 100.0, martingale_ratio))
    calm_score = clamp01(1.0 - max(over_score * 0.55, loss_score * 0.7, revenge_score * 0.8))

    raw = {
        "overtrader": 0.15 + over_score,
        "loss_aversion": 0.15 + loss_score,
        "revenge_trader": 0.15 + revenge_score,
        "calm_trader": 0.15 + calm_score,
    }
    total = sum(raw.values()) or 1.0

    ratios = {
        key: round((value / total) * 100, 2)
        for key, value in raw.items()
    }

    # Keep the output summing to ~100 after rounding.
    remainder = round(100.0 - sum(ratios.values()), 2)
    ratios["calm_trader"] = round(ratios["calm_trader"] + remainder, 2)
    return ratios

def compute_avg_holding_period_days(df):
    if df.empty: return 0.0
    holds = []
    lots_by_asset = {}
    ts_series = df["timestamp"]
    if not is_datetime64_any_dtype(ts_series):
        ts_series = pd.to_datetime(ts_series)
    if getattr(ts_series.dt, "tz", None) is not None:
        ts_series = ts_series.dt.tz_localize(None)
    ts_values = ts_series.dt.to_pydatetime()

    sides = df["side"].astype(str).str.upper().to_numpy()
    assets = df["asset"].to_numpy()
    qtys = pd.to_numeric(df["quantity"], errors="coerce").fillna(0).to_numpy()

    for side, asset, ts, qty in zip(sides, assets, ts_values, qtys):
        if pd.isna(asset) or pd.isna(ts) or qty <= 0:
            continue

        if side == "BUY":
            lots_by_asset.setdefault(asset, []).append({"ts": ts, "qty": float(qty)})
        elif side == "SELL":
            queue = lots_by_asset.get(asset, [])
            remaining = float(qty)
            while remaining > 0 and queue:
                lot = queue[0]
                used = min(remaining, lot["qty"])
                days = (ts - lot["ts"]).total_seconds() / 86400.0
                holds.append(days)
                lot["qty"] -= used
                remaining -= used
                if lot["qty"] <= 1e-9:
                    queue.pop(0)
    return float(np.mean(holds)) if holds else 0.0

def compute_user_portfolio_metrics(df):
    def clamp01(value):
        return round(max(0.0, min(1.0, float(value))) * 100, 2)

    # 1. TRADE FREQUENCY (Log-Normalized)
    days_in_data = (df["timestamp"].max() - df["timestamp"].min()).days or 1
    avg_trades_per_day = len(df) / days_in_data
    trade_frequency = clamp01(np.log10(avg_trades_per_day + 1) / 4.0)

    # 2. CONSISTENCY (CV logic)
    trades_by_day = df.groupby(df["timestamp"].dt.date).size()
    if len(trades_by_day) > 1:
        cv = trades_by_day.std() / (trades_by_day.mean() + 1e-9)
        consistency = clamp01(1.0 - (cv / 2.0)) 
    else:
        consistency = 100.0

    # 3. RISK REACTIVITY (Z-Score logic)
    df["trade_value"] = df["quantity"] * df["entry_price"]
    overall_mean = df["trade_value"].mean()
    overall_std = df["trade_value"].std()
    
    loss_mask = df["profit_loss"].shift(1) < 0
    trades_after_loss = df.loc[loss_mask, "trade_value"]
    
    if not trades_after_loss.empty and overall_std > 0:
        mean_after_loss = trades_after_loss.mean()
        z_score = (mean_after_loss - overall_mean) / overall_std
        risk_reactivity = clamp01(sigmoid_norm(np.exp(z_score), midpoint=1.0, sensitivity=1.0))
    else:
        risk_reactivity = 50.0

    # 4. HOLDING PATIENCE
    avg_hold = compute_avg_holding_period_days(df)
    holding_patience = clamp01(avg_hold / (avg_hold + 1.0))

    return {
        "consistency_score": consistency,
        "holding_patience_score": holding_patience,
        "risk_reactivity_score": risk_reactivity,
        "trade_frequency_score": trade_frequency,
    }

def main():
    if len(sys.argv) < 2: return
    args = [arg for arg in sys.argv[1:] if not arg.startswith("-")]
    use_ml = "--no-ml" not in sys.argv
    if not args:
        return
    df = pd.read_csv(args[0])
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    
    # --- Standard Stats ---
    hourly_idx = pd.date_range(start=df["timestamp"].min().floor("h"), end=df["timestamp"].max().ceil("h"), freq="h")
    trades_per_hour = df.groupby(df["timestamp"].dt.floor("h")).size().reindex(hourly_idx, fill_value=0)
    
    wins = df.loc[df["profit_loss"] > 0, "profit_loss"]
    losses = df.loc[df["profit_loss"] < 0, "profit_loss"].abs()
    avg_win, avg_loss = safe_mean(wins), safe_mean(losses)
    
    # --- Revenge / Martingale Tracking ---
    df['trade_value'] = df["quantity"] * df["entry_price"]
    overall_mean = df['trade_value'].mean()  # FIXED: Added this definition
    
    df['is_loss'] = df['profit_loss'] < 0
    df['streak_id'] = (df['is_loss'] != df['is_loss'].shift()).cumsum()
    df['streak_count'] = df.groupby('streak_id').cumcount() + 1
    df.loc[~df['is_loss'], 'streak_count'] = 0
    df['prev_loss_streak'] = df['streak_count'].shift(1).fillna(0)
    
    martingale_stats_raw = df.groupby('prev_loss_streak')['trade_value'].mean().to_dict()
    martingale_stats = {int(k): float(0 if pd.isna(v) or np.isinf(v) else v) for k, v in martingale_stats_raw.items()}

    # Avoid NaN/inf in tilt calculation (common when overall_mean is 0)
    baseline = overall_mean if overall_mean and np.isfinite(overall_mean) else None
    tilt_base = martingale_stats.get(6, baseline)
    tilt_indicator_pct = 0.0
    if tilt_base is not None and baseline and baseline != 0:
        ratio = tilt_base / baseline if baseline else 1.0
        if np.isfinite(ratio) and ratio > 0:
            tilt_indicator_pct = round(sigmoid_norm(ratio, 1.0, 5.0) * 100, 2)

    bias_type_ratios = None
    if use_ml and classify_with_ml is not None:
        cls_df = stride_sample(df, 120000)
        bias_type_ratios = classify_with_ml(cls_df)

    overtrading = {
        "avg_trades_per_hour": float(trades_per_hour.mean()),
        "max_trades_in_one_hour": int(trades_per_hour.max()),
    }
    loss_aversion = {
        "avg_abs_loss": avg_loss,
        "avg_win": avg_win,
        "disposition_ratio": (avg_loss / avg_win) if avg_win else 1.0,
    }
    revenge_trading = {
        "martingale_stats": martingale_stats,
        "tilt_indicator_pct": tilt_indicator_pct,
    }

    if not bias_type_ratios:
        bias_type_ratios = derive_bias_type_ratios(
            overtrading=overtrading,
            loss_aversion=loss_aversion,
            revenge_trading=revenge_trading,
        )

    # Final Output
    result = {
        "bias_type_ratios": bias_type_ratios,
        "behavioral": {
            "overtrading": overtrading,
            "loss_aversion": loss_aversion,
            "revenge_trading": revenge_trading,
        },
        "portfolio_metrics": compute_user_portfolio_metrics(df)
    }
    # Ensure JSON has no NaN/inf
    clean = json.loads(json.dumps(result, allow_nan=False))
    print(json.dumps(clean, indent=2))

if __name__ == "__main__":
    main()
