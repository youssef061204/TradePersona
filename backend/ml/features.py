"""One feature implementation shared by training, serving and perturbation tests."""
from __future__ import annotations

import csv
import io
import re

import numpy as np
import pandas as pd

FEATURE_VERSION = "1.0.0"
MAX_ROWS = 500_000
MAX_BYTES = 50 * 1024 * 1024
REQUIRED = ("timestamp", "quantity", "entry_price", "profit_loss")
# name: (human label, unit, definition)
DEFINITIONS = {
    "trades_per_day": ("Trading activity", "trades/day", "Count / max(elapsed UTC days, 1)."),
    "max_trades_hour": ("Busiest clock hour", "trades", "Maximum count in a UTC clock-hour bin."),
    "median_gap_minutes": ("Median completion interval", "minutes", "Median elapsed minutes between successive completed trades."),
    "gap_cv": ("Interval variability", "ratio", "Population SD / mean of completion intervals."),
    "burst_fraction": ("Rapid completions", "fraction", "Fraction of successive completion intervals <= 5 minutes."),
    "daily_count_cv": ("Daily activity variability", "ratio", "Population SD / mean of daily counts including zero-count calendar days."),
    "size_cv": ("Position size variability", "ratio", "Population SD / mean of quantity * entry price; no account-equity risk claim."),
    "max_size_to_median": ("Largest relative position", "ratio", "Maximum notional divided by median notional."),
    "post_loss_size_ratio": ("Size after losses", "ratio", "Median next/prior notional ratio over transitions following a loss."),
    "post_win_size_ratio": ("Size after wins", "ratio", "Median next/prior notional ratio over transitions following a win."),
    "post_loss_increase_fraction": ("Size increases after loss", "fraction", "Fraction of loss-following transitions with next notional > prior notional."),
    "post_loss_gap_ratio": ("Completion pace after losses", "ratio", "Median loss-following completion interval / overall median interval."),
    "post_win_gap_ratio": ("Completion pace after wins", "ratio", "Median win-following completion interval / overall median interval."),
    "streak_size_ratio": ("Size after consecutive losses", "ratio", "Median next/prior notional ratio following at least two consecutive losses."),
    "win_fraction": ("Winning trades", "fraction", "Fraction of realized outcomes > 0; zero outcomes are neither wins nor losses."),
    "loss_win_magnitude_ratio": ("Mean loss / mean win", "ratio", "Mean absolute realized loss divided by mean realized win; not a disposition measure."),
    "max_loss_streak_fraction": ("Longest loss sequence", "fraction", "Maximum consecutive losses divided by total trades."),
    "median_holding_minutes": ("Median holding duration", "minutes", "Median explicitly supplied completed-position holding duration."),
    "holding_cv": ("Holding variability", "ratio", "Population SD / mean of explicitly supplied holding duration."),
    "loss_win_holding_ratio": ("Loser / winner holding time", "ratio", "Median loss holding duration / median win holding duration; descriptive proxy only."),
}
FEATURE_NAMES = list(DEFINITIONS)


class ValidationError(ValueError):
    def __init__(self, message, quality=None):
        super().__init__(message)
        self.quality = quality


def validate_csv(text: str):
    """Strict syntax; reject invalid rows instead of silently changing trajectories."""
    quality = dict(total_rows=0, usable_rows=0, malformed_rows=0, duplicate_rows=0,
                   missing_fields=[], warnings=[], date_range={"start": None, "end": None})
    if not isinstance(text, str) or not text.strip():
        raise ValidationError("Upload a nonempty CSV.", quality)
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise ValidationError("CSV exceeds the 50 MiB limit.", quality)
    try:
        rows = list(csv.reader(io.StringIO(text.lstrip("\ufeff")), strict=True))
    except csv.Error as exc:
        raise ValidationError("Malformed CSV quoting.", quality) from exc
    if len(rows) < 2:
        raise ValidationError("CSV needs a header and at least one trade.", quality)
    header = [h.strip().lower() for h in rows[0]]
    if len(set(header)) != len(header):
        raise ValidationError("CSV contains duplicate column names.", quality)
    body = [r for r in rows[1:] if r]
    quality["total_rows"] = len(body)
    if len(body) > MAX_ROWS:
        raise ValidationError("CSV exceeds 500,000 rows.", quality)
    quality["missing_fields"] = [k for k in REQUIRED if k not in header]
    if quality["missing_fields"]:
        raise ValidationError("Missing required columns: " + ", ".join(quality["missing_fields"]), quality)
    bad_width = sum(len(r) != len(header) for r in body)
    if bad_width:
        quality["malformed_rows"] = bad_width
        raise ValidationError("Every row must have the same number of columns as the header.", quality)
    df = pd.DataFrame(body, columns=header)
    if df.empty:
        raise ValidationError("No trades found.", quality)
    for key in ("trader_id", "account_id", "currency"):
        if key in df and df[key].str.strip().nunique() > 1:
            raise ValidationError(f"Use one {key} per upload; aggregation would mix incompatible histories.", quality)
    # Only ISO dates are accepted: ambiguity such as 02/03/2025 is not guessed.
    iso = df.timestamp.str.match(r"^\d{4}-\d{2}-\d{2}(?:[T ].*)?$")
    naive = df.timestamp.str.match(r"^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$")
    df["timestamp"] = pd.to_datetime(df.timestamp.where(iso), format="mixed", utc=True, errors="coerce")
    bad = df.timestamp.isna()
    for key in REQUIRED[1:]:
        df[key] = pd.to_numeric(df[key], errors="coerce")
        bad |= ~np.isfinite(df[key])
    bad |= (df.quantity <= 0) | (df.entry_price <= 0)
    bad |= ~np.isfinite(df.quantity * df.entry_price)
    if "holding_minutes" in df:
        supplied = df.holding_minutes.str.strip().ne("")
        df["holding_minutes"] = pd.to_numeric(df.holding_minutes, errors="coerce")
        bad |= supplied & (~np.isfinite(df.holding_minutes) | (df.holding_minutes < 0))
    else:
        df["holding_minutes"] = np.nan
        quality["missing_fields"].append("holding_minutes (optional for metrics; required for classification)")
    quality["malformed_rows"] = int(bad.sum())
    quality["usable_rows"] = int((~bad).sum())
    if bad.any():
        raise ValidationError("Invalid timestamp, nonfinite number, or nonpositive quantity/price. Fix malformed rows and retry.", quality)
    if naive.any():
        quality["warnings"].append("Timestamps without timezone were interpreted as UTC.")
    # Identical behavioral records may be duplicates even when an arbitrary row ID differs.
    identity = list(REQUIRED) + [k for k in ("asset", "side", "holding_minutes") if k in df]
    dup = df.duplicated(subset=identity)
    quality["duplicate_rows"] = int(dup.sum())
    df = df.loc[~dup].sort_values("timestamp", kind="stable").reset_index(drop=True)
    if quality["duplicate_rows"]:
        quality["warnings"].append("Exact repeated trade records removed; verify simultaneous identical trades are not distinct fills.")
    if df.timestamp.duplicated().any():
        quality["warnings"].append("Simultaneous completions have ambiguous sequence order; classification will abstain.")
    if (df.timestamp.max() - df.timestamp.min()).days > 3660:
        raise ValidationError("History spans more than ten years; upload a shorter review period.", quality)
    quality["usable_rows"] = len(df)
    quality["date_range"] = dict(start=df.timestamp.min().isoformat(), end=df.timestamp.max().isoformat())
    return df, quality


