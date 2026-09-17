import express from "express";
import multer from "multer";
import cors from "cors";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { curateCoaching } from "./gemini_coach.js";
import { persistAggregate } from "./snowflake.js";

const backendDir = path.dirname(fileURLToPath(import.meta.url));
const { PythonWorker, WorkerError } = createRequire(import.meta.url)(
  "./services/worker.cjs",
);
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const SESSION_TTL_MS = 30 * 60 * 1000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createApp({
  worker = new PythonWorker(),
  now = Date.now,
  ttlMs = SESSION_TTL_MS,
  maxSessions = 100,
  env = process.env,
  evaluationPath = path.join(backendDir, "ml/artifacts/v1/evaluation.json"),
  coaching = curateCoaching,
  analytics = persistAggregate,
} = {}) {
  const app = express();
  const sessions = new Map();
  let uploadsInFlight = 0;
  const allowedOrigins = (
    env.CORS_ORIGINS ||
    (env.NODE_ENV === "production" ? "" : "http://localhost:3000")
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    next();
  });
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin))
          return callback(null, true);
        return callback(
          Object.assign(new Error("Origin is not allowed."), { status: 403 }),
        );
      },
      methods: ["GET", "POST", "DELETE"],
      allowedHeaders: ["Content-Type"],
      credentials: false,
    }),
  );
  app.use(express.json({ limit: "8kb" }));
  const prune = () => {
    for (const [id, session] of sessions)
      if (session.expires <= now()) sessions.delete(id);
  };
  const cleanupTimer = setInterval(prune, Math.min(ttlMs, 60_000));
  cleanupTimer.unref();
  const lookup = (req, res, next) => {
    prune();
    const session =
      UUID.test(req.params.sessionId) && sessions.get(req.params.sessionId);
    if (!session)
      return res.status(404).json({
        error: {
          message: "Analysis expired or not found. Upload your CSV again.",
        },
      });
    req.session = session;
    next();
  };
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1,
      fields: 0,
      parts: 2,
    },
    fileFilter(_req, file, callback) {
      if (!/\.csv$/i.test(file.originalname))
        return callback(
          Object.assign(new Error("Upload a CSV file."), { status: 400 }),
        );
      callback(null, true);
    },
  });
  app.get("/healthz", (_req, res) =>
    res.json({
      status: "ok",
      service: "tradepersona",
      storage: "memory",
      session_ttl_minutes: 30,
    }),
  );
  app.post(
    "/api/uploads/usertrades",
    (req, res, next) => {
      if (uploadsInFlight >= 5)
        return res.status(503).json({
          error: {
            message: "Analysis capacity reached. Please retry shortly.",
          },
        });
      uploadsInFlight += 1;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          uploadsInFlight -= 1;
        }
      };
      res.once("finish", release);
      res.once("close", release);
      next();
    },
    upload.single("file"),
    async (req, res) => {
      if (!req.file?.buffer?.length)
        return res.status(400).json({
          error: { message: "Choose a nonempty CSV file in the file field." },
        });
      let csv;
      try {
        csv = new TextDecoder("utf-8", { fatal: true }).decode(req.file.buffer);
      } catch {
        return res
          .status(400)
          .json({ error: { message: "CSV must be UTF-8 text." } });
      }
      const analysis = await worker.analyze(csv);
      prune();
      while (sessions.size >= maxSessions)
        sessions.delete(sessions.keys().next().value);
      const sessionId = randomUUID();
      sessions.set(sessionId, {
        analysis,
        expires: now() + ttlMs,
        analyticsSent: false,
        analyticsPending: false,
        coachingPending: false,
      });
      res.status(201).json({ sessionId, analysis });
    },
  );
  app.get("/api/analysis/:sessionId", lookup, (req, res) =>
    res.json({
      sessionId: req.params.sessionId,
      analysis: req.session.analysis,
    }),
  );
  app.delete("/api/analysis/:sessionId", lookup, (req, res) => {
    sessions.delete(req.params.sessionId);
    res.status(204).end();
  });
  app.get("/api/evaluation", async (_req, res) => {
    try {
      res.json(JSON.parse(await readFile(evaluationPath, "utf8")));
    } catch {
      res.status(503).json({
        error: {
          message:
            "Evaluation artifact is unavailable. Run the explicit ML training command.",
        },
      });
    }
  });
  app.post("/api/analysis/:sessionId/coaching", lookup, async (req, res) => {
    if (req.body?.useGemini !== true)
      return res.status(400).json({
        error: {
          message:
            "Explicit useGemini consent is required to share aggregate evidence with Gemini.",
        },
      });
    if (
      env.ENABLE_GEMINI !== "true" ||
      !env.GEMINI_API_KEY ||
      !env.GEMINI_MODEL
    )
      return res.status(503).json({
        error: {
          message:
            "Optional Gemini interpretation is not configured. Deterministic coaching remains available.",
        },
      });
    if (req.session.coachingPending)
      return res
        .status(429)
        .json({ error: { message: "Interpretation already in progress." } });
    req.session.coachingPending = true;
    try {
      res.json({ coaching: await coaching(req.session.analysis, env) });
    } finally {
      req.session.coachingPending = false;
    }
  });
  app.post("/api/analysis/:sessionId/analytics", lookup, async (req, res) => {
    if (req.body?.consent !== true)
      return res.status(400).json({
        error: {
          message: "Explicit consent is required to store aggregate analytics.",
        },
      });
    if (env.ENABLE_AGGREGATE_ANALYTICS !== "true")
      return res.status(503).json({
        error: { message: "Optional aggregate analytics is disabled." },
      });
    if (req.session.analyticsSent) return res.json({ stored: true });
    if (req.session.analyticsPending)
      return res
        .status(429)
        .json({ error: { message: "Aggregate storage already in progress." } });
    req.session.analyticsPending = true;
    try {
      await analytics(req.session.analysis, env);
      req.session.analyticsSent = true;
      res.json({ stored: true });
    } finally {
      req.session.analyticsPending = false;
    }
  });
  app.use((_req, res) =>
    res.status(404).json({ error: { message: "Endpoint not found." } }),
  );
  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError)
      return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
        error: {
          message:
            error.code === "LIMIT_FILE_SIZE"
              ? "CSV exceeds the 5 MB limit."
              : "Send exactly one CSV in the file field, with no extra fields.",
        },
      });
    if (error instanceof WorkerError)
      return res.status(error.status).json({
        error: {
          message: error.message,
          ...(error.quality ? { quality: error.quality } : {}),
        },
      });
    if (error.status === 400 || error.type === "entity.parse.failed")
      return res.status(400).json({
        error: {
          message: "Invalid request. Check the file and JSON fields.",
        },
      });
    if (error.status === 413)
      return res
        .status(413)
        .json({ error: { message: "Request is too large." } });
    if (error.status === 403)
      return res
        .status(403)
        .json({ error: { message: "Origin is not allowed." } });
    res.status(503).json({
      error: {
        message: "Analysis service is temporarily unavailable. Please retry.",
      },
    });
  });
  app.locals.close = () => {
    clearInterval(cleanupTimer);
    sessions.clear();
    worker.close?.();
  };
  return app;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  dotenv.config({ path: path.join(backendDir, ".env"), quiet: true });
  const app = createApp();
  const server = app.listen(Number(process.env.PORT || 3001), "0.0.0.0", () =>
    console.log("TradePersona API ready"),
  );
  server.requestTimeout = 30_000;
  const shutdown = () => {
    app.locals.close();
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
