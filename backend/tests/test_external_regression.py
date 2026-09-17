"""Regression checks for shortcut-learning failures found by external simulation."""
from __future__ import annotations
import sys, unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from ml.external_benchmark import make_external_pure
from ml.features import MODEL_FEATURE_NAMES, extract_features, feature_frame
from ml.inference import load_artifact, predict_history, probability
from ml.evaluation import metrics

class ExternalGeneralizationRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.bundle = load_artifact()
    def test_known_shortcut_features_cannot_drive_classification(self):
        self.assertNotIn("size_cv", MODEL_FEATURE_NAMES); self.assertNotIn("median_holding_minutes", MODEL_FEATURE_NAMES); self.assertNotIn("holding_cv", MODEL_FEATURE_NAMES)
    def test_independent_generator_has_useful_cross_generator_signal(self):
        histories, labels, _ = make_external_pure(80, seed=123456)
        self.assertGreater(metrics(labels, probability(self.bundle, feature_frame(histories)))["macro_f1"], 0.65)
    def test_loss_holding_signal_is_not_ranked_last(self):
        histories, labels, _ = make_external_pure(40, seed=654321)
        for history, label in zip(histories, labels):
            if label != "loss_aversion": continue
            probs = predict_history(history, self.bundle, extract_features(history))["probabilities"]
            self.assertGreater(probs["loss_aversion"], probs["calm_trader"]); self.assertGreater(probs["loss_aversion"], probs["overtrader"]); self.assertGreater(probs["loss_aversion"], probs["revenge_trader"]); break

if __name__ == "__main__": unittest.main()
