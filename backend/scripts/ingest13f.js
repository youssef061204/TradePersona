/**
 * ingest13f.js
 *
 * Pulls recent 13F filings from SEC for a small set of investors (CIKs),
 * ingests filings + holdings into Snowflake, computes quarter metrics,
 * and writes a "style vector" per investor for your compare endpoint.
 *
 * This version is "code-stable":
 * - No top-level use of `conn` (fixes ReferenceError)
 * - No `INFO_TABLE_XML` column usage (your Snowflake table doesn't have it)
 * - VALUES placeholder counts match COLUMNn references (fixes COLUMN8/COLUMN14 errors)
 * - Better Snowflake error logging prints SQL + binds + queryId
 */

import "dotenv/config";
import snowflake from "snowflake-sdk";
import { XMLParser } from "fast-xml-parser";

// ----------------------------
// Config
// ----------------------------
const SEC_UA =
  process.env.SEC_USER_AGENT ||
  "QHacksBiasDetector/1.0 (contact: you@example.com)";

const INGEST_LIMIT = Number(process.env.INGEST_13F_LIMIT || 8);

// Snowflake locations
const DB = "TRADE_SHIELD";
const CORE_SCHEMA = "CORE";
const ANALYTICS_SCHEMA = "ANALYTICS";

// Tables
const T_FILINGS = `${DB}.${ANALYTICS_SCHEMA}.INVESTOR_13F_FILINGS`;
const T_HOLDINGS = `${DB}.${ANALYTICS_SCHEMA}.INVESTOR_13F_HOLDINGS`;
const T_QMETRICS = `${DB}.${ANALYTICS_SCHEMA}.INVESTOR_QUARTER_METRICS`;
const T_VECTORS = `${DB}.${ANALYTICS_SCHEMA}.INVESTOR_STYLE_VECTORS`;

// Investors
const INVESTORS = [
  { investorId: "buffett_berkshire", display: "Warren Buffett (Berkshire)", cik10: "0001067983" },
  { investorId: "cathie_ark", display: "Cathie Wood (ARK)", cik10: "0001697748" },
  { investorId: "burry_scion", display: "Michael Burry (Scion)", cik10: "0001649339" },
];

// XML parser
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  allowBooleanAttributes: true,
  parseTagValue: true,
  trimValues: true,
});

// ----------------------------
// Utilities
// ----------------------------
function cikNoLeadingZeros(cik10) {
  return String(cik10).replace(/^0+/, "") || "0";
}

function accessionNoDashes(accession) {
  return String(accession).replace(/-/g, "");
}

/**
 * Normalize date to 'YYYY-MM-DD' OR null.
 * Accepts Date object, YYYYMMDD, YYYY-MM-DD, and parseable strings.
 */
function toDate(v) {
  if (!v) return null;

  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }

  const s = String(v).trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }

  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);

  return null;
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function safeStr(x) {
  if (x === undefined || x === null) return null;
  const s = String(x).trim();
  return s ? s : null;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ----------------------------
// SEC fetch
// ----------------------------
async function secFetch(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": SEC_UA,
      "Accept-Encoding": "gzip, deflate, br",
      Accept: "*/*",
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(
      `SEC fetch failed ${res.status} ${res.statusText} url=${url} body=${txt.slice(0, 200)}`
    );
  }
  return res;
}

async function fetchJson(url) {
  const res = await secFetch(url);
  return res.json();
}

// ----------------------------
// Snowflake helpers
// ----------------------------
function getConnection() {
  const account = process.env.SNOWFLAKE_ACCOUNT;
  const username = process.env.SNOWFLAKE_USERNAME;
  const password = process.env.SNOWFLAKE_PASSWORD;
  const warehouse = process.env.SNOWFLAKE_WAREHOUSE;

  if (!account || !username || !password || !warehouse) {
    throw new Error(
      "Missing Snowflake env vars. Need SNOWFLAKE_ACCOUNT, SNOWFLAKE_USERNAME, SNOWFLAKE_PASSWORD, SNOWFLAKE_WAREHOUSE."
    );
  }

  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection({
      account,
      username,
      password,
      warehouse,
      database: DB,
      schema: CORE_SCHEMA,
      // Optional:
      // role: process.env.SNOWFLAKE_ROLE,
    });
    conn.connect((err, c) => (err ? reject(err) : resolve(c)));
  });
}

