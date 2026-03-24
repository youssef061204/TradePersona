const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");


function resolvePythonExecutable() {
    if (process.env.PYTHON_PATH) {
        return process.env.PYTHON_PATH;
    }


    const projectRoot = path.join(__dirname, "..", "..");
    const venvPython = process.platform === "win32"
        ? path.join(projectRoot, ".venv", "Scripts", "python.exe")
        : path.join(projectRoot, ".venv", "bin", "python");


    if (fs.existsSync(venvPython)) {
        return venvPython;
    }


    return "python";
}


function runPythonMetrics(csvPath) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, "bias_engine.py");
        const pythonExec = resolvePythonExecutable();

        // Suppress Python warnings on stdout (they broke JSON parsing)
        const args = ["-W", "ignore", scriptPath, csvPath];
        const env = { ...process.env, PYTHONWARNINGS: "ignore" };

        const proc = spawn(pythonExec, args, { env });


        let stdout = "";
        let stderr = "";


        proc.stdout.on("data", (data) => {
            stdout += data.toString();
        });


        proc.stderr.on("data", (data) => {
            stderr += data.toString();
        });


        proc.on("close", (code) => {
            if (code !== 0) {
                return reject(new Error(stderr || `Python exited with code ${code}`));
            }
            const text = stdout.trim();

            const tryParse = (payload) => {
                try {
                    return JSON.parse(payload);
                } catch {
                    return null;
                }
            };

            let parsed = tryParse(text);
            if (!parsed) {
                const lastBrace = text.lastIndexOf("{");
                if (lastBrace >= 0) {
                    parsed = tryParse(text.slice(lastBrace));
                }
            }

            if (parsed) return resolve(parsed);

            const detail = stderr || text || `Python exited with code ${code}`;
            return reject(new Error(`Failed to parse Python JSON output: ${detail.slice(0, 400)}`));
        });
    });
}


module.exports = { runPythonMetrics };
