// Run a command (npm/pnpm/yarn/bun/deno install, rebuild, ...) with Node's
// built-in child_process. Replaces execa, which pulled in ~20 packages.
//
//   await run("npm", ["install"], { cwd, stdio: "inherit" })        // stream output
//   const r = await run("npm", ["ci"], { cwd, stdio: "pipe", all: true, reject: false })
//   r.exitCode, r.all                                               // capture output
const { spawn } = require("child_process");

// Windows: npm/pnpm/yarn are .cmd shims, which Node 20+ only starts through a
// shell (CVE-2024-27980). Quote each argument for cmd.exe.
const isWindows = process.platform === "win32";
const quoteWin = (a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '""')}"`);

function run(cmd, args = [], options = {}) {
  const { cwd, env, stdio = "pipe", all = false, reject = true } = options;
  return new Promise((resolve, rejectPromise) => {
    let child;
    try {
      child = isWindows
        ? spawn([cmd, ...args].map(quoteWin).join(" "), { cwd, env, stdio: stdio === "inherit" ? "inherit" : "pipe", shell: true })
        : spawn(cmd, args, { cwd, env, stdio: stdio === "inherit" ? "inherit" : "pipe" });
    } catch (error) {
      rejectPromise(error);
      return;
    }

    let output = "";
    if (stdio !== "inherit") {
      const collect = (chunk) => {
        if (all) output += chunk;
      };
      child.stdout.setEncoding("utf8").on("data", collect);
      child.stderr.setEncoding("utf8").on("data", collect);
    }

    child.on("error", (error) => {
      // e.g. ENOENT: the command isn't installed
      if (reject) rejectPromise(error);
      else resolve({ exitCode: 127, all: `${output}${error.message}`, failed: true });
    });
    child.on("close", (code, signal) => {
      const exitCode = code === null ? 1 : code;
      const result = { exitCode, signal, all: output, failed: exitCode !== 0 };
      if (exitCode !== 0 && reject) {
        const error = new Error(`Command failed with exit code ${exitCode}: ${[cmd, ...args].join(" ")}`);
        Object.assign(error, result);
        rejectPromise(error);
      } else {
        resolve(result);
      }
    });
  });
}

module.exports = { run };