function exec(conn, sqlText, binds = []) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err, stmt, rows) => {
        if (err) {
          console.error("\n--- SNOWFLAKE ERROR ---");
          console.error("Message:", err.message);
          console.error("Code:", err.code, "SQLState:", err.sqlState);
          console.error("QueryId:", err.data?.queryId);
          console.error("\n--- SQL ---\n" + sqlText);
          console.error("\n--- BINDS ---\n", binds);
          return reject(err);
        }
        resolve(rows || []);
      },
    });
  });
}

// ----------------------------
// Extract SEC filings list (13F-HR and 13F-HR/A) from submissions JSON
// ----------------------------
function extract13FFilings(submissions, limit) {
  const recent = submissions?.filings?.recent;
  if (!recent) return [];

  const forms = recent.form || [];
  const accessionNumbers = recent.accessionNumber || [];
  const filingDates = recent.filingDate || [];
  const reportDates = recent.reportDate || [];
  const primaryDocuments = recent.primaryDocument || [];

  const out = [];
  for (let i = 0; i < forms.length; i++) {
    const form = String(forms[i] || "");
    if (form !== "13F-HR" && form !== "13F-HR/A") continue;

    const accession = String(accessionNumbers[i] || "");
    if (!accession) continue;

    out.push({
      form,
      accession,
      filingDate: toDate(filingDates[i]),
      reportPeriod: toDate(reportDates[i]),
      primaryDocument: String(primaryDocuments[i] || ""),
    });
  }

  // newest-first; slice then reverse later for oldest->newest processing
  return out.slice(0, limit);
}

