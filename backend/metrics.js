function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stddev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length;
  return Math.sqrt(v);
}

export function computeUserMetrics(trades) {
  // trades per day
  const byDay = new Map();
  for (const t of trades) {
    const d = new Date(t.ts);
    if (Number.isNaN(d.valueOf())) continue;
    const day = d.toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const tradesPerDay = [...byDay.values()];
  const trade_frequency = mean(tradesPerDay); // trades/day

  // trade sizes (CAD)
  const sizes = trades
    .map((t) => t.notional)
    .map((x) => (x == null || x === "" ? null : Number(x)))
    .filter((x) => Number.isFinite(x) && x > 0);

  const avg_trade_size = mean(sizes);
  const trade_size_variability = stddev(sizes);

  // % trades after loss (only if PL exists)
  const plNums = trades
    .map((t) => (t.pl == null || t.pl === "" ? null : Number(t.pl)))
    .filter((x) => Number.isFinite(x));

  let pct_trades_after_loss = null;
  if (plNums.length >= 2) {
    let lossCount = 0;
    let afterLossCount = 0;

    for (let i = 0; i < trades.length - 1; i++) {
      const cur = trades[i].pl == null || trades[i].pl === "" ? null : Number(trades[i].pl);
      if (!Number.isFinite(cur)) continue;

      if (cur < 0) {
        lossCount++;
        afterLossCount++; // next trade exists
      }
    }

    pct_trades_after_loss = lossCount ? afterLossCount / (trades.length - 1) : 0;
  }

  // average holding period (requires sells to close buys; FIFO)
  let avg_holding_period_days = null;
  const hasSell = trades.some((t) => (t.side || "").toUpperCase() === "SELL");

  if (hasSell) {
    const lots = new Map(); // asset -> [{ts, qty}]
    const holds = [];

    for (const t of trades) {
      const side = (t.side || "").toUpperCase();
      const ts = new Date(t.ts);
      if (Number.isNaN(ts.valueOf())) continue;

      const asset = t.asset;
      const qty = t.qty == null || t.qty === "" ? null : Number(t.qty);

      if (!asset || !Number.isFinite(qty) || qty <= 0) continue;

      if (side === "BUY") {
        if (!lots.has(asset)) lots.set(asset, []);
        lots.get(asset).push({ ts, qty });
      } else if (side === "SELL") {
        const queue = lots.get(asset) ?? [];
        let remaining = qty;

        while (remaining > 0 && queue.length) {
          const lot = queue[0];
          const used = Math.min(remaining, lot.qty);
          const days = (ts - lot.ts) / (1000 * 60 * 60 * 24);
          holds.push(days);
          lot.qty -= used;
          remaining -= used;
          if (lot.qty <= 1e-9) queue.shift();
        }
      }
    }

    if (holds.length) avg_holding_period_days = mean(holds);
  }

  return {
    trade_frequency,
    avg_trade_size,
    trade_size_variability,
    pct_trades_after_loss,
    avg_holding_period_days,
  };
}

export function normalizeMetrics(m) {
  const clamp01 = (x) => Math.max(0, Math.min(1, x));

  return {
    trade_frequency: clamp01((m.trade_frequency ?? 0) / 20), // 20 trades/day => 1
    avg_trade_size: clamp01((m.avg_trade_size ?? 0) / 5000), // 5k CAD => 1
    holding_period:
      m.avg_holding_period_days == null ? null : clamp01(m.avg_holding_period_days / 90), // 90d => 1
    after_loss:
      m.pct_trades_after_loss == null ? null : clamp01(m.pct_trades_after_loss), // already 0..1
    size_variability: clamp01((m.trade_size_variability ?? 0) / 5000),
  };
}
