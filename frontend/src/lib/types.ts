export const CLASS_NAMES: Record<string, string> = {
  calm_trader: "Steady pattern",
  loss_aversion: "Longer loss holding",
  overtrader: "High activity",
  revenge_trader: "Post-loss escalation",
};
export const className = (key: string | null) =>
  key ? (CLASS_NAMES[key] ?? key) : "No classification";
export const humanize = (key: string) => key.replaceAll("_", " ");
export const percent = (value: number | null | undefined, digits = 1) => {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  const step = 10 ** -digits;
  if (value > 0 && value * 100 < step / 2) return `<${step}%`;
  if (value < 1 && value * 100 > 100 - step / 2) return `>${100 - step}%`;
  return `${(value * 100).toFixed(digits)}%`;
};
export const number = (value: number | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(value)
    ? "Unavailable"
    : value.toLocaleString("en-US", { maximumFractionDigits: digits });
export const date = (value: string) =>
  new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
export interface Quality {
  total_rows: number;
  usable_rows: number;
  malformed_rows: number;
  duplicate_rows: number;
  missing_fields: string[];
  warnings: string[];
  date_range: { start: string | null; end: string | null };
}
export interface Prediction {
  status: "classified" | "abstained" | "unavailable";
  label: string | null;
  probabilities: Record<string, number>;
  confidence: number | null;
  margin: number | null;
  reasons: string[];
  model_version: string;
  calibration: string;
}
export interface Analysis {
  schema_version: string;
  scope: string;
  quality: Quality;
  features: Record<string, number | null>;
  prediction: Prediction;
  evidence: {
    feature: string;
    label: string;
    value: number | null;
    unit: string;
  }[];
  explanations: {
    feature: string;
    value: number;
    reference: number;
    probability_delta: number;
  }[];
  explanation_method: string;
  counterfactuals: {
    title: string;
    description: string;
    original_probability: number;
    counterfactual_probability: number;
    label: string;
    changed_features: string[];
  }[];
  trends: {
    start: string;
    end: string;
    trades: number;
    features: Record<string, number | null>;
    prediction: Prediction;
  }[];
  coaching: { source: "deterministic"; summary: string; actions: string[] };
  alignment: {
    source: string;
    dimensions: { dimension: string; value: number | null; target: number }[];
    disclaimer: string;
  };
}
export interface Scores {
  macro_f1: number;
  weighted_f1: number;
  accuracy: number;
  balanced_accuracy: number;
}
export interface Reliability {
  lower: number;
  upper: number;
  count: number;
  confidence: number | null;
  accuracy: number | null;
}
export interface CalibrationScores {
  brier: number;
  ece: number;
  log_loss: number;
  reliability: Reliability[];
}
export interface Evaluation {
  schema_version: string;
  scope: string;
  selected_model: string;
  feature_version: string;
  dataset: {
    origin: string;
    unit: string;
    split_counts: Record<string, number>;
    classes: string[];
    fingerprint: string;
  };
  methodology: string;
  models: { name: string; validation: Scores }[];
  test: Scores & {
    per_class: Record<
      string,
      { precision: number; recall: number; f1: number; support: number }
    >;
    confusion_matrix: number[][];
    macro_f1_ci95: number[];
  };
  calibration: {
    method: string;
    temperature: number;
    raw: CalibrationScores;
    calibrated: CalibrationScores;
  };
  coverage: {
    threshold: number;
    coverage: number;
    accuracy: number | null;
    macro_f1: number | null;
  }[];
  feature_importance: { feature: string; importance: number }[];
  robustness: {
    perturbation: string;
    agreement: number | null;
    mean_probability_change: number | null;
    coverage: number;
    comparable_predictions: number;
    histories: number;
  }[];
  shift: Scores;
  limitations: string[];
}
