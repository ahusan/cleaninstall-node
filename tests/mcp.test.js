// MCP server: driven by the official @modelcontextprotocol/sdk client over
// real stdio, plus direct tests of the tool logic with a stubbed runner.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { LATEST_PROTOCOL_VERSION } = require("@modelcontextprotocol/sdk/types.js");
const { createServer, resolveProjectDir } = require("../lib/mcp");

const CLI = path.resolve(__dirname, "../bin/cleanup.js");
const FIX = path.join(__dirname, "fixtures", "errors");
const json = (o) => JSON.stringify(o);

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

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cin-mcp-")));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("over stdio with the official MCP SDK client", () => {
  let client;
  let transport;

  async function connect(dir = root) {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp", "--dir", dir],
      stderr: "pipe",
    });
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);
  }
  afterEach(async () => {
    if (client) await client.close();
    client = undefined;
  });

  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    return { ...res, data: res.isError ? null : JSON.parse(res.content[0].text) };
  };

  test("handshake: latest protocol, server info, instructions, tools with annotations", async () => {
    make(root, { "package.json": json({ name: "app" }) });
    await connect();
    expect(client.getServerVersion()).toEqual(
      expect.objectContaining({ name: "cleaninstall-node", version: require("../package.json").version })
    );
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: false } });
    expect(client.getInstructions()).toContain("BEFORE deleting node_modules or lockfiles");

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["diagnose", "explain_error", "apply_fix", "plan_clean", "clean"]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const ro of ["diagnose", "explain_error", "plan_clean"]) expect(byName[ro].annotations.readOnlyHint).toBe(true);
    for (const rw of ["apply_fix", "clean"]) {
      expect(byName[rw].annotations.destructiveHint).toBe(true);
      expect(byName[rw].inputSchema.required).toContain("plan_id");
    }
  });

  test("explain_error: structured meaning + plan_id", async () => {
    make(root, { "package.json": json({ name: "app" }), "package-lock.json": "{}", node_modules: {} });
    await connect();
    const res = await call("explain_error", { error: fs.readFileSync(path.join(FIX, "abi.txt"), "utf8") });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual(res.data);
    expect(res.data.error.matches[0].id).toBe("native-abi");
    expect(res.data.plan.steps).toEqual([{ kind: "rebuild", command: "npm rebuild old-native" }]);
    expect(res.data.plan_id).toMatch(/^[0-9a-f]{12}$/);
    expect(res.data.next).toContain(res.data.plan_id);
  });

  test("diagnose a healthy-but-uninstalled project", async () => {
    make(root, { "package.json": json({ name: "app", dependencies: { ms: "^2" } }), "package-lock.json": "{}" });
    await connect();
    const { data } = await call("diagnose", { native: false });
    expect(data.findings.map((f) => f.id)).toContain("not-installed");
    expect(data.plan.steps[0].command).toBe("npm install");
  });

  test("plan_clean -> clean deletes exactly the plan, keeps lockfiles, refuses a stale plan_id", async () => {
    make(root, {
      "package.json": json({ name: "app" }),
      "package-lock.json": "{}",
      node_modules: { a: { "index.js": "x".repeat(100) } },
      dist: { "out.js": "y" },
      src: { "index.js": "z" },
    });
    await connect();
    const plan = (await call("plan_clean", {})).data;
    expect(plan.targets.map((t) => t.path).sort()).toEqual(["dist", "node_modules"]);
    expect(plan.totalBytes).toBe(101);
    expect(exists("node_modules")).toBe(true); // read-only

    const stale = await call("clean", { plan_id: "000000000000" });
    expect(stale.isError).toBe(true);
    expect(stale.content[0].text).toContain("Call plan_clean again");
    expect(exists("node_modules")).toBe(true);

    const done = (await call("clean", { plan_id: plan.plan_id })).data;
    expect(done.removed.sort()).toEqual(["dist", "node_modules"]);
    expect(exists("node_modules")).toBe(false);
    expect(exists("package-lock.json")).toBe(true);
    expect(exists("src/index.js")).toBe(true);
  });

  test("clean with lockfiles=true needs a plan made with lockfiles=true", async () => {
    make(root, { "package.json": json({ name: "app" }), "package-lock.json": "{}", node_modules: {} });
    await connect();
    const withoutLock = (await call("plan_clean", {})).data;
    const mismatch = await call("clean", { plan_id: withoutLock.plan_id, lockfiles: true });
    expect(mismatch.isError).toBe(true);
    const withLock = (await call("plan_clean", { lockfiles: true })).data;
    expect(withLock.targets.map((t) => t.path)).toContain("package-lock.json");
    await call("clean", { plan_id: withLock.plan_id, lockfiles: true });
    expect(exists("package-lock.json")).toBe(false);
  });

  test("apply_fix refuses a stale plan_id", async () => {
    make(root, { "package.json": json({ name: "app", dependencies: { ms: "^2" } }), "package-lock.json": "{}" });
    await connect();
    const res = await call("apply_fix", { plan_id: "deadbeef0000", native: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("plan changed");
  });

  test("path guard: no package.json / missing dir are tool errors", async () => {
    make(root, { "package.json": json({ name: "app" }), empty: {} });
    await connect();
    const noPkg = await call("diagnose", { dir: "empty" });
    expect(noPkg.isError).toBe(true);
    expect(noPkg.content[0].text).toContain("No package.json");
    expect((await call("plan_clean", { dir: "does-not-exist" })).isError).toBe(true);
  });

  test("unknown tool is a protocol error", async () => {
    make(root, { "package.json": json({ name: "app" }) });
    await connect();
    await expect(client.callTool({ name: "rm_rf", arguments: {} })).rejects.toThrow(/Unknown tool/);
  });
});

