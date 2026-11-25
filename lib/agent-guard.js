#!/usr/bin/env node
// cleaninstall-node agent guard: a Claude Code PreToolUse hook that stops AI
// agents from deleting node_modules or lockfiles and points them at a
// diagnosis instead. Installed by `npx cleaninstall-node agent install`.
//
// Standalone on purpose (Node built-ins only): it is copied into the project
// and must work even when node_modules is missing or broken, and it runs on
// every Bash call, so it must be fast. On any internal error it allows the
// command (exit 0, no output) rather than get in the agent's way.
// Turn it off for a session with CLEANINSTALL_GUARD=off.

const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
];

// --- tokenising ------------------------------------------------------------

// Split a command line into simple commands on ; && || | & and newlines,
// respecting quotes. Pipes are kept as boundaries too.
function splitCommands(line) {
  const parts = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < line.length) {
        cur += c + line[++i];
        continue;
      }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ";" || c === "\n" || c === "|" || c === "&") {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      if ((c === "|" || c === "&") && line[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// Shell-ish word splitting with quote removal.
function words(cmd) {
  const out = [];
  let cur = "";
  let quote = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has || cur) out.push(cur);
  return out;
}

const basename = (p) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop();

// node_modules itself (or every package in it), not something inside it:
// `node_modules`, `./node_modules/`, `packages/*/node_modules`, `node_modules/*`.
// `node_modules/.cache` or `node_modules/.vite` are targeted cache clears: allowed.
function isNodeModulesTarget(t) {
  const p = t.replace(/^\.[\\/]/, "").replace(/[\\/]+$/, "");
  return basename(p) === "node_modules" || /(^|[\\/])node_modules[\\/]\*$/.test(p);
}
const isLockfile = (t) => LOCKFILES.includes(basename(t));

// Strip wrappers to find the real program: sudo, env, VAR=1, time, nohup,
// command, npx/pnpm dlx/yarn dlx/bunx/npm exec.
function program(argv) {
  let a = argv.slice();
  for (;;) {
    if (!a.length) return a;
    const first = a[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) a = a.slice(1);
    else if (["sudo", "nohup", "time", "command", "builtin", "exec"].includes(first)) a = a.slice(1).filter((x, i) => i > 0 || !x.startsWith("-"));
    else if (first === "env") a = a.slice(1).filter((x, i, arr) => !(i === 0 && x.startsWith("-")));
    else if (first === "npx" || first === "bunx" || first === "pnpx") a = a.slice(1).filter((x) => !/^(-y|--yes|--no-install|-p|--package)$/.test(x));
    else if ((first === "pnpm" || first === "yarn") && a[1] === "dlx") a = a.slice(2);
    else if (first === "npm" && a[1] === "exec") a = a.slice(2).filter((x) => x !== "--" && !/^(-y|--yes)$/.test(x));
    else return a;
  }
}

// --- detection ---------------------------------------------------------------

function inspectSimple(cmd, hits, depth) {
  const argv = program(words(cmd));
  if (!argv.length) return;
  const prog = basename(argv[0]).toLowerCase().replace(/\.exe$/, "");
  const args = argv.slice(1);
  const flags = args.filter((a) => a.startsWith("-") || /^\/[a-z]$/i.test(a));
  const targets = args.filter((a) => !a.startsWith("-") && !/^\/[a-z]$/i.test(a));

  // Nested shells: bash -c "rm -rf node_modules"
  if (["bash", "sh", "zsh", "dash"].includes(prog) && depth < 3) {
    const i = args.indexOf("-c");
    if (i !== -1 && args[i + 1]) inspect(args[i + 1], hits, depth + 1);
    return;
  }

  const recursive =
    flags.some((f) => /^-[a-zA-Z]*[rR]/.test(f) || f === "--recursive") ||
    flags.some((f) => /^-recurse$/i.test(f) || /^\/s$/i.test(f));

  if (prog === "rm" || prog === "unlink") {
    for (const t of targets) {
      if (isLockfile(t)) hits.push({ kind: "lockfile", target: t });
      else if (recursive && isNodeModulesTarget(t)) hits.push({ kind: "node_modules", target: t });
    }
    return;
  }
  if (["rimraf", "del", "del-cli", "trash", "rmrf"].includes(prog) && prog !== "del") {
    for (const t of targets) {
      if (isLockfile(t)) hits.push({ kind: "lockfile", target: t });
      else if (isNodeModulesTarget(t)) hits.push({ kind: "node_modules", target: t });
    }
    return;
  }
  // PowerShell and Windows cmd
  if (["remove-item", "ri", "rmdir", "rd", "del", "erase"].includes(prog)) {
    for (const t of targets) {
      if (isLockfile(t)) hits.push({ kind: "lockfile", target: t });
      else if (isNodeModulesTarget(t) && (recursive || prog === "remove-item" || prog === "ri")) {
        hits.push({ kind: "node_modules", target: t });
      }
    }
    return;
  }
  // git clean -x / -X deletes ignored files, which includes node_modules.
  if (prog === "git" && args[0] === "clean") {
    const f = args.slice(1).filter((x) => x.startsWith("-") && !x.startsWith("--"));
    const force = f.some((x) => x.includes("f")) || args.includes("--force");
    if (force && f.some((x) => /[xX]/.test(x))) hits.push({ kind: "node_modules", target: "git clean -x" });
    return;
  }
  // find . -name node_modules -exec rm -rf {} + / -delete
  if (prog === "find") {
    const named = args.some((a, i) => /^-i?name$/.test(args[i - 1] || "") && basename(a) === "node_modules");
    if (named && (args.includes("-delete") || /-exec(dir)?\s+rm\b/.test(args.join(" ")))) {
      hits.push({ kind: "node_modules", target: "find -name node_modules" });
    }
    const lock = args.find((a, i) => /^-i?name$/.test(args[i - 1] || "") && isLockfile(a));
    if (lock && (args.includes("-delete") || /-exec(dir)?\s+rm\b/.test(args.join(" ")))) {
      hits.push({ kind: "lockfile", target: lock });
    }
  }
}

function inspect(line, hits, depth = 0) {
  const parts = splitCommands(line);
  for (const part of parts) inspectSimple(part, hits, depth);
  // find ... -name node_modules ... | xargs rm -rf
  if (/\bfind\b[^|]*-i?name\s+['"]?node_modules\b[^|]*\|\s*xargs\s+(sudo\s+)?rm\b/.test(line)) {
    hits.push({ kind: "node_modules", target: "find | xargs rm" });
  }
  // node -e "fs.rmSync('node_modules', { recursive: true })"
  const js = line.match(/\b(?:rmSync|rmdirSync|rm|rmdir)\(\s*['"`]([^'"`]+)['"`]/g) || [];
  for (const m of js) {
    const t = m.replace(/^.*\(\s*['"`]/, "").replace(/['"`]$/, "");
    if (isNodeModulesTarget(t)) hits.push({ kind: "node_modules", target: t });
    else if (isLockfile(t)) hits.push({ kind: "lockfile", target: t });
  }
  return hits;
}

/**
 * @param {string} command - a shell command line
 * @returns {{blocked: boolean, hits: Array<{kind: string, target: string}>, reason?: string}}
 */
function checkCommand(command) {
  const hits = [];
  inspect(String(command || ""), hits);
  const unique = hits.filter((h, i) => hits.findIndex((x) => x.kind === h.kind && x.target === h.target) === i);
  if (!unique.length) return { blocked: false, hits: [] };
  return { blocked: true, hits: unique, reason: reasonFor(unique) };
}

function reasonFor(hits) {
  const lock = hits.filter((h) => h.kind === "lockfile").map((h) => basename(h.target));
  const nm = hits.some((h) => h.kind === "node_modules");
  const what = [nm ? "node_modules" : null, lock.length ? [...new Set(lock)].join(", ") : null].filter(Boolean).join(" and ");
  return [
    `Blocked by the cleaninstall-node guard: this command deletes ${what}.`,
    lock.length
      ? "Deleting a lockfile makes the next install resolve different dependency versions; only do that if the user explicitly asked for it."
      : "Deleting node_modules rarely fixes the real cause and makes the user wait for a full reinstall.",
    "Do this instead:",
    '1. Diagnose: npx cleaninstall-node doctor --from-error "<the error output>" (or the explain_error MCP tool), then apply its smallest fix with --fix.',
    "2. If a fresh install is really needed: npx cleaninstall-node -y --install (removes node_modules, keeps lockfiles).",
    "3. Only if the user explicitly asked to reset lockfiles too: npx cleaninstall-node -y --lockfiles --install.",
    "If the user explicitly asked for this exact command, tell them the cleaninstall-node hook in .claude/settings.json blocked it (they can run it themselves, or set CLEANINSTALL_GUARD=off).",
  ].join("\n");
}

// --- hook entry point ----------------------------------------------------------

function main() {
  if (String(process.env.CLEANINSTALL_GUARD || "").toLowerCase() === "off") return;
  const decision = process.argv.includes("--ask") ? "ask" : "deny";
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (input += c));
  process.stdin.on("end", () => {
    try {
      const event = JSON.parse(input);
      if (event.tool_name !== "Bash") return;
      const result = checkCommand(event.tool_input && event.tool_input.command);
      if (!result.blocked) return;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: decision,
            permissionDecisionReason: result.reason,
          },
        })
      );
    } catch {
      // Never break the agent because of the guard itself.
    }
  });
}

if (require.main === module) main();

module.exports = { checkCommand, splitCommands, words, LOCKFILES };
