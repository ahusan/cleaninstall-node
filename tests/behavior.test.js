// Behaviour tests against a real temporary directory (no mock-fs), so glob
// and fs behave exactly as they do for users.
const fs = require("fs");
const os = require("os");
const path = require("path");

const mockQuestion = jest.fn();
jest.mock("readline/promises", () => ({
  createInterface: jest.fn(() => ({ question: mockQuestion, close: jest.fn() })),
}));
jest.mock("../lib/run", () => ({ run: jest.fn() }));

const { cleanup } = require("../index");
const { detectPackageManager } = require("../bin/cleanup.js");

let root;

// Build a directory tree: string values are files, objects are directories.
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
const pkg = (obj = {}) => JSON.stringify({ name: "x", ...obj });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cin-"));
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockQuestion.mockReset();
  require("../lib/run").run.mockReset();
  process.exitCode = undefined;
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("type safety", () => {
  test("does not delete a FILE that matches a directory name", async () => {
    make(root, { "package.json": pkg(), build: "#!/bin/sh\necho build", dist: { "a.js": "" } });
    await cleanup({ dir: root, verbose: false });
    expect(exists("build")).toBe(true);
    expect(exists("dist")).toBe(false);
  });

  test("does not delete a DIRECTORY that matches a file pattern", async () => {
    make(root, { "package.json": pkg(), "yarn.lock": { keep: "me" } });
    await cleanup({ dir: root, verbose: false, removeLockfiles: true });
    expect(exists("yarn.lock/keep")).toBe(true);
  });
});

describe("lockfiles", () => {
  const lockTree = () => ({
    "package.json": pkg(),
    node_modules: { a: "" },
    "package-lock.json": "{}",
    "yarn.lock": "",
    "pnpm-lock.yaml": "",
    "bun.lock": "",
    "bun.lockb": "",
  });

  test("are kept by default", async () => {
    make(root, lockTree());
    await cleanup({ dir: root, verbose: false });
    expect(exists("node_modules")).toBe(false);
    for (const f of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"]) {
      expect(exists(f)).toBe(true);
    }
  });

  test("are removed with removeLockfiles (including bun)", async () => {
    make(root, lockTree());
    await cleanup({ dir: root, verbose: false, removeLockfiles: true });
    for (const f of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"]) {
      expect(exists(f)).toBe(false);
    }
  });
});

describe("package manager detection", () => {
  test("prefers the packageManager field over lockfiles", () => {
    make(root, { "package.json": pkg({ packageManager: "pnpm@9.12.0" }), "package-lock.json": "{}" });
    expect(detectPackageManager(root)).toBe("pnpm");
  });

  test.each([
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ])("%s -> %s", (lock, manager) => {
    make(root, { "package.json": pkg(), [lock]: "" });
    expect(detectPackageManager(root)).toBe(manager);
  });

  test("install uses the detected manager and survives lockfile removal", async () => {
    make(root, { "package.json": pkg(), "bun.lock": "", node_modules: {} });
    await cleanup({ dir: root, verbose: false, install: true, removeLockfiles: true });
    expect(require("../lib/run").run).toHaveBeenCalledWith(
      "bun",
      ["install"],
      expect.objectContaining({ cwd: root })
    );
  });

  test("installCommand from config is honoured", async () => {
    make(root, {
      "package.json": pkg({ cleaninstallNode: { installCommand: "npm ci --no-audit" } }),
      node_modules: {},
    });
    await cleanup({ dir: root, verbose: false, install: true });
    expect(require("../lib/run").run).toHaveBeenCalledWith(
      "npm",
      ["ci", "--no-audit"],
      expect.objectContaining({ cwd: root })
    );
  });
});

