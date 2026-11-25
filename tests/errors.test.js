// doctor --from-error: error text -> meaning -> fix, in the context of a project.
// Fixtures in tests/fixtures/errors are real npm/pnpm/yarn/Node output;
// tests/fixtures/errors/known are reconstructed from documented formats.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { explainError, packageFromPath } = require("../lib/errors");
const { diagnoseFromError, runDoctor } = require("../lib/doctor");

const FIX = path.join(__dirname, "fixtures", "errors");
const fixture = (name) => fs.readFileSync(path.join(FIX, name), "utf8");

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
const json = (o) => JSON.stringify(o);
const pkgDir = (name, version, extra = {}) => ({ "package.json": json({ name, version, ...extra }) });

function explain(text, packageManager = "npm") {
  return explainError(text, { rootDir: root, packageManager });
}
const ids = (matches) => matches.map((m) => m.id);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cin-err-"));
  make(root, { "package.json": json({ name: "app", version: "1.0.0" }) });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("every fixture is recognised as the right error", () => {
  const cases = [
    // real captures
    ["abi.txt", "native-abi"],
    ["elf.txt", "native-platform"],
    ["cjs-not-found.txt", "module-not-found"],
    ["esm-not-found.txt", "module-not-found"],
    ["not-exported.txt", "subpath-not-exported"],
    ["npm-ci-out-of-sync.txt", "lockfile-out-of-sync"],
    ["pnpm-frozen.txt", "lockfile-out-of-sync"],
    ["yarn-frozen.txt", "lockfile-out-of-sync"],
    ["npm-eresolve.txt", "peer-conflict"],
    ["npm-ebadengine.txt", "node-engine"],
    ["yarn-engine.txt", "node-engine"],
    ["pnpm-engine.txt", "node-engine"],
    ["npm-workspace-protocol.txt", "wrong-package-manager"],
    ["corepack-mismatch.txt", "wrong-package-manager"],
    ["npm-run-not-found.txt", "command-not-found"],
    ["rollup-missing-native.txt", "platform-binary-missing"],
    ["esbuild-missing-native.txt", "platform-binary-missing"],
    ["sharp-missing-native.txt", "platform-binary-missing"],
    // reconstructed
    ["known/err-require-esm.txt", "require-esm"],
    ["known/enospc-disk.txt", "disk-full"],
    ["known/enospc-watchers.txt", "file-watchers"],
    ["known/eacces.txt", "permissions"],
    ["known/eintegrity.txt", "integrity"],
    ["known/enotempty.txt", "corrupted-install"],
    ["known/node-gyp.txt", "native-build-failed"],
    ["known/vite-import.txt", "module-not-found"],
    ["known/webpack-resolve.txt", "module-not-found"],
    ["known/next-resolve.txt", "module-not-found"],
    ["known/ts2307.txt", "module-not-found"],
    ["known/esbuild-wrong-platform.txt", "platform-binary-missing"],
    ["known/windows-not-recognized.txt", "command-not-found"],
    ["known/zsh-not-found.txt", "command-not-found"],
  ];

  test.each(cases)("%s -> %s", (file, id) => {
    expect(ids(explain(fixture(file)))).toEqual([id]);
  });

  test("no fixture is left untested", () => {
    const all = [
      ...fs.readdirSync(FIX).filter((f) => f.endsWith(".txt")),
      ...fs.readdirSync(path.join(FIX, "known")).filter((f) => f.endsWith(".txt")).map((f) => `known/${f}`),
    ];
    expect(all.sort()).toEqual(cases.map((c) => c[0]).sort());
  });

  test("unrelated text matches nothing", () => {
    expect(explain("TypeError: Cannot read properties of undefined (reading 'map')")).toEqual([]);
  });
});