function pickInfoTableXml(files) {
  const lower = files.map((f) => String(f).toLowerCase());
  const candidates = [];

  for (let i = 0; i < lower.length; i++) {
    const f = lower[i];
    if (!f.endsWith(".xml")) continue;

    const score =
      (f.includes("infotable") ? 100 : 0) +
      (f.includes("informationtable") ? 90 : 0) +
      (f.includes("form13f") && f.includes("table") ? 80 : 0) +
      (f.includes("13f") && f.includes("table") ? 70 : 0) +
      (f.includes("primary") ? -50 : 0);

    candidates.push({ name: files[i], score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.length ? candidates[0].name : null;
}

async function listFilingFiles(cik10, accession) {
  const cik = cikNoLeadingZeros(cik10);
  const accNo = accessionNoDashes(accession);
  const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accNo}/index.json`;
  const j = await fetchJson(url);
  const items = j?.directory?.item || [];
  return items.map((it) => it.name).filter(Boolean);
}

async function downloadXml(cik10, accession, filename) {
  const cik = cikNoLeadingZeros(cik10);
  const accNo = accessionNoDashes(accession);
  const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accNo}/${filename}`;
  const res = await secFetch(url);
  return res.text();
}

/**
 * Pull periodOfReport from the primary filing doc (more reliable than submissions reportDate)
 */
async function getReportPeriodFromPrimaryDoc(cik10, accession, primaryDocName) {
  if (!primaryDocName) return null;

  const cik = cikNoLeadingZeros(cik10);
  const accNo = accessionNoDashes(accession);
  const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accNo}/${primaryDocName}`;
  const text = await (await secFetch(url)).text();

  try {
    const p = parser.parse(text);
    const xmlDate =
      p?.edgarSubmission?.formData?.periodOfReport ??
      p?.submission?.formData?.periodOfReport ??
      p?.formData?.periodOfReport ??
      p?.periodOfReport ??
      null;

    const d = toDate(xmlDate);
    if (d) return d;
  } catch {
    // ignore
  }

  const m =
    text.match(/<periodOfReport>\s*([0-9]{8}|[0-9]{4}-[0-9]{2}-[0-9]{2})\s*<\/periodOfReport>/i) ||
    text.match(/periodOfReport[^0-9]*([0-9]{8}|[0-9]{4}-[0-9]{2}-[0-9]{2})/i);

  return m ? toDate(m[1]) : null;
}

// ----------------------------
// Parse 13F information table -> holdings rows
// ----------------------------
function normalizeInfoTableRows(xmlObj) {
  const infoTable = xmlObj?.informationTable || xmlObj?.form13FInformationTable || xmlObj;

  let rows =
    infoTable?.infoTable ??
    infoTable?.informationTable?.infoTable ??
    infoTable?.form13FInformationTable?.infoTable ??
    null;

  if (!rows) return [];
  if (!Array.isArray(rows)) rows = [rows];

  return rows.map((r) => {
    const issuer = r?.nameOfIssuer ?? r?.issuerName ?? r?.issuer ?? null;
    const titleOfClass = r?.titleOfClass ?? r?.classTitle ?? null;
    const cusip = r?.cusip ?? r?.CUSIP ?? null;

    const value = r?.value ?? r?.valueX1000 ?? null;

    const shrsAmt = r?.shrsOrPrnAmt?.sshPrnamt ?? r?.sshPrnamt ?? null;
    const shrsType = r?.shrsOrPrnAmt?.sshPrnamtType ?? r?.sshPrnamtType ?? null;

    const putCall = r?.putCall ?? null;
    const discretion = r?.investmentDiscretion ?? r?.invDiscretion ?? null;

    const voteSole = r?.votingAuthority?.Sole ?? r?.votingAuthority?.sole ?? null;
    const voteShared = r?.votingAuthority?.Shared ?? r?.votingAuthority?.shared ?? null;
    const voteNone = r?.votingAuthority?.None ?? r?.votingAuthority?.none ?? null;

    const nValue = value !== null && value !== undefined ? Number(String(value).replace(/,/g, "")) : null;
    const nShares = shrsAmt !== null && shrsAmt !== undefined ? Number(String(shrsAmt).replace(/,/g, "")) : null;

    const nVoteSole = voteSole !== null && voteSole !== undefined ? Number(String(voteSole).replace(/,/g, "")) : null;
    const nVoteShared = voteShared !== null && voteShared !== undefined ? Number(String(voteShared).replace(/,/g, "")) : null;
    const nVoteNone = voteNone !== null && voteNone !== undefined ? Number(String(voteNone).replace(/,/g, "")) : null;

    return {
      cusip: safeStr(cusip),
      issuer: safeStr(issuer),
      titleOfClass: safeStr(titleOfClass),
      value: Number.isFinite(nValue) ? Math.round(nValue) : null,
      shares: Number.isFinite(nShares) ? Math.round(nShares) : null,
      sharesType: safeStr(shrsType),
      putCall: safeStr(putCall),
      discretion: safeStr(discretion),
      voteSole: Number.isFinite(nVoteSole) ? Math.round(nVoteSole) : null,
      voteShared: Number.isFinite(nVoteShared) ? Math.round(nVoteShared) : null,
      voteNone: Number.isFinite(nVoteNone) ? Math.round(nVoteNone) : null,
    };
  });
}

async function parseHoldingsFromInfoTableXml(xmlText) {
  const obj = parser.parse(xmlText);
  const rows = normalizeInfoTableRows(obj);

  // Filter out junk
  return rows.filter((h) => {
    const hasId = !!h.cusip || !!h.issuer;
    const hasValue = h.value !== null;
    return hasId && hasValue;
  });
}

// ----------------------------
// Snowflake write: filings
// ----------------------------
async function upsertFiling(conn, row) {
  await exec(
    conn,
    `DELETE FROM ${T_FILINGS} WHERE INVESTOR_ID = ? AND ACCESSION = ?`,
    [row.investorId, row.accession]
  );

  await exec(
    conn,
    `INSERT INTO ${T_FILINGS}
     (INVESTOR_ID, CIK, ACCESSION, FORM_TYPE, FILING_DATE, REPORT_PERIOD, INDEX_JSON_URL, INFO_TABLE_URL)
     SELECT
      COLUMN1::STRING,
      COLUMN2::STRING,
      COLUMN3::STRING,
      COLUMN4::STRING,
      TO_DATE(COLUMN5::STRING, 'YYYY-MM-DD'),
      TO_DATE(COLUMN6::STRING, 'YYYY-MM-DD'),
      COLUMN7::STRING,
      COLUMN8::STRING
     FROM VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.investorId,
      row.cik10,          // keep as 10-digit string (with leading zeros)
      row.accession,
      row.formType,
      row.filingDate,
      row.reportPeriod,
      row.indexJsonUrl,
      row.infoTableUrl,
    ]
  );
}

