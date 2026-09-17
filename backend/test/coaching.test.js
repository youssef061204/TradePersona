import test from "node:test";
import assert from "node:assert/strict";
import { curateCoaching, validateSelection } from "../gemini_coach.js";
import { aggregateRecord } from "../snowflake.js";
const analysis = {
  schema_version: "1.0",
  scope: "synthetic",
  prediction: {
    status: "classified",
    label: "calm_trader",
    confidence: 0.8,
    model_version: "v1",
  },
  quality: { usable_rows: 100, date_range: { start: "sensitive" } },
  evidence: [],
  explanations: [],
  counterfactuals: [],
  coaching: {
    source: "deterministic",
    summary: "Measured pattern.",
    actions: ["Review your recorded decisions.", "Keep a consistent journal."],
  },
};
test("Gemini cannot add prose, numbers, actions, duplicates, or change uncertainty", async () => {
  assert.equal(validateSelection({ action_ids: [3] }, analysis.coaching.actions), null);
  assert.equal(validateSelection({ action_ids: [0, 0] }, analysis.coaching.actions), null);
  const request = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ action_ids: [1], summary: "Guaranteed 100% returns" }) }] } }] }) });
  const result = await curateCoaching(analysis, { GEMINI_MODEL: "configured-model" }, request);
  assert.equal(result.summary, analysis.coaching.summary);
  assert.deepEqual(result.actions, [analysis.coaching.actions[1]]);
  const abstained = await curateCoaching({ ...analysis, prediction: { status: "abstained", label: null, reasons: ["uncertain"] } }, { GEMINI_MODEL: "configured-model" }, request);
  assert.equal(abstained.source, "gemini-curated");
  assert.equal(abstained.summary, analysis.coaching.summary);
});
test("provider failures preserve deterministic coaching", async () => {
  assert.deepEqual(await curateCoaching(analysis, {}, async () => { throw new Error("failure"); }), analysis.coaching);
});
test("Snowflake aggregation excludes personal fields, raw trades, dates, and capability IDs", () => {
  assert.deepEqual(Object.keys(aggregateRecord({ ...analysis, sessionId: "secret", trades: ["private"] })), ["schema_version", "model_version", "status", "label", "confidence", "usable_rows"]);
});
