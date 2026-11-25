// `cleaninstall-node mcp`: a Model Context Protocol server over stdio, so AI
// agents (Claude Code, Cursor, VS Code, ...) can diagnose and fix installs
// with structured tools instead of `rm -rf node_modules`.
//
// No runtime dependencies: stdio MCP is newline-delimited JSON-RPC 2.0. The
// test suite drives this server with the official @modelcontextprotocol/sdk
// client to check compatibility.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const pkg = require("../package.json");
const { diagnose, diagnoseFromError } = require("./doctor");

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `cleaninstall-node diagnoses and fixes broken Node.js installs (npm, pnpm, yarn, bun).
- When an install, build, dev server or test run fails with a dependency-looking error, call explain_error with the error output BEFORE deleting node_modules or lockfiles. It explains the cause for this project and gives the smallest fix.
- Use diagnose for a general health check of the project's installed dependencies.
- apply_fix and clean change the project. They require the plan_id from a preceding diagnose/explain_error or plan_clean call: show the user the plan first, then pass its plan_id. If the project changed in between, they refuse and you must re-plan.
- Never delete lockfiles unless the user asks; clean keeps them unless lockfiles=true.`;

const dirProp = {
  dir: {
    type: "string",
    description: "Project root containing package.json. Defaults to the server's working directory.",
  },
};

