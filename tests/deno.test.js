// Deno support: simulated layouts everywhere, plus real `deno install`
// integration tests when Deno is available (CI installs it).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { detectPackageManager, denoNodeModulesMode, denoNpmImports, stripJsonc, LOCKFILES, findOnPath } = require("../lib/project");
const { diagnose, runFixStep } = require("../lib/doctor");
const { installAgent } = require("../lib/agent");
const { isDependencyFile } = require("../lib/hook");

const CLI = path.resolve(__dirname, "../bin/cleanup.js");
const json = (o) => JSON.stringify(o, null, 2);

let root;
function make(base, tree) {
  for (const [name, value] of Object.entries(tree)) {
    const p = path.join(base, name);
    if (typeof value === "string") {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, value);
    } else {
      fs.mkdirSync(p, { recursive: true });
      make(p, value);
    }
  }
}
const exists = (rel) => fs.existsSync(path.join(root, rel));
const ids = (report, severity) => report.findings.filter((f) => !severity || f.severity === severity).map((f) => f.id);

// A Deno-installed package in node_modules/.deno/<name@version> (+ top-level link).
function denoPkg(name, version, { initialized = true, scriptsRun = false } = {}) {
  const dir = `${name.replace("/", "+")}@${version}`;
  const files = { node_modules: { [name]: { "package.json": JSON.stringify({ name, version }) } } };
  if (initialized) files[".initialized"] = "";
  if (scriptsRun) files[".scripts-run"] = "";
  return { [dir]: files };
}
function denoLock(npm, extra = {}) {
  return json({ version: "5", specifiers: {}, npm, ...extra });
}
function linkTop(name, version) {
  const target = path.join(".deno", `${name.replace("/", "+")}@${version}`, "node_modules", name);
  const link = path.join(root, "node_modules", name);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target.replace(/^/, name.includes("/") ? "../" : ""), link);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cin-deno-")));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("detection", () => {
  test("deno.lock, deno.json and deno.jsonc mean Deno", () => {
    make(root, { "package.json": "{}", "deno.lock": denoLock({}) });
    expect(detectPackageManager(root)).toBe("deno");
    fs.rmSync(path.join(root, "deno.lock"));
    fs.rmSync(path.join(root, "package.json"));
    make(root, { "deno.jsonc": '{\n  // comment\n  "imports": { "ms": "npm:ms@^2.1.0", "std": "jsr:@std/path@1" },\n}' });
    expect(detectPackageManager(root)).toBe("deno");
    expect(denoNpmImports(root)).toEqual({ ms: "^2.1.0" });
  });

  test("nodeModulesDir modes", () => {
    make(root, { "deno.json": json({}) });
    expect(denoNodeModulesMode(root)).toBe("none"); // no package.json: global cache
    make(root, { "deno.json": json({ nodeModulesDir: "auto" }) });
    expect(denoNodeModulesMode(root)).toBe("auto");
    make(root, { "deno.json": json({}), "package.json": "{}" });
    expect(denoNodeModulesMode(root)).toBe("manual"); // package.json: Deno uses node_modules
  });

  test("JSONC: comments and trailing commas, but not // inside strings", () => {
    expect(JSON.parse(stripJsonc('{ "u": "https://x//y", /* c */ "a": [1,], // t\n }'))).toEqual({ u: "https://x//y", a: [1] });
  });

  test("deno.lock is a lockfile for --lockfiles; deno files trigger the git hook; scoped npm imports parse", () => {
    expect(LOCKFILES).toContain("deno.lock");
    for (const f of ["deno.lock", "deno.json", "deno.jsonc"]) expect(isDependencyFile(f)).toBe(true);
    make(root, { "deno.json": json({ imports: { "@types/ms": "npm:@types/ms@0.7.34", bare: "npm:left-pad" } }) });
    expect(denoNpmImports(root)).toEqual({ "@types/ms": "0.7.34", "left-pad": "*" });
  });
});

