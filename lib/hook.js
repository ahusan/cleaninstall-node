// `cleaninstall-node hook`: git hooks that notice when a checkout, pull or
// rebase changed dependencies, and warn (or install) before you hit a
// confusing error.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { diagnose } = require("./doctor");

const HOOKS = ["post-checkout", "post-merge", "post-rewrite"];
const MARK_START = "# >>> cleaninstall-node >>>";
const MARK_END = "# <<< cleaninstall-node <<<";
const MODES = ["warn", "install"];
const NULL_SHA = /^0+$/;

// Files whose change means node_modules may now be stale.
const DEPENDENCY_FILES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "bun.lock",
  "bun.lockb",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  ".yarnrc.yml",
  ".npmrc",
]);

function isDependencyFile(file) {
  if (file.split("/").includes("node_modules")) return false;
  return DEPENDENCY_FILES.has(path.posix.basename(file));
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function gitDir(cwd) {
  return path.resolve(cwd, git(["rev-parse", "--git-dir"], cwd));
}

// The two commits to compare for a given hook invocation, or null to skip.
function rangeFor(event, args) {
  if (event === "post-checkout") {
    const [prev, next, branchFlag] = args;
    if (branchFlag !== "1") return null; // file checkout, not a branch switch
    if (!prev || !next || prev === next || NULL_SHA.test(prev)) return null;
    return [prev, next];
  }
  if (event === "post-merge" || event === "post-rewrite") {
    if (event === "post-rewrite" && args[0] === "amend") return null;
    return ["ORIG_HEAD", "HEAD"];
  }
  return null;
}

function changedDependencyFiles(event, args, cwd) {
  const range = rangeFor(event, args);
  if (!range) return [];
  let out;
  try {
    out = git(["diff", "--name-only", range[0], range[1]], cwd);
  } catch {
    return [];
  }
  return out.split("\n").filter(Boolean).filter(isDependencyFile);
}

function shouldSkip(event, cwd) {
  if (process.env.CLEANINSTALL_SKIP_HOOK === "1") return "CLEANINSTALL_SKIP_HOOK=1";
  if (process.env.CI && process.env.CI !== "false") return "CI";
  try {
    const dir = gitDir(cwd);
    // Mid-rebase checkouts: post-rewrite reports once at the end instead.
    // (The rebase state dir still exists while post-rewrite runs.)
    if (event === "post-checkout" && fs.existsSync(path.join(dir, "rebase-merge")) || fs.existsSync(path.join(dir, "rebase-apply"))) {
      return "rebase in progress";
    }
  } catch {
    return "not a git repository";
  }
  return null;
}

// Called by the installed hook script. Never throws, never fails git.
async function runHook(event, args, options = {}) {
  const cwd = path.resolve(options.dir || process.cwd());
  const log = options.log || ((m) => process.stderr.write(m + "\n"));
  const mode = MODES.includes(process.env.CLEANINSTALL_HOOK_MODE)
    ? process.env.CLEANINSTALL_HOOK_MODE
    : MODES.includes(options.mode) ? options.mode : "warn";
  const result = { event, mode, changed: [], action: "none" };

  try {
    const skip = shouldSkip(event, cwd);
    if (skip) return { ...result, action: "skipped", reason: skip };

    result.changed = changedDependencyFiles(event, args, cwd);
    if (result.changed.length === 0) return result;

    // Native addons don't change on checkout; keep the hook fast.
    const report = diagnose(cwd, { native: false });
    const problems = report.findings.filter((f) => f.severity === "error");
    if (problems.length === 0) return { ...result, action: "ok" };

    const listed = result.changed.slice(0, 3).join(", ") + (result.changed.length > 3 ? ", …" : "");
    log(`\n📦 cleaninstall-node: dependencies changed (${listed})`);
    for (const f of problems) log(`   ✖ ${f.title}`);

    const { steps, blocked, manual } = report.plan;
    const autoSteps = steps.filter((s) => s.kind === "install" || s.kind === "rebuild");

    if (blocked.length > 0) {
      for (const m of manual) log(`   → ${m}, then run: npx cleaninstall-node doctor --fix`);
      return { ...result, action: "warned" };
    }

    if (mode === "install" && autoSteps.length === steps.length && autoSteps.length > 0 && options.execa) {
      for (const step of autoSteps) {
        log(`   → running ${step.label}`);
        await options.execa(step.cmd, step.args, { stdio: "inherit", cwd });
      }
      log("   ✔ dependencies are up to date\n");
      return { ...result, action: "installed" };
    }

    for (const s of steps) log(`   → run: ${s.label}`);
    log("   (or: npx cleaninstall-node doctor --fix)\n");
    return { ...result, action: "warned" };
  } catch (error) {
    log(`cleaninstall-node hook: ${error && error.message ? error.message : error}`);
    return { ...result, action: "error" };
  }
}

// ---------------------------------------------------------------------------
// Installing the hook scripts
// ---------------------------------------------------------------------------

// Where hook scripts live. With husky, write to .husky/ (committed, so the
// whole team gets them); otherwise the repo's hooks dir (respects core.hooksPath).
function resolveHooksDir(cwd) {
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  let hooksPath = "";
  try {
    hooksPath = git(["config", "core.hooksPath"], cwd);
  } catch {
    // not set
  }
  if (/(^|\/)\.husky(\/_)?\/?$/.test(hooksPath) && fs.existsSync(path.join(top, ".husky"))) {
    return { dir: path.join(top, ".husky"), kind: "husky" };
  }
  if (hooksPath) return { dir: path.resolve(top, hooksPath), kind: "core.hooksPath" };
  return { dir: path.resolve(cwd, git(["rev-parse", "--git-path", "hooks"], cwd)), kind: "git" };
}

function hookBlock(event, mode) {
  const modeArg = mode && mode !== "warn" ? ` --mode ${mode}` : "";
  const run = `hook run ${event}${modeArg} "$@"`;
  return [
    MARK_START,
    "# Warns when this checkout/pull/rebase changed dependencies. https://github.com/ahusan/cleaninstall-node",
    "if [ -x ./node_modules/.bin/cleaninstall-node ]; then",
    `  ./node_modules/.bin/cleaninstall-node ${run} || true`,
    "elif command -v cleaninstall-node >/dev/null 2>&1; then",
    `  cleaninstall-node ${run} || true`,
    "fi",
    MARK_END,
  ].join("\n");
}

function stripBlock(content) {
  const re = new RegExp(`\\n?${MARK_START}[\\s\\S]*?${MARK_END}\\n?`, "g");
  return content.replace(re, "\n");
}

function installHooks(options = {}) {
  const cwd = path.resolve(options.dir || process.cwd());
  const mode = options.mode || "warn";
  if (!MODES.includes(mode)) throw new Error(`Unknown mode "${mode}" (use ${MODES.join(" or ")})`);
  const { dir, kind } = resolveHooksDir(cwd);
  fs.mkdirSync(dir, { recursive: true });

  const written = [];
  for (const event of HOOKS) {
    const file = path.join(dir, event);
    const block = hookBlock(event, mode);
    let content;
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, "utf8");
      const base = stripBlock(existing).replace(/\s+$/, "");
      content = `${base || "#!/bin/sh"}\n\n${block}\n`;
    } else {
      content = `#!/bin/sh\n\n${block}\n`;
    }
    fs.writeFileSync(file, content);
    fs.chmodSync(file, 0o755);
    written.push(file);
  }
  return { dir, kind, mode, files: written };
}

function uninstallHooks(options = {}) {
  const cwd = path.resolve(options.dir || process.cwd());
  const { dir, kind } = resolveHooksDir(cwd);
  const removed = [];
  for (const event of HOOKS) {
    const file = path.join(dir, event);
    if (!fs.existsSync(file)) continue;
    const existing = fs.readFileSync(file, "utf8");
    if (!existing.includes(MARK_START)) continue;
    const rest = stripBlock(existing).trim();
    if (rest === "" || rest === "#!/bin/sh" || rest === "#!/usr/bin/env sh") {
      fs.unlinkSync(file);
    } else {
      fs.writeFileSync(file, rest + "\n");
    }
    removed.push(file);
  }
  return { dir, kind, files: removed };
}

module.exports = {
  HOOKS,
  isDependencyFile,
  rangeFor,
  changedDependencyFiles,
  runHook,
  installHooks,
  uninstallHooks,
  resolveHooksDir,
};