test("accepts the SDK's latest protocol version as-is", async () => {
  const out = [];
  const s = createServer({ write: (l) => out.push(JSON.parse(l)), cwd: os.tmpdir(), execa: jest.fn() });
  s.receive(json({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION } }));
  expect(out[0].result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
});

describe("resolveProjectDir", () => {
  test("refuses root and home", () => {
    expect(() => resolveProjectDir("/", "/")).toThrow(/filesystem root/);
    expect(() => resolveProjectDir(os.homedir(), "/")).toThrow(/home directory/);
  });
});

describe("tool logic with a stubbed command runner", () => {
  // Drive createServer directly so apply_fix can run without network access.
  function server(execa) {
    const out = [];
    const s = createServer({ write: (line) => out.push(JSON.parse(line)), cwd: root, execa });
    let id = 0;
    return {
      out,
      async call(name, args, meta) {
        id += 1;
        s.receive(json({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } }));
        await s.idle();
        const msg = out.find((m) => m.id === id);
        return msg.result.isError ? { error: msg.result.content[0].text } : JSON.parse(msg.result.content[0].text);
      },
    };
  }

  test("apply_fix runs the planned rebuild, captures output, re-checks, and sends progress", async () => {
    make(root, { "package.json": json({ name: "app" }), "package-lock.json": "{}", node_modules: {} });
    const execa = jest.fn(async () => ({ exitCode: 0, all: "rebuilt old-native" }));
    const s = server(execa);
    const error = fs.readFileSync(path.join(FIX, "abi.txt"), "utf8");
    const plan = await s.call("explain_error", { error });
    const res = await s.call("apply_fix", { plan_id: plan.plan_id, error }, { progressToken: "p1" });

    expect(execa).toHaveBeenCalledWith("npm", ["rebuild", "old-native"], expect.objectContaining({ cwd: root, stdio: "pipe" }));
    expect(res.applied).toEqual([{ command: "npm rebuild old-native", exitCode: 0, output: "rebuilt old-native" }]);
    expect(res.recheck.summary.errors).toBe(0);
    expect(res.next).toContain("Re-run the command that failed");
    expect(s.out.some((m) => m.method === "notifications/progress" && m.params.progressToken === "p1")).toBe(true);
  });

  test("apply_fix reports a failing step instead of throwing", async () => {
    make(root, { "package.json": json({ name: "app", dependencies: { ms: "^2" } }), "package-lock.json": "{}" });
    const execa = jest.fn(async () => ({ exitCode: 1, all: "npm error network ETIMEDOUT" }));
    const s = server(execa);
    const plan = await s.call("diagnose", { native: false });
    const res = await s.call("apply_fix", { plan_id: plan.plan_id, native: false });
    expect(res.failed.step).toBe("npm install");
    expect(res.applied[0].output).toContain("ETIMEDOUT");
  });

  test("apply_fix is blocked on the wrong Node version", async () => {
    make(root, { "package.json": json({ name: "app", dependencies: { ms: "^2" } }), ".nvmrc": "10" });
    const execa = jest.fn();
    const s = server(execa);
    const plan = await s.call("diagnose", { native: false });
    expect(plan.plan_id).toBeUndefined();
    expect(plan.next).toContain("blocked");
    const res = await s.call("apply_fix", { plan_id: "anything", native: false });
    expect(res.error).toContain("blocked");
    expect(execa).not.toHaveBeenCalled();
  });

  test("clean with install=true runs the install with captured output", async () => {
    make(root, { "package.json": json({ name: "app" }), "package-lock.json": "{}", node_modules: { x: "1" } });
    const execa = jest.fn(async () => ({ exitCode: 0, all: "added 1 package" }));
    const s = server(execa);
    const plan = await s.call("plan_clean", { only: ["node_modules"] });
    const res = await s.call("clean", { plan_id: plan.plan_id, only: ["node_modules"], install: true });
    expect(res.removed).toEqual(["node_modules"]);
    expect(res.installed).toBe(true);
    expect(res.applied[0]).toEqual(expect.objectContaining({ command: "npm install", output: "added 1 package" }));
  });

  test("protocol basics: version negotiation, ping, unknown methods, notifications", async () => {
    const out = [];
    const s = createServer({ write: (l) => out.push(JSON.parse(l)), cwd: root, execa: jest.fn() });
    s.receive(json({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }));
    s.receive(json({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }));
    s.receive(json({ jsonrpc: "2.0", method: "notifications/initialized" }));
    s.receive(json({ jsonrpc: "2.0", id: 3, method: "ping" }));
    s.receive(json({ jsonrpc: "2.0", id: 4, method: "resources/list" }));
    s.receive("{not json");
    await s.idle();
    expect(out.find((m) => m.id === 1).result.protocolVersion).toBe("2024-11-05");
    expect(out.find((m) => m.id === 2).result.protocolVersion).toBe("2025-11-25");
    expect(out.find((m) => m.id === 3).result).toEqual({});
    expect(out.find((m) => m.id === 4).error.code).toBe(-32601);
    expect(out.find((m) => m.id === null).error.code).toBe(-32700);
    expect(out).toHaveLength(5); // the notification got no reply
  });
});
