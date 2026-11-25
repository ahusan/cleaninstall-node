// `cleaninstall-node agent install|uninstall|check`: teach AI coding agents to
// diagnose broken installs instead of deleting node_modules and lockfiles.
//
// - Instruction files: a marked block in AGENTS.md (read by most agents),
//   CLAUDE.md (Claude Code reads AGENTS.md only when there is no CLAUDE.md),
//   and .github/copilot-instructions.md / .cursor/rules when those tools are set up.
// - Claude Code hook: a PreToolUse guard in .claude/settings.json that denies
//   (or asks about) Bash commands deleting node_modules or lockfiles.
const fs = require("fs");
const path = require("path");
const { checkCommand } = require("./agent-guard");
const { findOnPath } = require("./project");

const START = "<!-- cleaninstall-node:start -->";
const END = "<!-- cleaninstall-node:end -->";
// .cjs so both Node and Deno run it as CommonJS. 3.2.0 installed a .js copy.
const GUARD_FILE = path.join(".claude", "hooks", "cleaninstall-guard.cjs");
const OLD_GUARD_FILE = path.join(".claude", "hooks", "cleaninstall-guard.js");
const GUARD_MARK = "cleaninstall-guard";

const GUIDANCE = `## Broken installs (cleaninstall-node)

When an install, build, dev server or test fails with a dependency error (\`Cannot find module\`, \`NODE_MODULE_VERSION\`, \`ERESOLVE\`, \`EBADENGINE\`, missing rollup/esbuild/sharp binaries, \`command not found\`, lockfile out of sync):

- Do **not** delete \`node_modules\` or lockfiles to "start fresh". Diagnose first:
  \`npx cleaninstall-node doctor --from-error "<error output>"\` (or pipe it: \`<command> 2>&1 | npx cleaninstall-node doctor --from-error\`), or the \`explain_error\` MCP tool if it's available.
- Apply the fix it suggests (\`--fix\`, or the \`apply_fix\` MCP tool), then re-run the command that failed.
- If a fresh install is really needed: \`npx cleaninstall-node -y --install\` (removes node_modules, keeps lockfiles).
- Never delete or regenerate lockfiles unless the user asks; then use \`npx cleaninstall-node -y --lockfiles --install\`.`;

const block = (body) => `${START}\n${body}\n${END}`;
const BLOCK_RE = new RegExp(`\\n*${START}[\\s\\S]*?${END}\\n*`, "g");

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// Insert or replace our block in a text file. Returns the action taken.
function upsertBlock(file, body, { create = true } = {}) {
  const existing = readText(file);
  if (existing === null) {
    if (!create) return null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, block(body) + "\n");
    return "created";
  }
  const rest = existing.replace(BLOCK_RE, "\n\n").replace(/\s+$/, "");
  const next = (rest ? `${rest}\n\n` : "") + block(body) + "\n";
  if (next === existing) return "unchanged";
  fs.writeFileSync(file, next);
  return existing.includes(START) ? "updated" : "appended";
}

function removeBlock(file) {
  const existing = readText(file);
  if (existing === null || !existing.includes(START)) return null;
  const rest = existing.replace(BLOCK_RE, "\n\n").trim();
  if (!rest) {
    fs.unlinkSync(file);
    return "deleted";
  }
  fs.writeFileSync(file, rest + "\n");
  return "removed block";
}

// Node when it's installed; Deno-only machines run the guard with Deno.
function guardRuntime() {
  if (!process.versions.deno) return "node";
  return findOnPath("node") ? "node" : "deno";
}

function guardCommand(mode, runtime = guardRuntime()) {
  const script = `"\${CLAUDE_PROJECT_DIR}/.claude/hooks/cleaninstall-guard.cjs"`;
  const flag = mode === "ask" ? " --ask" : "";
  return runtime === "deno"
    ? `deno run --allow-env=CLEANINSTALL_GUARD ${script}${flag}`
    : `node ${script}${flag}`;
}

function isOurHook(h) {
  return h && typeof h.command === "string" && h.command.includes(GUARD_MARK);
}

function readSettings(file) {
  const text = readText(file);
  if (text === null) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch (e) {
    throw new Error(`${file} isn't valid JSON (${e.message}); fix it or add the hook by hand. Nothing was changed.`);
  }
}

// Remove our hook from settings (in place). Returns true if something was removed.
function stripOurHook(settings) {
  const groups = settings.hooks && Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : null;
  if (!groups) return false;
  let removed = false;
  const kept = [];
  for (const g of groups) {
    const hooks = Array.isArray(g.hooks) ? g.hooks : [];
    const others = hooks.filter((h) => !isOurHook(h));
    if (others.length !== hooks.length) removed = true;
    if (others.length) kept.push({ ...g, hooks: others });
    else if (!hooks.length) kept.push(g);
  }
  if (!removed) return false;
  if (kept.length) settings.hooks.PreToolUse = kept;
  else delete settings.hooks.PreToolUse;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return true;
}

