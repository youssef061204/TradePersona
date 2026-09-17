# Feature schema 1.0.0

One row per independent completed-trade history. Input notional is quantity times entry price, not risk relative to account equity. Features exclude identifiers, class names, source, absolute wealth and calendar date. Population standard deviations use ddof=0. Missing evidence remains unavailable; serving abstains instead of substituting neutral behavior.

| Feature | Unit | Definition |
|---|---|---|
| trades_per_day | trades/day | Count / max(elapsed UTC days, 1). |
| max_trades_hour | trades | Maximum count in a UTC clock-hour bin. |
| median_gap_minutes | minutes | Median elapsed minutes between successive completed trades. |
| gap_cv | ratio | Population SD / mean of completion intervals. |
| burst_fraction | fraction | Fraction of successive completion intervals <= 5 minutes. |
| daily_count_cv | ratio | Population SD / mean of daily counts including zero-count calendar days. |
| size_cv | ratio | Population SD / mean of quantity * entry price; no account-equity risk claim. |
| max_size_to_median | ratio | Maximum notional divided by median notional. |
| post_loss_size_ratio | ratio | Median next/prior notional ratio over transitions following a loss. |
| post_win_size_ratio | ratio | Median next/prior notional ratio over transitions following a win. |
| post_loss_increase_fraction | fraction | Fraction of loss-following transitions with next notional > prior notional. |
| post_loss_gap_ratio | ratio | Median loss-following completion interval / overall median interval. |
| post_win_gap_ratio | ratio | Median win-following completion interval / overall median interval. |
| streak_size_ratio | ratio | Median next/prior notional ratio following at least two consecutive losses. |
| win_fraction | fraction | Fraction of realized outcomes > 0; zero outcomes are neither wins nor losses. |
| loss_win_magnitude_ratio | ratio | Mean absolute realized loss divided by mean realized win; not a disposition measure. |
| max_loss_streak_fraction | fraction | Maximum consecutive losses divided by total trades. |
| median_holding_minutes | minutes | Median explicitly supplied completed-position holding duration. |
| holding_cv | ratio | Population SD / mean of explicitly supplied holding duration. |
| loss_win_holding_ratio | ratio | Median loss holding duration / median win holding duration; descriptive proxy only. |
