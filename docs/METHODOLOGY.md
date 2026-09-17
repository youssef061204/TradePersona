# Preregistered benchmark design, version 1

This plan is written before first training/evaluation. Task: recover one assigned latent simulation regime from an independent completed-trade trajectory. Labels are `calm_trader` (steady), `loss_aversion` (longer losing-position holding), `overtrader` (high activity) and `revenge_trader` (post-loss escalation). Names are compatibility keys, not verified psychological labels. Real-world predictive validity is unknown.

The old four CSVs are excluded from training and scoring: source and label are inseparable. We do not relabel windows from those sources and call them independent traders.

## Simulator and independence

Each simulated trader contributes one complete trajectory of 65–160 sequential completed positions. All classes share nuisance distributions (notional scale, prices, win rate, assets, start dates, record count). Overlapping lognormal latent tendencies modify activity, post-loss size/delay, and loss holding. Holding times are explicit, and the next trade opens only after the preceding outcome is known. Outcomes are synthetic, not exchange prices or market returns. Regime mixtures do not model all real behavior, and class frequency is balanced by construction. The same generator family underlies train and in-distribution test, a substantial limitation.

Independent SeedSequence pairs (partition seed, trajectory index) generate whole groups: train 640, selection 240, calibration 240, policy validation 240, final test 320, distribution shift 320. No rows/windows/traders cross partitions. Save group IDs, record fingerprints and seed configuration. Check duplicate fingerprints across splits. Start dates overlap across synthetic people; dates are not predictive features and calendar overlap is not shared outcomes. A chronological holdout is not a meaningful historical-market test here, since no market series is present. The separate shift regime uses 4× notionals, 1.5× sizing noise, 1.6× base delays and 0.65× loss-response effect deviations. It is a stress test, not real market validation.

## Selection and calibration

Compare the **unchanged legacy Python heuristic** at trajectory level, a training-majority baseline, scaled multinomial logistic regression (C 0.1, 1), Random Forest (minimum leaf 3, 8; 160 trees), and histogram gradient boosting (leaves 7, 15; 120 iterations). Median imputation and logistic scaling fit on training only. Select learned algorithm/hyperparameters using selection-set macro F1; ties retain the simpler earlier candidate. Baseline comparisons are selection-set metrics, clearly separated from final test metrics. The benchmark does not guarantee learned models improve the heuristic.

Fit one positive temperature on a distinct calibration partition by minimizing multiclass log loss. Use policy-validation log loss to choose between temperature-scaled and original probabilities. Report both on held-out test regardless of whether calibration helps. No refitting after calibration. Multiclass Brier is sum of squared class errors (range 0–2); ECE uses 10 equal-width bins of top-label confidence and is sample/bin dependent. Neither guarantees calibration under shift.

## Abstention and explanation

Fix policy before the test: at least 30 trades, 5 wins and 5 losses, complete positive holding evidence, unambiguous completion sequence, all required feature summaries calculable, maximum probability >=0.55 and top-two gap >=0.10. Training-only feature ranges use 0.5th/99.5th percentiles expanded by 1.5 IQR, with an epsilon floor. Any violation abstains. This marginal range check is deliberately simple and cannot detect every unsupported joint distribution. Report confidence-threshold sweep with the same data/margin/range gates; policy is not chosen to maximize a test metric.

Local explanations measure actual change in selected-class probability when one feature is replaced by the training median. They are sensitivity probes, not additive attributions, causal effects or SHAP. Correlated features can produce implausible combinations; label that limitation. Global importance is selection-validation permutation macro-F1 decrease, never a final-test tuning signal. Counterfactuals modify a raw sequence (remove loss-conditioned sizing escalation or make loss holding comparable to winner median), recalculate every feature and rerun the model. They are hypothetical model predictions, not promised investment outcomes; omit unsupported/out-of-range scenarios.

## Locked test and uncertainty

Write a frozen selection record before creating final test/shift histories. Evaluate the selected model once; save predictions so `ml:evaluate` checks/recomputes reported scores without selecting or fitting anything. A training run refuses to overwrite an existing experiment. Reproduction into a new directory is permitted but must not be used to tune against the published test. Report macro/weighted F1, balanced/ordinary accuracy, precision/recall/F1 per class, confusion matrix, one-vs-rest ROC-AUC and average precision. Macro F1 weights all regimes equally. Stratified trajectory bootstrap (1,000 replicates, fixed seed) gives a conditional 95% interval, not a population guarantee.

Prespecified perturbations on held-out histories: remove 10% of trades, jitter completion times ±30 seconds, multiply notionals by 2% lognormal noise, retain first half, duplicate 10% of rows, omit holding duration. Revalidate/recompute and report probability changes, label agreement and abstention. These are diagnostics only; do not redesign the model after viewing them. Changes for discovered implementation bugs require explicit artifact invalidation and transparent documentation.

References: [scikit-learn grouped validation](https://scikit-learn.org/stable/modules/cross_validation.html#cross-validation-iterators-for-grouped-data), [probability calibration](https://scikit-learn.org/stable/modules/calibration.html), [temperature scaling](https://arxiv.org/abs/1706.04599).
