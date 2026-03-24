import { exec } from "./exec.js";

// -------- DB fetch
export async function fetchTrades(conn, sessionId) {
  const rows = await exec(
    conn,
    `SELECT TRADE_ID, TS, SIDE, ASSET, QTY, NOTIONAL, PL
     FROM CORE.TRADES
     WHERE SESSION_ID = ?
     ORDER BY TS ASC`,
    [sessionId]
  );

  return rows.map((r) => ({
    tradeId: String(r.TRADE_ID),
    ts: new Date(r.TS),
    side: r.SIDE ? String(r.SIDE).toUpperCase() : null,
    asset: r.ASSET ? String(r.ASSET).toUpperCase() : null,
    qty: r.QTY == null ? null : Number(r.QTY),
    notional: r.NOTIONAL == null ? null : Number(r.NOTIONAL),
    pl: r.PL == null ? null : Number(r.PL),
  }));
}

// -------- helpers
function median(nums) {
  if (!nums.length) return 0;
  const arr = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function clamp(min, x, max) {
  return Math.max(min, Math.min(max, x));
}

function hasValidPL(trades) {
  return trades.some((t) => t.pl != null && Number.isFinite(Number(t.pl)));
}

function minutesBetween(a, b) {
  return Math.round((b - a) / (1000 * 60));
}

// -------- Bias detection
export function computeBiases(trades) {
  // Group trades by day
  const byDay = new Map(); // day -> array of trades
  for (const t of trades) {
    if (!(t.ts instanceof Date) || Number.isNaN(t.ts.valueOf())) continue;
    const day = t.ts.toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(t);
  }

  const tradesPerDay = [...byDay.values()].map((arr) => arr.length);
  const dayKeys = [...byDay.keys()];

  // -------- 1) Overtrading (works even for single-day dataset)
  let overScore = 0;
  const overEvidence = [];

  if (tradesPerDay.length === 0) {
    overScore = 0;
  } else if (tradesPerDay.length === 1) {
    const count = tradesPerDay[0];
    // Heuristic: 5 trades/day = ~33, 15 trades/day = 100
    overScore = clamp(0, Math.round((count / 15) * 100), 100);
    overEvidence.push({
      day: dayKeys[0],
      trades: count,
      rule: "single-day volume heuristic",
    });
  } else {
    const med = median(tradesPerDay);
    const maxDay = Math.max(...tradesPerDay);

    // ratio-based scoring: 2x median => 50, 3x median => 100
    const ratio = med > 0 ? maxDay / med : maxDay;
    overScore = clamp(0, Math.round((ratio - 1) * 50), 100);

    for (const [day, arr] of byDay.entries()) {
      if (med > 0 && arr.length >= Math.ceil(med * 2)) {
        overEvidence.push({ day, trades: arr.length, baselineMedian: med });
      }
    }
  }

  // -------- 2) Revenge trading (requires P/L)
  const revengeEvidence = [];
  let revengeScore = 0;
  let revengeInsufficient = false;

  const plOk = hasValidPL(trades);
  if (!plOk) {
    revengeInsufficient = true;
  } else {
    // Heuristic:
    // If a loss is followed within 10 minutes by another trade, count it.
    // If notional increases after loss, mark sizeUp.
    // Score based on fraction of losses that trigger this.
    const losses = trades
      .map((t, idx) => ({ t, idx }))
      .filter(({ t }) => Number.isFinite(t.pl) && t.pl < 0);

    let triggers = 0;

    for (const { t, idx } of losses) {
      const next = trades[idx + 1];
      if (!next) continue;

      const mins = minutesBetween(t.ts, next.ts);
      if (mins <= 10) {
        triggers++;
        const sizeUp =
          (t.notional != null && next.notional != null && next.notional > t.notional * 1.15) ||
          false;

        revengeEvidence.push({
          lossTradeId: t.tradeId,
          nextTradeId: next.tradeId,
          minutesAfterLoss: mins,
          sizeUp,
        });
      }
    }

    const lossCount = losses.length || 1;
    const rate = triggers / lossCount;

    // score: 0.3 => 30, 0.8 => 80+, cap at 100
    revengeScore = clamp(0, Math.round(rate * 100), 100);
  }

  // -------- 3) Loss aversion (requires P/L)
  let lossAversionScore = 0;
  const lossAversionEvidence = [];
  let lossAversionInsufficient = false;

  if (!plOk) {
    lossAversionInsufficient = true;
  } else {
    const wins = trades.map((t) => t.pl).filter((x) => Number.isFinite(x) && x > 0);
    const losses = trades.map((t) => t.pl).filter((x) => Number.isFinite(x) && x < 0).map((x) => Math.abs(x));

    const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;

    const ratio = avgWin > 0 ? avgLoss / avgWin : (avgLoss > 0 ? 999 : 0);

    // Scoring:
    // ratio 1.0 => 0
    // ratio 1.5 => 30
    // ratio 2.0 => 60
    // ratio 3.0+ => 100
    let score = 0;
    if (ratio <= 1.05) score = 0;
    else if (ratio <= 1.5) score = 30;
    else if (ratio <= 2.0) score = 60;
    else if (ratio <= 3.0) score = 85;
    else score = 100;

    lossAversionScore = score;

    lossAversionEvidence.push({
      avgWin: Number(avgWin.toFixed(2)),
      avgLoss: Number(avgLoss.toFixed(2)),
      lossWinRatio: Number((avgWin > 0 ? avgLoss / avgWin : 0).toFixed(2)),
    });
  }

  return {
    overtrading: { score: overScore, evidence: overEvidence },
    revenge: {
      score: revengeScore,
      evidence: revengeEvidence,
      insufficientData: revengeInsufficient,
    },
    lossAversion: {
      score: lossAversionScore,
      evidence: lossAversionEvidence,
      insufficientData: lossAversionInsufficient,
    },
  };
}

// -------- Coaching
export function coachingFromBiases(biases) {
  const tips = [];

  if (biases.overtrading.score >= 60) {
    tips.push("Daily trade cap: set a hard limit (e.g., 5–10 trades/day). Require a written reason once you hit the cap.");
  } else if (biases.overtrading.score >= 30) {
    tips.push("Add friction: require a checklist before each trade to reduce impulse entries.");
  }

  if (!biases.revenge.insufficientData) {
    if (biases.revenge.score >= 60) {
      tips.push("Cooldown rule: after any loss, wait 10–20 minutes before the next trade. After 2 losses, stop for the day.");
    } else if (biases.revenge.score >= 30) {
      tips.push("After losses, reduce size on the next trade (e.g., 50%) to prevent escalation.");
    }
  } else {
    tips.push("Revenge trading needs realized P/L to measure. Upload a file that includes per-trade P/L for full detection.");
  }

  if (!biases.lossAversion.insufficientData) {
    if (biases.lossAversion.score >= 60) {
      tips.push("Define exits upfront: set a stop-loss and a profit target before entering. Avoid moving stops wider after entry.");
      tips.push("Track payoff ratio (avg win vs avg loss). Aim for avg win ≥ avg loss by enforcing disciplined exits.");
    } else if (biases.lossAversion.score >= 30) {
      tips.push("Review your winners vs losers: tighten stops or let winners run slightly longer to improve payoff ratio.");
    }
  } else {
    tips.push("Loss aversion needs realized P/L to measure. Upload a file that includes per-trade P/L for full detection.");
  }

  // Deduplicate
  return [...new Set(tips)];
}

// -------- Charts for frontend
export function chartData(trades) {
  const perDay = new Map();

  for (const t of trades) {
    const d = new Date(t.ts);
    if (Number.isNaN(d.valueOf())) continue;
    const day = d.toISOString().slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }

  const tradesPerDay = [...perDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, count]) => ({ day, count }));

  const hasPL = hasValidPL(trades);

  let cumulative = 0;
  const cumulativeSeries = trades
    .filter((t) => !Number.isNaN(new Date(t.ts).valueOf()))
    .sort((a, b) => new Date(a.ts) - new Date(b.ts))
    .map((t) => {
      const v = hasPL ? (Number(t.pl) || 0) : (Number(t.notional) || 0);
      cumulative += v;
      return { ts: new Date(t.ts).toISOString(), value: Number(cumulative.toFixed(2)) };
    });

  const timeline = trades.map((t) => ({
    ts: new Date(t.ts).toISOString(),
    value: hasPL ? (Number(t.pl) || 0) : (Number(t.notional) || 0),
    asset: t.asset,
    side: t.side,
  }));

  // Limit timeline length to keep frontend charts stable
  const MAX_POINTS = 2000;
  let timelineCapped = timeline;
  if (timeline.length > MAX_POINTS) {
    const step = Math.ceil(timeline.length / MAX_POINTS);
    timelineCapped = timeline.filter((_, idx) => idx % step === 0);
  }

  return {
    tradesPerDay,
    hasPL,
    cumulativeLabel: hasPL ? "Cumulative P/L" : "Cumulative Trade Value",
    timelineLabel: hasPL ? "Trade P/L" : "Trade Value",
    cumulativeSeries,
    timeline: timelineCapped,
  };
}