describe("details are extracted from real output", () => {
  test("native ABI: package and Node versions", () => {
    const [m] = explain(fixture("abi.txt"));
    expect(m.packages).toEqual(["old-native"]);
    expect(m.explanation[0]).toContain("compiled for Node 20 (ABI 115)");
    expect(m.explanation[0]).toContain("Node 22 (ABI 127)");
    expect(m.fix).toEqual({ kind: "rebuild", packages: ["old-native"] });
  });

  test("wrong platform binary -> rebuild that package", () => {
    const [m] = explain(fixture("elf.txt"));
    expect(m.fix).toEqual({ kind: "rebuild", packages: ["mac-native"] });
    expect(m.explanation[0]).toContain("invalid ELF header");
  });

  test("rollup/esbuild/sharp missing platform package -> reinstall, generic module-not-found suppressed", () => {
    const rollup = explain(fixture("rollup-missing-native.txt"));
    expect(ids(rollup)).toEqual(["platform-binary-missing"]); // not also module-not-found
    expect(rollup[0].title).toBe("rollup is missing its native binary for this platform");
    expect(rollup[0].explanation[0]).toContain("@rollup/rollup-linux-x64-gnu");
    expect(rollup[0].fix).toEqual({ kind: "reinstall" });
    expect(explain(fixture("sharp-missing-native.txt"))[0].explanation[0]).toContain("@img/sharp-linux-x64");
    expect(explain(fixture("known/esbuild-wrong-platform.txt"))[0].explanation[0]).toContain("@esbuild/linux-x64");
  });

  test("generic platform package (e.g. @swc/core) is recognised too", () => {
    const [m] = explain("Error: Cannot find module '@swc/core-linux-x64-gnu'");
    expect(m.id).toBe("platform-binary-missing");
    expect(m.title).toBe("@swc/core is missing its native binary for this platform");
  });

  test("lockfile out of sync names the right package manager", () => {
    expect(explain(fixture("npm-ci-out-of-sync.txt"))[0].manual[0]).toContain("`npm install`");
    expect(explain(fixture("npm-ci-out-of-sync.txt"))[0].explanation.join(" ")).toContain("left-pad@1.3.0");
    expect(explain(fixture("pnpm-frozen.txt"))[0].manual[0]).toContain("`pnpm install`");
    expect(explain(fixture("yarn-frozen.txt"))[0].manual[0]).toContain("`yarn install`");
  });

  test("ERESOLVE names both sides of the peer conflict", () => {
    const [m] = explain(fixture("npm-eresolve.txt"));
    expect(m.explanation[0]).toBe('react-dom@18.2.0 needs react@"^18.2.0" as a peer dependency, but the project has react@17.0.2.');
    expect(m.manual.join(" ")).toContain("--legacy-peer-deps");
    expect(m.manual.join(" ")).not.toMatch(/use --force/);
  });

  test.each(["npm-ebadengine.txt", "yarn-engine.txt", "pnpm-engine.txt"])(
    "%s: required Node range, and it blocks fixes",
    (file) => {
      const [m] = explain(fixture(file));
      expect(m.explanation[0]).toContain(">=99");
      expect(m.explanation[0]).toContain("v22.23.5");
      expect(m.blocksFix).toBe(true);
    }
  );

  test("disk full vs file watchers are told apart", () => {
    expect(explain(fixture("known/enospc-disk.txt"))[0].manual[0]).toContain("cleaninstall-node --dry-run");
    expect(explain(fixture("known/enospc-watchers.txt"))[0].title).toContain("not a disk problem");
  });

  test("EACCES inside the project vs a global location", () => {
    expect(explain(fixture("known/eacces.txt"))[0].title).toBe("node_modules is owned by another user");
    const global = explain("Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/cleaninstall-node'");
    expect(global[0].title).toBe("No permission to write a global install location");
  });

  test("node-gyp failure names the package and Python", () => {
    const [m] = explain(fixture("known/node-gyp.txt"));
    expect(m.title).toBe("better-sqlite3 failed to compile");
    expect(m.explanation.join(" ")).toContain("Node 25.0.0");
    expect(m.explanation.join(" ")).toContain("Python");
  });

  test("packageFromPath handles scopes, pnpm and Windows paths", () => {
    expect(packageFromPath("/a/node_modules/.pnpm/x@1/node_modules/@scope/pkg/build/a.node")).toBe("@scope/pkg");
    expect(packageFromPath("C:\\app\\node_modules\\sqlite3\\lib\\binding\\x.node")).toBe("sqlite3");
    expect(packageFromPath("/no/modules/here.js")).toBeNull();
  });
});

