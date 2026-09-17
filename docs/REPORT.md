# Final technical report

This report describes the implemented repository at feature schema `1.0.0`. All predictive performance numbers below come from the frozen, reproducible **synthetic benchmark** in `backend/ml/artifacts/v1/evaluation.json`. They do not estimate accuracy on real traders.

## 1. Architecture before and after

Before: Next.js uploaded CSVs to a large Express server, which wrote raw and normalized files, spawned a new Python process per analysis, retrained a per-trade Random Forest from four filename-labelled CSVs, mixed duplicate JavaScript/Python formulas, cached a global last-user result, and optionally asked an LLM for classification-like output. Persona pages combined manually constructed investor vectors with behavioral claims.

After: Next.js provides a direct upload → dashboard flow and an artifact-driven evaluation page. Express validates upload boundaries, holds at most 100 capability sessions for 30 minutes, and talks to one bounded persistent Python JSONL worker. Python is the sole owner of validation, feature extraction, deterministic evidence, artifact inference, abstention, explanations, counterfactuals, and trends. Training is explicit and never runs at application startup. Optional Gemini only selects verified educational action IDs after explicit consent; optional Snowflake stores a small aggregate after separate consent.

## 2–3. Dataset audit, origin, and limitations

The four original backend CSVs contain 10,000 rows each but only four identifiable trajectories, exactly one per class. No generator, source, trader/session ID, seed, labeling protocol, or license was recorded. Three files share the same uninterrupted one-minute timestamp grid; `overtrader.csv` uses a deterministic ten-second grid. Class-specific corruptions, missingness, impossible balances, and ambiguous outcome timing are present. Labels are assigned only by filename.

Those files are retained only as quarantined legacy fixtures and contribute no data to the new benchmark. The complete evidence is in `DATA_AUDIT.md`.

The replacement benchmark is a documented synthetic simulator: 2,000 independent trajectories containing 224,524 completed trades. It assigns overlapping latent regimes for steady behavior, longer loss holding, high activity, and post-loss escalation. Every result remains limited by the simulator design, artificial balanced priors, simplified market behavior, and lack of real labels.

## 4. Leakage found and fixed

The legacy classifier treated 40,000 sequential trades from four sources as independent class-labelled observations, trained on all rows, and reported training hard-vote proportions as bias percentages. Source cadence and outcome-generation artifacts leaked class identity. No held-out evaluation existed.

The replacement prediction unit is one complete independent trajectory. Train, selection, calibration, policy, test, and shift groups have unique IDs, fingerprints, and seeds; no trajectory crosses partitions. The original files are excluded. The test set is generated only after the selected model, calibration choice, and abstention policy are frozen to disk. Preprocessing is fitted within each candidate pipeline on training only. Tests inspect the complete committed manifest for group and fingerprint isolation.

## 5. Final feature set

Twenty canonical, versioned features cover:

- activity: trades/day, maximum trades/hour, median completion gap, gap variability, rapid-completion fraction, daily-count variability;
- sizing: size variability and maximum/median relative size;
- post-outcome behavior: size and timing ratios after losses and wins, post-loss increase fraction, consecutive-loss sizing;
- outcomes: win fraction, loss/win magnitude ratio, longest-loss-streak fraction;
- holding: median duration, duration variability, and loser/winner duration ratio.

Every feature has an explicit definition and unit in `FEATURES.md`. Identifiers, filename/source, calendar date, class names, absolute wealth, and account metadata are excluded.

## 6. Split methodology

| Partition | Independent trajectories | Purpose |
|---|---:|---|
| Train | 640 | Fit preprocessing and candidates |
| Selection | 240 | Select algorithm/hyperparameters; compute permutation importance |
| Calibration | 240 | Fit one temperature parameter |
| Policy | 240 | Decide whether scaling improves log loss; report prespecified abstention sweep |
| Test | 320 | One final in-distribution evaluation |
| Shift | 320 | Prespecified changed-scale/noise/effect stress test |

All partitions are balanced across four synthetic regimes. The bootstrap resamples whole trajectories within class, never individual trades.

## 7–12. Models compared and selection

The following are **selection-validation** results. Each learned-model row is the best predefined hyperparameter setting for its family.

| Model | Macro F1 | Accuracy | Balanced accuracy |
|---|---:|---:|---:|
| Original deterministic heuristic | 0.284 | 0.400 | 0.400 |
| Training-majority baseline | 0.100 | 0.250 | 0.250 |
| Logistic regression (`C=1`) | **0.824** | 0.825 | 0.825 |
| Random Forest (160 trees, min leaf 8) | 0.822 | 0.821 | 0.821 |
| Histogram gradient boosting (7 leaves, 120 iterations) | 0.814 | 0.813 | 0.813 |