// ----------------------------
// Snowflake write: holdings
// ----------------------------
async function insertHoldings(conn, investorId, accession, reportPeriod, holdings) {
  if (!holdings.length) return;

  await exec(
    conn,
    `DELETE FROM ${T_HOLDINGS} WHERE INVESTOR_ID = ? AND ACCESSION = ?`,
    [investorId, accession]
  );

  // 14 placeholders per row (MUST match COLUMN1..COLUMN14 below)
  const values = holdings.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");

  const binds = holdings.flatMap((h) => [
    investorId,              // 1
    reportPeriod,            // 2
    accession,               // 3
    safeStr(h.cusip),        // 4
    safeStr(h.issuer),       // 5
    safeStr(h.titleOfClass), // 6
    h.value ?? null,         // 7
    h.shares ?? null,        // 8
    safeStr(h.sharesType),   // 9
    safeStr(h.putCall),      // 10
    safeStr(h.discretion),   // 11
    h.voteSole ?? null,      // 12
    h.voteShared ?? null,    // 13
    h.voteNone ?? null,      // 14
  ]);

  await exec(
    conn,
    `INSERT INTO ${T_HOLDINGS}
     (INVESTOR_ID, REPORT_PERIOD, ACCESSION, CUSIP, ISSUER, TITLE_OF_CLASS,
      VALUE_USD_THOUSANDS, SHARES, SHARES_TYPE, PUT_CALL, INVESTMENT_DISCRETION,
      VOTE_SOLE, VOTE_SHARED, VOTE_NONE)
     SELECT
      COLUMN1::STRING,
      TO_DATE(COLUMN2::STRING, 'YYYY-MM-DD'),
      COLUMN3::STRING,
      NULLIF(TRIM(COLUMN4::STRING), ''),
      NULLIF(TRIM(COLUMN5::STRING), ''),
      NULLIF(TRIM(COLUMN6::STRING), ''),
      COLUMN7::NUMBER(38,0),
      COLUMN8::NUMBER(38,0),
      NULLIF(TRIM(COLUMN9::STRING), ''),
      NULLIF(TRIM(COLUMN10::STRING), ''),
      NULLIF(TRIM(COLUMN11::STRING), ''),
      COLUMN12::NUMBER(38,0),
      COLUMN13::NUMBER(38,0),
      COLUMN14::NUMBER(38,0)
     FROM VALUES ${values}`,
    binds
  );
}

