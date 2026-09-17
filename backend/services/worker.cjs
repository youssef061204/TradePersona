const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

class WorkerError extends Error {
  constructor(message, status = 503, quality) {
    super(message);
    this.status = status;
    this.quality = quality;
  }
}

function resolvePythonExecutable() {
  if (process.env.PYTHON_PATH) return process.env.PYTHON_PATH;
  const root = path.resolve(__dirname, "../..");
  const executable =
    process.platform === "win32"
      ? ["Scripts", "python.exe"]
      : ["bin", "python"];
  for (const base of [root, path.join(root, "backend")]) {
    const candidate = path.join(base, ".venv", ...executable);
    if (existsSync(candidate)) return candidate;
  }
  return process.platform === "win32" ? "python" : "python3";
}

class PythonWorker {
  constructor({ timeoutMs = 30_000, maxQueue = 4, spawnProcess = spawn } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxQueue = maxQueue;
    this.spawnProcess = spawnProcess;
    this.queue = [];
    this.active = null;
    this.child = null;
    this.closed = false;
  }
  analyze(csv) {
    if (this.closed)
      return Promise.reject(new WorkerError("Analysis worker is closed."));
    if (Buffer.byteLength(csv, "utf8") > 5 * 1024 * 1024)
      return Promise.reject(
        new WorkerError("CSV exceeds the 5 MB limit.", 413),
      );
    if (this.active && this.queue.length >= this.maxQueue)
      return Promise.reject(
        new WorkerError("Analysis capacity reached. Please retry shortly."),
      );
    return new Promise((resolve, reject) => {
      const job = { id: randomUUID(), csv, resolve, reject };
      job.timer = setTimeout(() => {
        if (this.active === job)
          this.fail(
            new WorkerError(
              "Analysis timed out. Please retry with a smaller history.",
              504,
            ),
          );
        else {
          this.queue = this.queue.filter((item) => item !== job);
          reject(
            new WorkerError("Analysis queue timed out. Please retry.", 504),
          );
        }
      }, this.timeoutMs);
      this.queue.push(job);
      this.pump();
    });
  }
  start() {
    const child = this.spawnProcess(
      resolvePythonExecutable(),
      ["-m", "ml.worker"],
      {
        cwd: path.resolve(__dirname, ".."),
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          OMP_NUM_THREADS: "1",
          OPENBLAS_NUM_THREADS: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (this.child !== child) return;
      output += chunk;
      if (output.length > 4 * 1024 * 1024)
        return this.fail(new WorkerError("Invalid analysis response."));
      let index;
      while ((index = output.indexOf("\n")) !== -1) {
        const line = output.slice(0, index);
        output = output.slice(index + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return this.fail(new WorkerError("Invalid analysis response."));
        }
        const job = this.active;
        if (
          !job ||
          message.id !== job.id ||
          (!message.result && !message.error)
        )
          return this.fail(new WorkerError("Invalid analysis response."));
        this.active = null;
        clearTimeout(job.timer);
        if (message.error)
          job.reject(
            new WorkerError(
              message.error.message || "CSV validation failed.",
              422,
              message.error.quality,
            ),
          );
        else job.resolve(message.result);
        this.pump();
      }
    });
    // Consume stderr without logging financial data, paths, or library diagnostics.
    child.stderr.resume();
    child.stdin.on("error", () => {
      if (this.child === child)
        this.fail(
          new WorkerError("Analysis worker disconnected. Please retry."),
        );
    });
    child.on("error", () => {
      if (this.child === child)
        this.fail(new WorkerError("Python analysis worker is unavailable."));
    });
    child.on("exit", () => {
      if (this.child === child)
        this.fail(new WorkerError("Analysis worker stopped. Please retry."));
    });
  }
  pump() {
    if (this.closed || this.active || !this.queue.length) return;
    this.active = this.queue.shift();
    try {
      if (!this.child) this.start();
      this.child.stdin.write(
        JSON.stringify({ id: this.active.id, csv: this.active.csv }) + "\n",
      );
      this.active.csv = null;
    } catch {
      this.fail(new WorkerError("Python analysis worker is unavailable."));
    }
  }
  fail(error) {
    const child = this.child;
    this.child = null;
    child?.kill();
    const jobs = this.active ? [this.active, ...this.queue] : this.queue;
    this.active = null;
    this.queue = [];
    for (const job of jobs) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    // Restart lazily on the next request, avoiding crash loops.
  }
  close() {
    this.closed = true;
    this.fail(new WorkerError("Analysis worker is closed."));
  }
}
module.exports = { PythonWorker, WorkerError, resolvePythonExecutable };