def ratio(a, b):
    return float(a / b) if np.isfinite(a) and np.isfinite(b) and b > 0 else np.nan


def cv(values):
    v = np.asarray(values, dtype=float)
    return ratio(np.std(v), np.mean(v)) if len(v) else np.nan


def median(values):
    v = np.asarray(values, dtype=float)
    v = v[np.isfinite(v)]
    return float(np.median(v)) if len(v) else np.nan


def extract_features(df: pd.DataFrame) -> dict[str, float]:
    df = df.sort_values("timestamp", kind="stable")
    n = len(df)
    if n == 0:
        raise ValidationError("No usable trades.")
    size = (df.quantity * df.entry_price).to_numpy(float)
    pl = df.profit_loss.to_numpy(float)
    gap = df.timestamp.diff().dt.total_seconds().to_numpy()[1:] / 60
    size_change = size[1:] / size[:-1]
    after_loss, after_win = pl[:-1] < 0, pl[:-1] > 0
    streak = []
    run = 0
    for p in pl:
        run = run + 1 if p < 0 else 0
        streak.append(run)
    daily = df.set_index("timestamp").resample("D").size().to_numpy()
    hold = df.get("holding_minutes", pd.Series(np.nan, index=df.index)).to_numpy(float)
    # Partial holdings are not silently treated as representative of a whole history.
    complete_holds = np.isfinite(hold).all()
    features = {
        "trades_per_day": n / max((df.timestamp.max() - df.timestamp.min()).total_seconds() / 86400, 1),
        "max_trades_hour": float(df.groupby(df.timestamp.dt.floor("h")).size().max()),
        "median_gap_minutes": median(gap), "gap_cv": cv(gap),
        "burst_fraction": float(np.mean(gap <= 5)) if len(gap) else np.nan,
        "daily_count_cv": cv(daily), "size_cv": cv(size),
        "max_size_to_median": ratio(size.max(), median(size)),
        "post_loss_size_ratio": median(size_change[after_loss]),
        "post_win_size_ratio": median(size_change[after_win]),
        "post_loss_increase_fraction": float(np.mean(size_change[after_loss] > 1)) if after_loss.any() else np.nan,
        "post_loss_gap_ratio": ratio(median(gap[after_loss]), median(gap)),
        "post_win_gap_ratio": ratio(median(gap[after_win]), median(gap)),
        "streak_size_ratio": median(size_change[np.asarray(streak[:-1]) >= 2]),
        "win_fraction": float(np.mean(pl > 0)),
        "loss_win_magnitude_ratio": ratio(np.mean(-pl[pl < 0]) if (pl < 0).any() else np.nan,
                                         np.mean(pl[pl > 0]) if (pl > 0).any() else np.nan),
        "max_loss_streak_fraction": max(streak) / n,
        "median_holding_minutes": median(hold) if complete_holds else np.nan,
        "holding_cv": cv(hold) if complete_holds else np.nan,
        "loss_win_holding_ratio": ratio(median(hold[pl < 0]), median(hold[pl > 0])) if complete_holds else np.nan,
    }
    return {name: float(features[name]) for name in FEATURE_NAMES}


def feature_frame(histories):
    return pd.DataFrame([extract_features(df) for df in histories], columns=FEATURE_NAMES)


def json_features(features):
    return {k: float(v) if np.isfinite(v) else None for k, v in features.items()}
