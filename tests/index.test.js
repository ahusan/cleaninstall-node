const fs = require("fs");
const path = require("path");
const mockFs = require("mock-fs");
const { cleanup, DEFAULT_CONFIG } = require("../index");

// Mock console methods to prevent test output noise
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

beforeEach(() => {
  console.log = jest.fn();
  console.warn = jest.fn();
  console.error = jest.fn();
});

afterEach(() => {
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;
  mockFs.restore();
});

describe("cleanup function", () => {
  test("should remove specified directories and files", async () => {
    // Setup mock filesystem
    mockFs({
      "/project": {
        "package.json": JSON.stringify({
          name: "test-project",
          version: "1.0.0",
        }),
        node_modules: {
          "some-package": {
            "package.json": "{}",
          },
        },
        "package-lock.json": "mock content",
        src: {
          "index.js": 'console.log("Hello World");',
        },
      },
    });

    // Run cleanup
    await cleanup({ dir: "/project" });

    // Check if node_modules and package-lock.json were removed
    expect(fs.existsSync("/project/node_modules")).toBe(false);
    expect(fs.existsSync("/project/package-lock.json")).toBe(false);

    // Check that src directory was not removed
    expect(fs.existsSync("/project/src")).toBe(true);
  });

  test("should respect custom configuration", async () => {
    // Setup mock filesystem
    mockFs({
      "/project": {
        "package.json": JSON.stringify({
          name: "test-project",
          version: "1.0.0",
        }),
        node_modules: {
          "some-package": {
            "package.json": "{}",
          },
        },
        dist: {
          "bundle.js": 'console.log("bundled");',
        },
        src: {
          "index.js": 'console.log("Hello World");',
        },
      },
    });

    // Run cleanup with custom config
    await cleanup({
      dir: "/project",
      dirsToRemove: ["dist"], // Only remove dist, not node_modules
      filesToRemove: [], // Don't remove any files
    });

    // Check if dist was removed but node_modules was not
    expect(fs.existsSync("/project/dist")).toBe(false);
    expect(fs.existsSync("/project/node_modules")).toBe(true);
  });

  test("should handle monorepo structure", async () => {
    // Setup mock filesystem with monorepo structure
    mockFs({
      "/monorepo": {
        "package.json": JSON.stringify({
          name: "monorepo",
          version: "1.0.0",
        }),
        node_modules: {
          "some-package": {
            "package.json": "{}",
          },
        },
        apps: {
          app1: {
            "package.json": "{}",
            node_modules: {
              "app-dep": {
                "package.json": "{}",
              },
            },
          },
          app2: {
            "package.json": "{}",
            node_modules: {
              "app-dep": {
                "package.json": "{}",
              },
            },
          },
        },
        packages: {
          pkg1: {
            "package.json": "{}",
            node_modules: {
              "pkg-dep": {
                "package.json": "{}",
              },
            },
          },
        },
      },
    });

    // Run cleanup
    await cleanup({ dir: "/monorepo" });

    // Check if node_modules were removed from root and workspaces
    expect(fs.existsSync("/monorepo/node_modules")).toBe(false);
    expect(fs.existsSync("/monorepo/apps/app1/node_modules")).toBe(false);
    expect(fs.existsSync("/monorepo/apps/app2/node_modules")).toBe(false);
    expect(fs.existsSync("/monorepo/packages/pkg1/node_modules")).toBe(false);
  });

  test("should load config from package.json", async () => {
    // Setup mock filesystem with config in package.json
    mockFs({
      "/project": {
        "package.json": JSON.stringify({
          name: "test-project",
          version: "1.0.0",
          cleaninstallNode: {
            dirsToRemove: ["custom-dir"],
            filesToRemove: ["custom-file.txt"],
          },
        }),
        node_modules: {
          "some-package": {
            "package.json": "{}",
          },
        },
        "custom-dir": {
          "file.txt": "content",
        },
        "custom-file.txt": "content",
      },
    });

    // Run cleanup
    await cleanup({ dir: "/project" });

    // Check if custom-dir and custom-file.txt were removed
    expect(fs.existsSync("/project/custom-dir")).toBe(false);
    expect(fs.existsSync("/project/custom-file.txt")).toBe(false);

    // node_modules should not be removed as it's not in the custom config
    expect(fs.existsSync("/project/node_modules")).toBe(true);
  });

  test("should load config from .cleaninstallnoderc", async () => {
    // Setup mock filesystem with .cleaninstallnoderc
    mockFs({
      "/project": {
        "package.json": JSON.stringify({
          name: "test-project",
          version: "1.0.0",
        }),
        ".cleaninstallnoderc": JSON.stringify({
          dirsToRemove: ["rc-dir"],
          filesToRemove: ["rc-file.txt"],
        }),
        node_modules: {
          "some-package": {
            "package.json": "{}",
          },
        },
        "rc-dir": {
          "file.txt": "content",
        },
        "rc-file.txt": "content",
      },
    });

    // Run cleanup
    await cleanup({ dir: "/project" });

    // Check if rc-dir and rc-file.txt were removed
    expect(fs.existsSync("/project/rc-dir")).toBe(false);
    expect(fs.existsSync("/project/rc-file.txt")).toBe(false);

    // node_modules should not be removed as it's not in the custom config
    expect(fs.existsSync("/project/node_modules")).toBe(true);
  });

  test("should handle errors gracefully", async () => {
    // Setup mock filesystem with a file that can't be accessed
    mockFs({
      "/project": {
        "package.json": JSON.stringify({
          name: "test-project",
          version: "1.0.0",
        }),
        node_modules: mockFs.directory({
          mode: 0, // This will cause permission errors
          items: {
            "some-package": {
              "package.json": "{}",
            },
          },
        }),
      },
    });

    // Run cleanup and expect it not to throw
    await expect(cleanup({ dir: "/project" })).resolves.not.toThrow();

    // Error should have been logged
    expect(console.error).toHaveBeenCalled();
  });
});
