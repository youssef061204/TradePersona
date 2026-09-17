"""Independence, probability, artifact-schema, and abstention tests."""
from __future__ import annotations

import hashlib
import math
import sys
import tempfile
import unittest
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from pandas.testing import assert_frame_equal

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from ml.evaluation import calibration_metrics, metrics
from ml.features import FEATURE_NAMES, FEATURE_VERSION, extract_features, feature_frame
from ml.inference import (ARTIFACT_DIR, load_artifact, predict_history,
                          probability, range_eligible, sufficiency_reasons)
from ml.models import POLICY, probability_policy, temperature_scale
from ml.simulator import CLASSES, SPLIT_SEEDS, make_split, simulate


class FixedProbabilityModel:
    """Small joblib-safe estimator stand-in for inference contract tests."""

    classes_ = np.asarray(CLASSES)

    def __init__(self, probabilities=(0.8, 0.1, 0.05, 0.05)):
        self.probabilities = np.asarray(probabilities, dtype=float)

    def predict_proba(self, frame):
        return np.tile(self.probabilities, (len(frame), 1))


def complete_history(rows=40):
    timestamp = pd.date_range("2025-01-01", periods=rows, freq="1h", tz="UTC")
    return pd.DataFrame(
        {
            "timestamp": timestamp,
            "quantity": np.resize([10.0, 14.0, 9.0, 12.0], rows),
            "entry_price": np.resize([100.0, 101.0, 99.0, 102.0], rows),
            "profit_loss": np.resize([-10.0, -5.0, 12.0, 14.0], rows),
            "holding_minutes": np.resize([20.0, 30.0, 25.0, 35.0], rows),
        }
    )


def bundle_for(history, probabilities=(0.8, 0.1, 0.05, 0.05)):
    features = extract_features(history)
    values = np.asarray([features[name] for name in FEATURE_NAMES])
    return {
        "model": FixedProbabilityModel(probabilities),
        "feature_version": FEATURE_VERSION,
        "feature_names": FEATURE_NAMES,
        "model_version": "test-model",
        "calibration_method": "temperature",
        "temperature": 1.0,
        "bounds": {"lower": values - np.maximum(np.abs(values), 1) * 10,
                   "upper": values + np.maximum(np.abs(values), 1) * 10},
        "medians": values,
    }


class SimulatorIndependenceTests(unittest.TestCase):
    def test_split_generation_is_deterministic(self):
        histories_a, labels_a, groups_a = make_split("train", count=12)
        histories_b, labels_b, groups_b = make_split("train", count=12)
        self.assertEqual(groups_a, groups_b)
        np.testing.assert_array_equal(labels_a, labels_b)
        for left, right in zip(histories_a, histories_b):
            assert_frame_equal(left, right, check_exact=True)

    def test_split_group_ids_and_trajectory_fingerprints_do_not_overlap(self):
        seen_groups = set()
        seen_fingerprints = set()
        for split in SPLIT_SEEDS:
            histories, labels, groups = make_split(split, count=12)
            self.assertEqual(len(histories), len(labels))
            self.assertEqual(len(groups), len(set(groups)))
            self.assertTrue(seen_groups.isdisjoint(groups))
            seen_groups.update(groups)

            fingerprints = {
                hashlib.sha256(history.to_csv(index=False).encode("utf-8")).hexdigest()
                for history in histories
            }
            self.assertEqual(len(fingerprints), len(histories))
            self.assertTrue(seen_fingerprints.isdisjoint(fingerprints))
            seen_fingerprints.update(fingerprints)

    def test_simulation_preserves_outcome_before_next_completion(self):
        history = simulate(12345, "revenge_trader")
        self.assertTrue(history.timestamp.is_monotonic_increasing)
        self.assertTrue((history.timestamp.diff().dropna().dt.total_seconds() > 0).all())
        self.assertTrue((history.holding_minutes > 0).all())
        self.assertTrue((history.quantity > 0).all())
        self.assertTrue((history.entry_price > 0).all())


