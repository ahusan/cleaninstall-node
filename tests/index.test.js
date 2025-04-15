const fs = require("fs");
const path = require("path");
const mockFs = require("mock-fs");
const { cleanup, DEFAULT_CONFIG } = require("../index");

// Mock console methods to prevent test output noise
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

// --- Define persistent mock objects BEFORE jest.mock calls ---

// Persistent mock for the readline interface object
const mockRlInterface = {
  question: jest.fn(),
  close: jest.fn(),
};

// --- Mock Modules ---

// Mock readline module
jest.mock("readline/promises", () => ({
  // createInterface is now just a basic mock function
  createInterface: jest.fn(),
}));

// Mock execa module
jest.mock("execa", () => ({
  execa: jest.fn(),
}));

beforeEach(async () => {
  // Make beforeEach async if needed for imports
  // Reset console mocks
  console.log = jest.fn();
  console.warn = jest.fn();
  console.error = jest.fn();

  // Reset readline interface mock methods
  mockRlInterface.question.mockReset();
  mockRlInterface.close.mockReset();

  // Get the mocked createInterface function *after* jest.mock runs
  // and set its implementation to return our persistent mock object.
  // Use dynamic import if necessary, or ensure require order works.
  const { createInterface } = require("readline/promises");
  createInterface.mockImplementation(() => mockRlInterface);

  // Reset execa mock using direct require
  // Check if the mocked module and function exist before resetting
  try {
    const execaMock = require("execa");
    if (execaMock && typeof execaMock.execa?.mockReset === "function") {
      execaMock.execa.mockReset();
    } else {
      // console.warn("Could not reset execa mock in beforeEach");
    }
  } catch (e) {
    /* Ignore if require fails, mock might not be fully set up */
  }

  // Restore file system
  mockFs.restore();
});

afterEach(() => {
  // Restore console and filesystem
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;
  mockFs.restore();
});