// ----------------------------
// Quarter metrics + style vectors
// ----------------------------
async function computeAndStoreQuarterMetrics(conn, investorId, reportPeriod) {
  const prevRows = await exec(
    conn,
    `SELECT MAX(REPORT_PERIOD) AS RP
     FROM ${T_HOLDINGS}
     WHERE INVESTOR_ID = ? AND REPORT_PERIOD < TO_DATE(?, 'YYYY-MM-DD')`,
    [investorId, reportPeriod]
  );
  const prevRp = prevRows?.[0]?.RP ? toDate(prevRows[0].RP) : null;

  const curStats = await exec(
    conn,
    `SELECT
       COUNT(*) AS HOLDINGS_COUNT,
       SUM(VALUE_USD_THOUSANDS) AS TOTAL_VALUE_USD_THOUSANDS
     FROM ${T_HOLDINGS}
     WHERE INVESTOR_ID = ? AND REPORT_PERIOD = TO_DATE(?, 'YYYY-MM-DD')`,
    [investorId, reportPeriod]
  );

  const holdingsCount = Number(curStats?.[0]?.HOLDINGS_COUNT || 0);
  const totalValue = Number(curStats?.[0]?.TOTAL_VALUE_USD_THOUSANDS || 0);

  const top10 = await exec(
    conn,
    `WITH cur AS (
       SELECT VALUE_USD_THOUSANDS
       FROM ${T_HOLDINGS}
       WHERE INVESTOR_ID = ? AND REPORT_PERIOD = TO_DATE(?, 'YYYY-MM-DD')
       ORDER BY VALUE_USD_THOUSANDS DESC
       LIMIT 10
     )
     SELECT SUM(VALUE_USD_THOUSANDS) AS TOP10_VALUE FROM cur`,
    [investorId, reportPeriod]
  );
  const top10Value = Number(top10?.[0]?.TOP10_VALUE || 0);
  const top10Concentration = totalValue > 0 ? top10Value / totalValue : 0;

  // Turnover proxy and consistency proxy from CUSIP overlap
  let turnoverProxy = 0;
  let consistencyProxy = 0;

  if (prevRp) {
    const curSetRows = await exec(
      conn,
      `SELECT DISTINCT CUSIP
       FROM ${T_HOLDINGS}
       WHERE INVESTOR_ID = ?
         AND REPORT_PERIOD = TO_DATE(?, 'YYYY-MM-DD')
         AND NULLIF(TRIM(CUSIP), '') IS NOT NULL`,
      [investorId, reportPeriod]
    );

    const prevSetRows = await exec(
      conn,
      `SELECT DISTINCT CUSIP
       FROM ${T_HOLDINGS}
       WHERE INVESTOR_ID = ?
         AND REPORT_PERIOD = TO_DATE(?, 'YYYY-MM-DD')
         AND NULLIF(TRIM(CUSIP), '') IS NOT NULL`,
      [investorId, prevRp]
    );

    const curSet = new Set(curSetRows.map((r) => String(r.CUSIP)));
    const prevSet = new Set(prevSetRows.map((r) => String(r.CUSIP)));

    const union = new Set([...curSet, ...prevSet]);
    let inter = 0;
    for (const c of curSet) if (prevSet.has(c)) inter++;

    const jaccard = union.size ? inter / union.size : 0;
    turnoverProxy = clamp01(1 - jaccard);
    consistencyProxy = clamp01(jaccard);
  }

  const vector = {
    trade_frequency: turnoverProxy,
    holding_patience: clamp01(1 - turnoverProxy),
    risk_reactivity: clamp01(turnoverProxy * (1 - consistencyProxy)),
    consistency: consistencyProxy,
  };

  await exec(
    conn,
    `DELETE FROM ${T_QMETRICS}
     WHERE INVESTOR_ID = ? AND REPORT_PERIOD = TO_DATE(?, 'YYYY-MM-DD')`,
    [investorId, reportPeriod]
  );

  await exec(
    conn,
    `INSERT INTO ${T_QMETRICS}
     (INVESTOR_ID, REPORT_PERIOD, HOLDINGS_COUNT, TOTAL_VALUE_USD_THOUSANDS,
      TOP10_CONCENTRATION, TURNOVER_PROXY, CONSISTENCY_PROXY, VECTOR_JSON, LOAD_TS)
     SELECT
      COLUMN1::STRING,
      TO_DATE(COLUMN2::STRING, 'YYYY-MM-DD'),
      COLUMN3::NUMBER(38,0),
      COLUMN4::NUMBER(38,0),
      COLUMN5::FLOAT,
      COLUMN6::FLOAT,
      COLUMN7::FLOAT,
      PARSE_JSON(COLUMN8::STRING),
      CURRENT_TIMESTAMP()
     FROM VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      investorId,
      reportPeriod,
      holdingsCount,
      totalValue,
      top10Concentration,
      turnoverProxy,
      consistencyProxy,
      JSON.stringify(vector),
    ]
  );
}

async function updateStyleVectorFromLatest(conn, investorId) {
  const rows = await exec(
    conn,
    `SELECT REPORT_PERIOD, VECTOR_JSON
     FROM ${T_QMETRICS}
     WHERE INVESTOR_ID = ?
     ORDER BY REPORT_PERIOD DESC
     LIMIT 6`,
    [investorId]
  );

  if (!rows.length) return;

  const vs = rows.map((r) => {
    const v = r.VECTOR_JSON;
    const obj = typeof v === "string" ? JSON.parse(v) : v;
    return {
      trade_frequency: clamp01(obj?.trade_frequency),
      holding_patience: clamp01(obj?.holding_patience),
      risk_reactivity: clamp01(obj?.risk_reactivity),
      consistency: clamp01(obj?.consistency),
    };
  });

  const weights = [0.35, 0.25, 0.18, 0.12, 0.07, 0.03];
  const keys = ["trade_frequency", "holding_patience", "risk_reactivity", "consistency"];

  const avgVec = {};
  for (const k of keys) {
    let num = 0;
    let den = 0;
    for (let i = 0; i < vs.length; i++) {
      const w = weights[i] ?? 0.02;
      num += w * Number(vs[i][k] || 0);
      den += w;
    }
    avgVec[k] = den > 0 ? clamp01(num / den) : 0;
  }

  await exec(conn, `DELETE FROM ${T_VECTORS} WHERE INVESTOR_ID = ?`, [investorId]);

  await exec(
    conn,
    `INSERT INTO ${T_VECTORS} (INVESTOR_ID, VECTOR_JSON, UPDATED_AT)
     SELECT COLUMN1::STRING, PARSE_JSON(COLUMN2::STRING), CURRENT_TIMESTAMP()
     FROM VALUES (?, ?)`,
    [investorId, JSON.stringify(avgVec)]
  );
}

// ----------------------------
// Main per-investor ingestion
// ----------------------------
async function ingestInvestor(conn, investor) {
  const { investorId, cik10 } = investor;

  console.log(`\n=== Ingest ${investorId} CIK ${cik10} ===`);

  const subUrl = `https://data.sec.gov/submissions/CIK${cik10}.json`;
  const sub = await fetchJson(subUrl);

  const filings = extract13FFilings(sub, INGEST_LIMIT);
  const filingsChrono = [...filings].reverse(); // oldest -> newest

  for (const f of filingsChrono) {
    const files = await listFilingFiles(cik10, f.accession);
    const infoXml = pickInfoTableXml(files) || f.primaryDocument || "primary_doc.xml";

    let rp = f.reportPeriod || null;
    if (!rp) rp = await getReportPeriodFromPrimaryDoc(cik10, f.accession, f.primaryDocument);
    rp = toDate(rp);

    if (!rp) {
      console.log(`  - ${f.accession} missing/bad reportPeriod (skip)`);
      continue;
    }

    let holdings = [];
    try {
      const xmlText = await downloadXml(cik10, f.accession, infoXml);
      holdings = await parseHoldingsFromInfoTableXml(xmlText);
    } catch {
      holdings = [];
    }

    console.log(`  - ${rp} ${f.accession}: holdings=${holdings.length} xml=${infoXml}`);

    const cikNo0 = cikNoLeadingZeros(cik10);
    const accNo = accessionNoDashes(f.accession);
    const indexJsonUrl = `https://www.sec.gov/Archives/edgar/data/${cikNo0}/${accNo}/index.json`;
    const infoTableUrl = `https://www.sec.gov/Archives/edgar/data/${cikNo0}/${accNo}/${infoXml}`;

    await upsertFiling(conn, {
    investorId,
    cik10,
    accession: f.accession,
    formType: f.form,
    filingDate: toDate(f.filingDate) || rp,
    reportPeriod: rp,
    indexJsonUrl,
    infoTableUrl,
    });


    if (holdings.length) {
      await insertHoldings(conn, investorId, f.accession, rp, holdings);
    }

    await computeAndStoreQuarterMetrics(conn, investorId, rp);

    // be gentle to SEC
    await sleep(150);
  }

  await updateStyleVectorFromLatest(conn, investorId);
}

// ----------------------------
// Run
// ----------------------------
async function main() {
  const conn = await getConnection();

  try {
    // Safety: set session context
    await exec(conn, `USE DATABASE ${DB}`);
    await exec(conn, `USE SCHEMA ${CORE_SCHEMA}`);

    for (const inv of INVESTORS) {
      await ingestInvestor(conn, inv);
    }

    console.log("\n✅ Done ingesting 13F data.");
  } finally {
    conn.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
