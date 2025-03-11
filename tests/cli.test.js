const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const mockFs = require("mock-fs");

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

// Helper function to run the CLI
function runCLI(args = "") {
  const cliPath = path.resolve(__dirname, "../bin/cleanup.js");
  try {
    return execSync(`node ${cliPath} ${args}`, {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    return error.stdout;
  }
}

describe("CLI", () => {
  test("should display help information with --help flag", () => {
    const output = runCLI("--help");
    expect(output).toContain("Usage:");
    expect(output).toContain("Options:");
    expect(output).toContain("--version");
    expect(output).toContain("--dir");
    expect(output).toContain("--verbose");
  });

  test("should display version with --version flag", () => {
    const output = runCLI("--version");
    const packageJson = require("../package.json");
    expect(output.trim()).toBe(packageJson.version);
  });

  // Note: We can't fully test the CLI's file system operations with mock-fs
  // because execSync creates a new process that doesn't see the mocked file system.
  // For more comprehensive CLI testing, we would need integration tests.
});
