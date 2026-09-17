"""Hand-computable feature and strict CSV-boundary tests."""
from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from ml.features import (FEATURE_NAMES, MAX_BYTES, MAX_ROWS, ValidationError,
                         extract_features, feature_frame, json_features,
                         validate_csv)


class FeatureExtractionTests(unittest.TestCase):
    def setUp(self):
        self.history = pd.DataFrame(
            {
                "timestamp": pd.to_datetime(
                    [
                        "2025-01-01T00:00:00Z",
                        "2025-01-01T00:10:00Z",
                        "2025-01-01T00:30:00Z",
                        "2025-01-01T01:00:00Z",
                        "2025-01-01T01:40:00Z",
                        "2025-01-01T02:30:00Z",
                    ],
                    utc=True,
                ),
                "quantity": [10, 20, 10, 30, 15, 15],
                "entry_price": [10, 10, 10, 10, 10, 10],
                "profit_loss": [-10, 20, -30, -10, 40, 0],
                "holding_minutes": [10, 20, 30, 40, 50, 60],
            }
        )

    def test_features_match_manual_sequence_calculations(self):
        actual = extract_features(self.history)

        self.assertEqual(list(actual), FEATURE_NAMES)
        self.assertAlmostEqual(actual["trades_per_day"], 6.0)
        self.assertAlmostEqual(actual["max_trades_hour"], 3.0)
        self.assertAlmostEqual(actual["median_gap_minutes"], 30.0)
        self.assertAlmostEqual(actual["gap_cv"], math.sqrt(200) / 30)
        self.assertAlmostEqual(actual["burst_fraction"], 0.0)
        self.assertAlmostEqual(actual["daily_count_cv"], 0.0)

        notionals = np.asarray([100, 200, 100, 300, 150, 150], dtype=float)
        self.assertAlmostEqual(actual["size_cv"], notionals.std() / notionals.mean())
        self.assertAlmostEqual(actual["max_size_to_median"], 2.0)
        self.assertAlmostEqual(actual["post_loss_size_ratio"], 2.0)
        self.assertAlmostEqual(actual["post_win_size_ratio"], 0.75)
        self.assertAlmostEqual(actual["post_loss_increase_fraction"], 2 / 3)
        self.assertAlmostEqual(actual["post_loss_gap_ratio"], 1.0)
        self.assertAlmostEqual(actual["post_win_gap_ratio"], 35 / 30)
        self.assertAlmostEqual(actual["streak_size_ratio"], 0.5)
        self.assertAlmostEqual(actual["win_fraction"], 2 / 6)
        self.assertAlmostEqual(actual["loss_win_magnitude_ratio"], (50 / 3) / 30)
        self.assertAlmostEqual(actual["max_loss_streak_fraction"], 2 / 6)
        self.assertAlmostEqual(actual["median_holding_minutes"], 35.0)
        self.assertAlmostEqual(
            actual["holding_cv"], np.asarray([10, 20, 30, 40, 50, 60]).std() / 35
        )
        self.assertAlmostEqual(actual["loss_win_holding_ratio"], 30 / 35)

    def test_input_order_does_not_change_sequence_features(self):
        expected = extract_features(self.history)
        shuffled = self.history.sample(frac=1, random_state=9)
        actual = extract_features(shuffled)
        for name in FEATURE_NAMES:
            self.assertAlmostEqual(actual[name], expected[name])

    def test_partial_holding_evidence_is_unavailable(self):
        partial = self.history.copy()
        partial.loc[2, "holding_minutes"] = np.nan
        actual = extract_features(partial)
        self.assertTrue(math.isnan(actual["median_holding_minutes"]))
        self.assertTrue(math.isnan(actual["holding_cv"]))
        self.assertTrue(math.isnan(actual["loss_win_holding_ratio"]))
        self.assertIsNone(json_features(actual)["loss_win_holding_ratio"])

    def test_feature_frame_has_canonical_order(self):
        frame = feature_frame([self.history, self.history.copy()])
        self.assertEqual(list(frame.columns), FEATURE_NAMES)
        self.assertEqual(frame.shape, (2, len(FEATURE_NAMES)))