Logistic regression was selected by the prespecified maximum-validation-macro-F1 rule. The margin over Random Forest is only 0.002 and does not establish meaningful statistical superiority; the linear model is also smaller and easier to inspect. No candidate was chosen from final-test results.

## 13–15. Held-out performance and confusion matrix

Held-out synthetic macro F1 is **0.7786**, with a stratified trajectory-bootstrap 95% interval of **[0.7351, 0.8203]**. Weighted F1 is 0.7786; accuracy and balanced accuracy are 0.7781. One-vs-rest macro ROC-AUC is 0.9417 and macro PR-AUC is 0.8553.

| Synthetic regime | Precision | Recall | F1 | Support |
|---|---:|---:|---:|---:|
| Steady pattern | 0.671 | 0.663 | 0.667 | 80 |
| Longer loss holding | 0.851 | 0.788 | 0.818 | 80 |
| High activity | 0.659 | 0.700 | 0.679 | 80 |
| Post-loss escalation | 0.939 | 0.963 | 0.951 | 80 |

Confusion matrix, actual rows × predicted columns in the order above:

```text
[[53,  6, 18,  3],
 [ 7, 63, 10,  0],
 [17,  5, 56,  2],
 [ 2,  0,  1, 77]]
```

The largest confusion is between steady and high-activity regimes, consistent with overlapping simulator parameters.

## 16. Calibration

Temperature scaling fitted `T=1.0329` and improved policy-validation log loss, so it is deployed. On the untouched test:

| Metric | Raw | Temperature-scaled |
|---|---:|---:|
| Multiclass Brier (lower is better) | 0.2974 | **0.2967** |
| Log loss (lower is better) | 0.5171 | **0.5154** |
| 10-bin top-label ECE (lower is better) | **0.0446** | 0.0454 |

Calibration improved Brier and log loss slightly while ECE worsened slightly. The dashboard reports both rather than claiming uniform improvement.

## 17. Abstention tradeoff

Production policy requires at least 30 completed trades, five wins, five losses, complete holding evidence, unambiguous nonoverlapping completion ordering, finite required features, supported training ranges, top probability ≥0.55, and top-two margin ≥0.10.

| Probability threshold | Coverage | Retained accuracy | Retained macro F1 |
|---|---:|---:|---:|
| Fixed policy: 0.55 | **85.0%** | 81.6% | 0.808 |
| 0.65 | 72.2% | 87.9% | 0.859 |
| 0.75 | 62.5% | 90.5% | 0.877 |
| 0.85 | 49.1% | 94.9% | 0.916 |

The 0.55 policy was defined before the test. Higher selective scores exclude more histories and do not establish safety on real data.

## 18–19. Explainability and counterfactuals

For a classified history, local explanations replace one feature at a time with the training median and report the actual change in selected-class probability. Tests independently rerun every displayed sensitivity. These are model sensitivity probes, not additive SHAP values or causal attributions; correlated-feature probes can be unrealistic.

Counterfactuals edit raw histories rather than isolated columns. The sizing scenario caps post-loss notional at the median of other positions and scales realized P/L to preserve the recorded percentage return; the holding scenario caps loss duration at the winner median. The engine then recomputes all twenty features, verifies training-range support, and reruns inference. Tests independently reconstruct the sizing scenario. The UI calls these hypothetical model predictions and makes no return or causal claim.

## 20. Robustness

Measured on 80 held-out histories:

| Perturbation | Label agreement | Mean absolute probability change | Classified coverage |
|---|---:|---:|---:|
| Remove 10% of trades | 95.0% | 0.0259 | 82.5% |
| Timestamp jitter ±30 seconds | 100.0% | 0.0003 | 87.5% |
| 2% sizing noise | 100.0% | 0.0047 | 87.5% |
| First half only | 86.3% | 0.0482 | 77.5% |
| Duplicate 10% | 100.0% | effectively 0 | 87.5% |
| Remove holding duration | not comparable | not comparable | 0% (abstains) |

Under the prespecified shifted simulator, overall macro F1 falls to **0.7044**. At the fixed 0.55 threshold, coverage is 70.3% and retained macro F1 is 0.7566. This exposes rather than hides sensitivity to distribution change.

## 21. Automated verification

