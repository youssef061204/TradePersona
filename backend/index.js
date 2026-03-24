import express from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.join(process.cwd(), "backend", ".env") });
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import cors from "cors";

import { getConnection } from "./snowflake.js";
import { exec } from "./exec.js";

import { parseUpload } from "./ingest.js";
import { fetchTrades, computeBiases, coachingFromBiases, chartData } from "./bias.js";
import { computeUserMetrics, normalizeMetrics } from "./metrics.js";
import {
  getInvestorVector,
  computeUserVector,
  computeUserVectorFromPortfolioMetrics,
  alignmentScore,
} from "./alignment.js";

import { coachLikeInvestor } from "./gemini_coach.js";

const require = createRequire(import.meta.url);
const { runPythonMetrics } = require("./services/metrics.cjs");
const { analyzeBias } = require("./services/gemini.cjs");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const RAW_DIR = path.join(__dirname, "uploads", "usertrades_raw");
if (!fs.existsSync(RAW_DIR)) {
  fs.mkdirSync(RAW_DIR, { recursive: true });
}

const sessionPortfolioMetrics = new Map();
const sessionTrades = new Map(); // in-memory fallback when Snowflake is unavailable
let lastUserTradesResult = null;

function normalizeTrades(trades) {
  return trades
    .map((t) => {
      const ts = new Date(t.ts);
      if (Number.isNaN(ts.valueOf())) return null;
      return {
        ...t,
        ts,
        side: t.side ? String(t.side).toUpperCase() : null,
        asset: t.asset ? String(t.asset).toUpperCase() : null,
        qty: t.qty == null || t.qty === "" ? null : Number(t.qty),
        notional: t.notional == null || t.notional === "" ? null : Number(t.notional),
        pl: t.pl == null || t.pl === "" ? null : Number(t.pl),
        entryPrice:
          t.entryPrice == null || t.entryPrice === "" ? null : Number(t.entryPrice),
      };
    })
    .filter(Boolean);
}

async function getTradesForSession(sessionId) {
  let trades = [];
  let conn = null;

  try {
    conn = await getConnection();
    trades = await fetchTrades(conn, sessionId);
  } catch (err) {
    console.warn("Snowflake fetch failed; using fallback if available:", err?.message || err);
  } finally {
    if (conn) conn.destroy();
  }

  if ((!trades || trades.length === 0) && sessionTrades.has(sessionId)) {
    trades = sessionTrades.get(sessionId);
  }

  return trades;
}

function csvCell(value) {
  if (value === null || value === undefined || value === "") return "";
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildNormalizedTradesCsv(trades) {
  const header = "timestamp,side,asset,quantity,entry_price,profit_loss";
  const rows = trades.map((t) => {
    const tsValue = t.ts instanceof Date ? t.ts.toISOString() : t.ts;
    const qty = t.qty == null || t.qty === "" ? null : Number(t.qty);
    const notional = t.notional == null || t.notional === "" ? null : Number(t.notional);
    const entryPrice =
      t.entryPrice != null && t.entryPrice !== "" && Number.isFinite(Number(t.entryPrice))
        ? Number(t.entryPrice)
        : Number.isFinite(qty) && qty !== 0 && Number.isFinite(notional)
          ? Math.abs(notional) / Math.abs(qty)
          : null;

    return [
      tsValue,
      t.side,
      t.asset,
      qty,
      entryPrice,
      t.pl,
    ].map(csvCell).join(",");
  });

  return [header, ...rows].join("\n");
}

async function writeNormalizedCsvFile(trades, destPath) {
  const stream = fs.createWriteStream(destPath);
  stream.write("timestamp,side,asset,quantity,entry_price,profit_loss\n");

  for (const t of trades) {
    const tsValue = t.ts instanceof Date ? t.ts.toISOString() : t.ts;
    const qty = t.qty == null || t.qty === "" ? null : Number(t.qty);
    const notional = t.notional == null || t.notional === "" ? null : Number(t.notional);
    const entryPrice =
      t.entryPrice != null && t.entryPrice !== "" && Number.isFinite(Number(t.entryPrice))
        ? Number(t.entryPrice)
        : Number.isFinite(qty) && qty !== 0 && Number.isFinite(notional)
          ? Math.abs(notional) / Math.abs(qty)
          : null;

    const row = [
      tsValue,
      t.side,
      t.asset,
      qty,
      entryPrice,
      t.pl,
    ]
      .map(csvCell)
      .join(",") + "\n";

    if (!stream.write(row)) {
      await new Promise((resolve) => stream.once("drain", resolve));
    }
  }

  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
    stream.end();
  });
}

