// End-to-end: run the real CLI in a child process against temp directories.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const CLI = path.resolve(__dirname, "../bin/cleanup.js");
const pkg = require("../package.json");

function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    input: "", // stdin is not a TTY, so no confirmation prompt
    env: { ...process.env, CI: "true" },
    ...opts,
  });
  return { code: res.status, out: res.stdout + res.stderr };
}

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cin-cli-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("CLI", () => {
  test("--version prints the package version", () => {
    const { code, out } = run(["--version"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe(pkg.version);
  });

  test("--help lists the options and subcommands", () => {
    const { out } = run(["--help"]);
    for (const s of ["--dry-run", "-i, --interactive", "-y, --yes", "--lockfiles", "--install", "doctor", "hook"]) {
      expect(out).toContain(s);
    }
  });

  test("cleans a project without prompting when stdin is not a TTY", () => {
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
    fs.mkdirSync(path.join(root, "node_modules", "a"), { recursive: true });
    fs.writeFileSync(path.join(root, "build"), "#!/bin/sh\n");

    const { code } = run(["-d", root, "--no-verbose"]);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(root, "package-lock.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "build"))).toBe(true);
  });

  test("--dry-run deletes nothing", () => {
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    fs.mkdirSync(path.join(root, "dist"));
    const { code, out } = run(["-d", root, "--dry-run", "--no-verbose"]);
    expect(code).toBe(0);
    expect(out).toContain("Would remove");
    expect(fs.existsSync(path.join(root, "dist"))).toBe(true);
  });

  test("doctor --json reports and exits 1 on errors", () => {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { ms: "^2" } }));
    const { code, out } = run(["doctor", "-d", root, "--json", "--no-native"]);
    expect(code).toBe(1);
    const report = JSON.parse(out);
    expect(report.findings.map((f) => f.id)).toContain("not-installed");
    expect(report.plan.steps[0].label).toBe("npm install");
  });
});