describe("cleanup function", () => {
  test("should remove specified directories and files", async () => {
    mockFs({
      "/project": {
        // Mock root
        "package.json": "{}",
        node_modules: { file: "a" },
        "package-lock.json": "lock",
        src: { file: "f" },
      },
    });
    // Ensure dir option points to mock root
    await cleanup({ dir: "/project", verbose: false });
    expect(fs.existsSync("/project/node_modules")).toBe(false);
    expect(fs.existsSync("/project/package-lock.json")).toBe(false);
    expect(fs.existsSync("/project/src")).toBe(true);
  });

  test("should respect custom configuration options", async () => {
    mockFs({
      "/project": {
        // Mock root
        "package.json": "{}",
        node_modules: { file: "a" },
        dist: { file: "b" },
      },
    });
    await cleanup({
      dir: "/project", // Explicit dir
      dirsToRemove: ["dist"],
      filesToRemove: [],
      verbose: false,
    });
    expect(fs.existsSync("/project/dist")).toBe(false);
    expect(fs.existsSync("/project/node_modules")).toBe(true);
  });

  test("should use scanDepth to find nested packages if no workspaces defined", async () => {
    mockFs({
      "/project": {
        "package.json": "{}", // Root package.json
        node_modules: {}, // Root node_modules
        subdir: {
          "package.json": "{}", // Nested package
          node_modules: { nested: "dep" },
        },
        other_dir: {
          // No package.json
          node_modules: { other: "dep" },
        },
        deep: {
          nested: {
            "package.json": "{}",
            node_modules: {}, // Depth 3
          },
        },
      },
    });

    // Default scanDepth is 2, should clean root and subdir
    await cleanup({ dir: "/project", verbose: false });
    expect(fs.existsSync("/project/node_modules")).toBe(false);
    expect(fs.existsSync("/project/subdir/node_modules")).toBe(false);
    expect(fs.existsSync("/project/other_dir/node_modules")).toBe(true); // Should be skipped
    expect(fs.existsSync("/project/deep/nested/node_modules")).toBe(true); // Should be skipped (depth 3)

    // Re-setup mock FS for depth 1 test
    mockFs({
      "/project": {
        "package.json": "{}",
        node_modules: {},
        subdir: {
          "package.json": "{}",
          node_modules: { nested: "dep" },
        },
      },
    });
    // Explicit depth 1 should only clean root
    await cleanup({ dir: "/project", verbose: false, depth: 1 });
    expect(fs.existsSync("/project/node_modules")).toBe(false);
    expect(fs.existsSync("/project/subdir/node_modules")).toBe(true); // Should be skipped
  });

  test("should load config from package.json", async () => {
    mockFs({
      "/project": {
        "package.json": JSON.stringify({
          cleaninstallNode: {
            /* config */
          },
        }),
        "custom-dir": {},
        "custom-file.txt": "",
        node_modules: {},
      },
    });
    // Explicit dir
    await cleanup({ dir: "/project", verbose: false });
    // ... assertions ...
  });

  test("should load config from .cleaninstallnoderc", async () => {
    mockFs({
      "/project": {
        ".cleaninstallnoderc": JSON.stringify({
          /* config */
        }),
        "rc-dir": {},
        "rc-file.txt": "",
        node_modules: {},
      },
    });
    // Explicit dir
    await cleanup({ dir: "/project", verbose: false });
    // ... assertions ...
  });

  // --- Workspace Detection Tests ---
  test("should handle monorepo using package.json workspaces", async () => {
    mockFs({
      "/monorepo": {
        /* structure */
      },
    });
    // Explicit dir
    await cleanup({ dir: "/monorepo", verbose: false });
    // ... assertions ...
  });

  test("should handle monorepo using pnpm-workspace.yaml", async () => {
    mockFs({
      "/monorepo": {
        /* structure */
      },
    });
    // Explicit dir
    await cleanup({ dir: "/monorepo", verbose: false });
    // ... assertions ...
  });

  // --- Glob Pattern Tests ---
  describe("glob pattern support", () => {
    test("should remove directories matching glob patterns", async () => {
      mockFs({
        "/project": {
          /* structure */
        },
      });
      // Explicit dir
      await cleanup({
        dir: "/project",
        dirsToRemove: ["cache-*", "node_modules"],
        verbose: false,
      });
      // ... assertions ...
    });

    test("should remove files matching glob patterns", async () => {
      mockFs({
        "/project": {
          /* structure */
        },
      });
      // Explicit dir
      await cleanup({
        dir: "/project",
        filesToRemove: ["*.log", "*.tmp", "package-lock.json"],
        verbose: false,
      });
      // ... assertions ...
    });
  });

  // --- Dry Run Tests ---
  test("should not delete files in dry run mode", async () => {
    mockFs({
      "/project": {
        /* structure */
      },
    });
    // Explicit dir
    await cleanup({ dir: "/project", dryRun: true, verbose: true });
    // ... assertions ...
  });

  // --- Interactive Tests ---
  describe("interactive mode", () => {
    beforeEach(() => {
      mockFs({
        "/project": {
          /* structure */
        },
      });
    });

    test("should delete items if user confirms (y)", async () => {
      mockRlInterface.question.mockResolvedValue("y");
      // Explicit dir
      await cleanup({ dir: "/project", interactive: true, verbose: false });
      // ... assertions ...
    });

    test("should delete items if user confirms (yes)", async () => {
      mockRlInterface.question.mockResolvedValue("yes");
      // Explicit dir
      await cleanup({ dir: "/project", interactive: true, verbose: false });
      // ... assertions ...
    });

    test("should skip items if user denies (n)", async () => {
      mockRlInterface.question.mockResolvedValue("n");
      // Explicit dir
      await cleanup({ dir: "/project", interactive: true, verbose: false });
      // ... assertions ...
    });

    test("should skip items if user denies (anything else)", async () => {
      mockRlInterface.question.mockResolvedValue("maybe");
      // Explicit dir
      await cleanup({ dir: "/project", interactive: true, verbose: false });
      // ... assertions ...
    });
  });

  // --- Auto-Install Tests ---
  describe("auto-install mode", () => {
    const setupProject = (lockFile) => {
      const files = { "/project": { node_modules: {} } };
      if (lockFile) {
        files["/project"][lockFile] = "lock";
      }
      mockFs(files);
    };

    test("should run pnpm install if pnpm-lock.yaml exists", async () => {
      setupProject("pnpm-lock.yaml");
      await cleanup({ dir: "/project", install: true, verbose: false });
      expect(fs.existsSync("/project/node_modules")).toBe(false);
      // Access mock directly via require
      expect(require("execa").execa).toHaveBeenCalledWith(
        "pnpm",
        ["install"],
        expect.objectContaining({ cwd: "/project" })
      );
    });

    test("should run yarn install if yarn.lock exists", async () => {
      setupProject("yarn.lock");
      await cleanup({ dir: "/project", install: true, verbose: false });
      expect(fs.existsSync("/project/node_modules")).toBe(false);
      // Access mock directly via require
      expect(require("execa").execa).toHaveBeenCalledWith(
        "yarn",
        ["install"],
        expect.objectContaining({ cwd: "/project" })
      );
    });

    test("should run npm install if package-lock.json exists", async () => {
      setupProject("package-lock.json");
      await cleanup({ dir: "/project", install: true, verbose: false });
      expect(fs.existsSync("/project/node_modules")).toBe(false);
      // Access mock directly via require
      expect(require("execa").execa).toHaveBeenCalledWith(
        "npm",
        ["install"],
        expect.objectContaining({ cwd: "/project" })
      );
    });

    test("should run npm install if no lock file exists", async () => {
      setupProject(null);
      await cleanup({ dir: "/project", install: true, verbose: false });
      expect(fs.existsSync("/project/node_modules")).toBe(false);
      // Access mock directly via require
      expect(require("execa").execa).toHaveBeenCalledWith(
        "npm",
        ["install"],
        expect.objectContaining({ cwd: "/project" })
      );
    });

    test("should not run install if install: false", async () => {
      setupProject("package-lock.json");
      await cleanup({ dir: "/project", install: false, verbose: false });
      // Access mock directly via require
      expect(require("execa").execa).not.toHaveBeenCalled();
    });

    test("should not run install if dryRun: true", async () => {
      setupProject("package-lock.json");
      await cleanup({
        dir: "/project",
        install: true,
        dryRun: true,
        verbose: false,
      });
      // Access mock directly via require
      expect(require("execa").execa).not.toHaveBeenCalled();
    });

    test("should still run install if interactive mode is used", async () => {
      setupProject("package-lock.json");
      mockRlInterface.question.mockResolvedValue("y");
      await cleanup({
        dir: "/project",
        install: true,
        interactive: true,
        verbose: false,
      });
      // Access mock directly via require
      expect(require("execa").execa).toHaveBeenCalledWith(
        "npm",
        ["install"],
        expect.objectContaining({ cwd: "/project" })
      );
      expect(mockRlInterface.close).toHaveBeenCalled();
    });
  });

  // --- Error Handling ---
  test("should log error if deletion fails (e.g., rmSync throws)", async () => {
    mockFs({
      "/project": {
        node_modules: { file: "a" },
      },
    });

    // Spy on fs.rmSync and make it throw an actual Error object
    const rmSyncSpy = jest.spyOn(fs, "rmSync").mockImplementation(() => {
      throw new Error("Mock rmSync Error"); // Throw Error object
    });

    // Run cleanup
    await cleanup({ dir: "/project", verbose: false });

    // Expect console.error to have been called due to the mocked error
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Error processing /project/node_modules"),
      expect.any(Error) // Assertion should now pass
    );
    // Check that the specific mocked error message was part of the logged Error object
    expect(console.error).toHaveBeenCalledWith(
      expect.anything(), // The message string
      expect.objectContaining({ message: "Mock rmSync Error" })
    );

    // Restore the original rmSync implementation
    rmSyncSpy.mockRestore();
  });
});