function dateRangeFromTrades(trades) {
  let minTs = null;
  let maxTs = null;
  for (const t of trades) {
    const ts = t.ts instanceof Date ? t.ts : new Date(t.ts);
    if (Number.isNaN(ts.valueOf())) continue;
    if (!minTs || ts < minTs) minTs = ts;
    if (!maxTs || ts > maxTs) maxTs = ts;
  }
  return { minTs, maxTs };
}

function computeRevengeFallback(trades) {
  if (!trades || !trades.length) return { martingale_stats: {}, tilt_indicator_pct: 0 };

  // derive entryPrice if missing
  const withValues = trades.map((t) => {
    const qty = t.qty == null ? null : Number(t.qty);
    const notional = t.notional == null ? null : Number(t.notional);
    const entry =
      t.entryPrice != null && t.entryPrice !== "" && Number.isFinite(Number(t.entryPrice))
        ? Number(t.entryPrice)
        : Number.isFinite(qty) && qty !== 0 && Number.isFinite(notional)
          ? Math.abs(notional) / Math.abs(qty)
          : null;
    return { ...t, qty, notional, entryPrice: entry, plNum: t.pl == null ? null : Number(t.pl) };
  });

  const tradeValues = withValues.map((t) =>
    Number.isFinite(t.entryPrice) && Number.isFinite(t.qty) ? t.entryPrice * t.qty : 0
  );
  const overallMean =
    tradeValues.length && tradeValues.some((v) => Number.isFinite(v) && v !== 0)
      ? tradeValues.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) / tradeValues.length
      : 0;

  // build streaks
  const isLoss = withValues.map((t) => Number.isFinite(t.plNum) && t.plNum < 0);
  let streakId = 0;
  const prevLossStreak = [];
  for (let i = 0; i < isLoss.length; i++) {
    if (i === 0) {
      streakId = isLoss[i] ? 1 : 0;
      prevLossStreak.push(0);
      continue;
    }
    if (isLoss[i - 1] === isLoss[i]) {
      streakId = isLoss[i] ? streakId + 1 : 0;
    } else {
      streakId = isLoss[i] ? 1 : 0;
    }
    prevLossStreak.push(isLoss[i - 1] ? streakId : 0);
  }

  const buckets = new Map();
  withValues.forEach((t, idx) => {
    const streak = prevLossStreak[idx] || 0;
    const val = tradeValues[idx] || 0;
    if (!buckets.has(streak)) buckets.set(streak, []);
    buckets.get(streak).push(val);
  });

  const martingale_stats = {};
  for (const [k, arr] of buckets.entries()) {
    const clean = arr.filter((v) => Number.isFinite(v));
    martingale_stats[k] = clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : 0;
  }

  const base = overallMean || martingale_stats[0] || 0;
  let tilt_indicator_pct = 0;
  if (base && martingale_stats[6]) {
    const ratio = martingale_stats[6] / base;
    if (Number.isFinite(ratio) && ratio > 0) {
      const sigmoid = 1 / (1 + Math.exp(-5 * Math.log(ratio)));
      tilt_indicator_pct = Math.round(sigmoid * 10000) / 100;
    }
  }

  return { martingale_stats, tilt_indicator_pct };
}

function ensureRevenge(metrics, trades) {
  const revenge = metrics?.behavioral?.revenge_trading;
  const hasSignal =
    revenge &&
    revenge.martingale_stats &&
    Object.values(revenge.martingale_stats).some((v) => Number.isFinite(Number(v)) && Number(v) !== 0) &&
    Number.isFinite(revenge.tilt_indicator_pct) &&
    revenge.tilt_indicator_pct !== 0;

  if (hasSignal) return metrics;

  const fallback = computeRevengeFallback(trades);
  return {
    ...(metrics || {}),
    behavioral: {
      ...(metrics?.behavioral || {}),
      revenge_trading: fallback,
    },
  };
}

