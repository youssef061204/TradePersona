# Deploy the TradePersona API

The Docker service runs Express and one persistent Python inference process. It loads the versioned, trusted `backend/ml/artifacts/v1/model.joblib`; it never trains at startup. `/api/evaluation` reads the generated artifact beside the model. `/healthz` is a process liveness check; verify an upload and the evaluation endpoint separately after deployment.

## Prepare and deploy

1. Complete the README setup, run tests, and ensure the model and evaluation artifacts exist. If intentionally regenerating the benchmark, run the explicit training command in the README before building.
2. Build locally with `docker build -t tradepersona-api backend` and run with `docker run --rm -p 3001:10000 -e PORT=10000 -e CORS_ORIGINS=http://localhost:3000 tradepersona-api`.
3. Push the reviewed repository to your GitHub repository, then create a Render Blueprint using `render.yaml`.
4. Set `CORS_ORIGINS` to the exact HTTPS frontend origin, such as `https://your-site.vercel.app`. Multiple approved origins are comma-separated; wildcards are unsupported. Production denies browser origins if this is unset.
5. Set the frontend's `NEXT_PUBLIC_API_BASE_URL` to the deployed API origin and rebuild the frontend. Confirm `/healthz`, `/api/evaluation`, and a sample CSV upload from the frontend.

No Gemini or Snowflake credentials are required for the full default analytics flow. Supply secrets only in the hosting provider's environment settings. `.env`, uploads, logs and local environments must not enter the image. The image runs as an unprivileged user.

## Retention and capacity

Raw CSV uploads stay in request/worker memory and are never written to disk. Accepted files are UTF-8 CSV, at most 50 MB and 50,000 rows. Python owns structural and numeric validation. One worker handles analysis, with at most four queued jobs and a 30-second total deadline. There are at most five admitted uploads. Worker failure clears pending jobs and the next request starts a new worker.

Only analysis results are retained: at most 100 memory sessions, for a fixed 30 minutes. Oldest sessions are evicted at capacity. Restart/redeploy deletes all sessions. `DELETE /api/analysis/:sessionId` deletes one result. A session UUID is a bearer capability: anyone with it can read/delete that result, so do not share it or log request URLs. Configure your reverse proxy/provider access logging accordingly. There are no accounts or durable history. Horizontal replicas would need shared storage or session affinity; this deployment intentionally uses one process.

## Optional Gemini curation

Enable with `ENABLE_GEMINI=true`, `GEMINI_API_KEY`, and an explicit `GEMINI_MODEL` supported by the provider. `POST /api/analysis/:sessionId/coaching` requires JSON `{"useGemini":true}`. This is consent to send aggregate evidence, predictions and explanations to Gemini. The default UI does not invoke it automatically.

Gemini can only select and order IDs of educational actions already derived deterministically. Its prose and numbers are never displayed. An abstained/unavailable prediction bypasses Gemini; invalid selections, provider errors and timeouts return deterministic coaching. This intentionally constrains the [generateContent API](https://ai.google.dev/api/generate-content), rather than trusting a prompt to prevent hallucinations. The summary and original analysis are unchanged.

## Optional Snowflake aggregate analytics

Enable with `ENABLE_AGGREGATE_ANALYTICS=true` and the `SNOWFLAKE_*` variables in `.env.example`. Use an account/credential permitted by your organization's Snowflake authentication policy and a least-privilege role. Configure the database, schema and warehouse, and pre-create the table; the application does not create warehouse resources:

```sql
CREATE TABLE TRADEPERSONA_AGGREGATES (
  CREATED_AT TIMESTAMP_LTZ,
  SCHEMA_VERSION VARCHAR,
  MODEL_VERSION VARCHAR,
  STATUS VARCHAR,
  LABEL VARCHAR,
  CONFIDENCE FLOAT,
  USABLE_ROWS INTEGER
);
```

`POST /api/analysis/:sessionId/analytics` requires JSON `{"consent":true}`. It stores only the columns above, with the time of aggregate insertion, using bound SQL values. It never stores raw trades, trade timestamps, assets, monetary values, account identifiers or session capabilities. Explicitly opted-in aggregate records are separate from the ephemeral analysis; deleting a session does not remove an aggregate record. Establish your own warehouse retention policy before enabling this integration. A repeated successful request for the same live session does not insert again; network ambiguity can still require warehouse deduplication in a production deployment.

The application disables [Snowflake driver logging](https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-logs) to avoid financial data in logs. The optional SEC 13F ingestion script remains an independent public-holdings utility; quarterly holdings cannot establish a person's trading psychology and do not label or train the behavioral model.

The Snowflake dependency's `toml` parser is overridden to patched v4.2+ (same CommonJS `parse` interface) because its default v3 dependency has published vulnerabilities. Keep the lockfile and dependency audit in CI. External Gemini/Snowflake operations require live credentials and are not validated by the default offline test suite.
