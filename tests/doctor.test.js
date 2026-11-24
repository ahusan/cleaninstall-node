// doctor: diagnosis + fix planning, against real temp directories with the
// state files each package manager writes into node_modules.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const {
  diagnose,
  runDoctor,
  classifyLoadError,
  parseYarnV1Lock,
} = require("../lib/doctor");

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
const json = (o) => JSON.stringify(o, null, 2);
const ids = (report, severity) =>
  report.findings.filter((f) => !severity || f.severity === severity).map((f) => f.id);
const installedPkg = (name, version) => ({ "package.json": json({ name, version }) });

// A healthy npm project: ms@2.1.3, plus an optional platform package that
// is in the lockfile but (correctly) not installed.
function npmProject({ lockMs = "2.1.3", installedMs = "2.1.3" } = {}) {
  const lockPackages = {
    "": { name: "app", dependencies: { ms: "^2.1.0" }, optionalDependencies: { "@esbuild/darwin-arm64": "0.24.0" } },
    "node_modules/ms": { version: lockMs },
    "node_modules/@esbuild/darwin-arm64": { version: "0.24.0", optional: true },
  };
  make(root, {
    "package.json": json({ name: "app", dependencies: { ms: "^2.1.0" } }),
    "package-lock.json": json({ lockfileVersion: 3, packages: lockPackages }),
    node_modules: {
      ".package-lock.json": json({ lockfileVersion: 3, packages: { "node_modules/ms": { version: installedMs } } }),
      ms: installedPkg("ms", installedMs),
    },
  });
}

const opts = { native: false, nodeVersion: "v22.11.0" };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cin-doctor-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  jest.restoreAllMocks();
  process.exitCode = undefined;
});

describe("healthy projects", () => {
  test("npm project in sync has no errors and no fix steps", () => {
    npmProject();
    const report = diagnose(root, opts);
    expect(ids(report, "error")).toEqual([]);
    expect(ids(report, "warn")).toEqual([]);
    expect(report.plan.steps).toEqual([]);
  });
});