describe("Cannot find module: the answer depends on the project", () => {
  const setPkg = (pkg) => fs.writeFileSync(path.join(root, "package.json"), json({ name: "app", ...pkg }));

  test("declared but not installed -> install", () => {
    setPkg({ dependencies: { axios: "^1.7.0" } });
    const [m] = explain(fixture("known/vite-import.txt"));
    expect(m.title).toBe("axios is in package.json but not installed");
    expect(m.fix).toEqual({ kind: "install" });
  });

  test("not declared and not installed -> add it, with the project's package manager", () => {
    const [m] = explain(fixture("known/webpack-resolve.txt"), "pnpm");
    expect(m.title).toBe("axios isn't a dependency of this project");
    expect(m.manual).toEqual(["Add it: pnpm add axios"]);
    expect(m.fix).toBeUndefined();
  });

  test("installed only transitively -> phantom dependency", () => {
    make(root, { node_modules: { debug: pkgDir("debug", "4.3.4") } });
    const [m] = explain("Error: Cannot find module 'debug'");
    expect(m.title).toBe("debug is used but not listed in package.json");
    expect(m.manual).toEqual(["Add it explicitly: npm install debug"]);
  });

  test("installed version outside the declared range -> install", () => {
    setPkg({ dependencies: { ms: "^3.0.0" } });
    make(root, { node_modules: { ms: pkgDir("ms", "2.1.3") } });
    const [m] = explain("Error: Cannot find module 'ms/next'");
    expect(m.title).toBe("ms 2.1.3 is installed, but package.json wants ^3.0.0");
    expect(m.fix).toEqual({ kind: "install" });
  });

  test("subpath that doesn't exist in the installed version", () => {
    setPkg({ dependencies: { lodash: "^4.17.0" } });
    make(root, { node_modules: { lodash: pkgDir("lodash", "4.17.21") } });
    const [m] = explain("Module not found: Error: Can't resolve 'lodash/nope' in '/app/src'");
    expect(m.title).toBe("lodash is installed, but 'lodash/nope' doesn't exist in it");
  });

  test("installed, in range, no subpath -> package is broken -> reinstall", () => {
    setPkg({ dependencies: { ms: "^2.1.0" } });
    make(root, { node_modules: { ms: pkgDir("ms", "2.1.3") } });
    expect(explain("Error: Cannot find module 'ms'")[0].fix).toEqual({ kind: "reinstall" });
  });

  test("TypeScript: installed without types -> @types package", () => {
    setPkg({ dependencies: { lodash: "^4.17.0" } });
    make(root, { node_modules: { lodash: pkgDir("lodash", "4.17.21") } });
    const [m] = explain(fixture("known/ts2307.txt"));
    expect(m.title).toBe("lodash is installed but has no TypeScript types");
    expect(m.manual).toEqual(["Add the types: npm install -D @types/lodash"]);
  });

  test("scoped TypeScript types name", () => {
    setPkg({ dependencies: { "@acme/ui": "^1.0.0" } });
    make(root, { node_modules: { "@acme": { ui: pkgDir("@acme/ui", "1.0.0") } } });
    const [m] = explain("error TS2307: Cannot find module '@acme/ui' or its corresponding type declarations.");
    expect(m.manual[0]).toContain("@types/acme__ui");
  });

  test("relative import -> a code problem, not an install problem", () => {
    const [m] = explain("Error: Cannot find module './utils/format'\nRequire stack:\n- /app/src/index.js");
    expect(m.code).toBe(true);
    expect(m.fix).toBeUndefined();
    expect(m.explanation.join(" ")).toContain("case");
  });

  test("Node built-in", () => {
    expect(explain("Module not found: Error: Can't resolve 'fs' in '/app/src'")[0].title).toBe(
      "Built-in module 'fs' isn't available"
    );
  });

  test("workspace packages' dependencies count as declared", () => {
    setPkg({ workspaces: ["packages/*"] });
    make(root, { packages: { web: { "package.json": json({ dependencies: { zod: "^3.0.0" } }) } } });
    const matches = explainError("Error: Cannot find module 'zod'", {
      rootDir: root,
      packageManager: "npm",
      workspaceDirs: [path.join(root, "packages", "web")],
    });
    expect(matches[0].title).toBe("zod is in package.json but not installed");
  });
});

