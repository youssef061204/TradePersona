import { exec } from "./exec.js";

export async function getInvestorVector(conn, investorId) {
  const rows = await exec(
    conn,
    `SELECT VECTOR_JSON FROM ANALYTICS.INVESTOR_STYLE_VECTORS WHERE INVESTOR_ID = ?`,
    [investorId]
  );
  if (!rows.length) throw new Error("Investor vector not found");
  return rows[0].VECTOR_JSON; // driver returns object/variant-ish
}

export function computeUserVector(trades, biases) {
  // Normalize into 0..1 traits that roughly map to investor vectors
  // trade_frequency: higher trades/day => closer to 1
  const perDay = new Map();
  for (const t of trades) {
    const day = t.ts.toISOString().slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const counts = [...perDay.values()];
  const avgTradesPerDay = counts.length ? counts.reduce((a,b)=>a+b,0) / counts.length : trades.length;

  // compress: 0 trades/day => 0, 20+ => ~1
  const trade_frequency = Math.max(0, Math.min(1, avgTradesPerDay / 20));

  // holding_patience: we don’t have true hold time, so proxy with low overtrading + low revenge
  const holding_patience = Math.max(0, Math.min(1, 1 - (biases.overtrading.score / 100) * 0.6 - (biases.revenge.score / 100) * 0.4));

  // risk_reactivity: proxy mainly from revenge score
  const risk_reactivity = Math.max(0, Math.min(1, biases.revenge.score / 100));

  // consistency: proxy inversely related to overtrading variance across days
  let consistency = 0.7;
  if (counts.length >= 2) {
    const mean = avgTradesPerDay;
    const varr = counts.reduce((s,c)=>s + (c-mean)*(c-mean),0) / counts.length;
    const stdev = Math.sqrt(varr);
    // stdev 0 => 1, stdev 10 => ~0
    consistency = Math.max(0, Math.min(1, 1 - stdev / 10));
  }

  return { trade_frequency, holding_patience, risk_reactivity, consistency };
}

export function computeUserVectorFromPortfolioMetrics(portfolioMetrics) {
  if (!portfolioMetrics) return null;

  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const to01 = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return clamp01(n / 100);
  };

  return {
    trade_frequency: to01(portfolioMetrics.trade_frequency_score),
    holding_patience: to01(portfolioMetrics.holding_patience_score),
    risk_reactivity: to01(portfolioMetrics.risk_reactivity_score),
    consistency: to01(portfolioMetrics.consistency_score),
  };
}

export function alignmentScore(userVec, investorVec) {
  // investorVec may come in as stringified JSON depending on driver; normalize
  const iv = typeof investorVec === "string" ? JSON.parse(investorVec) : investorVec;

  const keys = ["trade_frequency", "holding_patience", "risk_reactivity", "consistency"];
  let sumSq = 0;
  for (const k of keys) {
    const a = Number(userVec[k] ?? 0);
    const b = Number(iv[k] ?? 0);
    sumSq += (a - b) * (a - b);
  }
  const dist = Math.sqrt(sumSq / keys.length);     // 0..1-ish
  const score = Math.round((1 - Math.min(1, dist)) * 100); // 0..100
  return {
    score,
    gaps: keys.map((k) => {
      const user = Number(userVec[k] ?? 0);
      const target = Number(iv[k] ?? 0);
      const diff = user - target;
      const direction =
        diff > 0.08 ? "higher" : diff < -0.08 ? "lower" : "close to";
      return {
        k,
        dimension: k,
        user,
        target,
        diff,
        description:
          direction === "close to"
            ? "Your behavior is already close to this investor on this dimension."
            : `Your ${k.replace(/_/g, " ")} is ${direction} than the target investor profile.`,
      };
    }),
  };
}
