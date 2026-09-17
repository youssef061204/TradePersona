# Dataset forensic audit

Audit snapshot: 2026-09-16, repository commit `0a7e46f`. This document covers the four labeled CSVs in `backend/datasets`, the downloadable sample CSV, and the legacy `services/ml_classifier.py` and `services/bias_engine.py` behavior that consumes them.

This is a **before-change audit**. The old Python serving implementations are preserved in Git history, not the active application. The downloadable sample has since been replaced with 148 explicitly synthetic completed trades (simulator seed 88001) including holding durations. The four original datasets remain quarantined under `backend/datasets` and are never used to train or evaluate the new model.

## Decision

The current labeled CSVs do **not** support a claim that TradePersona generalizes to unseen traders, sessions, or trajectories. Each class is a separate filename-level source, and the repository provides no trader ID, session ID, trajectory ID, generator seed, label record, or labeling protocol. The most defensible independent unit is therefore the whole source file/trajectory. That gives four units total and exactly one unit per class, so a group-held-out four-class evaluation is impossible.

The files should be treated as synthetic benchmark prototypes with unknown generator provenance. They may be retained as development fixtures, but no metric computed by randomly splitting their rows is evidence of real-world trader classification performance.

For a replacement benchmark, generate or collect multiple independent trader trajectories per class. Use a trader or generator-seed ID as the split group. A model observation may be an aggregated session or rolling window, but every observation from one trader/trajectory must remain in one split.

## Inventory and provenance

All five CSVs first appear in the repository's single initial commit, `9bb5dfb` (2026-03-24). The four backend datasets and both legacy Python files have no earlier Git history. No generator, source URL, citation, license, collection procedure, labeling rubric, or random seed exists in the repository. The class label is assigned solely by the filename mapping in `ml_classifier.py`.

| File | Rows | Timestamp range | Exact cadence | Missing cells | Git blob at introduction |
|---|---:|---|---:|---:|---|
| `calm_trader.csv` | 10,000 | 2025-03-01 09:30 to 2025-03-08 08:09 | 60 s | 405 | `27f788d2c78a7be7413ff50616288e78ee2c0077` |
| `loss_averse_trader.csv` | 10,000 | 2025-03-01 09:30 to 2025-03-08 08:09 | 60 s | 656 | `0e27711bce9e418562c894eae021e43d33d2e838` |
| `overtrader.csv` | 10,000 | 2025-03-01 09:30 to 2025-03-02 13:16:30 | 10 s | 374 | `e0fe1146f8c05982e18ea5688c8861b19b5e6816` |
| `revenge_trader.csv` | 10,000 | 2025-03-01 09:30 to 2025-03-08 08:09 | 60 s | 395 | `df68bded393af9cb1008fd74decb7d3c7cb83d00` |
| `tradepersona-sample.csv` | 30 | 2026-03-18 09:30Z to 2026-03-19 12:21Z | irregular | 0 | `100d5fc60ef00dfe09c8f1fa8e51bd3fca8454ad` |

The backend files exhibit overwhelming internal evidence of synthetic generation:

- Calm, loss-averse, and revenge have the exact same 10,000 timestamps, including uninterrupted overnight and weekend activity, with every row exactly 60 seconds apart. Overtrader uses an uninterrupted 10-second grid. The three one-minute files have timestamp Jaccard similarity 1.0; overtrader shares 1,667 exact timestamps with each.
- The seven symbols are sampled approximately uniformly, while every symbol has essentially the same broad entry-price distribution. Across files, entry prices center near 1,765-1,796 and mostly span roughly 50-3,500, irrespective of whether the symbol is AAPL, TSLA, NFLX, or another asset. This is incompatible with contemporaneous market histories.
- Most calculable P/L values were generated algebraically from same-row quantity and prices, and the files contain regular synthetic corruption/mutation patterns described below.

The precise generator cannot be recovered from the repository, so reports should say "synthetic data of unknown generator provenance," not name an unverified source.

The 30-row downloadable sample also has no provenance beyond the initial commit. It contains eight conspicuous loss/loss/win sequences in which size generally rises after losses. It is best described as a hand-curated synthetic demo fixture, not observed trading history.

## Schema and outcome-timing defects