describe("command not found", () => {
  const setPkg = (pkg) => fs.writeFileSync(path.join(root, "package.json"), json({ name: "app", ...pkg }));

  test("declared dev dependency not installed -> install", () => {
    setPkg({ devDependencies: { vite: "^5.0.0" } });
    const [m] = explain(fixture("npm-run-not-found.txt"));
    expect(m.title).toBe("vite isn't installed");
    expect(m.fix).toEqual({ kind: "install" });
  });

  test("known command whose package has a different name", () => {
    setPkg({ devDependencies: { typescript: "^5.0.0" } });
    const [m] = explain(fixture("known/zsh-not-found.txt"));
    expect(m.title).toBe("tsc comes from typescript, which isn't installed");
  });

  test("provider found through an installed package's bin field", () => {
    setPkg({ devDependencies: { "my-cli": "^1.0.0" } });
    make(root, { node_modules: { "my-cli": pkgDir("my-cli", "1.0.0", { bin: { mytool: "cli.js" } }) } });
    const [m] = explain("sh: 1: mytool: not found");
    expect(m.title).toBe("mytool comes from my-cli, which isn't installed");
  });

  test("not in package.json -> add as a dev dependency", () => {
    const [m] = explain(fixture("known/zsh-not-found.txt"), "yarn");
    expect(m.manual).toEqual(["Add it: yarn add -D typescript"]);
  });

  test("present in node_modules/.bin -> use npx", () => {
    make(root, { node_modules: { ".bin": { vite: "#!/bin/sh\n" } } });
    expect(explain(fixture("npm-run-not-found.txt"))[0].manual).toEqual(["Run it as `npx vite`, or from a package.json script"]);
  });

  test("the package manager itself is missing", () => {
    expect(explain("zsh: command not found: pnpm")[0].manual[0]).toContain("corepack enable");
  });
});

describe("diagnoseFromError folds the error into doctor's plan", () => {
  const opts = { native: false, nodeVersion: "v22.11.0" };

  test("native ABI error -> targeted rebuild step", () => {
    make(root, { "package-lock.json": "{}", node_modules: {} });
    const report = diagnoseFromError(root, fixture("abi.txt"), opts);
    expect(report.error.recognized).toBe(true);
    expect(report.plan.steps.map((s) => s.label)).toEqual(["npm rebuild old-native"]);
  });

  test("engine error blocks fixes", () => {
    make(root, { "package-lock.json": "{}", node_modules: {} });
    const report = diagnoseFromError(root, fixture("npm-ebadengine.txt"), opts);
    expect(report.plan.steps).toEqual([]);
    expect(report.plan.blocked.length).toBe(1);
  });

  test("doctor findings that explain the error are flagged as related", () => {
    fs.writeFileSync(path.join(root, "package.json"), json({ name: "app", dependencies: { axios: "^1" } }));
    make(root, { "package-lock.json": "{}", node_modules: {} });
    const report = diagnoseFromError(root, fixture("known/webpack-resolve.txt"), opts);
    expect(report.findings.find((f) => f.id === "missing-deps").related).toBe(true);
    expect(report.plan.steps.map((s) => s.kind)).toEqual(["install"]);
  });

  test("unrecognised error still runs doctor", () => {
    make(root, { "package-lock.json": "{}" });
    const report = diagnoseFromError(root, "something odd happened", opts);
    expect(report.error).toEqual({ recognized: false, matches: [] });
    expect(report.findings.length).toBeGreaterThan(0);
  });

  test("runDoctor reads the error from stdin and prints the meaning first", async () => {
    const lines = [];
    jest.spyOn(console, "log").mockImplementation((m = "") => lines.push(m));
    try {
      await runDoctor(
        { dir: root, native: false, fromError: true, readStdin: () => fixture("abi.txt") },
        jest.fn()
      );
    } finally {
      console.log.mockRestore();
      process.exitCode = undefined;
    }
    const out = lines.join("\n");
    expect(out.indexOf("What the error means")).toBeLessThan(out.indexOf("In this project"));
    expect(out).toContain("npm rebuild old-native");
  });
});

describe("CLI", () => {
  const CLI = path.resolve(__dirname, "../bin/cleanup.js");

  test("piped error -> JSON report with the match and exit code 1", () => {
    const res = spawnSync(process.execPath, [CLI, "doctor", "-d", root, "--from-error", "--json", "--no-native"], {
      input: fixture("rollup-missing-native.txt"),
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    const report = JSON.parse(res.stdout);
    expect(report.error.matches.map((m) => m.id)).toEqual(["platform-binary-missing"]);
    expect(report.plan.steps[0].kind).toBe("reinstall");
  });

  test("error passed as an argument", () => {
    const res = spawnSync(
      process.execPath,
      [CLI, "doctor", "-d", root, "--no-native", "--from-error", "Error: Cannot find module './missing'"],
      { encoding: "utf8", input: "" }
    );
    expect(res.stdout).toContain("A local file can't be found: ./missing");
  });
});