async function persistSessionToSnowflake({
  sessionId,
  userId,
  trades,
  metrics = null,
  dateRange = null,
  maxInsert = 5000,
  source = "simple_upload",
}) {
  if (!trades || trades.length === 0) return;

  const dr = dateRange ?? dateRangeFromTrades(trades);
  const dateStart = dr.minTs ? dr.minTs.toISOString().slice(0, 10) : null;
  const dateEnd = dr.maxTs ? dr.maxTs.toISOString().slice(0, 10) : null;

  const conn = await getConnection();

  // Ensure user exists
  await exec(
    conn,
    `MERGE INTO CORE.USERS t
     USING (SELECT ? AS USER_ID) s
     ON t.USER_ID = s.USER_ID
     WHEN NOT MATCHED THEN INSERT (USER_ID) VALUES (s.USER_ID)`,
    [userId]
  );

  await exec(
    conn,
    `INSERT INTO CORE.SESSIONS (SESSION_ID, USER_ID, SOURCE, NUM_TRADES, DATE_START, DATE_END)
    VALUES (?, ?, ?, ?, ?, ?)`,
    [sessionId, userId, source, trades.length, dateStart, dateEnd]
  );

  // Limit insert size to avoid giant VALUES payload blocking the event loop
  const batch = trades.slice(0, Math.min(maxInsert, trades.length));
  if (batch.length) {
    const values = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const binds = batch.flatMap((t) => [
      sessionId,
      String(t.tradeId),
      t.ts,
      t.side,
      t.asset,
      t.qty == null || t.qty === "" ? null : t.qty,
      t.notional == null || t.notional === "" ? null : t.notional,
      t.pl == null || t.pl === "" ? null : t.pl,
    ]);

    await exec(
      conn,
      `INSERT INTO CORE.TRADES (SESSION_ID, TRADE_ID, TS, SIDE, ASSET, QTY, NOTIONAL, PL)
       SELECT * FROM VALUES ${values}`,
      binds
    );
  }

  conn.destroy();

  if (metrics?.portfolio_metrics) {
    sessionPortfolioMetrics.set(sessionId, metrics.portfolio_metrics);
  }
}

async function computePortfolioMetricsForSession(sessionId, trades) {
  if (sessionPortfolioMetrics.has(sessionId)) {
    return sessionPortfolioMetrics.get(sessionId);
  }
  if (!trades || !trades.length) return null;

  const normalizedCsv = buildNormalizedTradesCsv(trades);
  const csvPath = path.join(RAW_DIR, `${sessionId}-normalized.csv`);
  await fs.promises.writeFile(csvPath, normalizedCsv);

  const pyResult = await runPythonMetrics(csvPath);
  const portfolioMetrics = pyResult?.portfolio_metrics || null;
  if (portfolioMetrics) {
    sessionPortfolioMetrics.set(sessionId, portfolioMetrics);
  }
  return portfolioMetrics;
}

app.get("/", (req, res) => {
  res.json({ message: "Backend is running" });
});

app.post("/api/analyze", async (req, res) => {
  const metrics = req.body?.metrics || lastUserTradesResult?.metrics;

  if (!metrics) {
    return res.status(400).json({
      error: "Invalid payload. Provide metrics or upload a CSV first.",
    });
  }

  try {
    const result = await analyzeBias(metrics);
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to analyze bias.",
      details: error?.message || "Unknown error",
    });
  }
});