class ProbabilityAndSchemaTests(unittest.TestCase):
    def test_temperature_scaled_probabilities_are_finite_and_normalized(self):
        raw = np.asarray([[0.7, 0.2, 0.08, 0.02], [0.1, 0.2, 0.3, 0.4]])
        calibrated = temperature_scale(raw, 1.7)
        self.assertTrue(np.isfinite(calibrated).all())
        self.assertTrue((calibrated >= 0).all())
        np.testing.assert_allclose(calibrated.sum(axis=1), 1.0)

    def test_evaluation_metrics_have_valid_probability_and_class_shapes(self):
        y = np.asarray(CLASSES * 2)
        p = np.full((len(y), len(CLASSES)), 0.05)
        for index, label in enumerate(y):
            p[index, CLASSES.index(label)] = 0.85
        report = metrics(y, p)
        calibration = calibration_metrics(y, p)
        self.assertEqual(
            report["confusion_matrix"],
            [[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 2]],
        )
        self.assertAlmostEqual(report["macro_f1"], 1.0)
        self.assertGreaterEqual(calibration["brier"], 0.0)
        self.assertLessEqual(calibration["brier"], 2.0)
        self.assertGreaterEqual(calibration["ece"], 0.0)
        self.assertLessEqual(calibration["ece"], 1.0)
        self.assertEqual(sum(row["count"] for row in calibration["reliability"]), len(y))

    def test_inference_rejects_reordered_feature_columns(self):
        history = complete_history()
        bundle = bundle_for(history)
        frame = feature_frame([history])
        result = probability(bundle, frame)
        self.assertEqual(result.shape, (1, len(CLASSES)))
        np.testing.assert_allclose(result.sum(axis=1), 1.0)
        with self.assertRaisesRegex(ValueError, "feature order"):
            probability(bundle, frame[FEATURE_NAMES[::-1]])

    def test_artifact_loader_enforces_feature_schema(self):
        history = complete_history()
        with tempfile.TemporaryDirectory() as directory:
            artifact = bundle_for(history)
            joblib.dump(artifact, Path(directory) / "model.joblib")
            load_artifact.cache_clear()
            loaded = load_artifact(directory)
            self.assertEqual(loaded["feature_names"], FEATURE_NAMES)

            artifact["feature_names"] = FEATURE_NAMES[::-1]
            joblib.dump(artifact, Path(directory) / "model.joblib")
            load_artifact.cache_clear()
            with self.assertRaisesRegex(ValueError, "feature schema"):
                load_artifact(directory)
        load_artifact.cache_clear()

    def test_deployed_artifact_loads_when_present(self):
        if not (ARTIFACT_DIR / "model.joblib").exists():
            self.skipTest("No trained artifact is installed in this checkout.")
        load_artifact.cache_clear()
        artifact = load_artifact()
        self.assertEqual(artifact["feature_version"], FEATURE_VERSION)
        self.assertEqual(artifact["feature_names"], FEATURE_NAMES)
        self.assertEqual(list(artifact["model"].classes_), CLASSES)


class AbstentionTests(unittest.TestCase):
    def test_insufficient_trade_count_abstains(self):
        history = complete_history(POLICY["min_trades"] - 1)
        result = predict_history(history, bundle_for(history))
        self.assertEqual(result["status"], "abstained")
        self.assertEqual(result["probabilities"], {})
        self.assertTrue(any("30 completed" in reason for reason in result["reasons"]))

    def test_missing_holding_evidence_abstains(self):
        history = complete_history()
        history["holding_minutes"] = np.nan
        result = predict_history(history, bundle_for(complete_history()))
        self.assertEqual(result["status"], "abstained")
        self.assertTrue(any("evidence is unavailable" in reason for reason in result["reasons"]))

    def test_simultaneous_completions_abstain(self):
        history = complete_history()
        history.loc[1, "timestamp"] = history.loc[0, "timestamp"]
        result = predict_history(history, bundle_for(complete_history()))
        self.assertEqual(result["status"], "abstained")
        self.assertTrue(any("ambiguous" in reason for reason in result["reasons"]))

    def test_out_of_range_history_abstains_but_keeps_experimental_probabilities(self):
        history = complete_history()
        features = extract_features(history)
        bundle = bundle_for(history)
        bundle["bounds"]["upper"][0] = features[FEATURE_NAMES[0]] - 1
        result = predict_history(history, bundle, features)
        self.assertEqual(result["status"], "abstained")
        self.assertEqual(list(result["probabilities"]), CLASSES)
        self.assertAlmostEqual(sum(result["probabilities"].values()), 1.0)
        self.assertTrue(any("outside" in reason for reason in result["reasons"]))

    def test_low_confidence_and_small_margin_abstain(self):
        history = complete_history()
        bundle = bundle_for(history, probabilities=(0.40, 0.35, 0.15, 0.10))
        result = predict_history(history, bundle)
        self.assertEqual(result["status"], "abstained")
        self.assertTrue(any("55%" in reason for reason in result["reasons"]))
        self.assertTrue(any("10 percentage" in reason for reason in result["reasons"]))

    def test_range_and_probability_policy_vectorization(self):
        history = complete_history()
        frame = feature_frame([history, history])
        bundle = bundle_for(history)
        np.testing.assert_array_equal(range_eligible(frame, bundle["bounds"]), [True, True])
        p = np.asarray([[0.7, 0.1, 0.1, 0.1], [0.5, 0.45, 0.03, 0.02]])
        np.testing.assert_array_equal(probability_policy(p), [True, False])


if __name__ == "__main__":
    unittest.main()
