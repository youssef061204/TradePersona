"""Serializable estimators and fixed policy shared between evaluation and inference."""
import numpy as np
from scipy.special import softmax
import pandas as pd


def legacy_probabilities(histories):
    """Exact legacy Python heuristic, retained solely as a benchmark comparator.

    Includes its weak assumptions: loss magnitude called disposition and the
    absent-six-loss-streak tilt default of 50%. Output order is CLASSES.
    These normalized scores must not be interpreted as calibrated probabilities.
    """
    outputs = []
    for df in histories:
        idx = pd.date_range(df.timestamp.min().floor("h"), df.timestamp.max().ceil("h"), freq="h")
        hourly = df.groupby(df.timestamp.dt.floor("h")).size().reindex(idx, fill_value=0)
        wins = df.loc[df.profit_loss > 0, "profit_loss"]
        losses = df.loc[df.profit_loss < 0, "profit_loss"].abs()
        disposition = losses.mean() / wins.mean() if len(wins) else 1
        size = (df.quantity * df.entry_price).to_numpy()
        streak, count = [], 0
        for value in df.profit_loss:
            streak.append(count)
            count = count + 1 if value < 0 else 0
        groups = pd.DataFrame({"streak": streak, "size": size}).groupby("streak")["size"].mean().to_dict()
        baseline = groups.get(0, 0)
        escalation = max([v for k, v in groups.items() if k != 0] or [baseline])
        martingale = (escalation - baseline) / baseline if baseline > 0 else 0
        tilt_ratio = groups.get(6, size.mean()) / size.mean()
        tilt = round(100 / (1 + np.exp(-5 * np.log(tilt_ratio))), 2) / 100 if tilt_ratio > 0 else 0
        over = np.clip(max(hourly.mean() / 3, hourly.max() / 10), 0, 1)
        loss = np.clip((disposition - 1) / 1.5, 0, 1)
        revenge = np.clip(max(tilt, martingale), 0, 1)
        calm = np.clip(1 - max(over * 0.55, loss * 0.7, revenge * 0.8), 0, 1)
        raw = np.asarray([calm, loss, over, revenge]) + 0.15
        percentages = np.round(100 * raw / raw.sum(), 2)
        percentages[0] += round(100 - percentages.sum(), 2)
        outputs.append(percentages / 100)
    return np.asarray(outputs)


def temperature_scale(probabilities, temperature):
    return softmax(np.log(np.clip(probabilities, 1e-12, 1)) / temperature, axis=1)


POLICY = {"min_trades": 30, "min_wins": 5, "min_losses": 5,
          "confidence_threshold": 0.55, "margin_threshold": 0.10}


def probability_policy(p, threshold=0.55):
    ordered = np.sort(p, axis=1)
    return (ordered[:, -1] >= threshold) & ((ordered[:, -1] - ordered[:, -2]) >= POLICY["margin_threshold"])
