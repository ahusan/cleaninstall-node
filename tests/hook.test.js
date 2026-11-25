// git hook: real temporary git repositories, no network.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  isDependencyFile,
  rangeFor,
  runHook,
  installHooks,
  uninstallHooks,
} = require("../lib/hook");

let root;
const savedEnv = {};
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const write = (rel, content) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};
const json = (o) => JSON.stringify(o, null, 2);

// package.json + lockfile pinning ms@version (committed)
function commitMs(version, message) {
  write("package.json", json({ name: "app", dependencies: { ms: version } }));
  write(
    "package-lock.json",
    json({ lockfileVersion: 3, packages: { "": { dependencies: { ms: version } }, "node_modules/ms": { version } } })
  );
  git("add", "-A");
  git("commit", "-qm", message);
  return git("rev-parse", "HEAD");
}

// Pretend npm installed ms@version (node_modules is gitignored)
function installMs(version) {
  write("node_modules/.package-lock.json", json({ packages: { "node_modules/ms": { version } } }));
  write("node_modules/ms/package.json", json({ name: "ms", version }));
}

beforeEach(() => {
  for (const k of ["CI", "CLEANINSTALL_SKIP_HOOK", "CLEANINSTALL_HOOK_MODE"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cin-hook-")));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  write(".gitignore", "node_modules\n");
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("change detection", () => {
  test("dependency files", () => {
    expect(isDependencyFile("package-lock.json")).toBe(true);
    expect(isDependencyFile("packages/a/package.json")).toBe(true);
    expect(isDependencyFile(".nvmrc")).toBe(true);
    expect(isDependencyFile("src/index.js")).toBe(false);
    expect(isDependencyFile("vendor/node_modules/x/package.json")).toBe(false);
  });

  test("which hook invocations compare which commits", () => {
    expect(rangeFor("post-checkout", ["a1", "b2", "1"])).toEqual(["a1", "b2"]);
    expect(rangeFor("post-checkout", ["a1", "b2", "0"])).toBeNull(); // file checkout
    expect(rangeFor("post-checkout", ["a1", "a1", "1"])).toBeNull(); // checkout -b
    expect(rangeFor("post-checkout", ["0000000", "b2", "1"])).toBeNull(); // clone
    expect(rangeFor("post-merge", ["0"])).toEqual(["ORIG_HEAD", "HEAD"]);
    expect(rangeFor("post-rewrite", ["rebase"])).toEqual(["ORIG_HEAD", "HEAD"]);
    expect(rangeFor("post-rewrite", ["amend"])).toBeNull();
  });
});

describe("runHook", () => {
  let logs;
  const log = (m) => logs.push(m);
  beforeEach(() => {
    logs = [];
  });

  test("silent when no dependency file changed", async () => {
    const a = commitMs("2.1.3", "init");
    write("README.md", "hi");
    git("add", "-A");
    git("commit", "-qm", "docs");
    const b = git("rev-parse", "HEAD");
    installMs("2.1.3");
    const res = await runHook("post-checkout", [a, b, "1"], { dir: root, log });
    expect(res.changed).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("silent when dependencies changed but node_modules already matches", async () => {
    const a = commitMs("2.1.3", "init");
    const b = commitMs("2.1.2", "downgrade");
    installMs("2.1.2");
    const res = await runHook("post-checkout", [a, b, "1"], { dir: root, log });
    expect(res.changed.sort()).toEqual(["package-lock.json", "package.json"]);
    expect(res.action).toBe("ok");
    expect(logs).toEqual([]);
  });

  test("warns with the command to run when node_modules is stale", async () => {
    const a = commitMs("2.1.3", "init");
    const b = commitMs("2.1.2", "downgrade");
    installMs("2.1.3");
    const execa = jest.fn();
    const res = await runHook("post-checkout", [a, b, "1"], { dir: root, log, execa });
    expect(res.action).toBe("warned");
    expect(execa).not.toHaveBeenCalled();
    const out = logs.join("\n");
    expect(out).toContain("dependencies changed");
    expect(out).toContain("node_modules is out of sync with package-lock.json");
    expect(out).toContain("→ run: npm install");
  });

  test("post-merge compares ORIG_HEAD..HEAD", async () => {
    commitMs("2.1.3", "init");
    git("checkout", "-qb", "other");
    commitMs("2.1.2", "downgrade");
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-edit", "other"); // fast-forward, sets ORIG_HEAD
    installMs("2.1.3");
    const res = await runHook("post-merge", ["0"], { dir: root, log });
    expect(res.action).toBe("warned");
  });

  test("install mode runs the install", async () => {
    const a = commitMs("2.1.3", "init");
    const b = commitMs("2.1.2", "downgrade");
    installMs("2.1.3");
    const execa = jest.fn(async () => installMs("2.1.2"));
    const res = await runHook("post-checkout", [a, b, "1"], { dir: root, log, execa, mode: "install" });
    expect(res.action).toBe("installed");
    expect(execa).toHaveBeenCalledWith("npm", ["install"], expect.objectContaining({ cwd: root }));
  });

  test("CLEANINSTALL_HOOK_MODE overrides the installed mode", async () => {
    const a = commitMs("2.1.3", "init");
    const b = commitMs("2.1.2", "downgrade");
    installMs("2.1.3");
    process.env.CLEANINSTALL_HOOK_MODE = "warn";
    const execa = jest.fn();
    const res = await runHook("post-checkout", [a, b, "1"], { dir: root, log, execa, mode: "install" });
    expect(res.action).toBe("warned");
    expect(execa).not.toHaveBeenCalled();
  });

  test("never installs when the Node version is wrong", async () => {
    const a = commitMs("2.1.3", "init");
    write(".nvmrc", "10\n");
    const b = commitMs("2.1.2", "downgrade + pin old node");
    installMs("2.1.3");
    const execa = jest.fn();
    await runHook("post-checkout", [a, b, "1"], { dir: root, log, execa, mode: "install" });
    expect(execa).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("nvm use");
  });

  test.each([
    ["CI", "true"],
    ["CLEANINSTALL_SKIP_HOOK", "1"],
  ])("skipped when %s=%s", async (key, value) => {
    const a = commitMs("2.1.3", "init");
    const b = commitMs("2.1.2", "downgrade");
    installMs("2.1.3");
    process.env[key] = value;
    const res = await runHook("post-checkout", [a, b, "1"], { dir: root, log });
    expect(res.action).toBe("skipped");
    expect(logs).toEqual([]);
  });

  test("post-checkout during a rebase is skipped (post-rewrite reports instead)", async () => {
    const a = commitMs("2.1.3", "init");
    const b = commitMs("2.1.2", "downgrade");
    installMs("2.1.3");
    fs.mkdirSync(path.join(root, ".git", "rebase-merge"));
    expect((await runHook("post-checkout", [a, b, "1"], { dir: root, log })).action).toBe("skipped");
    git("update-ref", "ORIG_HEAD", a);
    expect((await runHook("post-rewrite", ["rebase"], { dir: root, log })).action).toBe("warned");
  });

  test("never throws outside a git repo", async () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "cin-norepo-"));
    try {
      const res = await runHook("post-merge", ["0"], { dir: notRepo, log });
      expect(res.action).toBe("skipped");
    } finally {
      fs.rmSync(notRepo, { recursive: true, force: true });
    }
  });
});

describe("installing hooks", () => {
  test("outside a git repository: a clear error", () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "cin-norepo2-"));
    try {
      expect(() => installHooks({ dir: notRepo })).toThrow(/isn't inside a git repository/);
    } finally {
      fs.rmSync(notRepo, { recursive: true, force: true });
    }
  });

  const hooksDir = () => path.join(root, ".git", "hooks");

  test("creates executable post-checkout/post-merge/post-rewrite and is idempotent", () => {
    installHooks({ dir: root });
    installHooks({ dir: root });
    for (const h of ["post-checkout", "post-merge", "post-rewrite"]) {
      const file = path.join(hooksDir(), h);
      const content = fs.readFileSync(file, "utf8");
      expect(content.startsWith("#!/bin/sh")).toBe(true);
      expect(content.match(/>>> cleaninstall-node >>>/g)).toHaveLength(1);
      expect(content).toContain(`hook run ${h} "$@"`);
      if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o111).not.toBe(0);
    }
  });

  test("--mode install is written into the hook", () => {
    installHooks({ dir: root, mode: "install" });
    expect(fs.readFileSync(path.join(hooksDir(), "post-merge"), "utf8")).toContain("hook run post-merge --mode install");
    expect(() => installHooks({ dir: root, mode: "nuke" })).toThrow(/Unknown mode/);
  });

  test("keeps existing hook content; uninstall restores it", () => {
    fs.mkdirSync(hooksDir(), { recursive: true });
    fs.writeFileSync(path.join(hooksDir(), "post-merge"), "#!/bin/sh\necho team-hook\n");
    installHooks({ dir: root });
    const merged = fs.readFileSync(path.join(hooksDir(), "post-merge"), "utf8");
    expect(merged).toContain("echo team-hook");
    expect(merged).toContain("cleaninstall-node hook run post-merge");

    uninstallHooks({ dir: root });
    expect(fs.readFileSync(path.join(hooksDir(), "post-merge"), "utf8")).toBe("#!/bin/sh\necho team-hook\n");
    expect(fs.existsSync(path.join(hooksDir(), "post-checkout"))).toBe(false);
  });

  test("uses .husky/ when husky owns core.hooksPath", () => {
    fs.mkdirSync(path.join(root, ".husky", "_"), { recursive: true });
    git("config", "core.hooksPath", ".husky/_");
    const res = installHooks({ dir: root });
    expect(res.kind).toBe("husky");
    expect(fs.existsSync(path.join(root, ".husky", "post-checkout"))).toBe(true);
    expect(fs.existsSync(path.join(hooksDir(), "post-checkout"))).toBe(false);
  });

  test("the installed script actually runs through git", () => {
    // Real end-to-end: a fake `cleaninstall-node` on PATH records its args.
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "cin-bin-"));
    const record = path.join(binDir, "calls.txt");
    fs.writeFileSync(path.join(binDir, "cleaninstall-node"), `#!/bin/sh\necho "$@" >> "${record}"\n`);
    fs.chmodSync(path.join(binDir, "cleaninstall-node"), 0o755);
    try {
      commitMs("2.1.3", "init");
      installHooks({ dir: root });
      git("checkout", "-qb", "other");
      commitMs("2.1.2", "downgrade");
      execFileSync("git", ["checkout", "-q", "main"], {
        cwd: root,
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
      });
      expect(fs.readFileSync(record, "utf8")).toMatch(/^hook run post-checkout [0-9a-f]{40} [0-9a-f]{40} 1$/m);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});
