"""Disclosed synthetic generator with class-independent nuisance distributions.

Labels represent simulated behavioral regimes, never human diagnoses. Absolute
holding time, baseline size, win rate and ordinary size noise are nuisance
variables sampled from the same distributions for every class. Class identity is
introduced only through the intended behavioral mechanism.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

SIMULATOR_VERSION = "2.0.0"
CLASSES = ["calm_trader", "loss_aversion", "overtrader", "revenge_trader"]
SPLIT_SEEDS = {"train": 1701, "selection": 2701, "calibration": 3701,
               "policy": 4701, "test": 5701, "shift": 6701}
SPLIT_COUNTS = {"train": 960, "selection": 320, "calibration": 320,
                "policy": 320, "test": 400, "shift": 400}


def simulate(seed: int, label: str, shifted: bool = False):
    if label not in CLASSES:
        raise ValueError(f"Unknown synthetic class: {label}")
    rng = np.random.default_rng(seed)
    n = int(rng.integers(90, 221))

    # Nuisance variables: identical distributions across all labels.
    baseline_size = rng.lognormal(8.15, 0.65)
    size_noise = rng.uniform(0.18, 0.55)
    base_gap = rng.lognormal(5.45, 0.55)          # ~4h median, wide across traders
    holding_base = rng.lognormal(3.35, 0.65)      # ~28m median, wide across traders
    holding_noise = rng.uniform(0.28, 0.62)
    gap_noise = rng.uniform(0.35, 0.70)
    win_rate = rng.uniform(0.40, 0.62)

    # Signal strength varies substantially so classes overlap instead of forming
    # narrow caricatures. Non-target mechanisms remain exactly neutral.
    activity_multiplier = rng.uniform(0.50, 0.82) if label == "overtrader" else 1.0
    loss_hold_multiplier = rng.uniform(1.35, 2.20) if label == "loss_aversion" else 1.0
    post_loss_size_multiplier = rng.uniform(1.15, 1.55) if label == "revenge_trader" else 1.0
    post_loss_gap_multiplier = rng.uniform(0.55, 0.82) if label == "revenge_trader" else 1.0

    if shifted:
        # Prespecified nuisance shift plus weaker behavioral signal. The shift
        # changes scale/distribution without introducing new class fingerprints.
        baseline_size *= rng.uniform(2.0, 5.0)
        size_noise *= 1.25
        base_gap *= rng.uniform(1.25, 1.65)
        holding_base *= rng.uniform(1.4, 2.0)
        activity_multiplier = 1 + 0.70 * (activity_multiplier - 1)
        loss_hold_multiplier = 1 + 0.70 * (loss_hold_multiplier - 1)
        post_loss_size_multiplier = 1 + 0.70 * (post_loss_size_multiplier - 1)
        post_loss_gap_multiplier = 1 + 0.70 * (post_loss_gap_multiplier - 1)

    elapsed = pd.Timestamp("2025-01-01", tz="UTC") + pd.Timedelta(days=int(rng.integers(0, 90)))
    rows = []
    previous_loss = False
    for _ in range(n):
        loss = rng.random() > win_rate
        notional = baseline_size * rng.lognormal(0, size_noise)
        if previous_loss:
            notional *= post_loss_size_multiplier

        hold = holding_base * rng.lognormal(0, holding_noise)
        if loss:
            hold *= loss_hold_multiplier
        hold = max(0.5, hold)

        idle = base_gap * activity_multiplier * rng.lognormal(0, gap_noise)
        if previous_loss:
            idle *= post_loss_gap_multiplier
        idle = max(1.0, idle)

        # Completion interval is prior idle + current hold, keeping the synthetic
        # outcome known before the next outcome-conditioned transition.
        elapsed += pd.Timedelta(minutes=float(idle + hold))
        price = rng.lognormal(4.55, 0.28)
        pnl_fraction = rng.lognormal(-4.55, 0.50)
        pnl = notional * pnl_fraction * (-1 if loss else 1)
        rows.append({
            "timestamp": elapsed,
            "quantity": notional / price,
            "entry_price": price,
            "profit_loss": pnl,
            "holding_minutes": hold,
            "asset": str(rng.choice(["AAA", "BBB", "CCC", "DDD"])),
            "side": "LONG",
        })
        previous_loss = loss
    return pd.DataFrame(rows)


def make_split(name, count=None, seed_offset=0):
    n = count if count is not None else SPLIT_COUNTS[name]
    seed = SPLIT_SEEDS[name] + seed_offset
    histories, labels, groups = [], [], []
    for i in range(n):
        label = CLASSES[i % len(CLASSES)]
        child_seed = int(np.random.SeedSequence([seed, i]).generate_state(1)[0])
        histories.append(simulate(child_seed, label, shifted=name == "shift"))
        labels.append(label)
        groups.append(f"{name}-trajectory-{i:05d}")
    return histories, np.asarray(labels), groups
