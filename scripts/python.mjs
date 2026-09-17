import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const virtualenv = resolve(
  root,
  ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const executable =
  process.env.PYTHON_PATH || (existsSync(virtualenv) ? virtualenv : "python");
const child = spawn(executable, process.argv.slice(2), {
  cwd: resolve(root, "backend"),
  stdio: "inherit",
  env: { ...process.env, OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1" },
});
child.on("error", () => {
  console.error("Python unavailable. Create .venv or set PYTHON_PATH.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
