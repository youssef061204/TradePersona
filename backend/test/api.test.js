import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createApp, MAX_UPLOAD_BYTES } from "../index.js";
const { WorkerError } = createRequire(import.meta.url)(
  "../services/worker.cjs",
);

async function server(t, options = {}) {
  const app = createApp({
    worker: {
      analyze: async (csv) => ({
        marker: csv,
        prediction: { status: "abstained" },
      }),
    },
    env: {},
    ...options,
  });
  const http = app.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(async () => {
    app.locals.close();
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });
  return `http://127.0.0.1:${http.address().port}`;
}
async function upload(
  base,
  text = "first",
  name = "trades.csv",
  field = "file",
) {
  const body = new FormData();
  body.append(field, new Blob([text]), name);
  return fetch(`${base}/api/uploads/usertrades`, { method: "POST", body });
}

test("upload creates separate capability sessions, supports deletion, and has no latest-user endpoint", async (t) => {
  const base = await server(t);
  const firstResponse = await upload(base, "account-a");
  assert.equal(firstResponse.status, 201);
  assert.equal(firstResponse.headers.get("cache-control"), "no-store");
  const first = await firstResponse.json();
  const second = await (
    await upload(base, "account-b", "../../escape.csv")
  ).json();
  assert.notEqual(first.sessionId, second.sessionId);
  const read = await (
    await fetch(`${base}/api/analysis/${first.sessionId}`)
  ).json();
  assert.equal(read.analysis.marker, "account-a");
  assert.equal((await fetch(`${base}/api/analysis`)).status, 404);
  assert.equal((await fetch(`${base}/api/analysis/not-a-session`)).status, 404);
  assert.equal(
    (
      await fetch(`${base}/api/analysis/${first.sessionId}`, {
        method: "DELETE",
      })
    ).status,
    204,
  );
  assert.equal(
    (await fetch(`${base}/api/analysis/${first.sessionId}`)).status,
    404,
  );
  assert.equal(
    (await fetch(`${base}/api/analysis/${second.sessionId}`)).status,
    200,
  );
});

test("sessions have fixed expiry and bounded FIFO capacity", async (t) => {
  let clock = 0;
  const base = await server(t, {
    now: () => clock,
    ttlMs: 1000,
    maxSessions: 2,
  });
  const first = await (await upload(base)).json();
  const second = await (await upload(base)).json();
  await upload(base);
  assert.equal(
    (await fetch(`${base}/api/analysis/${first.sessionId}`)).status,
    404,
  );
  clock = 999;
  assert.equal(
    (await fetch(`${base}/api/analysis/${second.sessionId}`)).status,
    200,
  );
  clock = 1000;
  assert.equal(
    (await fetch(`${base}/api/analysis/${second.sessionId}`)).status,
    404,
  );
});

test("upload rejects missing, empty, wrong field, non-CSV, invalid UTF8, and oversized files", async (t) => {
  let calls = 0;
  const base = await server(t, {
    worker: {
      analyze: async () => {
        calls++;
        return {};
      },
    },
  });
  assert.equal(
    (await fetch(`${base}/api/uploads/usertrades`, { method: "POST" })).status,
    400,
  );
  assert.equal((await upload(base, "")).status, 400);
  assert.equal((await upload(base, "a", "a.csv", "wrong")).status, 400);
  assert.equal((await upload(base, "a", "a.exe")).status, 400);
  assert.equal((await upload(base, new Uint8Array([0xff, 0xff]))).status, 400);
  assert.equal(
    (await upload(base, "a".repeat(MAX_UPLOAD_BYTES + 1))).status,
    413,
  );
  assert.equal(calls, 0);
});

test("validation quality is preserved but unexpected errors hide internal details", async (t) => {
  const base = await server(t, {
    worker: {
      analyze: async (csv) => {
        if (csv === "invalid")
          throw new WorkerError("Required columns missing.", 422, {
            missing_fields: ["timestamp"],
          });
        throw new Error("password=SECRET file=C:/private/history.csv");
      },
    },
  });
  const invalid = await upload(base, "invalid");
  assert.equal(invalid.status, 422);
  assert.deepEqual((await invalid.json()).error.quality.missing_fields, [
    "timestamp",
  ]);
  const broken = await upload(base);
  assert.equal(broken.status, 503);
  assert.doesNotMatch(await broken.text(), /SECRET|private|password/);
});

test("CORS is exact allowlist and production has no wildcard default", async (t) => {
  const base = await server(t, {
    env: { NODE_ENV: "production", CORS_ORIGINS: "https://trade.example" },
  });
  const allowed = await fetch(`${base}/healthz`, {
    headers: { Origin: "https://trade.example" },
  });
  assert.equal(
    allowed.headers.get("access-control-allow-origin"),
    "https://trade.example",
  );
  assert.equal(
    (
      await fetch(`${base}/healthz`, {
        headers: { Origin: "https://trade.example.evil" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("evaluation missing artifact and malformed JSON have understandable safe failures", async (t) => {
  const base = await server(t, { evaluationPath: "./missing-evaluation.json" });
  assert.equal((await fetch(`${base}/api/evaluation`)).status, 503);
  const malformed = await fetch(`${base}/api/analysis/fake/coaching`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{broken",
  });
  assert.equal(malformed.status, 400);
});

test("optional external services require explicit consent and server enablement", async (t) => {
  let calls = 0;
  const base = await server(t, {
    analytics: async () => {
      calls++;
    },
    coaching: async () => {
      calls++;
    },
  });
  const { sessionId } = await (await upload(base)).json();
  for (const [route, body] of [
    ["analytics", { consent: true }],
    ["coaching", { useGemini: true }],
  ]) {
    const url = `${base}/api/analysis/${sessionId}/${route}`;
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
      503,
    );
  }
  assert.equal(calls, 0);
});

test("upload admission is bounded before CSV buffers are allocated", async (t) => {
  const resolvers = [];
  const base = await server(t, {
    worker: {
      analyze: () => new Promise((resolve) => resolvers.push(resolve)),
    },
  });
  const pending = Array.from({ length: 5 }, () => upload(base));
  while (resolvers.length < 5)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await upload(base)).status, 503);
  resolvers.forEach((resolve) => resolve({}));
  assert.deepEqual(
    (await Promise.all(pending)).map((response) => response.status),
    [201, 201, 201, 201, 201],
  );
});