app.get("/health", async (req, res) => {
  try {
    const conn = await getConnection();
    const rows = await exec(conn, "SELECT CURRENT_VERSION() AS VERSION");
    conn.destroy();
    res.json({ ok: true, snowflakeVersion: rows[0].VERSION });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/uploads/usertrades", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const original = req.file.originalname || "upload.csv";
  if (!original.toLowerCase().endsWith(".csv")) {
    return res.status(400).json({ error: "Only CSV files allowed" });
  }

  try {
    const safeName = `${Date.now()}-${path.basename(original)}`;
    const rawPath = path.join(RAW_DIR, safeName);
    await fs.promises.writeFile(rawPath, req.file.buffer);

    // Create session ID for this upload
    const sessionId = uuidv4();
    const userId = "demo-user";

    let metrics = null;
    const normalizedPath = path.join(RAW_DIR, `${sessionId}-normalized.csv`);

    // Parse trades, normalize, and run metrics (critical path)
    let normalized = [];
    let dateRange = null;
    try {
      const parsed = await parseUpload(req.file.buffer, { normalizedPath });
      normalized = parsed.normalized ? parsed.trades : normalizeTrades(parsed.trades);
      dateRange = parsed.dateRange;

      if (!parsed.normalized) {
        await writeNormalizedCsvFile(normalized, normalizedPath);
      }

      if (normalized.length) {
        sessionTrades.set(sessionId, normalized);
      }

      metrics = await runPythonMetrics(normalizedPath);
      metrics = ensureRevenge(metrics, normalized);
      metrics = ensureRevenge(metrics, normalized);
      if (metrics?.portfolio_metrics) {
        sessionPortfolioMetrics.set(sessionId, metrics.portfolio_metrics);
      }
    } catch (err) {
      console.error("Upload parsing/metrics failed:", err);
      return res.status(400).json({ error: "Normalization failed", message: err?.message || String(err) });
    }

    // Kick off Snowflake persistence without blocking user response
    persistSessionToSnowflake({
      sessionId,
      userId,
      trades: normalized,
      metrics,
      dateRange,
    }).catch((err) => console.warn("Failed to create session for simple upload:", err?.message || err));

    lastUserTradesResult = {
      ok: true,
      filename: safeName,
      sessionId,
      metrics,
      normalizedPath,
    };

    return res.json(lastUserTradesResult);
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Normalization failed",
      message: err.message,
    });
  }
});

app.get("/api/uploads/usertrades", (req, res) => {
  if (!lastUserTradesResult) {
    return res.status(404).json({
      error: "No user trades have been uploaded yet",
    });
  }

  const maybeRefresh = async () => {
    const ensurePath = async () => {
      if (lastUserTradesResult?.normalizedPath && fs.existsSync(lastUserTradesResult.normalizedPath)) {
        return lastUserTradesResult.normalizedPath;
      }
      if (lastUserTradesResult?.sessionId && sessionTrades.has(lastUserTradesResult.sessionId)) {
        const tmpPath = path.join(RAW_DIR, `${lastUserTradesResult.sessionId}-recalc.csv`);
        const trades = sessionTrades.get(lastUserTradesResult.sessionId);
        await writeNormalizedCsvFile(trades, tmpPath);
        lastUserTradesResult.normalizedPath = tmpPath;
        return tmpPath;
      }
      return null;
    };

    const normalizedPath = await ensurePath();
    if (!normalizedPath) return lastUserTradesResult;
    const revenge = lastUserTradesResult?.metrics?.behavioral?.revenge_trading;
    const needsRefresh =
      !revenge ||
      !revenge.martingale_stats ||
      Object.values(revenge.martingale_stats).every((v) => Number(v) === 0) ||
      (revenge.tilt_indicator_pct ?? 0) === 0;
    if (!needsRefresh) return lastUserTradesResult;

    try {
      const refreshed = await runPythonMetrics(normalizedPath);
      const trades = sessionTrades.get(lastUserTradesResult.sessionId);
      lastUserTradesResult.metrics = ensureRevenge(refreshed, trades);
    } catch (err) {
      console.warn("Failed to refresh metrics for last upload:", err?.message || err);
      // JS fallback so UI still gets revenge stats
      if (lastUserTradesResult.sessionId && sessionTrades.has(lastUserTradesResult.sessionId)) {
        const trades = sessionTrades.get(lastUserTradesResult.sessionId);
        const revengeFallback = computeRevengeFallback(trades);
        lastUserTradesResult.metrics = {
          ...(lastUserTradesResult.metrics || {}),
          behavioral: {
            ...(lastUserTradesResult.metrics?.behavioral || {}),
            revenge_trading: revengeFallback,
          },
        };
      }
    }
    return lastUserTradesResult;
  };

  maybeRefresh().then((payload) => res.json(payload));
});

/**
 * POST /upload
 * form-data:
 *  - file: CSV or JSON file
 *  - userId: optional string
 */
