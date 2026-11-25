// Core cleanup() tests against real temporary directories.
// (These used mock-fs, which doesn't support Node 24's fs internals.)
const fs = require("fs");
const os = require("os");
const path = require("path");

const mockRlInterface = { question: jest.fn(), close: jest.fn() };
jest.mock("readline/promises", () => ({ createInterface: jest.fn() }));
jest.mock("execa", () => ({ execa: jest.fn() }));

const { cleanup } = require("../index");

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

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cin-index-"));
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockRlInterface.question.mockReset();
  mockRlInterface.close.mockReset();
  require("readline/promises").createInterface.mockImplementation(() => mockRlInterface);
  require("execa").execa.mockReset();
  process.exitCode = undefined;
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("cleanup function", () => {
  test("should remove specified directories and files", async () => {
    make(root, {
      "package.json": "{}",
      node_modules: { file: "a" },
      "package-lock.json": "lock",
      src: { file: "f" },
    });
    await cleanup({ dir: root, verbose: false });
    expect(exists("node_modules")).toBe(false);
    // Lockfiles are kept unless removeLockfiles / --lockfiles is set
    expect(exists("package-lock.json")).toBe(true);
    expect(exists("src")).toBe(true);
  });

  test("should respect custom configuration options", async () => {
    make(root, {
      "package.json": "{}",
      node_modules: { file: "a" },
      dist: { file: "b" },
    });
    await cleanup({ dir: root, dirsToRemove: ["dist"], filesToRemove: [], verbose: false });
    expect(exists("dist")).toBe(false);
    expect(exists("node_modules")).toBe(true);
  });

  test("should use scanDepth to find nested packages if no workspaces defined", async () => {
    const tree = () => ({
      "package.json": "{}",
      node_modules: { x: "" },
      subdir: { "package.json": "{}", node_modules: { nested: "dep" } },
      other_dir: { node_modules: { other: "dep" } }, // no package.json
      deep: { nested: { "package.json": "{}", node_modules: { x: "" } } }, // depth 3
    });
    make(root, tree());

    // Default scanDepth is 2: root and subdir
    await cleanup({ dir: root, verbose: false });
    expect(exists("node_modules")).toBe(false);
    expect(exists("subdir/node_modules")).toBe(false);
    expect(exists("other_dir/node_modules")).toBe(true);
    expect(exists("deep/nested/node_modules")).toBe(true);

    // Explicit depth 1 only cleans the root
    make(root, tree());
    await cleanup({ dir: root, verbose: false, depth: 1 });
    expect(exists("node_modules")).toBe(false);
    expect(exists("subdir/node_modules")).toBe(true);
  });

  // Config, workspace, glob, dry-run and interactive behaviour is covered
  // in tests/behavior.test.js.

  describe("auto-install mode", () => {
    const setupProject = (lockFile) => {
      const tree = { node_modules: { a: "" } };
      if (lockFile) tree[lockFile] = "lock";
      make(root, tree);
    };
    const execa = () => require("execa").execa;

    test.each([
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["package-lock.json", "npm"],
      [null, "npm"],
    ])("lockfile %s -> runs %s install", async (lockFile, manager) => {
      setupProject(lockFile);
      await cleanup({ dir: root, install: true, verbose: false });
      expect(exists("node_modules")).toBe(false);
      expect(execa()).toHaveBeenCalledWith(manager, ["install"], expect.objectContaining({ cwd: root }));
    });

    test("should not run install if install: false", async () => {
      setupProject("package-lock.json");
      await cleanup({ dir: root, install: false, verbose: false });
      expect(execa()).not.toHaveBeenCalled();
    });

    test("should not run install if dryRun: true", async () => {
      setupProject("package-lock.json");
      await cleanup({ dir: root, install: true, dryRun: true, verbose: false });
      expect(execa()).not.toHaveBeenCalled();
      expect(exists("node_modules")).toBe(true);
    });

    test("should still run install if interactive mode is used", async () => {
      setupProject("package-lock.json");
      mockRlInterface.question.mockResolvedValue("y");
      await cleanup({ dir: root, install: true, interactive: true, verbose: false });
      expect(exists("node_modules")).toBe(false);
      expect(execa()).toHaveBeenCalledWith("npm", ["install"], expect.objectContaining({ cwd: root }));
      expect(mockRlInterface.close).toHaveBeenCalled();
    });
  });

  test("should log error if deletion fails (e.g., rmSync throws)", async () => {
    make(root, { node_modules: { file: "a" } });
    const rmSyncSpy = jest.spyOn(fs, "rmSync").mockImplementation(() => {
      throw new Error("Mock rmSync Error");
    });

    const result = await cleanup({ dir: root, verbose: false });

    expect(console.error).toHaveBeenCalledWith(
      `Error processing ${path.join(root, "node_modules")}:`,
      expect.objectContaining({ message: "Mock rmSync Error" })
    );
    expect(result.failed).toEqual([path.join(root, "node_modules")]);
    rmSyncSpy.mockRestore();
  });
});