describe("install state", () => {
  test("missing node_modules -> install", () => {
    make(root, { "package.json": json({ dependencies: { ms: "^2" } }), "package-lock.json": "{}" });
    const report = diagnose(root, opts);
    expect(ids(report, "error")).toContain("not-installed");
    expect(report.plan.steps.map((s) => s.label)).toEqual(["npm install"]);
  });

  test("npm: lockfile changed after install (git pull) -> install", () => {
    npmProject({ lockMs: "2.1.2", installedMs: "2.1.3" });
    const report = diagnose(root, opts);
    const sync = report.findings.find((f) => f.id === "lockfile-sync");
    expect(sync.severity).toBe("error");
    expect(sync.details[0]).toBe("ms: installed 2.1.3, lockfile 2.1.2");
    expect(report.plan.steps.map((s) => s.kind)).toEqual(["install"]);
  });

  test("npm: optional platform packages missing from node_modules are fine", () => {
    npmProject();
    const sync = diagnose(root, opts).findings.find((f) => f.id === "lockfile-sync");
    expect(sync.severity).toBe("ok");
  });

  test("pnpm: wanted vs current lockfile importers differ", () => {
    const lock = (v) =>
      `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      ms:\n        specifier: ^2.1.0\n        version: ${v}\n`;
    make(root, {
      "package.json": json({ dependencies: { ms: "^2.1.0" } }),
      "pnpm-lock.yaml": lock("2.1.2"),
      node_modules: {
        ".modules.yaml": "layoutVersion: 5\n",
        ".pnpm": { "lock.yaml": lock("2.1.3") },
        ms: installedPkg("ms", "2.1.3"),
      },
    });
    const report = diagnose(root, opts);
    expect(report.packageManager).toBe("pnpm");
    expect(report.findings.find((f) => f.id === "lockfile-sync").details[0]).toBe(
      "ms: installed 2.1.3, lockfile 2.1.2"
    );
    expect(report.plan.steps.map((s) => s.label)).toEqual(["pnpm install"]);
  });

  test("pnpm: ignored build scripts are surfaced", () => {
    make(root, {
      "package.json": json({ dependencies: {} }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      node_modules: { ".modules.yaml": "ignoredBuilds:\n  - esbuild@0.24.0\n" },
    });
    const f = diagnose(root, opts).findings.find((x) => x.id === "pnpm-ignored-builds");
    expect(f.severity).toBe("warn");
    expect(f.manual).toBe("pnpm approve-builds");
  });

  test("yarn v1: lockfile parse and drift detection", () => {
    const yarnLock = `# yarn lockfile v1\n\n"ms@^2.1.0", ms@^2.1.1:\n  version "2.1.2"\n  resolved "https://r/ms-2.1.2.tgz#a"\n`;
    expect(parseYarnV1Lock(yarnLock)).toEqual({
      "ms@^2.1.0": "https://r/ms-2.1.2.tgz#a",
      "ms@^2.1.1": "https://r/ms-2.1.2.tgz#a",
    });
    make(root, {
      "package.json": json({ dependencies: { ms: "^2.1.0" } }),
      "yarn.lock": yarnLock,
      node_modules: {
        ".yarn-integrity": json({
          systemParams: `${process.platform}-${process.arch}-${process.versions.modules}`,
          lockfileEntries: { "ms@^2.1.0": "https://r/ms-2.1.3.tgz#b" },
        }),
        ms: installedPkg("ms", "2.1.3"),
      },
    });
    const sync = diagnose(root, opts).findings.find((f) => f.id === "lockfile-sync");
    expect(sync.severity).toBe("error");
    expect(sync.details).toEqual(
      expect.arrayContaining(["ms@^2.1.0 resolves differently than installed", "ms@^2.1.1 is not installed"])
    );
  });

  test("yarn v1: installed under a different Node ABI", () => {
    make(root, {
      "package.json": json({}),
      "yarn.lock": "# yarn lockfile v1\n",
      node_modules: { ".yarn-integrity": json({ systemParams: "linux-x64-115", lockfileEntries: {} }) },
    });
    expect(ids(diagnose(root, opts), "warn")).toContain("yarn-system");
  });

  test("direct dependency installed at a version outside its range", () => {
    make(root, {
      "package.json": json({ dependencies: { ms: "^3.0.0", aliased: "npm:ms@^2.0.0" } }),
      node_modules: { ms: installedPkg("ms", "2.1.3"), aliased: installedPkg("ms", "2.1.3") },
    });
    const f = diagnose(root, opts).findings.find((x) => x.id === "dep-versions");
    expect(f.details).toEqual(["ms: installed 2.1.3, package.json wants ^3.0.0"]);
  });

  test("workspace deps resolve through hoisted root node_modules", () => {
    make(root, {
      "package.json": json({ workspaces: ["packages/*"] }),
      packages: { a: { "package.json": json({ dependencies: { ms: "^2", missing: "^1" } }) } },
      node_modules: { ms: installedPkg("ms", "2.1.3") },
    });
    const f = diagnose(root, opts).findings.find((x) => x.id === "missing-deps");
    expect(f.details).toEqual([`${path.join("packages", "a")}: missing`]);
  });
});

describe("package managers", () => {
  test("node_modules installed by a different manager -> clean reinstall", () => {
    make(root, {
      "package.json": json({ packageManager: "pnpm@10.0.0", dependencies: { ms: "^2" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      node_modules: { ".package-lock.json": "{}", ms: installedPkg("ms", "2.1.3") },
    });
    const report = diagnose(root, opts);
    expect(ids(report, "error")).toEqual(["wrong-installer"]);
    expect(report.plan.steps).toEqual([expect.objectContaining({ kind: "reinstall", cmd: "pnpm" })]);
  });

  test("multiple lockfiles and packageManager mismatch warn", () => {
    make(root, {
      "package.json": json({ packageManager: "bun@1.1.0" }),
      "yarn.lock": "",
      "package-lock.json": "{}",
    });
    const warns = ids(diagnose(root, opts), "warn");
    expect(warns).toEqual(expect.arrayContaining(["multiple-lockfiles", "package-manager-field"]));
  });

  test("dependencies but no lockfile warns", () => {
    make(root, { "package.json": json({ dependencies: { ms: "^2" } }), node_modules: { ms: installedPkg("ms", "2.1.3") } });
    expect(ids(diagnose(root, opts), "warn")).toContain("no-lockfile");
  });
});

describe("node version", () => {
  test(".nvmrc major mismatch is an error and blocks fixes", () => {
    make(root, { ".nvmrc": "v20\n", "package.json": json({ dependencies: { ms: "^2" } }) });
    const report = diagnose(root, opts);
    expect(ids(report, "error")).toEqual(expect.arrayContaining(["node-version", "not-installed"]));
    expect(report.plan.steps).toEqual([]);
    expect(report.plan.blocked.length).toBe(1);
    expect(report.plan.manual).toContain("nvm use");
  });

  test("same major, different patch is only a warning", () => {
    make(root, { ".node-version": "22.10.0", "package.json": json({}) });
    expect(ids(diagnose(root, opts), "warn")).toEqual(["node-version"]);
  });

  test("lts aliases are skipped; matching major is ok", () => {
    make(root, { ".nvmrc": "lts/*", ".tool-versions": "nodejs 22.11.0\n", "package.json": json({}) });
    const report = diagnose(root, opts);
    expect(ids(report, "error")).toEqual([]);
    expect(ids(report, "warn")).toEqual([]);
  });

  test("engines.node not satisfied", () => {
    make(root, { "package.json": json({ engines: { node: ">=24" } }) });
    expect(ids(diagnose(root, opts), "error")).toEqual(["node-engines"]);
  });
});

describe("native modules", () => {
  test("classifies Node's load errors", () => {
    expect(
      classifyLoadError(
        "Error: The module '/x.node'\nwas compiled against a different Node.js version using\nNODE_MODULE_VERSION 115. This version of Node.js requires\nNODE_MODULE_VERSION 127. Please try re-compiling"
      )
    ).toEqual({ kind: "abi", built: 115, required: 127 });
    expect(classifyLoadError("Error: /x.node: invalid ELF header").kind).toBe("platform");
    expect(classifyLoadError("Error: libfoo.so: cannot open shared object file").kind).toBe("other");
  });

  test("broken addons (incl. inside pnpm's .pnpm store) -> targeted rebuild", () => {
    make(root, {
      "package.json": json({ dependencies: {} }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      node_modules: {
        ".modules.yaml": "layoutVersion: 5\n",
        ".pnpm": {
          "sqlite@1.0.0": { node_modules: { sqlite: { "package.json": json({ name: "sqlite" }), build: { Release: { "sqlite.node": "x" } } } } },
        },
        "@scope": { ok: { "package.json": json({ name: "@scope/ok" }), build: { Release: { "ok.node": "x" } } } },
      },
    });
    const loadAddon = (file) =>
      file.includes("sqlite")
        ? { ok: false, error: "NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 127." }
        : { ok: true };
    const report = diagnose(root, { nodeVersion: "v22.11.0", loadAddon });
    expect(report.findings.find((f) => f.id === "native-abi").details).toEqual([
      "sqlite: built for ABI 115, this Node needs 127",
    ]);
    expect(report.plan.steps).toEqual([expect.objectContaining({ label: "pnpm rebuild sqlite" })]);
  });

  let hasGcc = false;
  try {
    execSync("gcc --version", { stdio: "ignore" });
    hasGcc = process.platform === "linux";
  } catch {
    // no compiler
  }
  (hasGcc ? test : test.skip)("real addon compiled for another ABI is detected via dlopen", () => {
    const pkgDir = path.join(root, "node_modules", "old-native");
    fs.mkdirSync(path.join(pkgDir, "build", "Release"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), json({ name: "old-native" }));
    const src = path.join(root, "fake.c");
    const otherAbi = Number(process.versions.modules) - 12;
    fs.writeFileSync(
      src,
      `struct m { int v; unsigned f; void* d; const char* fn; void* r; void* c; const char* n; void* p; struct m* l; };
       extern void node_module_register(void*);
       static struct m mod = {${otherAbi}, 0, 0, "fake.c", 0, 0, "old", 0, 0};
       __attribute__((constructor)) static void reg(void) { node_module_register(&mod); }`
    );
    execSync(`gcc -shared -fPIC -o "${path.join(pkgDir, "build", "Release", "old.node")}" "${src}"`);
    fs.writeFileSync(path.join(root, "package.json"), json({}));
    const report = diagnose(root, { nodeVersion: process.version });
    const f = report.findings.find((x) => x.id === "native-abi");
    expect(f.details).toEqual([
      `old-native: built for ABI ${otherAbi}, this Node needs ${process.versions.modules}`,
    ]);
  });
});

describe("runDoctor", () => {
  beforeEach(() => jest.spyOn(console, "log").mockImplementation(() => {}));

  test("--fix runs the planned install, then re-checks", async () => {
    npmProject({ lockMs: "2.1.2", installedMs: "2.1.3" });
    const execa = jest.fn(async () => {
      // simulate npm install bringing node_modules in line
      fs.writeFileSync(
        path.join(root, "node_modules", ".package-lock.json"),
        json({ packages: { "node_modules/ms": { version: "2.1.2" } } })
      );
      fs.writeFileSync(path.join(root, "node_modules", "ms", "package.json"), json({ name: "ms", version: "2.1.2" }));
    });
    const report = await runDoctor({ dir: root, fix: true, native: false }, execa);
    expect(execa).toHaveBeenCalledWith("npm", ["install"], expect.objectContaining({ cwd: root }));
    expect(ids(report, "error")).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  test("--fix does nothing when the Node version is wrong; exit code 1", async () => {
    make(root, { ".nvmrc": "10", "package.json": json({ dependencies: { ms: "^2" } }) });
    const execa = jest.fn();
    await runDoctor({ dir: root, fix: true, native: false }, execa);
    expect(execa).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("--json prints a machine-readable report", async () => {
    npmProject();
    const write = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runDoctor({ dir: root, json: true, native: false }, jest.fn());
    const out = JSON.parse(write.mock.calls.map((c) => c[0]).join(""));
    expect(out.summary).toEqual({ errors: 0, warnings: 0 });
    expect(out.packageManager).toBe("npm");
  });
});
