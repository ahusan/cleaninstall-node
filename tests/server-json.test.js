// The official MCP Registry rejects a publish unless server.json matches the
// npm package: same name as package.json "mcpName", same version, and a
// description of at most 100 characters.
const pkg = require('../package.json');
const server = require('../server.json');

describe('server.json (MCP Registry listing)', () => {
  test('name matches package.json mcpName', () => {
    expect(pkg.mcpName).toBe('io.github.ahusan/cleaninstall-node');
    expect(server.name).toBe(pkg.mcpName);
  });

  test('versions match package.json', () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0].version).toBe(pkg.version);
  });

  test('describes the npm package and how to start the server', () => {
    const p = server.packages[0];
    expect(p.registryType).toBe('npm');
    // Not pkg.name: the GitHub Packages job renames the package to
    // @ahusan/cleaninstall-node before publishing, which runs these tests.
    expect(p.identifier).toBe('cleaninstall-node');
    expect(p.transport).toEqual({ type: 'stdio' });
    expect(p.packageArguments).toEqual([{ type: 'positional', value: 'mcp' }]);
  });

  test('description fits the registry limit', () => {
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  test('repository points at this repo', () => {
    expect(server.repository).toEqual({ url: 'https://github.com/ahusan/cleaninstall-node', source: 'github' });
  });
});