describe("node_modules vs deno.lock", () => {
  const opts = { native: false, nodeVersion: "v22.11.0" };
  function project(lockNpm, store, pkgDeps = { ms: "^2.1.0" }) {
    make(root, {
      "package.json": json({ name: "app", version: "1.0.0", dependencies: pkgDeps }),
      "deno.lock": denoLock(lockNpm),
      node_modules: { ".deno": store },
    });
  }

  test("in sync, with another OS's optional binary absent", () => {
    project(
      {
        "ms@2.1.3": { integrity: "x" },
        "@esbuild/darwin-arm64@0.24.0": { integrity: "x", os: ["darwin"], cpu: ["arm64"] },
        "@types/ms@0.7.34": { integrity: "x" },
      },
      { ...denoPkg("ms", "2.1.3"), ...denoPkg("@types/ms", "0.7.34") }
    );
    linkTop("ms", "2.1.3");
    const report = diagnose(root, opts);
    expect(report.packageManager).toBe("deno");
    expect(report.findings.find((f) => f.id === "lockfile-sync").severity).toBe("ok");
    expect(ids(report, "error")).toEqual([]);
  });

  test("lockfile moved to another version (git pull) -> deno install", () => {
    project({ "ms@2.1.2": { integrity: "x" } }, denoPkg("ms", "2.1.3"));
    linkTop("ms", "2.1.3");
    const report = diagnose(root, opts);
    const sync = report.findings.find((f) => f.id === "lockfile-sync");
    expect(sync.details[0]).toBe("ms: installed 2.1.3, lockfile 2.1.2");
    expect(report.plan.steps.map((s) => s.label)).toEqual(["deno install"]);
  });

  test("missing and half-installed packages", () => {
    project({ "ms@2.1.3": { integrity: "x" }, "debug@4.3.4": { integrity: "x" } }, denoPkg("debug", "4.3.4", { initialized: false }), {});
    const details = diagnose(root, opts).findings.find((f) => f.id === "lockfile-sync").details;
    expect(details).toEqual(expect.arrayContaining(["ms 2.1.3 is not installed", "debug@4.3.4 was only partly installed"]));
  });

  test("install scripts Deno skipped", () => {
    project({ "esbuild@0.24.0": { integrity: "x", scripts: true } }, denoPkg("esbuild", "0.24.0"), { esbuild: "0.24.0" });
    linkTop("esbuild", "0.24.0");
    const f = diagnose(root, opts).findings.find((x) => x.id === "deno-skipped-scripts");
    expect(f.manual).toBe("deno install --allow-scripts=npm:esbuild");
  });

  test("...but not once they've run", () => {
    project({ "esbuild@0.24.0": { integrity: "x", scripts: true } }, denoPkg("esbuild", "0.24.0", { scriptsRun: true }), { esbuild: "0.24.0" });
    linkTop("esbuild", "0.24.0");
    expect(ids(diagnose(root, opts))).not.toContain("deno-skipped-scripts");
  });

  test("node_modules written by npm in a Deno project -> clean reinstall with deno", () => {
    make(root, {
      "package.json": json({ name: "app", dependencies: { ms: "^2" } }),
      "deno.lock": denoLock({ "ms@2.1.3": { integrity: "x" } }),
      node_modules: { ".package-lock.json": "{}", ms: { "package.json": json({ name: "ms", version: "2.1.3" }) } },
    });
    const report = diagnose(root, opts);
    expect(ids(report, "error")).toEqual(["wrong-installer"]);
    expect(report.plan.steps[0]).toEqual(expect.objectContaining({ kind: "reinstall", cmd: "deno", args: ["install"] }));
  });
});

