// lib/run.js: the built-in replacement for execa. Real child processes.
const { run } = require("../lib/run");

const node = process.execPath;

test("resolves with exit code 0 and captures stdout + stderr with all: true", async () => {
  const res = await run(node, ["-e", "console.log('out'); console.error('err')"], { stdio: "pipe", all: true });
  expect(res.exitCode).toBe(0);
  expect(res.all).toContain("out");
  expect(res.all).toContain("err");
});

test("rejects on a non-zero exit by default, with the exit code on the error", async () => {
  await expect(run(node, ["-e", "process.exit(3)"])).rejects.toMatchObject({ exitCode: 3 });
});

test("reject: false resolves with the exit code instead", async () => {
  const res = await run(node, ["-e", "console.log('x'); process.exit(2)"], { all: true, reject: false });
  expect(res).toMatchObject({ exitCode: 2, failed: true });
  expect(res.all).toContain("x");
});

test("a missing command rejects (ENOENT), or resolves with 127 when reject: false", async () => {
  await expect(run("definitely-not-a-real-command-xyz", [])).rejects.toThrow();
  const res = await run("definitely-not-a-real-command-xyz", [], { reject: false });
  expect(res.exitCode).toBe(127);
});

test("passes cwd and arguments with spaces through unchanged", async () => {
  const os = require("os");
  const res = await run(node, ["-e", "console.log(process.cwd() + '|' + process.argv[1])", "a b c"], {
    cwd: os.tmpdir(),
    all: true,
  });
  expect(res.all.trim()).toBe(`${require("fs").realpathSync(os.tmpdir())}|a b c`);
});

test("stdio: inherit streams to the terminal and still resolves", async () => {
  const res = await run(node, ["-e", "0"], { stdio: "inherit" });
  expect(res.exitCode).toBe(0);
});
