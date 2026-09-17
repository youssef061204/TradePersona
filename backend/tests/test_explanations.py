"""Faithfulness checks and artifact-level independence checks."""
import json
import unittest

import numpy as np
import pandas as pd

from ml.features import FEATURE_NAMES, extract_features, validate_csv
from ml.inference import ARTIFACT_DIR, counterfactuals, explain, load_artifact, predict_history, probability
from ml.simulator import CLASSES, simulate


class ExplanationAndArtifactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = load_artifact()
        cls.history = simulate(88001, "revenge_trader")  # Demo seed, outside benchmark.

    def test_local_sensitivities_equal_actual_model_probability_changes(self):
        features = extract_features(self.history)
        label = CLASSES[np.argmax(probability(self.bundle, pd.DataFrame([features], columns=FEATURE_NAMES))[0])]
        column = CLASSES.index(label)
        original = probability(self.bundle, pd.DataFrame([features], columns=FEATURE_NAMES))[0, column]
        explanations = explain(features, self.bundle, label)
        self.assertEqual(len(explanations), 6)
        for item in explanations:
            changed = dict(features, **{item["feature"]: item["reference"]})
            actual = probability(self.bundle, pd.DataFrame([changed], columns=FEATURE_NAMES))[0, column]
            self.assertAlmostEqual(item["probability_delta"], original - actual, places=12)

    def test_counterfactual_recomputes_consistent_raw_position_and_outcome_changes(self):
        label = "revenge_trader"
        scenarios = counterfactuals(self.history, self.bundle, label)
        sizing = next(row for row in scenarios if row["title"].startswith("Keep post-loss"))
        modified = self.history.copy()
        notionals = modified.quantity * modified.entry_price
        after_loss = modified.profit_loss.shift(1) < 0
        cap = float(notionals[~after_loss].median())
        for index in modified.index[after_loss]:
            reduction = min(1.0, cap / notionals[index])
            modified.loc[index, "quantity"] *= reduction
            modified.loc[index, "profit_loss"] *= reduction
        f = extract_features(modified)
        expected = probability(self.bundle, pd.DataFrame([f], columns=FEATURE_NAMES))[0, CLASSES.index(label)]
        self.assertAlmostEqual(sizing["counterfactual_probability"], expected, places=12)
        self.assertIn("size_cv", sizing["changed_features"])
        self.assertIn("post_win_size_ratio", sizing["changed_features"])

    def test_overlapping_positions_abstain_before_outcome_conditioned_prediction(self):
        modified = self.history.copy()
        modified.loc[1, "holding_minutes"] = 1e6
        result = predict_history(modified, self.bundle)
        self.assertEqual(result["status"], "abstained")
        self.assertEqual(result["probabilities"], {})
        self.assertTrue(any("Overlapping" in reason for reason in result["reasons"]))

    def test_csv_roundtrip_uses_the_same_inference_features(self):
        parsed, _ = validate_csv(self.history.to_csv(index=False))
        left, right = extract_features(self.history), extract_features(parsed)
        np.testing.assert_allclose([left[k] for k in FEATURE_NAMES], [right[k] for k in FEATURE_NAMES], rtol=1e-12, equal_nan=True)

    def test_full_saved_manifest_has_isolated_groups_and_balanced_partitions(self):
        manifest = json.loads((ARTIFACT_DIR / "split_manifest.json").read_text())
        groups, fingerprints = set(), set()
        for entries in manifest.values():
            group_ids = {row["group"] for row in entries}
            hashes = {row["fingerprint"] for row in entries}
            self.assertEqual(len(group_ids), len(entries))
            self.assertEqual(len(hashes), len(entries))
            self.assertFalse(groups.intersection(group_ids))
            self.assertFalse(fingerprints.intersection(hashes))
            groups.update(group_ids)
            fingerprints.update(hashes)
            for label in CLASSES:
                self.assertEqual(sum(row["label"] == label for row in entries), len(entries) // 4)


if __name__ == "__main__":
    unittest.main()