describe("deno.json-only projects", () => {
  const opts = { native: false, nodeVersion: "v22.11.0" };

  test("global cache: nothing to check, and that's said plainly", () => {
    make(root, { "deno.json": json({ imports: { ms: "npm:ms@^2.1.0" } }), "deno.lock": denoLock({}) });
    const report = diagnose(root, opts);
    expect(ids(report, "error")).toEqual([]);
    expect(report.findings.find((f) => f.id === "deno-global-cache").title).toContain("global cache");
  });

  test("nodeModulesDir auto without node_modules -> deno install; no deno.lock -> warning", () => {
    make(root, { "deno.json": json({ imports: { ms: "npm:ms@^2.1.0" }, nodeModulesDir: "auto" }) });
    const report = diagnose(root, opts);
    expect(ids(report, "error")).toEqual(["not-installed"]);
    expect(ids(report, "warn")).toEqual(["no-lockfile"]);
    expect(report.plan.steps[0].label).toBe("deno install");
  });

  test("npm imports are checked against what's installed", () => {
    make(root, {
      "deno.json": json({ imports: { ms: "npm:ms@^3.0.0" }, nodeModulesDir: "auto" }),
      "deno.lock": denoLock({ "ms@2.1.3": { integrity: "x" } }),
      node_modules: { ".deno": denoPkg("ms", "2.1.3") },
    });
    linkTop("ms", "2.1.3");
    const f = diagnose(root, opts).findings.find((x) => x.id === "dep-versions");
    expect(f.details).toEqual(["ms: installed 2.1.3, deno.json wants ^3.0.0"]);
  });
});

describe("native modules in Deno projects", () => {
  function nativeProject() {
    make(root, {
      "package.json": json({ name: "app", dependencies: {} }),
      "deno.lock": denoLock({}),
      node_modules: {
        ".deno": {
          "legacy@1.0.0": { ".initialized": "", node_modules: { legacy: { "package.json": json({ name: "legacy" }), build: { Release: { "a.node": "x" } } } } },
          "wrongos@1.0.0": { ".initialized": "", node_modules: { wrongos: { "package.json": json({ name: "wrongos" }), build: { Release: { "b.node": "x" } } } } },
        },
      },
    });
  }
  const loadAddon = (file) =>
    file.includes("legacy")
      ? { ok: false, error: "TypeError: Cannot load native addon at /x/a.node: it was built against the legacy Node.js native addon API (NODE_MODULE / nan), which Deno does not support. Only Node-API (N-API) addons are supported." }
      : { ok: false, error: "TypeError: /x/b.node: invalid ELF header" };

  test("legacy addons: explained, not 'rebuilt'; wrong OS: targeted Deno rebuild", () => {
    nativeProject();
    const report = diagnose(root, { nodeVersion: "v22.11.0", loadAddon });
    const legacy = report.findings.find((f) => f.id === "native-deno-unsupported");
    expect(legacy.details[0]).toBe("legacy");
    expect(legacy.fix).toBeUndefined();
    const step = report.plan.steps.find((s) => s.kind === "rebuild");
    expect(step.cmd).toBe("deno");
    expect(step.args).toEqual(["install", "--allow-scripts=npm:wrongos"]);
    expect(step.removePaths).toEqual([path.join(root, "node_modules", ".deno", "wrongos@1.0.0")]);
    expect(step.label).toBe("remove node_modules/.deno/wrongos@1.0.0, then deno install --allow-scripts=npm:wrongos");
  });

  test("runFixStep removes only that package's folder, and refuses anything else", async () => {
    nativeProject();
    const store = path.join(root, "node_modules", ".deno");
    const run = jest.fn(async () => ({ exitCode: 0 }));
    await runFixStep({ kind: "rebuild", cmd: "deno", args: ["install"], removePaths: [path.join(store, "wrongos@1.0.0")] }, root, { run });
    expect(exists("node_modules/.deno/wrongos@1.0.0")).toBe(false);
    expect(exists("node_modules/.deno/legacy@1.0.0")).toBe(true);
    expect(run).toHaveBeenCalledWith("deno", ["install"], expect.objectContaining({ cwd: root }));

    for (const bad of [root, path.join(root, "node_modules"), store, path.join(store, "legacy@1.0.0", "node_modules"), "/"]) {
      await expect(runFixStep({ kind: "rebuild", cmd: "deno", args: [], removePaths: [bad] }, root, { run })).rejects.toThrow(/Refusing/);
    }
    expect(exists("node_modules/.deno/legacy@1.0.0")).toBe(true);
  });
});

