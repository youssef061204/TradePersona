"""History-level metrics, calibration, bootstrap and selective prediction."""
import numpy as np
from sklearn.metrics import (accuracy_score, average_precision_score, balanced_accuracy_score,
                             confusion_matrix, f1_score, log_loss, precision_recall_fscore_support,
                             roc_auc_score)

from .models import probability_policy
from .simulator import CLASSES


def metrics(y, p):
    pred = np.asarray(CLASSES)[np.asarray(p).argmax(axis=1)]
    precision, recall, f1, support = precision_recall_fscore_support(y, pred, labels=CLASSES, zero_division=0)
    result = dict(macro_f1=float(f1_score(y, pred, labels=CLASSES, average="macro", zero_division=0)),
                  weighted_f1=float(f1_score(y, pred, labels=CLASSES, average="weighted", zero_division=0)),
                  accuracy=float(accuracy_score(y, pred)), balanced_accuracy=float(balanced_accuracy_score(y, pred)),
                  per_class={c: dict(precision=float(precision[i]), recall=float(recall[i]), f1=float(f1[i]), support=int(support[i])) for i, c in enumerate(CLASSES)},
                  confusion_matrix=confusion_matrix(y, pred, labels=CLASSES).tolist())
    if set(y) == set(CLASSES):
        target = np.asarray(y)[:, None] == np.asarray(CLASSES)[None, :]
        result["roc_auc_ovr_macro"] = float(roc_auc_score(target, p, average="macro"))
        result["pr_auc_macro"] = float(average_precision_score(target, p, average="macro"))
    return result


def calibration_metrics(y, p, bins=10):
    p = np.asarray(p)
    target = np.asarray(y)[:, None] == np.asarray(CLASSES)[None, :]
    confidence = p.max(axis=1)
    correct = np.asarray(CLASSES)[p.argmax(axis=1)] == y
    reliability, ece = [], 0
    for i in range(bins):
        lower, upper = i / bins, (i + 1) / bins
        mask = (confidence >= lower) & ((confidence < upper) if i < bins - 1 else (confidence <= upper))
        count = int(mask.sum())
        acc = float(correct[mask].mean()) if count else None
        conf = float(confidence[mask].mean()) if count else None
        if count:
            ece += count / len(y) * abs(acc - conf)
        reliability.append(dict(lower=lower, upper=upper, count=count, confidence=conf, accuracy=acc))
    return dict(brier=float(np.mean(np.sum((p - target) ** 2, axis=1))), ece=float(ece),
                log_loss=float(log_loss(y, p, labels=CLASSES)), reliability=reliability)


def bootstrap_f1(y, p, seed=8101, repeats=1000):
    """Stratified trajectory bootstrap, conditional on this balanced regime mixture.

    One row per independent group; no trade-level pseudoreplication.
    """
    rng = np.random.default_rng(seed)
    y = np.asarray(y)
    pred = np.asarray(CLASSES)[p.argmax(axis=1)]
    strata = [np.flatnonzero(y == c) for c in CLASSES]
    values = []
    for _ in range(repeats):
        ix = np.concatenate([rng.choice(s, len(s), replace=True) for s in strata])
        values.append(f1_score(y[ix], pred[ix], average="macro", labels=CLASSES, zero_division=0))
    return np.quantile(values, [0.025, 0.975]).tolist()


def coverage_curve(y, p, eligible):
    result = []
    for threshold in (0, 0.4, 0.55, 0.65, 0.75, 0.85, 0.95):
        mask = probability_policy(p, threshold) & eligible
        score = metrics(np.asarray(y)[mask], p[mask]) if mask.any() else {}
        result.append(dict(threshold=threshold, coverage=float(mask.mean()), accepted=int(mask.sum()),
                           accuracy=score.get("accuracy"), macro_f1=score.get("macro_f1")))
    return result