/**
 * Install agent guidance (and the Claude Code guard hook) into a project.
 * @returns {{dir: string, changes: Array<{file: string, action: string}>}}
 */
function installAgent({ dir = process.cwd(), hook = true, mode = "deny", dryRun = false, runtime } = {}) {
  const root = path.resolve(dir);
  if (!fs.existsSync(path.join(root, "package.json"))) {
    throw new Error(`No package.json in ${root}; run this in the project root (or pass --dir).`);
  }
  if (!["deny", "ask"].includes(mode)) throw new Error(`Unknown mode "${mode}" (use deny or ask)`);

  const plan = [];
  const rel = (f) => path.relative(root, f) || f;
  const agents = path.join(root, "AGENTS.md");
  const claude = path.join(root, "CLAUDE.md");
  const copilot = path.join(root, ".github", "copilot-instructions.md");
  const cursorDir = path.join(root, ".cursor");

  plan.push({ file: agents, run: () => upsertBlock(agents, GUIDANCE) });
  // Claude Code only falls back to AGENTS.md when there is no CLAUDE.md.
  // If we created CLAUDE.md (it holds only our block), keep it as an import.
  const claudeText = readText(claude);
  const claudeIsOurs = claudeText === null || !claudeText.replace(BLOCK_RE, "").trim();
  plan.push({ file: claude, run: () => upsertBlock(claude, claudeIsOurs ? "@AGENTS.md" : GUIDANCE) });
  if (fs.existsSync(copilot)) plan.push({ file: copilot, run: () => upsertBlock(copilot, GUIDANCE, { create: false }) });
  if (fs.existsSync(cursorDir)) {
    const rule = path.join(cursorDir, "rules", "cleaninstall-node.mdc");
    const body = `---\ndescription: Diagnose broken Node installs instead of deleting node_modules\nalwaysApply: true\n---\n\n${GUIDANCE}\n`;
    plan.push({
      file: rule,
      run: () => {
        const prev = readText(rule);
        if (prev === body) return "unchanged";
        fs.mkdirSync(path.dirname(rule), { recursive: true });
        fs.writeFileSync(rule, body);
        return prev === null ? "created" : "updated";
      },
    });
  }

  if (hook) {
    const settingsFile = path.join(root, ".claude", "settings.json");
    const guard = path.join(root, GUARD_FILE);
    const settings = readSettings(settingsFile); // validate before touching anything
    plan.push({
      file: guard,
      run: () => {
        const src = fs.readFileSync(path.join(__dirname, "agent-guard.js"), "utf8");
        const old = path.join(root, OLD_GUARD_FILE);
        if (fs.existsSync(old)) fs.unlinkSync(old); // migrate from 3.2.0
        const prev = readText(guard);
        if (prev === src) return "unchanged";
        fs.mkdirSync(path.dirname(guard), { recursive: true });
        fs.writeFileSync(guard, src);
        fs.chmodSync(guard, 0o755);
        return prev === null ? "created" : "updated";
      },
    });
    plan.push({
      file: settingsFile,
      run: () => {
        const existed = fs.existsSync(settingsFile);
        const before = JSON.stringify(settings);
        const hadOurs = stripOurHook(settings);
        settings.hooks = settings.hooks || {};
        settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];
        settings.hooks.PreToolUse.push({
          matcher: "Bash",
          hooks: [{ type: "command", command: guardCommand(mode, runtime), timeout: 10 }],
        });
        if (JSON.stringify(settings) === before) return "unchanged";
        fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
        fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
        return hadOurs ? "updated hook" : existed ? "added hook" : "created";
      },
    });
  }

  const changes = plan.map((p) => ({ file: rel(p.file), action: dryRun ? "would write" : p.run() })).filter((c) => c.action);
  return { dir: root, mode, hook, changes };
}

function uninstallAgent({ dir = process.cwd() } = {}) {
  const root = path.resolve(dir);
  const rel = (f) => path.relative(root, f);
  const changes = [];
  for (const f of ["AGENTS.md", "CLAUDE.md", path.join(".github", "copilot-instructions.md")]) {
    const action = removeBlock(path.join(root, f));
    if (action) changes.push({ file: f, action });
  }
  const rule = path.join(root, ".cursor", "rules", "cleaninstall-node.mdc");
  if (fs.existsSync(rule)) {
    fs.unlinkSync(rule);
    changes.push({ file: rel(rule), action: "deleted" });
  }
  const settingsFile = path.join(root, ".claude", "settings.json");
  if (fs.existsSync(settingsFile)) {
    const settings = readSettings(settingsFile);
    if (stripOurHook(settings)) {
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
      changes.push({ file: rel(settingsFile), action: "removed hook" });
    }
  }
  for (const f of [GUARD_FILE, OLD_GUARD_FILE]) {
    const guard = path.join(root, f);
    if (fs.existsSync(guard)) {
      fs.unlinkSync(guard);
      changes.push({ file: rel(guard), action: "deleted" });
    }
  }
  return { dir: root, changes };
}

module.exports = { installAgent, uninstallAgent, checkCommand, GUIDANCE, START, END };