class CsvValidationTests(unittest.TestCase):
    HEADER = "timestamp,quantity,entry_price,profit_loss,holding_minutes,trader_id\n"

    def assert_invalid(self, text, phrase=None):
        with self.assertRaises(ValidationError) as caught:
            validate_csv(text)
        if phrase:
            self.assertIn(phrase, str(caught.exception))
        self.assertIsNotNone(caught.exception.quality)
        return caught.exception

    def test_rejects_empty_and_header_only_uploads(self):
        self.assert_invalid("", "nonempty")
        self.assert_invalid(self.HEADER, "at least one trade")

    def test_rejects_missing_and_duplicate_headers(self):
        exc = self.assert_invalid("timestamp,quantity,entry_price\n2025-01-01,1,10\n", "Missing required")
        self.assertEqual(exc.quality["missing_fields"], ["profit_loss"])
        self.assert_invalid(
            "timestamp,quantity,quantity,entry_price,profit_loss\n2025-01-01,1,1,10,2\n",
            "duplicate column",
        )

    def test_rejects_malformed_csv_width_and_quoting(self):
        self.assert_invalid(self.HEADER + "2025-01-01,1,10,-1\n", "same number")
        self.assert_invalid(self.HEADER + '"2025-01-01,1,10,-1,5,one\n', "quoting")

    def test_rejects_invalid_timestamp_and_numbers(self):
        invalid_rows = [
            "03/04/2025,1,10,-1,5,one",
            "2025-01-01T00:00:00Z,zero,10,-1,5,one",
            "2025-01-01T00:00:00Z,1,0,-1,5,one",
            "2025-01-01T00:00:00Z,1,10,inf,5,one",
            "2025-01-01T00:00:00Z,1,10,-1,-2,one",
        ]
        for row in invalid_rows:
            with self.subTest(row=row):
                exc = self.assert_invalid(self.HEADER + row + "\n", "Invalid timestamp")
                self.assertEqual(exc.quality["malformed_rows"], 1)

    def test_rejects_mixed_accounts(self):
        text = self.HEADER + (
            "2025-01-01T00:00:00Z,1,10,-1,5,one\n"
            "2025-01-01T00:10:00Z,1,10,1,5,two\n"
        )
        self.assert_invalid(text, "one trader_id")

    def test_sorts_warns_and_removes_behavioral_duplicates(self):
        duplicate = "2025-01-01T00:10:00,1,10,-1,5,one"
        text = self.HEADER + (
            duplicate + "\n"
            "2025-01-01T00:00:00,2,10,2,6,one\n"
            + duplicate
            + "\n"
        )
        frame, quality = validate_csv(text)
        self.assertEqual(quality["total_rows"], 3)
        self.assertEqual(quality["usable_rows"], 2)
        self.assertEqual(quality["duplicate_rows"], 1)
        self.assertTrue(frame.timestamp.is_monotonic_increasing)
        self.assertTrue(all(value.tzinfo is not None for value in frame.timestamp))
        self.assertTrue(any("UTC" in warning for warning in quality["warnings"]))
        self.assertTrue(any("removed" in warning for warning in quality["warnings"]))

    def test_accepts_exactly_fifty_thousand_rows(self):
        header = "timestamp,quantity,entry_price,profit_loss\n"
        rows = "\n".join(
            f"2025-01-01T00:00:00Z,{i + 1},10,{1 if i % 2 else -1}"
            for i in range(MAX_ROWS)
        )
        frame, quality = validate_csv(header + rows + "\n")
        self.assertEqual(len(frame), MAX_ROWS)
        self.assertEqual(quality["usable_rows"], MAX_ROWS)

    def test_rejects_more_than_fifty_thousand_rows(self):
        header = "timestamp,quantity,entry_price,profit_loss\n"
        row = "2025-01-01T00:00:00Z,1,10,-1\n"
        exc = self.assert_invalid(header + row * (MAX_ROWS + 1), "50,000")
        self.assertEqual(exc.quality["total_rows"], MAX_ROWS + 1)

    def test_rejects_payload_over_byte_limit(self):
        payload = self.HEADER + (" " * (MAX_BYTES + 1))
        self.assert_invalid(payload, "5 MiB")


if __name__ == "__main__":
    unittest.main()
