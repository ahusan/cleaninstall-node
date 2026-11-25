// agent install/uninstall and the Claude Code guard hook.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { checkCommand } = require("../lib/agent-guard");
const { installAgent, uninstallAgent, START } = require("../lib/agent");

const GUARD = path.resolve(__dirname, "../lib/agent-guard.js");
const CLI = path.resolve(__dirname, "../bin/cleanup.js");

let root;
const file = (rel) => path.join(root, rel);
const read = (rel) => fs.readFileSync(file(rel), "utf8");
const write = (rel, content) => {
  fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
  fs.writeFileSync(file(rel), content);
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cin-agent-")));
  write("package.json", JSON.stringify({ name: "app" }));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("guard: what gets blocked", () => {
  test.each([
    "rm -rf node_modules",
    "rm -rf node_modules package-lock.json && npm install",
    "rm -fr ./node_modules/",
    "rm -r -f node_modules",
    "cd web && rm -rf node_modules",
    "sudo rm -rf node_modules",
    "FOO=1 rm -rf node_modules",
    'rm -rf "node_modules"',
    "rm -rf packages/*/node_modules",
    "rm -rf **/node_modules",
    "rm -rf node_modules/*",
    "npx rimraf node_modules",
    "npx -y rimraf node_modules",
    "pnpm dlx rimraf node_modules",
    "find . -name node_modules -type d -prune -exec rm -rf {} +",
    'find . -name "node_modules" -prune | xargs rm -rf',
    "Remove-Item -Recurse -Force node_modules",
    "rd /s /q node_modules",
    "rmdir /s /q node_modules",
    'bash -c "rm -rf node_modules"',
    "git clean -fdx",
    "git clean -xdf",
    "node -e \"require('fs').rmSync('node_modules',{recursive:true})\"",
    "rm package-lock.json",
    "rm -f yarn.lock pnpm-lock.yaml",
    "rm bun.lockb",
    "del package-lock.json",
    "find . -name package-lock.json -delete",
  ])("blocks: %s", (cmd) => {
    expect(checkCommand(cmd).blocked).toBe(true);
  });

  test.each([
    "rm -rf node_modules/.cache",
    "rm -rf node_modules/.vite",
    "rm -rf .next node_modules/.cache",
    "rm node_modules/.bin/foo",
    "ls node_modules",
    "rm -rf dist build",
    'git commit -m "rm -rf node_modules"',
    "echo rm -rf node_modules",
    'grep -r "rm -rf node_modules" docs',
    "npm install",
    "npx cleaninstall-node -y --lockfiles --install",
    "git clean -fd",
    "git rm --cached -r node_modules",
    "rm -f node_modules.zip",
    "rm -rf my_node_modules_backup",
    "cat package-lock.json | jq .",
    "rm node_modules", // not recursive: fails on a directory anyway
  ])("allows: %s", (cmd) => {
    expect(checkCommand(cmd).blocked).toBe(false);
  });

  test("reason names what's deleted and offers the safe commands", () => {
    const r = checkCommand("rm -rf node_modules yarn.lock");
    expect(r.reason).toContain("deletes node_modules and yarn.lock");
    expect(r.reason).toContain("cleaninstall-node doctor --from-error");
    expect(r.reason).toContain("npx cleaninstall-node -y --install");
  });
});

describe("guard as a Claude Code PreToolUse hook (stdin/stdout contract)", () => {
  const run = (event, args = [], env = {}) =>
    spawnSync(process.execPath, [GUARD, ...args], {
      input: typeof event === "string" ? event : JSON.stringify(event),
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  const bash = (command) => ({
    session_id: "s",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "x" },
    cwd: root,
  });

  test("denies with a reason Claude can read", () => {
    const res = run(bash("rm -rf node_modules"));
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout).hookSpecificOutput;
    expect(out.hookEventName).toBe("PreToolUse");
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain("Blocked by the cleaninstall-node guard");
  });

  test("--ask asks instead of denying", () => {
    expect(JSON.parse(run(bash("rm -rf node_modules"), ["--ask"]).stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  test.each([
    ["an allowed command", bash("npm test")],
    ["another tool", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "x" } }],
    ["invalid JSON", "{not json"],
  ])("stays silent for %s (normal permission flow)", (_, event) => {
    const res = run(event);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
  });

  test("CLEANINSTALL_GUARD=off disables it", () => {
    expect(run(bash("rm -rf node_modules"), [], { CLEANINSTALL_GUARD: "off" }).stdout).toBe("");
  });
});

describe("agent install", () => {
  test("fresh project: AGENTS.md, CLAUDE.md importing it, guard script and hook", () => {
    const res = installAgent({ dir: root });
    expect(res.changes).toEqual([
      { file: "AGENTS.md", action: "created" },
      { file: "CLAUDE.md", action: "created" },
      { file: path.join(".claude", "hooks", "cleaninstall-guard.cjs"), action: "created" },
      { file: path.join(".claude", "settings.json"), action: "created" },
    ]);
    expect(read("AGENTS.md")).toContain("npx cleaninstall-node doctor --from-error");
    // Claude Code ignores AGENTS.md when a CLAUDE.md exists, so CLAUDE.md imports it.
    expect(read("CLAUDE.md")).toContain("@AGENTS.md");
    expect(read(".claude/hooks/cleaninstall-guard.cjs")).toBe(fs.readFileSync(GUARD, "utf8"));
    const settings = JSON.parse(read(".claude/settings.json"));
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/cleaninstall-guard.cjs"', timeout: 10 }],
      },
    ]);
  });

  test("is idempotent", () => {
    installAgent({ dir: root });
    const second = installAgent({ dir: root });
    expect(second.changes.every((c) => c.action === "unchanged")).toBe(true);
    expect(read("AGENTS.md").split(START).length).toBe(2);
    expect(JSON.parse(read(".claude/settings.json")).hooks.PreToolUse).toHaveLength(1);
  });

  test("appends to an existing CLAUDE.md and keeps the user's content", () => {
    write("CLAUDE.md", "# My project\n\nUse pnpm.\n");
    installAgent({ dir: root });
    const text = read("CLAUDE.md");
    expect(text.startsWith("# My project\n\nUse pnpm.\n\n")).toBe(true);
    expect(text).toContain("Do **not** delete `node_modules`");
    expect(text).not.toContain("@AGENTS.md");
  });

  test("merges into existing settings without losing permissions or other hooks", () => {
    const existing = {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./lint-guard.sh" }] }],
        PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "prettier" }] }],
      },
    };
    write(".claude/settings.json", JSON.stringify(existing));
    const res = installAgent({ dir: root });
    expect(res.changes.find((c) => c.file.endsWith("settings.json")).action).toBe("added hook");
    const s = JSON.parse(read(".claude/settings.json"));
    expect(s.permissions).toEqual(existing.permissions);
    expect(s.hooks.PostToolUse).toEqual(existing.hooks.PostToolUse);
    expect(s.hooks.PreToolUse).toHaveLength(2);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe("./lint-guard.sh");
  });

  test("refuses to touch invalid settings.json, and writes nothing else either", () => {
    write(".claude/settings.json", "{ oops");
    expect(() => installAgent({ dir: root })).toThrow(/isn't valid JSON/);
    expect(read(".claude/settings.json")).toBe("{ oops");
    expect(fs.existsSync(file("AGENTS.md"))).toBe(false);
  });

  test("--ask, --no-hook and --dry-run", () => {
    installAgent({ dir: root, mode: "ask" });
    expect(JSON.parse(read(".claude/settings.json")).hooks.PreToolUse[0].hooks[0].command).toMatch(/--ask$/);

    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cin-agent2-")));
    try {
      fs.writeFileSync(path.join(other, "package.json"), "{}");
      expect(installAgent({ dir: other, dryRun: true }).changes.every((c) => c.action === "would write")).toBe(true);
      expect(fs.readdirSync(other)).toEqual(["package.json"]);
      installAgent({ dir: other, hook: false });
      expect(fs.existsSync(path.join(other, ".claude"))).toBe(false);
      expect(fs.existsSync(path.join(other, "AGENTS.md"))).toBe(true);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  test("Copilot and Cursor files only when those tools are already set up", () => {
    installAgent({ dir: root });
    expect(fs.existsSync(file(".github/copilot-instructions.md"))).toBe(false);
    expect(fs.existsSync(file(".cursor"))).toBe(false);

    write(".github/copilot-instructions.md", "Be nice.\n");
    fs.mkdirSync(file(".cursor"));
    installAgent({ dir: root });
    expect(read(".github/copilot-instructions.md")).toContain("Be nice.");
    expect(read(".github/copilot-instructions.md")).toContain("cleaninstall-node doctor");
    expect(read(".cursor/rules/cleaninstall-node.mdc")).toMatch(/^---\ndescription: .+\nalwaysApply: true\n---/);
  });

  test("needs a package.json", () => {
    fs.unlinkSync(file("package.json"));
    expect(() => installAgent({ dir: root })).toThrow(/No package.json/);
  });
});

describe("agent uninstall", () => {
  test("removes only what install added", () => {
    write("CLAUDE.md", "# Mine\n");
    write(
      ".claude/settings.json",
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./other.sh" }] }] } })
    );
    installAgent({ dir: root });
    const res = uninstallAgent({ dir: root });
    expect(res.changes.map((c) => c.action)).toEqual(expect.arrayContaining(["deleted", "removed block", "removed hook"]));
    expect(fs.existsSync(file("AGENTS.md"))).toBe(false); // created by us, now empty
    expect(read("CLAUDE.md")).toBe("# Mine\n");
    expect(fs.existsSync(file(".claude/hooks/cleaninstall-guard.cjs"))).toBe(false);
    expect(JSON.parse(read(".claude/settings.json"))).toEqual({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./other.sh" }] }] },
    });
  });

  test("leaves an empty settings object when ours was the only hook", () => {
    installAgent({ dir: root });
    uninstallAgent({ dir: root });
    expect(JSON.parse(read(".claude/settings.json"))).toEqual({});
  });
});

describe("end to end", () => {
  test("the installed hook command blocks rm -rf node_modules when run the way Claude Code runs it", () => {
    installAgent({ dir: root });
    const { command } = JSON.parse(read(".claude/settings.json")).hooks.PreToolUse[0].hooks[0];
    const res = spawnSync("sh", ["-c", command], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf node_modules" } }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    expect(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("CLI: agent check exits 1 when blocked, 0 when allowed", () => {
    const blocked = spawnSync(process.execPath, [CLI, "agent", "check", "rm", "-rf", "node_modules"], { encoding: "utf8" });
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toContain("Blocked by the cleaninstall-node guard");
    const allowed = spawnSync(process.execPath, [CLI, "agent", "check", "npm", "test"], { encoding: "utf8" });
    expect(allowed.status).toBe(0);
    expect(allowed.stdout.trim()).toBe("allowed");
  });

  test("CLI: agent install prints what it wrote", () => {
    const res = spawnSync(process.execPath, [CLI, "agent", "install", "--dir", root], { encoding: "utf8" });
    expect(res.status).toBe(0);
    for (const f of ["AGENTS.md", "CLAUDE.md", ".claude/settings.json"]) expect(res.stdout).toContain(f);
  });
});
