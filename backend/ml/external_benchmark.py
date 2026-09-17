"""Independent synthetic benchmark used only after model decisions are frozen.

This module intentionally does not import or call simulator.py. It uses different
sampling distributions and construction choices to detect generator-specific
shortcut learning. It must never be used for fitting, feature selection,
calibration, threshold selection or model selection.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

EXTERNAL_BENCHMARK_VERSION = "1.0.0"
CLASSES = ["calm_trader", "loss_aversion", "overtrader", "revenge_trader"]


def _history(seed: int, label: str, mixed: tuple[str, ...] = ()) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    n = int(rng.integers(110, 241))
    t = pd.Timestamp("2024-01-02T14:30:00Z") + pd.Timedelta(days=int(rng.integers(0, 120)))

    # Intentionally different from the training simulator: gamma/exponential
    # timing, normal log-notional noise and explicit occasional overnight gaps.
    baseline_notional = float(np.exp(rng.normal(8.25, 0.70)))
    base_gap = float(rng.uniform(110, 380))
    base_hold = float(rng.uniform(8, 95))
    win_rate = float(rng.uniform(0.41, 0.61))
    size_sigma = float(rng.uniform(0.15, 0.48))
    mechanisms = {label, *mixed}

    activity_strength = float(rng.uniform(0.42, 0.68)) if "overtrader" in mechanisms else 1.0
    loss_hold_strength = float(rng.uniform(1.35, 2.05)) if "loss_aversion" in mechanisms else 1.0
    escalation_strength = float(rng.uniform(1.14, 1.48)) if "revenge_trader" in mechanisms else 1.0
    acceleration_strength = float(rng.uniform(0.58, 0.84)) if "revenge_trader" in mechanisms else 1.0

    previous_loss = False
    rows = []
    for i in range(n):
        if i and rng.random() < 0.025:
            t += pd.Timedelta(hours=float(rng.uniform(8, 28)))
        loss = rng.random() > win_rate
        notional = baseline_notional * float(np.exp(rng.normal(0, size_sigma)))
        if previous_loss:
            notional *= escalation_strength

        hold = max(1.0, base_hold * float(rng.gamma(2.2, 1 / 2.2)))
        if loss:
            hold *= loss_hold_strength

        completion_gap = max(hold + 2.0, base_gap * activity_strength * float(rng.exponential(1.0) + 0.35))
        if previous_loss:
            completion_gap = max(hold + 2.0, completion_gap * acceleration_strength)
        t += pd.Timedelta(minutes=float(completion_gap))

        price = float(np.exp(rng.normal(4.72, 0.32)))
        move = float(np.clip(abs(rng.normal(0.006, 0.0035)), 0.0007, 0.03))
        pnl = notional * move * (-1 if loss else 1)
        rows.append({
            "timestamp": t,
            "quantity": notional / price,
            "entry_price": price,
            "profit_loss": pnl,
            "holding_minutes": hold,
            "asset": str(rng.choice(["SPY", "QQQ", "AAPL", "MSFT", "NVDA"])),
            "side": "LONG",
        })
        previous_loss = loss
    return pd.DataFrame(rows)


def make_external_pure(count: int = 1000, seed: int = 88001):
    histories, labels, groups = [], [], []
    for i in range(count):
        label = CLASSES[i % len(CLASSES)]
        child = int(np.random.SeedSequence([seed, i]).generate_state(1)[0])
        histories.append(_history(child, label))
        labels.append(label)
        groups.append(f"external-pure-{i:05d}")
    return histories, np.asarray(labels), groups


def make_external_ambiguous(count: int = 500, seed: int = 99001):
    pairs = [
        ("overtrader", "loss_aversion"),
        ("overtrader", "revenge_trader"),
        ("loss_aversion", "revenge_trader"),
        ("calm_trader", "revenge_trader"),
    ]
    histories, descriptors, groups = [], [], []
    for i in range(count):
        pair = pairs[i % len(pairs)]
        child = int(np.random.SeedSequence([seed, i]).generate_state(1)[0])
        # label only seeds the base constructor; both mechanisms are active.
        histories.append(_history(child, pair[0], mixed=(pair[1],)))
        descriptors.append("+".join(pair))
        groups.append(f"external-mixed-{i:05d}")
    return histories, np.asarray(descriptors), groups