The backend schema is `timestamp, asset, side, quantity, entry_price, exit_price, profit_loss, balance`. A row contains both entry and exit prices and realized P/L, which suggests a completed trade, but it contains only one timestamp. There is no exit or realization timestamp. Consequently, the data cannot establish that a previous row's loss was known when the next trade was entered.

This invalidates causal ordering assumptions in post-loss features. A future schema needs at least `entry_timestamp` and `exit_timestamp` (or `realized_at`). A "trade after a loss" may be counted only when the next entry occurs after that loss was realized.

The meaning of `side` is also unresolved. Among rows where quantity, prices, P/L, and side are present, only about half match a side-signed long/short P/L calculation. Instead, almost every non-mutated row uses the unsigned-direction formula:

`profit_loss = quantity * (exit_price - entry_price)`

| Source | Calculable rows | Rows matching unsigned-direction formula | Notable exceptions |
|---|---:|---:|---|
| calm | 9,792 | 9,772 (99.8%) | 20 mutated rows |
| loss-averse | 9,783 | 9,783 (100.0%) | none among calculable rows |
| overtrader | 9,800 | 9,781 (99.8%) | 19 mutated rows |
| revenge | 9,803 | 9,588 (97.8%) | 215 mutated rows |

The legacy holding-period calculation interprets BUY rows as opening lots and SELL rows as closing lots. That interpretation conflicts with each backend row already carrying its own entry price, exit price, and realized P/L. Holding duration is not identifiable from these files.

The frontend sample is ambiguous in a different way: it has P/L on each BUY or SELL row but no exit price or realization time. It must not be used to validate holding periods or post-loss ordering.

## Data quality findings

No exact duplicate rows or duplicate timestamps occur within any file. No exact rows occur across backend sources. A conservative near-duplicate check also found zero matches within or across sources when timestamp was ignored, categorical fields and quantity were held exact, and entry price, exit price, P/L, and balance were rounded to cents. This does not offset the much larger dependence problem: rows are sequential observations from only four source trajectories.

Missingness is source-specific and can itself leak class:

| Source | Asset | Side | Quantity | Entry | Exit | P/L |
|---|---:|---:|---:|---:|---:|---:|
| calm | 92 | 104 | 94 | 115 | 0 | 0 |
| loss-averse | 84 | 113 | 110 | 108 | 24 | 217 |
| overtrader | 94 | 80 | 108 | 92 | 0 | 0 |
| revenge | 102 | 94 | 103 | 96 | 0 | 0 |

`ml_classifier.py` silently turns missing quantity or entry price into trade value zero, then replaces all non-finite feature values with zero. Loss-averse is the only source with missing P/L and exit price. Missingness therefore becomes an undocumented source fingerprint rather than a validated input condition.

There are also strong integrity failures:

- Calm has 19 quantities above 200 and 19 entry prices above the normal synthetic ceiling; 20 rows no longer agree with the P/L formula. Its balance is otherwise exactly cumulative P/L from 10,000.
- Loss-averse has 14 P/L values with magnitude above 1,500, including a minimum of -23,677,221.51, while balances remain positive. Balance change disagrees with row P/L by more than `1e-5` in 1,971 of 9,782 computable transitions. The median loss is 103.44 and median win only 53.16, mechanically encoding the filename label in outcomes without a documented labeling rule.
- Overtrader has a negative balance in 9,024 rows. Balance change disagrees with P/L in 9,997 of 9,999 transitions, so balance is effectively unrelated to the ordered trade results.
- Revenge has 150 quantities above 200 versus 19 in calm, 19 in loss-averse, and 19 in overtrader. It has 215 P/L-formula breaks and 200 balance/P&L transition breaks, consistent with undocumented post-generation mutations.

These are not harmless outliers. They are class-dependent generator artifacts and consistency failures that a model can learn.

## Leakage and confounding

The legacy model labels every trade row with the class of its source filename. This converts four trajectory-level names into 40,000 allegedly independent labels. It then trains on all 40,000 rows with no train/validation/test split and no evaluation.

Its four features are also source- and outcome-confounded:

- `velocity` is constant at 0.016529 for all three one-minute files and about 0.09531 for virtually every overtrader row. Cadence is therefore a deterministic source/class identifier for overtrader.
- `revenge_signal` uses the prior row's realized P/L despite the absence of realization timestamps and divides it by the same source-specific cadence.
- `loss_magnitude` uses the target outcome itself. This may be a legitimate historical feature only if the prediction target is a later window and outcome availability is established; here it helps distinguish a file whose P/L distribution was mechanically altered to match its name.
- `size_aggression` is a ratio of adjacent rows within one source and is highly unstable around missing values and synthetic mutations.

An audit-only diagnostic reproduced the legacy pipeline. Evaluating on the same rows used for fitting produced 0.9785 accuracy and 0.9785 macro F1; these are resubstitution numbers and have no evaluation meaning. A stratified 80/20 random row split with seed 42 produced 0.5105 accuracy and 0.5106 macro F1, but that split is still invalid because train and test contain rows from every same underlying trajectory. In that split, overtrader recall was 1.000 while calm, loss-averse, and revenge recall was only 0.347, 0.359, and 0.336 respectively. The result shows that the cadence cue separates overtrader while the remaining classes are close to chance on held-out rows even under a leakage-prone split.

A chronological split would not repair independence: it would test later rows from the same stationary, exactly spaced generated trajectory. Leave-one-file-out evaluation is also undefined for the current four-class task because holding out a file removes that class entirely from training.

## Legacy inference semantics

`classify_with_ml` predicts a hard class for every uploaded trade, then reports the fraction of hard row predictions as four "bias type ratios." Those ratios are neither history-level class probabilities nor calibrated confidence. A behavioral class is a property of a sequence, so one isolated trade should not be the prediction unit.

Other consequences in the legacy code are material:

- The Random Forest and scaler are fitted on the full CSV collection on the first inference call and cached only in process memory. There is no versioned artifact, schema version, dataset fingerprint, or reproducible experiment record.
- Uploads above 120,000 rows are stride-sampled before feature construction. This increases adjacent time differences and can change both `velocity` and `revenge_signal`, so the same underlying history can receive different semantics solely because it crossed a row-count threshold.
- The first row receives an invented 60-second time difference and neutral previous P/L. Missing and infinite feature values are replaced with zero without a data-quality state.
- `bias_engine.py` averages trades across the full continuous hourly span. On these 24/7 grids, the three one-minute sources imply about 60 trades/hour and overtrader about 360, values far beyond the fallback heuristic's saturation thresholds.
- The martingale/tilt calculation substitutes the overall mean when loss-streak length six is absent; a ratio of one maps to a nominal 50% tilt rather than "unavailable." This is a score convention, not measured evidence.

## Required replacement methodology

The product predicts behavior from histories, so the primary independent unit should be a trader trajectory. If real trader IDs are unavailable, a synthetic simulator must emit an explicit `trajectory_id` and `seed`, with multiple independently randomized trajectories per class or continuous latent behavior parameters.

Recommended hierarchy:

1. A trade is an event, not an independent labeled example.
2. A session or rolling window is the model observation and contains enough trades to estimate behavioral features.
3. A trader or generated trajectory is the split group. All its windows remain in exactly one of train, validation, or final test.
4. Generation seeds and parameter regimes for the final test are frozen before model selection. A separate shifted-regime test may measure simulator distribution shift.

Labels must come from a documented source. For synthetic data, store the latent parameters and deterministic label rule separately from the observed features, and avoid setting class-specific constants that directly reveal the label. For real data, document annotators, rubric, agreement, and whether labels predate the evaluated window.

Any benchmark result must be described as synthetic benchmark performance. The existing CSVs should contribute no rows to a claimed held-out evaluation unless they are explicitly quarantined as an unsupported legacy fixture.

## Reproduction notes

The audit used pandas parsing with coercion for numeric and timestamp checks. Exact duplicates used all columns. Near duplicates ignored timestamp, required categorical fields and quantity to match exactly, and rounded the remaining numeric fields to two decimal places. Balance integrity compared `balance[t]` with `balance[t-1] + profit_loss[t]` at tolerance `1e-5`. The audit-only model diagnostic used the current feature function and `RandomForestClassifier(n_estimators=200, random_state=42, class_weight="balanced")`; the random split was stratified with `test_size=0.2` and `random_state=42`.
