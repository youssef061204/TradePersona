// investor_compare.js
import { exec } from "./exec.js";
import { alignmentScore } from "./alignment.js";

/**
 * Normalizes Snowflake VARIANT/OBJECT/STRING JSON into a plain JS object.
 */
function normalizeVectorJson(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;

  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Loads investors + their latest style vectors in one query.
 * Expects:
 *  - CORE.INVESTORS (INVESTOR_ID, DISPLAY_NAME, ... optional fields)
 *  - ANALYTICS.INVESTOR_STYLE_VECTORS (INVESTOR_ID, VECTOR_JSON)
 */
export async function fetchInvestorsWithVectors(conn) {
  const rows = await exec(
    conn,
    `SELECT
        i.INVESTOR_ID,
        i.DISPLAY_NAME,
        i.CATEGORY,
        i.SOURCE,
        v.VECTOR_JSON
     FROM CORE.INVESTORS i
     JOIN ANALYTICS.INVESTOR_STYLE_VECTORS v
       ON v.INVESTOR_ID = i.INVESTOR_ID
     ORDER BY i.DISPLAY_NAME`
  );

  return rows
    .map((r) => {
      const vec = normalizeVectorJson(r.VECTOR_JSON);
      return {
        investorId: String(r.INVESTOR_ID),
        displayName: r.DISPLAY_NAME ?? null,
        category: r.CATEGORY ?? null,
        source: r.SOURCE ?? null,
        vector: vec,
      };
    })
    .filter((x) => x.vector); // drop investors missing/invalid vectors
}

/**
 * Computes alignment for every investor and returns sorted list (best first).
 */
export function scoreAgainstInvestors(userVector, investorsWithVectors) {
  const scored = investorsWithVectors.map((inv) => {
    const alignment = alignmentScore(userVector, inv.vector);
    return {
      investorId: inv.investorId,
      displayName: inv.displayName,
      category: inv.category,
      source: inv.source,
      alignment, // { score, gaps:[...] }
      investorVector: inv.vector,
    };
  });

  scored.sort((a, b) => (b.alignment?.score ?? 0) - (a.alignment?.score ?? 0));
  return scored;
}