describe("cleanup and agent setup", () => {
  test("--lockfiles removes deno.lock and --install runs deno install", async () => {
    jest.resetModules();
    jest.doMock("../lib/run", () => ({ run: jest.fn(async () => ({ exitCode: 0 })) }));
    const { cleanup } = require("../index");
    const { run } = require("../lib/run");
    jest.spyOn(console, "log").mockImplementation(() => {});
    make(root, { "package.json": "{}", "deno.lock": denoLock({}), node_modules: { ".deno": {} } });
    try {
      await cleanup({ dir: root, verbose: false, removeLockfiles: true, install: true });
    } finally {
      console.log.mockRestore();
      jest.dontMock("../lib/run");
    }
    expect(exists("deno.lock")).toBe(false);
    expect(run).toHaveBeenCalledWith("deno", ["install"], expect.objectContaining({ cwd: root }));
  });

  test("agent install: Deno-only machines get a deno-run hook; old .js guard is migrated", () => {
    make(root, {
      "package.json": "{}",
      ".claude": {
        hooks: { "cleaninstall-guard.js": "old" },
        "settings.json": json({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/cleaninstall-guard.js"' }] }] } }),
      },
    });
    installAgent({ dir: root, runtime: "deno" });
    expect(exists(".claude/hooks/cleaninstall-guard.js")).toBe(false);
    expect(exists(".claude/hooks/cleaninstall-guard.cjs")).toBe(true);
    const hooks = JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.json"), "utf8")).hooks.PreToolUse;
    expect(hooks).toHaveLength(1);
    expect(hooks[0].hooks[0].command).toBe('deno run --allow-env=CLEANINSTALL_GUARD "${CLAUDE_PROJECT_DIR}/.claude/hooks/cleaninstall-guard.cjs"');
  });
});

// --- Real Deno --------------------------------------------------------------
const DENO = process.env.DENO_BIN || findOnPath("deno");
const withDeno = DENO ? describe : describe.skip;

withDeno("with a real Deno", () => {
  jest.setTimeout(120000);
  const deno = (args, cwd, extra = {}) =>
    spawnSync(DENO, args, { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, ...extra });

  test("deno install -> healthy; pulled deno.lock -> out of sync; --fix repairs it", () => {
    make(root, { "package.json": json({ name: "app", version: "1.0.0", dependencies: { ms: "2.1.3" } }) });
    expect(deno(["install"], root).status).toBe(0);
    let report = diagnose(root, { native: false });
    expect(report.packageManager).toBe("deno");
    expect(ids(report, "error")).toEqual([]);

    // Simulate a pull: deno.lock (and package.json) now want ms@2.1.2.
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cin-deno-up-")));
    try {
      fs.writeFileSync(path.join(other, "package.json"), json({ name: "app", version: "1.0.0", dependencies: { ms: "2.1.2" } }));
      expect(deno(["install"], other).status).toBe(0);
      for (const f of ["package.json", "deno.lock"]) fs.copyFileSync(path.join(other, f), path.join(root, f));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
    report = diagnose(root, { native: false });
    expect(report.findings.find((f) => f.id === "lockfile-sync").details[0]).toBe("ms: installed 2.1.3, lockfile 2.1.2");

    const fix = spawnSync(process.execPath, [CLI, "doctor", "-d", root, "--no-native", "--fix"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${path.dirname(DENO)}${path.delimiter}${process.env.PATH}` },
    });
    expect(fix.status).toBe(0);
    expect(diagnose(root, { native: false }).findings.find((f) => f.id === "lockfile-sync").severity).toBe("ok");
  });

  test("the CLI runs under Deno itself", () => {
    make(root, { "package.json": json({ name: "app", dependencies: {} }), "package-lock.json": "{}" });
    const res = deno(["run", "-A", CLI, "doctor", "-d", root, "--json"], root);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).packageManager).toBe("npm");
  });
});