describe("configuration", () => {
  test("package.json cleaninstallNode config is applied", async () => {
    make(root, {
      "package.json": pkg({ cleaninstallNode: { dirsToRemove: ["custom-dir"], filesToRemove: ["*.txt"] } }),
      "custom-dir": { a: "" },
      "notes.txt": "",
      node_modules: {},
    });
    await cleanup({ dir: root, verbose: false });
    expect(exists("custom-dir")).toBe(false);
    expect(exists("notes.txt")).toBe(false);
    expect(exists("node_modules")).toBe(true);
  });

  test(".cleaninstallnoderc overrides package.json", async () => {
    make(root, {
      "package.json": pkg({ cleaninstallNode: { dirsToRemove: ["a"] } }),
      ".cleaninstallnoderc": JSON.stringify({ dirsToRemove: ["b"] }),
      a: {},
      b: {},
    });
    await cleanup({ dir: root, verbose: false });
    expect(exists("a")).toBe(true);
    expect(exists("b")).toBe(false);
  });
});

describe("workspaces", () => {
  test("package.json workspaces, including ! exclusions", async () => {
    make(root, {
      "package.json": pkg({ workspaces: ["packages/*", "!packages/keep"] }),
      node_modules: {},
      packages: {
        a: { "package.json": pkg(), node_modules: {}, dist: {} },
        keep: { "package.json": pkg(), node_modules: {} },
      },
    });
    await cleanup({ dir: root, verbose: false });
    expect(exists("node_modules")).toBe(false);
    expect(exists("packages/a/node_modules")).toBe(false);
    expect(exists("packages/a/dist")).toBe(false);
    expect(exists("packages/keep/node_modules")).toBe(true);
  });

  test("pnpm-workspace.yaml", async () => {
    make(root, {
      "package.json": pkg(),
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
      apps: { web: { "package.json": pkg(), ".next": {}, node_modules: {} } },
    });
    await cleanup({ dir: root, verbose: false });
    expect(exists("apps/web/.next")).toBe(false);
    expect(exists("apps/web/node_modules")).toBe(false);
  });
});

describe("modes and result", () => {
  test("dry run deletes nothing and reports targets", async () => {
    make(root, { "package.json": pkg(), node_modules: { a: "12345" }, dist: {} });
    const result = await cleanup({ dir: root, verbose: false, dryRun: true });
    expect(exists("node_modules")).toBe(true);
    expect(exists("dist")).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.removed.map((p) => path.basename(p)).sort()).toEqual(["dist", "node_modules"]);
    expect(result.totalSize).toBe(5);
  });

  test("returns what was removed", async () => {
    make(root, { "package.json": pkg(), node_modules: { a: "abc" } });
    const result = await cleanup({ dir: root, verbose: false });
    expect(result.itemsDeleted).toBe(1);
    expect(result.removed).toEqual([path.join(root, "node_modules")]);
    expect(result.packageManager).toBe("npm");
  });

  test("glob targets inside a removed directory are not counted twice", async () => {
    make(root, { "package.json": pkg(), dist: { "x.log": "aaaa" } });
    const result = await cleanup({
      dir: root,
      verbose: false,
      dirsToRemove: ["dist"],
      filesToRemove: ["**/*.log"],
    });
    expect(result.itemsDeleted).toBe(1);
    expect(result.totalSize).toBe(4);
  });

  test("interactive: y deletes, n keeps", async () => {
    make(root, { "package.json": pkg(), dist: {}, node_modules: {} });
    mockQuestion.mockImplementation(async (q) => (q.includes("dist") ? "y" : "n"));
    const result = await cleanup({ dir: root, verbose: false, interactive: true });
    expect(exists("dist")).toBe(false);
    expect(exists("node_modules")).toBe(true);
    expect(result.skipped).toEqual([path.join(root, "node_modules")]);
  });

  test("skipDirs are never entered", async () => {
    make(root, {
      "package.json": pkg(),
      vendor: { "package.json": pkg(), node_modules: {} },
    });
    await cleanup({ dir: root, verbose: false, skipDirs: ["vendor"] });
    expect(exists("vendor/node_modules")).toBe(true);
  });
});