app.post("/upload", upload.single("file"), async (req, res) => {
  const userId = (req.body.userId || "demo-user").toString();

  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "Missing file field 'file'" });

    const sessionId = uuidv4();
    const normalizedPath = path.join(RAW_DIR, `${sessionId}-normalized.csv`);

    const parsed = await parseUpload(req.file.buffer, { normalizedPath });
    const mode = parsed.mode;
    const normalized = parsed.normalized ? parsed.trades : normalizeTrades(parsed.trades);
    if (!parsed.normalized) {
      await writeNormalizedCsvFile(normalized, normalizedPath);
    }
    if (normalized.length) sessionTrades.set(sessionId, normalized);

    // Compute portfolio metrics via bias_engine.py for this upload
    let portfolioMetrics = null;
    let metricsFull = null;
    try {
      const rawName = `${sessionId}-${path.basename(req.file.originalname || "upload.csv")}`;
      const rawPath = path.join(RAW_DIR, rawName);
      await fs.promises.writeFile(rawPath, req.file.buffer);

      const pyResult = await runPythonMetrics(normalizedPath);
      metricsFull = pyResult;
      portfolioMetrics = pyResult?.portfolio_metrics || null;
      if (portfolioMetrics) {
        sessionPortfolioMetrics.set(sessionId, portfolioMetrics);
      }
    } catch (err) {
      console.warn("Failed to compute portfolio metrics from upload:", err?.message || err);
    }

    if (!portfolioMetrics) {
      try {
        portfolioMetrics = await computePortfolioMetricsForSession(sessionId, normalized);
      } catch (err) {
        console.warn("Failed to compute portfolio metrics from normalized trades:", err?.message || err);
      }
    }

    // Session date range
    const dr = parsed.dateRange ?? dateRangeFromTrades(normalized);
    const dateStart = dr.minTs ? dr.minTs.toISOString().slice(0, 10) : null;
    const dateEnd = dr.maxTs ? dr.maxTs.toISOString().slice(0, 10) : null;

    await persistSessionToSnowflake({
      sessionId,
      userId,
      trades: normalized,
      metrics: portfolioMetrics ? { portfolio_metrics: portfolioMetrics } : null,
      dateRange: dr,
      source: `upload_${mode}`,
      maxInsert: 10000,
    });

    lastUserTradesResult = {
      ok: true,
      filename: path.basename(req.file.originalname || "upload.csv"),
      sessionId,
      metrics: metricsFull,
      normalizedPath,
    };

    res.json({
      ok: true,
      sessionId,
      tradesInserted: normalized.length,
      dateStart,
      dateEnd,
      mode,
      portfolioMetrics,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/analyze/:sessionId", async (req, res) => {
  const { sessionId } = req.params;

  try {
    const trades = await getTradesForSession(sessionId);
    if (!trades || trades.length === 0) {
      return res.status(404).json({ ok: false, error: "No trades found for this session" });
    }

    const biases = computeBiases(trades);

    // metrics per your diagram
    const userMetrics = computeUserMetrics(trades);
    const normalizedMetrics = normalizeMetrics(userMetrics);

    // charts for UI
    const charts = chartData(trades);

    // store bias metrics (scores + raw JSON) if Snowflake is reachable
    try {
      const conn = await getConnection();
      await exec(
        conn,
        `MERGE INTO ANALYTICS.USER_BIAS_METRICS t
         USING (SELECT ? AS SESSION_ID) s
         ON t.SESSION_ID = s.SESSION_ID
         WHEN MATCHED THEN UPDATE SET
           OVERTRADING_SCORE = ?,
           REVENGE_SCORE = ?,
           LOSS_AVERSION_SCORE = ?,
           BIAS_SUMMARY_JSON = ?,
           COMPUTED_AT = CURRENT_TIMESTAMP()
         WHEN NOT MATCHED THEN INSERT
           (SESSION_ID, OVERTRADING_SCORE, REVENGE_SCORE, LOSS_AVERSION_SCORE, BIAS_SUMMARY_JSON)
           VALUES (?, ?, ?, ?, ?)`,
        [
          sessionId,
          biases.overtrading.score,
          biases.revenge.score,
          biases.lossAversion.score,
          JSON.stringify(biases),
          sessionId,
          biases.overtrading.score,
          biases.revenge.score,
          biases.lossAversion.score,
          JSON.stringify(biases),
        ]
      );
      conn.destroy();
    } catch (err) {
      console.warn("Skipping Snowflake bias upsert:", err?.message || err);
    }

    const mode =
      trades.filter((t) => t.pl != null && t.pl !== "").length >= Math.max(2, Math.floor(trades.length * 0.3))
        ? "full"
        : "basic";

    res.json({
      ok: true,
      sessionId,
      mode,
      tradeCount: trades.length,
      biases,
      coaching: coachingFromBiases(biases),
      userMetrics,
      normalizedMetrics,
      charts,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/investors", async (req, res) => {
  try {
    const conn = await getConnection();
    const rows = await exec(conn, "SELECT * FROM CORE.INVESTORS ORDER BY DISPLAY_NAME");
    conn.destroy();
    res.json({ ok: true, investors: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/investors/:investorId/metrics", async (req, res) => {
  const { investorId } = req.params;

  try {
    const conn = await getConnection({ database: "TRADE_SHIELD", schema: "CORE" });

    const rows = await exec(
      conn,
      `SELECT REPORT_PERIOD, HOLDINGS_COUNT, TOTAL_VALUE_USD_THOUSANDS,
              TOP10_CONCENTRATION, TURNOVER_PROXY, CONSISTENCY_PROXY,
              VECTOR_JSON
       FROM TRADE_SHIELD.ANALYTICS.INVESTOR_QUARTER_METRICS
       WHERE INVESTOR_ID = ?
       ORDER BY REPORT_PERIOD DESC
       LIMIT 12`,
      [investorId]
    );

    res.json({ ok: true, investorId, quarters: rows });
    conn.destroy();
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/investors/:investorId/holdings/latest", async (req, res) => {
  const { investorId } = req.params;
  const limit = Number(req.query.limit || 20);

  try {
    const conn = await getConnection({ database: "TRADE_SHIELD", schema: "CORE" });

    const rpRows = await exec(
      conn,
      `SELECT MAX(REPORT_PERIOD) AS RP
       FROM TRADE_SHIELD.ANALYTICS.INVESTOR_13F_HOLDINGS
       WHERE INVESTOR_ID = ?`,
      [investorId]
    );
    const rp = rpRows?.[0]?.RP ? String(rpRows[0].RP).slice(0, 10) : null;
    if (!rp) return res.status(404).json({ ok: false, error: "No holdings found" });

    const rows = await exec(
      conn,
      `SELECT ISSUER, TITLE_OF_CLASS, CUSIP, VALUE_USD_THOUSANDS, SHARES
       FROM TRADE_SHIELD.ANALYTICS.INVESTOR_13F_HOLDINGS
       WHERE INVESTOR_ID = ? AND REPORT_PERIOD = ?
       ORDER BY VALUE_USD_THOUSANDS DESC
       LIMIT ${Math.min(limit, 100)}`,
      [investorId, rp]
    );

    res.json({ ok: true, investorId, reportPeriod: rp, holdings: rows });
    conn.destroy();
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/compare/:sessionId/:investorId", async (req, res) => {
  const { sessionId, investorId } = req.params;

  try {
    const conn = await getConnection();

    const trades = await getTradesForSession(sessionId);
    if (!trades || trades.length === 0) {
      return res.status(404).json({ ok: false, error: "No trades found for this session" });
    }
    const biases = computeBiases(trades);

    const investorVecRaw = await getInvestorVector(conn, investorId);
    const investorVector = typeof investorVecRaw === "string" ? JSON.parse(investorVecRaw) : investorVecRaw;

    let portfolioMetrics = sessionPortfolioMetrics.get(sessionId) || null;
    if (!portfolioMetrics) {
      try {
        portfolioMetrics = await computePortfolioMetricsForSession(sessionId, trades);
      } catch (err) {
        console.warn("Failed to compute portfolio metrics for compare:", err?.message || err);
      }
    }
    const userVector =
      computeUserVectorFromPortfolioMetrics(portfolioMetrics) || computeUserVector(trades, biases);
    const alignment = alignmentScore(userVector, investorVector);

    conn.destroy();

    res.json({
      ok: true,
      sessionId,
      investorId,
      alignment,
      userVector,
      investorVector,
      portfolioMetrics,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * NEW:
 * GET /coach/:sessionId/:investorId
 *
 * Computes comparison for chosen investor, then sends payload to Gemini
 * so Gemini returns "how to be more like X investor".
 */
app.get("/coach/:sessionId/:investorId", async (req, res) => {
  const { sessionId, investorId } = req.params;
  const includeHoldings = String(req.query.holdings || "0") === "1";

  try {
    const conn = await getConnection();

    // --- user side ---
    const trades = await getTradesForSession(sessionId);
    if (!trades || trades.length === 0) {
      return res.status(404).json({ ok: false, error: "No trades found for this session" });
    }
    const biases = computeBiases(trades);
    const userMetrics = computeUserMetrics(trades);
    const normalizedMetrics = normalizeMetrics(userMetrics);

    let portfolioMetrics = sessionPortfolioMetrics.get(sessionId) || null;
    if (!portfolioMetrics) {
      try {
        portfolioMetrics = await computePortfolioMetricsForSession(sessionId, trades);
      } catch (err) {
        console.warn("Failed to compute portfolio metrics for coach:", err?.message || err);
      }
    }
    const userVector =
      computeUserVectorFromPortfolioMetrics(portfolioMetrics) || computeUserVector(trades, biases);

    // --- investor side ---
    const invRows = await exec(conn, `SELECT * FROM CORE.INVESTORS WHERE INVESTOR_ID = ? LIMIT 1`, [investorId]);
    const investorMeta = invRows?.[0] || { INVESTOR_ID: investorId };

    const investorVecRaw = await getInvestorVector(conn, investorId);
    const investorVector = typeof investorVecRaw === "string" ? JSON.parse(investorVecRaw) : investorVecRaw;

    const alignment = alignmentScore(userVector, investorVector);

    // optional: pull latest quarter metrics as extra context (cheap)
    const qRows = await exec(
      conn,
      `SELECT REPORT_PERIOD, HOLDINGS_COUNT, TOTAL_VALUE_USD_THOUSANDS,
              TOP10_CONCENTRATION, TURNOVER_PROXY, CONSISTENCY_PROXY
       FROM TRADE_SHIELD.ANALYTICS.INVESTOR_QUARTER_METRICS
       WHERE INVESTOR_ID = ?
       ORDER BY REPORT_PERIOD DESC
       LIMIT 1`,
      [investorId]
    );
    const latestQuarter = qRows?.[0] || null;

    // optional: pull top holdings (more tokens, so off by default)
    let holdings = null;
    if (includeHoldings) {
      const rpRows = await exec(
        conn,
        `SELECT MAX(REPORT_PERIOD) AS RP
         FROM TRADE_SHIELD.ANALYTICS.INVESTOR_13F_HOLDINGS
         WHERE INVESTOR_ID = ?`,
        [investorId]
      );
      const rp = rpRows?.[0]?.RP ? String(rpRows[0].RP).slice(0, 10) : null;

      if (rp) {
        holdings = await exec(
          conn,
          `SELECT ISSUER, TITLE_OF_CLASS, CUSIP, VALUE_USD_THOUSANDS, SHARES
           FROM TRADE_SHIELD.ANALYTICS.INVESTOR_13F_HOLDINGS
           WHERE INVESTOR_ID = ? AND REPORT_PERIOD = ?
           ORDER BY VALUE_USD_THOUSANDS DESC
           LIMIT 15`,
          [investorId, rp]
        );
      } else {
        holdings = [];
      }
    }

    // --- payload to Gemini ---
    const payload = {
      sessionId,
      investor: {
        investorId: investorMeta.INVESTOR_ID || investorId,
        displayName: investorMeta.DISPLAY_NAME || investorMeta.DISPLAY || null,
        category: investorMeta.CATEGORY || null,
        source: investorMeta.SOURCE || null,
      },
      user: {
        userVector,
        userMetrics,
        normalizedMetrics,
        biases, // includes evidence & scores already
        portfolioMetrics,
      },
      target: {
        investorVector,
        latestQuarter,
        holdings,
      },
      alignment, // score + gaps
      constraints: {
        focusTraits: ["trade_frequency", "holding_patience", "risk_reactivity", "consistency"],
        goal: "Make the user trade more like the target investor, by reducing mismatches in the vector while addressing detected biases.",
      },
    };

    const coaching = await coachLikeInvestor(payload);

    conn.destroy();

    res.json({
      ok: true,
      sessionId,
      investorId,
      comparison: {
        investor: payload.investor,
        alignment,
        userVector,
        investorVector,
      },
      coaching,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