const TOOLS = [
  {
    name: "diagnose",
    title: "Diagnose the project's install",
    description:
      "Health check of installed dependencies: Node version vs .nvmrc/engines, node_modules vs lockfile, missing or out-of-range dependencies, native modules built for another Node/OS, mixed package managers. Returns findings and the smallest fix plan (with a plan_id for apply_fix). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        ...dirProp,
        native: { type: "boolean", description: "Load native addons to check their ABI (default true, slower).", default: true },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "explain_error",
    title: "Explain an install/runtime error",
    description:
      "Explain an error message (Cannot find module, NODE_MODULE_VERSION, ERESOLVE, EBADENGINE, ERR_REQUIRE_ESM, missing rollup/esbuild/sharp binaries, command not found, lockfile out of sync, ...) in the context of this project, combined with a diagnose. Returns what it means, related findings, and the smallest fix plan with a plan_id. Read-only. Call this before deleting node_modules or lockfiles.",
    inputSchema: {
      type: "object",
      properties: {
        error: { type: "string", description: "The error output, as printed (stack traces welcome)." },
        ...dirProp,
        native: { type: "boolean", default: false, description: "Also load native addons (slower)." },
      },
      required: ["error"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "apply_fix",
    title: "Apply the planned fix",
    description:
      "Run the fix plan from diagnose or explain_error: a targeted rebuild, an install, or (only when node_modules came from a different package manager) a clean reinstall. Requires that call's plan_id; refuses if the plan changed. Pass the same error text if the plan came from explain_error. Returns the command output and a re-check. Never touches lockfiles.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string", description: "plan_id from diagnose or explain_error." },
        error: { type: "string", description: "The error text, if the plan came from explain_error." },
        ...dirProp,
        native: { type: "boolean", description: "Must match the diagnose call (default true for diagnose, false for explain_error)." },
      },
      required: ["plan_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "plan_clean",
    title: "Preview a cleanup",
    description:
      "List what a cleanup would delete (node_modules, build output, caches; lockfiles only if lockfiles=true) across the project and its workspaces, with sizes and a plan_id for clean. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        ...dirProp,
        lockfiles: { type: "boolean", default: false, description: "Also remove lockfiles (changes resolved versions on reinstall)." },
        only: {
          type: "array",
          items: { type: "string" },
          description: "Only these directory names/globs (e.g. [\"node_modules\"]) instead of the configured list.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "clean",
    title: "Delete what plan_clean listed",
    description:
      "Delete exactly what plan_clean listed. Requires its plan_id and the same options; refuses if the targets changed. Optionally reinstall afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string", description: "plan_id from plan_clean." },
        ...dirProp,
        lockfiles: { type: "boolean", default: false },
        only: { type: "array", items: { type: "string" } },
        install: { type: "boolean", default: false, description: "Run the package manager's install afterwards." },
      },
      required: ["plan_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class ToolError extends Error {}

// os.homedir() needs --allow-sys under Deno; the env vars only need --allow-env.
function homeDir() {
  try {
    return os.homedir();
  } catch {
    return process.env.HOME || process.env.USERPROFILE || null;
  }
}

function resolveProjectDir(dir, cwd) {
  const resolved = path.resolve(cwd, dir || ".");
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new ToolError(`Directory not found: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new ToolError(`Not a directory: ${resolved}`);
  if (path.parse(resolved).root === resolved) throw new ToolError("Refusing to operate on the filesystem root.");
  const home = homeDir();
  if (home && resolved === path.resolve(home)) throw new ToolError("Refusing to operate on the home directory.");
  if (!fs.existsSync(path.join(resolved, "package.json"))) {
    throw new ToolError(`No package.json in ${resolved}. Pass dir pointing at the project root.`);
  }
  return resolved;
}

function planId(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}

function fixPlanId(report) {
  return planId({
    dir: report.rootDir,
    steps: report.plan.steps.map((s) => [s.kind, s.cmd, s.args]),
  });
}

function summarizeReport(report) {
  const errors = report.findings.filter((f) => f.severity === "error").length;
  const warnings = report.findings.filter((f) => f.severity === "warn").length;
  const steps = report.plan.steps.map((s) => ({ kind: s.kind, command: s.label }));
  const result = {
    project: report.rootDir,
    packageManager: report.packageManager,
    summary: { errors, warnings },
    findings: report.findings.map((f) => ({
      severity: f.severity,
      id: f.id,
      title: f.title,
      ...(f.details && f.details.length ? { details: f.details } : {}),
      ...(f.related ? { related_to_error: true } : {}),
    })),
    plan: {
      steps,
      manual: report.plan.manual,
      ...(report.plan.blocked.length ? { blocked_by: report.plan.blocked } : {}),
    },
  };
  if (report.error) result.error = report.error;
  if (report.plan.blocked.length) {
    result.next = "Fixes are blocked until the Node version is corrected (see plan.manual). Tell the user; don't reinstall.";
  } else if (steps.length) {
    result.plan_id = fixPlanId(report);
    result.next = `Show the user plan.steps, then call apply_fix with plan_id "${result.plan_id}"${report.error ? " and the same error text" : ""}.`;
  } else if (report.plan.manual.length) {
    result.next = "Nothing to run automatically; the plan.manual items need a code or configuration change.";
  } else {
    result.next = errors ? "No automatic fix available." : "The install looks healthy; no need to delete node_modules.";
  }
  return result;
}

// Run commands with output captured (stdout is the MCP channel).
function capturingExeca(execa, log) {
  return async (cmd, args, opts = {}) => {
    const res = await execa(cmd, args, { ...opts, stdio: "pipe", all: true, reject: false });
    const out = String(res.all || "").trim();
    log.push({ command: [cmd, ...args].join(" "), exitCode: res.exitCode, output: out.split("\n").slice(-40).join("\n") });
    if (res.exitCode !== 0) {
      const err = new Error(`${cmd} ${args.join(" ")} exited with ${res.exitCode}`);
      err.captured = true;
      throw err;
    }
    return res;
  };
}

async function cleanPlan(dir, args) {
  const { main } = require("../bin/cleanup.js");
  const options = {
    dir,
    dryRun: true,
    yes: true,
    verbose: false,
    removeLockfiles: Boolean(args.lockfiles),
    ...(Array.isArray(args.only) && args.only.length ? { dirsToRemove: args.only, filesToRemove: [] } : {}),
  };
  const result = await main(options, async () => {});
  const targets = result.targets.map((t) => ({
    path: path.relative(dir, t.path) || ".",
    type: t.isDirectory ? "directory" : "file",
    bytes: t.size,
  }));
  return { options, targets, totalBytes: result.totalSize, plan_id: planId({ dir, targets: targets.map((t) => t.path) }) };
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

function makeHandlers({ cwd, execa, progress }) {
  return {
    async diagnose(args) {
      const dir = resolveProjectDir(args.dir, cwd);
      return summarizeReport(diagnose(dir, { native: args.native !== false }));
    },

    async explain_error(args) {
      if (typeof args.error !== "string" || !args.error.trim()) throw new ToolError("error must be a non-empty string.");
      const dir = resolveProjectDir(args.dir, cwd);
      return summarizeReport(diagnoseFromError(dir, args.error, { native: args.native === true }));
    },

    async apply_fix(args) {
      const dir = resolveProjectDir(args.dir, cwd);
      const native = args.native !== undefined ? args.native : !args.error;
      const report = args.error ? diagnoseFromError(dir, args.error, { native }) : diagnose(dir, { native });
      if (report.plan.blocked.length) {
        throw new ToolError(`Fixes are blocked: ${report.plan.blocked.join("; ")}. ${report.plan.manual.join("; ")}`);
      }
      if (report.plan.steps.length === 0) {
        return { applied: [], next: "Nothing to apply: the plan has no automatic steps.", recheck: summarizeReport(diagnose(dir, { native })) };
      }
      const current = fixPlanId(report);
      if (current !== args.plan_id) {
        throw new ToolError(
          `The plan changed since plan_id ${args.plan_id} (now ${current}). Call ${args.error ? "explain_error" : "diagnose"} again and show the user the new plan.`
        );
      }
      const log = [];
      const run = capturingExeca(execa, log);
      const { main: cleanupMain } = require("../bin/cleanup.js");
      let failed = null;
      for (const [i, step] of report.plan.steps.entries()) {
        progress(i, report.plan.steps.length, step.label);
        try {
          if (step.kind === "reinstall") {
            await cleanupMain(
              { dir, yes: true, verbose: false, dirsToRemove: ["node_modules"], filesToRemove: [], install: false },
              run
            );
          }
          await run(step.cmd, step.args, { cwd: dir });
        } catch (error) {
          failed = { step: step.label, message: error.message };
          break;
        }
      }
      const recheck = summarizeReport(diagnose(dir, { native }));
      return {
        applied: log,
        ...(failed ? { failed } : {}),
        recheck,
        next: failed
          ? "A step failed; see applied[].output. Explain the failure to the user (explain_error can help)."
          : args.error
            ? "Re-run the command that failed to confirm the error is gone."
            : recheck.next,
      };
    },

    async plan_clean(args) {
      const dir = resolveProjectDir(args.dir, cwd);
      const plan = await cleanPlan(dir, args);
      return {
        project: dir,
        targets: plan.targets,
        totalBytes: plan.totalBytes,
        lockfiles: Boolean(args.lockfiles),
        ...(plan.targets.length ? { plan_id: plan.plan_id } : {}),
        next: plan.targets.length
          ? `Show the user the targets, then call clean with plan_id "${plan.plan_id}" and the same options.`
          : "Nothing to clean.",
      };
    },

    async clean(args) {
      const dir = resolveProjectDir(args.dir, cwd);
      const plan = await cleanPlan(dir, args);
      if (plan.targets.length === 0) return { removed: [], next: "Nothing to clean." };
      if (plan.plan_id !== args.plan_id) {
        throw new ToolError(`The cleanup targets changed since plan_id ${args.plan_id}. Call plan_clean again and show the user the new list.`);
      }
      const log = [];
      const { main } = require("../bin/cleanup.js");
      progress(0, 1, `removing ${plan.targets.length} item(s)`);
      let result;
      try {
        result = await main({ ...plan.options, dryRun: false, install: Boolean(args.install) }, capturingExeca(execa, log));
      } catch (error) {
        return { removed: [], failed: { message: error.message }, applied: log };
      }
      return {
        removed: result.removed.map((p) => path.relative(dir, p) || "."),
        failed: result.failed.map((p) => path.relative(dir, p) || "."),
        freedBytes: result.totalSize,
        ...(args.install ? { installed: result.installed, applied: log } : {}),
        next: args.install ? "Done." : "Reinstall with the project's package manager, or call diagnose for the exact command.",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

function createServer({ write, cwd = process.cwd(), execa }) {
  let queue = Promise.resolve(); // serialise tool calls: they may touch the same project
  const send = (msg) => write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  const reply = (id, result) => send({ id, result });
  const fail = (id, code, message) => send({ id, error: { code, message } });

  async function callTool(params, id) {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const progressToken = params && params._meta && params._meta.progressToken;
    const progress = (done, total, message) => {
      if (progressToken !== undefined) {
        send({ method: "notifications/progress", params: { progressToken, progress: done, total, message } });
      }
    };
    const handlers = makeHandlers({ cwd, execa: execa || require("./run").run, progress });
    if (!Object.prototype.hasOwnProperty.call(handlers, name)) {
      return fail(id, -32602, `Unknown tool: ${name}`);
    }
    try {
      const result = await handlers[name](args);
      reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result });
    } catch (error) {
      const message = error instanceof ToolError ? error.message : `Internal error: ${error && error.message}`;
      reply(id, { content: [{ type: "text", text: message }], isError: true });
    }
  }

  function handle(msg) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      if (msg && msg.id !== undefined && msg.method === undefined) return; // a response to us; we send no requests
      return fail(msg && msg.id !== undefined ? msg.id : null, -32600, "Invalid Request");
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined;

    switch (method) {
      case "initialize": {
        const requested = params && params.protocolVersion;
        reply(id, {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "cleaninstall-node", title: "cleaninstall-node", version: pkg.version },
          instructions: INSTRUCTIONS,
        });
        return;
      }
      case "ping":
        if (!isNotification) reply(id, {});
        return;
      case "tools/list":
        reply(id, { tools: TOOLS });
        return;
      case "tools/call":
        queue = queue.then(() => callTool(params, id)).catch(() => {});
        return;
      default:
        if (!isNotification) fail(id, -32601, `Method not found: ${method}`);
    }
  }

  return {
    receive(line) {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return fail(null, -32700, "Parse error");
      }
      for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
    },
    idle: () => queue,
  };
}

// Entry point for `cleaninstall-node mcp`.
function startStdioServer({ cwd } = {}) {
  // stdout carries protocol messages only; route all logging to stderr.
  const toStderr = (...a) => process.stderr.write(a.map(String).join(" ") + "\n");
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;

  const out = process.stdout;
  const server = createServer({ write: (s) => out.write(s), cwd });
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => server.receive(line));
  rl.on("close", () => server.idle().then(() => process.exit(0)));
  return server;
}

module.exports = { createServer, startStdioServer, TOOLS, SUPPORTED_PROTOCOL_VERSIONS, resolveProjectDir };
