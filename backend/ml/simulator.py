"""Disclosed simulation: labels are assigned latent regimes, never human diagnoses."""
from __future__ import annotations

import numpy as np
import pandas as pd

SIMULATOR_VERSION = "1.0.0"
CLASSES = ["calm_trader", "loss_aversion", "overtrader", "revenge_trader"]
SPLIT_SEEDS = {"train": 1701, "selection": 2701, "calibration": 3701,
               "policy": 4701, "test": 5701, "shift": 6701}
SPLIT_COUNTS = {"train": 640, "selection": 240, "calibration": 240,
                "policy": 240, "test": 320, "shift": 320}


def simulate(seed: int, label: str, shifted=False):
    rng = np.random.default_rng(seed)
    n = int(rng.integers(65, 161))
    # All regimes share nuisance distributions and overlapping behavioral tendencies.
    baseline_size = rng.lognormal(8.2, 0.8)
    size_noise = rng.uniform(0.12, 0.65)
    base_gap = rng.lognormal(5.7, 0.7)
    holding_base = rng.lognormal(2.3, 0.55)
    activity = rng.lognormal(-1.25 if label == "overtrader" else 0, 0.45)
    loss_holding = rng.lognormal(0.9 if label == "loss_aversion" else 0, 0.32)
    escalation = rng.lognormal(0.7 if label == "revenge_trader" else 0, 0.22)
    acceleration = rng.lognormal(-0.7 if label == "revenge_trader" else 0, 0.22)
    if shifted:
        # Prespecified external regime: larger size/noise, slower market, weaker signals.
        baseline_size *= 4
        size_noise *= 1.5
        base_gap *= 1.6
        loss_holding = 1 + 0.65 * (loss_holding - 1)
        escalation = 1 + 0.65 * (escalation - 1)
        acceleration = 1 + 0.65 * (acceleration - 1)
    win_rate = rng.uniform(0.38, 0.65)
    elapsed = pd.Timestamp("2025-01-01", tz="UTC") + pd.Timedelta(days=int(rng.integers(0, 90)))
    rows = []
    last_loss = False
    for _ in range(n):
        loss = rng.random() > win_rate
        notional = baseline_size * rng.lognormal(0, size_noise) * (escalation if last_loss else 1)
        hold = max(0.1, holding_base * rng.lognormal(0, 0.55) * (loss_holding if loss else 1))
        idle = max(0.1, base_gap * activity * rng.lognormal(0, 0.65) * (acceleration if last_loss else 1))
        elapsed += pd.Timedelta(minutes=idle + hold)
        price = rng.lognormal(4.5, 0.2)
        pnl = notional * rng.lognormal(-4.5, 0.45) * (-1 if loss else 1)
        rows.append({"timestamp": elapsed, "quantity": notional / price, "entry_price": price,
                     "profit_loss": pnl, "holding_minutes": hold,
                     "asset": str(rng.choice(["AAA", "BBB", "CCC"])), "side": "LONG"})
        last_loss = loss
    return pd.DataFrame(rows)


def make_split(name, count=None, seed_offset=0):
    n = count if count is not None else SPLIT_COUNTS[name]
    seed = SPLIT_SEEDS[name] + seed_offset
    histories, labels, groups = [], [], []
    for i in range(n):
        label = CLASSES[i % len(CLASSES)]
        # SeedSequence keeps split and trajectory identifiers structurally separate.
        child_seed = int(np.random.SeedSequence([seed, i]).generate_state(1)[0])
        histories.append(simulate(child_seed, label, shifted=name == "shift"))
        labels.append(label)
        groups.append(f"{name}-trajectory-{i:05d}")
    return histories, np.asarray(labels), groups