- 32 Python tests: hand-calculable features, validation boundaries, manifest isolation, artifact schema/order, probability/calibration contracts, abstention, explanation faithfulness, counterfactual recomputation.
- 15 Node tests: upload/session isolation and expiry, CORS, capacity/timeout/restart behavior, safe errors, constrained Gemini, aggregate-only Snowflake records.
- 5 Playwright flows: real CSV → API → Python → dashboard, insufficient-data abstention, malformed CSV, artifact-driven evaluation, expired session and mobile layout.
- Next.js production build and TypeScript passed.
- Root, backend, frontend npm audits and pinned Python dependency audit reported no known vulnerabilities after updates.
- The unprivileged backend Docker image built successfully; inside-container artifact evaluation and a live container sample upload both passed.
- A full separately generated reproduction matched dataset fingerprints, comparison/test/calibration/coverage/importance/robustness/shift outputs exactly in the tested environment.

CI runs the same layers, including a separately seeded small training smoke test rather than expensive full retraining.

## 22–23. UX and architecture improvements

The new experience starts with a documented CSV contract, client-side size/type feedback, a privacy/retention statement, and a clearly synthetic demo. The dashboard leads with classification or abstention, data quality, probabilities, actual measurements, sensitivity explanations, raw-history counterfactuals, nonoverlapping weekly trends, deterministic coaching, and an explicitly manual reference comparison. The evaluation route displays the generated model comparison, final metrics, class report, confusion matrix, reliability plot, coverage, importance, robustness, shift results, provenance, fingerprint, and limitations.

The API no longer exposes a global latest upload, filenames, temporary paths, or raw histories. It removes disk upload retention, uses exact CORS origins, caps file size/rows/sessions/queue/time, sanitizes worker failures, and runs the artifact-loaded Python worker persistently. Legacy duplicate formulas and misleading persona routes were removed from production.

## 24. Reproduction commands

```sh
npm run ml:evaluate
npm run ml:train -- --output ml/artifacts/reproduction-1
npm run ml:evaluate -- --output ml/artifacts/reproduction-1
npm test
npm run lint
npm run build
npm run test:e2e
npm run dev
```

Full setup, platform-specific environment activation, artifact overwrite protection, Docker, Render, CORS, and optional integration setup are in the root `README.md` and `DEPLOY_RENDER.md`.

## 25. Remaining limitations

There is no independently collected real-trader validation. Synthetic labels simplify mixed and evolving behavior. The generator has no market microstructure, portfolio equity, common market returns, liquidity, execution overlap, or causal behavioral annotation. Calibration and marginal range checks may fail under unknown joint shift. A user can misstate completion-time/holding semantics. Sessions are bearer capabilities in one process, without accounts or durable storage. Horizontal scaling requires shared session storage or affinity. Hosted deployment and live optional integrations were not published or credential-tested.

The strongest next research step is consented, independently labelled completed-position histories with trader groups, realization timestamps, documented annotation, and a locked unseen-trader evaluation.

## 26. Strongest defensible résumé metrics

- Built and tested one canonical 20-feature behavioral pipeline over a reproducible benchmark of **2,000 independent synthetic trajectories / 224,524 trades**, with six isolated data partitions and full artifact fingerprints.
- Achieved **0.779 held-out synthetic macro F1 [95% CI 0.735–0.820]** with calibrated logistic regression; fixed abstention classified **85%** of test histories at **0.808 retained macro F1**.
- Added **52 automated checks** (32 Python, 15 Node, 5 browser) plus Docker build/live-upload verification, dependency auditing, and reproducible artifact evaluation.

These numbers must always retain the word **synthetic** when used publicly.

## 27. Three Google XYZ résumé bullets

- Improved synthetic behavioral-regime classification from a **0.284 heuristic validation macro F1 to 0.824** by engineering a versioned 20-feature Python pipeline and comparing logistic regression, Random Forest, and gradient boosting across independent simulated trader trajectories.
- Achieved **0.779 held-out synthetic macro F1 (95% CI 0.735–0.820)** across 320 unseen trajectories by preventing group leakage across a 2,000-trajectory, 224,524-trade benchmark and separating model selection, calibration, abstention policy, testing, and distribution-shift evaluation.
- Increased reliable model coverage visibility to a measured **85% coverage at 0.808 retained synthetic macro F1** by shipping calibrated probabilities, range/data-quality abstention, faithful sensitivity explanations, raw-history counterfactuals, and **52 automated Python/Node/browser checks** in a Next.js–Express–Python application.
