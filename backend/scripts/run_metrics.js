const fs = require("fs");
const path = require("path");
const { computeTradingMetrics } = require("../services/metrics");

const outDir = path.join(
  __dirname,
  "..",
  "services",
  "portfolio_import",
  "data",
  "out"
);

const transactionsPath = path.join(outDir, "transactions.json");
const metricsPath = path.join(outDir, "metrics.json");

try {
  const raw = fs.readFileSync(transactionsPath, "utf-8");
  const payload = JSON.parse(raw);
  const transactions = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.transactions)
      ? payload.transactions
      : [];

  const metrics = computeTradingMetrics(transactions);

  fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2), "utf-8");
  console.log(`Wrote metrics to ${metricsPath}`);
} catch (err) {
  console.error("Failed to compute metrics:", err.message);
  process.exit(1);
}
