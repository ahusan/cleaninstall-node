// `cleaninstall-node doctor`: work out *why* an install is broken and apply
// the smallest fix, instead of always deleting node_modules.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const semver = require("semver");
const yaml = require("js-yaml");
const { globSync } = require("glob");
const {
  INSTALL_COMMANDS,
  readJson,
  declaredPackageManager,
  presentLockfiles,
  detectPackageManager,
  readWorkspacePatterns,
  readDenoConfig,
  denoNodeModulesMode,
  denoNpmImports,
  denoImports,
  denoWorkspaceMembers,
  parseDenoSpecifier,
  findOnPath,
} = require("./project");

const MAX_LISTED = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function finding(severity, id, title, extra = {}) {
  return { severity, id, title, details: [], ...extra };
}

function listSome(items, fmt = (x) => x) {
  const shown = items.slice(0, MAX_LISTED).map(fmt);
  if (items.length > MAX_LISTED) shown.push(`…and ${items.length - MAX_LISTED} more`);
  return shown;
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Which package manager wrote this node_modules, judged by its state files.
function detectInstaller(nodeModules) {
  if (isDir(path.join(nodeModules, ".deno"))) return "deno";
  if (fs.existsSync(path.join(nodeModules, ".modules.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(nodeModules, ".yarn-integrity"))) return "yarn";
  if (fs.existsSync(path.join(nodeModules, ".yarn-state.yml"))) return "yarn";
  if (fs.existsSync(path.join(nodeModules, ".package-lock.json"))) return "npm";
  return null; // bun and very old npm leave no marker
}

function isYarnBerry(rootDir) {
  const lock = readText(path.join(rootDir, "yarn.lock"));
  return Boolean(lock && lock.includes("__metadata:"));
}

// Workspace package directories (absolute), excluding the root.
function workspaceDirs(rootDir) {
  const patterns = readWorkspacePatterns(rootDir);
  const negative = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  const dirs = new Set();
  for (const pattern of patterns.filter((p) => !p.startsWith("!"))) {
    try {
      for (const d of globSync(pattern, {
        cwd: rootDir,
        absolute: true,
        ignore: [...negative, "**/node_modules/**"],
      })) {
        if (isDir(d) && fs.existsSync(path.join(d, "package.json"))) dirs.add(path.resolve(d));
      }
    } catch {
      // ignore bad patterns
    }
  }
  for (const d of denoWorkspaceMembers(rootDir).dirs) dirs.add(d);
  dirs.delete(path.resolve(rootDir));
  return [...dirs];
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

// Read a pinned version from a version-manager file.
function pinnedNodeVersions(rootDir, pkg) {
  const pins = [];
  for (const file of [".nvmrc", ".node-version"]) {
    const text = readText(path.join(rootDir, file));
    if (text && text.trim()) pins.push({ source: file, value: text.trim().split(/\s+/)[0] });
  }
  const tv = readText(path.join(rootDir, ".tool-versions"));
  if (tv) {
    const line = tv.split("\n").find((l) => /^(nodejs|node)\s+/.test(l.trim()));
    if (line) pins.push({ source: ".tool-versions", value: line.trim().split(/\s+/)[1] });
  }
  if (pkg && pkg.volta && pkg.volta.node) pins.push({ source: "volta.node", value: String(pkg.volta.node) });
  return pins;
}

function checkNodeVersion(rootDir, pkg, nodeVersion) {
  const findings = [];
  const current = semver.clean(nodeVersion);

  for (const pin of pinnedNodeVersions(rootDir, pkg)) {
    const raw = pin.value.replace(/^v/, "");
    if (!/^\d/.test(raw)) {
      // lts/*, node, stable, lts/iron… — can't compare without a network lookup
      continue;
    }
    const wantedMajor = semver.coerce(raw) && semver.coerce(raw).major;
    if (wantedMajor !== semver.major(current)) {
      findings.push(
        finding("error", "node-version", `Node ${nodeVersion} is running but ${pin.source} wants ${pin.value}`, {
          details: ["Installs, native modules and engines checks will not match the rest of the team."],
          blocksFix: true,
          manual: pin.source === ".nvmrc" ? "nvm use" : `switch to Node ${pin.value}`,
        })
      );
    } else if (semver.valid(raw) && raw !== current) {
      findings.push(
        finding("warn", "node-version", `Node ${nodeVersion} is running; ${pin.source} pins ${pin.value}`, {
          manual: pin.source === ".nvmrc" ? "nvm use" : `switch to Node ${pin.value}`,
        })
      );
    } else {
      findings.push(finding("ok", "node-version", `Node ${nodeVersion} matches ${pin.source} (${pin.value})`));
    }
  }

  const range = pkg && pkg.engines && pkg.engines.node;
  if (range && semver.validRange(range)) {
    if (!semver.satisfies(current, range, { includePrerelease: true })) {
      findings.push(
        finding("error", "node-engines", `Node ${nodeVersion} does not satisfy engines.node "${range}"`, {
          blocksFix: true,
          manual: `switch to a Node version matching ${range}`,
        })
      );
    } else if (!findings.some((f) => f.severity === "ok")) {
      findings.push(finding("ok", "node-engines", `Node ${nodeVersion} satisfies engines.node "${range}"`));
    }
  }
  return findings;
}

function checkPackageManager(rootDir, pkg, packageManager) {
  const findings = [];
  const locks = presentLockfiles(rootDir);
  const declared = declaredPackageManager(rootDir);
  const hasDeps =
    pkg && ["dependencies", "devDependencies", "optionalDependencies"].some(
      (k) => pkg[k] && Object.keys(pkg[k]).length > 0
    );

  const managers = [...new Set(locks.map((l) => l.manager))];
  if (managers.length > 1) {
    findings.push(
      finding("warn", "multiple-lockfiles", `Lockfiles from ${managers.length} package managers: ${locks.map((l) => l.file).join(", ")}`, {
        details: [`Keep the one for ${packageManager} and delete the rest, or teammates will install different trees.`],
        manual: "delete the lockfiles you don't use",
      })
    );
  }

  if (declared && locks.length > 0 && !locks.some((l) => l.manager === declared)) {
    findings.push(
      finding("warn", "package-manager-field", `packageManager says ${declared}, but the lockfile is ${locks[0].file}`, {
        manual: `run ${declared} install to create its lockfile, or fix the packageManager field`,
      })
    );
  }

  if (hasDeps && locks.length === 0) {
    findings.push(
      finding("warn", "no-lockfile", "No lockfile: every install can resolve different versions", {
        manual: `run ${packageManager} install and commit the lockfile`,
      })
    );
  }

  const nm = path.join(rootDir, "node_modules");
  const installer = isDir(nm) ? detectInstaller(nm) : null;
  if (installer && installer !== packageManager) {
    findings.push(
      finding("error", "wrong-installer", `node_modules was installed by ${installer}, but this project uses ${packageManager}`, {
        details: ["Package managers lay out node_modules differently; mixing them causes missing or duplicate packages."],
        fix: { kind: "reinstall" },
      })
    );
  }

  if (findings.length === 0 && locks.length > 0) {
    findings.push(finding("ok", "package-manager", `Using ${packageManager} (${locks[0].file})`));
  }
  return findings;
}

// npm: compare package-lock.json against node_modules/.package-lock.json
function npmSync(rootDir) {
  const lock = readJson(path.join(rootDir, "package-lock.json")) || readJson(path.join(rootDir, "npm-shrinkwrap.json"));
  const hidden = readJson(path.join(rootDir, "node_modules", ".package-lock.json"));
  if (!lock || !lock.packages || !hidden || !hidden.packages) return null;

  const problems = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key.includes("node_modules/")) continue;
    if (entry.link || entry.extraneous) continue;
    const installed = hidden.packages[key];
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    if (!installed) {
      // Optional deps for other platforms are never installed
      if (entry.optional || entry.devOptional) continue;
      problems.push(`${name} ${entry.version} is not installed`);
    } else if (installed.version !== entry.version) {
      problems.push(`${name}: installed ${installed.version}, lockfile ${entry.version}`);
    }
  }
  return { lockfile: "package-lock.json", problems };
}

// pnpm: compare the importers in pnpm-lock.yaml with node_modules/.pnpm/lock.yaml
function pnpmSync(rootDir) {
  const wantedText = readText(path.join(rootDir, "pnpm-lock.yaml"));
  const currentText = readText(path.join(rootDir, "node_modules", ".pnpm", "lock.yaml"));
  if (!wantedText || !currentText) return null;
  let wanted;
  let current;
  try {
    wanted = yaml.load(wantedText);
    current = yaml.load(currentText);
  } catch {
    return null;
  }
  const importersOf = (lock) =>
    lock.importers || {
      ".": {
        dependencies: lock.dependencies,
        devDependencies: lock.devDependencies,
        optionalDependencies: lock.optionalDependencies,
      },
    };
  const w = importersOf(wanted);
  const c = importersOf(current);
  const problems = [];
  for (const [project, deps] of Object.entries(w)) {
    for (const type of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, spec] of Object.entries((deps && deps[type]) || {})) {
        const want = typeof spec === "object" ? spec.version : spec;
        const curDeps = c[project] && c[project][type];
        const cur = curDeps && curDeps[name];
        const have = cur && (typeof cur === "object" ? cur.version : cur);
        const label = project === "." ? name : `${project}: ${name}`;
        if (!have) problems.push(`${label} ${want} is not installed`);
        else if (have !== want) problems.push(`${label}: installed ${have}, lockfile ${want}`);
      }
    }
  }
  return { lockfile: "pnpm-lock.yaml", problems };
}

// yarn v1: compare yarn.lock with node_modules/.yarn-integrity
function parseYarnV1Lock(text) {
  const entries = {};
  let patterns = null;
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    if (!line.startsWith(" ") && line.endsWith(":")) {
      patterns = line
        .slice(0, -1)
        .split(/,\s*/)
        .map((p) => p.replace(/^"|"$/g, ""));
      for (const p of patterns) entries[p] = null;
    } else if (patterns) {
      const m = line.match(/^\s+resolved\s+"?([^"]+)"?/);
      if (m) for (const p of patterns) entries[p] = m[1];
    }
  }
  return entries;
}

function yarnSync(rootDir) {
  if (isYarnBerry(rootDir)) return null;
  const lockText = readText(path.join(rootDir, "yarn.lock"));
  const integrity = readJson(path.join(rootDir, "node_modules", ".yarn-integrity"));
  if (!lockText || !integrity || !integrity.lockfileEntries) return null;
  const lock = parseYarnV1Lock(lockText);
  const problems = [];
  for (const [pattern, resolved] of Object.entries(lock)) {
    const have = integrity.lockfileEntries[pattern];
    if (have === undefined) problems.push(`${pattern} is not installed`);
    else if (resolved && have !== resolved) problems.push(`${pattern} resolves differently than installed`);
  }
  for (const pattern of Object.keys(integrity.lockfileEntries)) {
    if (!(pattern in lock)) problems.push(`${pattern} is installed but no longer in yarn.lock`);
  }
  return { lockfile: "yarn.lock", problems };
}

// deno: deno.lock "npm" entries vs node_modules/.deno/<name@version>
// (scoped names are stored as @scope+name@version, with an .initialized marker).
const denoDirName = (key) => key.replace(/\//g, "+");
const nameOfKey = (key) => key.slice(0, key.indexOf("@", 1));
const versionOfKey = (key) => key.slice(key.indexOf("@", 1) + 1).split("_")[0];

function readDenoLock(rootDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, "deno.lock"), "utf8"));
  } catch {
    return null;
  }
}

function matchesPlatform(entry) {
  const ok = (field, current) => {
    if (!field) return true;
    const list = [].concat(field);
    if (list.some((x) => x === `!${current}`)) return false;
    const positive = list.filter((x) => !String(x).startsWith("!"));
    return positive.length === 0 || positive.includes(current);
  };
  return ok(entry.os, process.platform) && ok(entry.cpu, process.arch);
}

function denoSync(rootDir) {
  const lock = readDenoLock(rootDir);
  const store = path.join(rootDir, "node_modules", ".deno");
  if (!lock || !lock.npm || !isDir(store)) return null;

  const installed = new Map(); // name -> [versions]
  for (const dir of fs.readdirSync(store)) {
    if (dir.startsWith(".") || dir === "node_modules") continue;
    const key = dir.replace(/^(@[^+]+)\+/, "$1/");
    const name = nameOfKey(key);
    if (!installed.has(name)) installed.set(name, []);
    installed.get(name).push(versionOfKey(key));
  }

  // Packages only reachable as optional dependencies may legitimately be absent.
  const optionalOnly = new Set();
  const required = new Set();
  // Lock dependency lists hold "name" or "name@version".
  const depName = (d) => {
    const str = String(d);
    const at = str.indexOf("@", 1);
    return at === -1 ? str : str.slice(0, at);
  };
  for (const entry of Object.values(lock.npm)) {
    for (const d of entry.dependencies || []) required.add(depName(d));
    for (const d of entry.optionalDependencies || []) optionalOnly.add(depName(d));
  }

  const problems = [];
  for (const [key, entry] of Object.entries(lock.npm)) {
    const name = nameOfKey(key);
    const version = versionOfKey(key);
    const dir = path.join(store, denoDirName(key));
    if (isDir(dir)) {
      if (!fs.existsSync(path.join(dir, ".initialized"))) problems.push(`${name}@${version} was only partly installed`);
      continue;
    }
    if (!matchesPlatform(entry)) continue; // another OS/CPU's binary
    const others = (installed.get(name) || []).filter((v) => v !== version);
    if (others.length) problems.push(`${name}: installed ${others.join(", ")}, lockfile ${version}`);
    else if (!(optionalOnly.has(name) && !required.has(name))) problems.push(`${name} ${version} is not installed`);
  }
  return { lockfile: "deno.lock", problems: [...new Set(problems)] };
}

function checkLockfileSync(rootDir, packageManager) {
  const result =
    packageManager === "npm" ? npmSync(rootDir) :
    packageManager === "pnpm" ? pnpmSync(rootDir) :
    packageManager === "yarn" ? yarnSync(rootDir) :
    packageManager === "deno" ? denoSync(rootDir) : null;
  if (!result) return [];
  if (result.problems.length === 0) {
    return [finding("ok", "lockfile-sync", `node_modules matches ${result.lockfile}`)];
  }
  return [
    finding("error", "lockfile-sync", `node_modules is out of sync with ${result.lockfile} (${result.problems.length} difference${result.problems.length === 1 ? "" : "s"})`, {
      details: [...listSome(result.problems), "Usually happens after git pull / switching branches without reinstalling."],
      fix: { kind: "install" },
    }),
  ];
}

// Every direct dependency is installed and satisfies its range. Works for
// any package manager that uses node_modules.
function resolveInstalled(name, fromDir, rootDir) {
  let dir = fromDir;
  for (;;) {
    const manifest = path.join(dir, "node_modules", name, "package.json");
    if (fs.existsSync(manifest)) return readJson(manifest) || {};
    if (dir === rootDir) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function checkDirectDependencies(rootDir) {
  if (fs.existsSync(path.join(rootDir, ".pnp.cjs"))) return []; // Yarn PnP: no node_modules
  const missing = [];
  const mismatched = [];
  let checked = 0;

  for (const dir of [rootDir, ...workspaceDirs(rootDir)]) {
    const pkg = readJson(path.join(dir, "package.json")) || {};
    const denoImportsHere = readDenoConfig(dir) ? denoNpmImports(dir) : {};
    if (!Object.keys(pkg).length && !Object.keys(denoImportsHere).length) continue;
    const where = dir === rootDir ? "" : `${path.relative(rootDir, dir)}: `;
    const groups = { dependencies: pkg.dependencies, devDependencies: pkg.devDependencies, optionalDependencies: pkg.optionalDependencies, denoImports: denoImportsHere };
    for (const type of Object.keys(groups)) {
      for (const [name, specRaw] of Object.entries(groups[type] || {})) {
        let spec = String(specRaw);
        if (spec.startsWith("npm:")) {
          const at = spec.lastIndexOf("@");
          spec = at > 4 ? spec.slice(at + 1) : "*";
        }
        checked += 1;
        const installed = resolveInstalled(name, dir, rootDir);
        if (!installed) {
          if (type !== "optionalDependencies") missing.push(`${where}${name}`);
          continue;
        }
        if (
          semver.validRange(spec) &&
          installed.version &&
          !semver.satisfies(installed.version, spec, { includePrerelease: true })
        ) {
          mismatched.push(`${where}${name}: installed ${installed.version}, ${type === "denoImports" ? "deno.json" : "package.json"} wants ${spec}`);
        }
      }
    }
  }

  const findings = [];
  if (missing.length > 0) {
    findings.push(
      finding("error", "missing-deps", `${missing.length} dependenc${missing.length === 1 ? "y is" : "ies are"} not installed`, {
        details: listSome(missing),
        fix: { kind: "install" },
      })
    );
  }
  if (mismatched.length > 0) {
    findings.push(
      finding("error", "dep-versions", `${mismatched.length} installed version${mismatched.length === 1 ? " doesn't" : "s don't"} match package.json`, {
        details: listSome(mismatched),
        fix: { kind: "install" },
      })
    );
  }
  if (findings.length === 0 && checked > 0) {
    findings.push(finding("ok", "direct-deps", `All ${checked} direct dependencies installed and in range`));
  }
  return findings;
}

// Find compiled addons (build/Release/*.node) in node_modules, including
// pnpm's .pnpm store. prebuilds/ folders are skipped: node-gyp-build picks
// the right one at runtime and they're usually N-API (ABI stable).
function findNativeAddons(rootDir) {
  const addons = [];
  const seen = new Set();

  const visitPackage = (pkgDir) => {
    let real;
    try {
      real = fs.realpathSync(pkgDir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    for (const sub of ["build/Release", "build/Debug"]) {
      const d = path.join(real, sub);
      if (!isDir(d)) continue;
      for (const f of fs.readdirSync(d)) {
        if (f.endsWith(".node")) {
          const manifest = readJson(path.join(real, "package.json")) || {};
          addons.push({ file: path.join(d, f), package: manifest.name || path.basename(real) });
        }
      }
    }
    const nested = path.join(real, "node_modules");
    if (isDir(nested)) visitNodeModules(nested);
  };

  const visitNodeModules = (nm) => {
    let entries;
    try {
      entries = fs.readdirSync(nm, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(nm, e.name);
      if (e.name === ".pnpm" || e.name === ".deno") {
        for (const inner of fs.readdirSync(p)) {
          const innerNm = path.join(p, inner, "node_modules");
          if (isDir(innerNm)) visitNodeModules(innerNm);
        }
      } else if (e.name.startsWith(".")) {
        continue;
      } else if (e.name.startsWith("@")) {
        for (const scoped of fs.readdirSync(p)) visitPackage(path.join(p, scoped));
      } else {
        visitPackage(p);
      }
    }
  };

  for (const dir of [rootDir, ...workspaceDirs(rootDir)]) {
    const nm = path.join(dir, "node_modules");
    if (isDir(nm)) visitNodeModules(nm);
  }
  return addons;
}

// Load an addon in a throwaway process so a crash can't take us down, using
// the runtime that will actually load it: Deno for Deno projects, Node
// otherwise (the real `node`, even when this tool itself runs under Deno).
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");

function addonLoader(runtime) {
  const underDeno = Boolean(process.versions.deno);
  if (runtime === "deno") {
    const bin = underDeno ? process.execPath : "deno";
    return (file) =>
      spawnAddon(bin, ["eval", "import process from 'node:process'; process.dlopen({ exports: {} }, Deno.env.get('CIN_ADDON'));"], {
        ...process.env,
        CIN_ADDON: file,
        NO_COLOR: "1",
      });
  }
  // Under Deno, spawning "node" runs Deno itself, so find the real binary.
  const bin = underDeno ? findOnPath("node") : process.execPath;
  if (!bin) return () => ({ skipped: true, reason: "Node.js isn't installed" });
  return (file) => spawnAddon(bin, ["-e", "process.dlopen({ exports: {} }, process.argv[1])", file], process.env);
}


function spawnAddon(bin, args, env) {
  let res;
  try {
    res = spawnSync(bin, args, { encoding: "utf8", timeout: 15000, env });
  } catch (error) {
    res = { error };
  }
  if (res.error && res.error.code === "ENOENT") return { skipped: true, reason: `${path.basename(bin)} isn't installed` };
  // Deno without --allow-run refuses to start the check: say so, don't guess.
  // (Deno's spawnSync then returns an empty object: no status, no error.)
  const refused =
    (res.error && (res.error.code === "NotCapable" || /Requires run access/.test(String(res.error.message)))) ||
    (process.versions.deno && !res.error && (res.status === undefined || res.status === null) && !res.signal);
  if (refused) return { skipped: true, reason: "Deno needs --allow-run to load them" };
  if (res.status === 0) return { ok: true };
  return { ok: false, error: stripAnsi(res.stderr || (res.error && res.error.message) || `exit ${res.status}`).trim() };
}

const defaultLoadAddon = addonLoader("node");

function classifyLoadError(message) {
  if (/legacy Node\.js native addon API|Only Node-API \(N-API\) addons are supported/.test(message)) {
    return { kind: "deno-unsupported" };
  }
  const abi = message.match(/NODE_MODULE_VERSION (\d+)\.[\s\S]*?requires\s+NODE_MODULE_VERSION (\d+)/);
  if (abi) return { kind: "abi", built: Number(abi[1]), required: Number(abi[2]) };
  if (/invalid ELF header|wrong ELF class|not a mach-o|mach-o file, but is an incompatible architecture|is not a valid Win32 application|Exec format error/i.test(message)) {
    return { kind: "platform" };
  }
  return { kind: "other" };
}

function checkNativeModules(rootDir, loadAddon = defaultLoadAddon, runtime = "node") {
  const addons = findNativeAddons(rootDir);
  if (addons.length === 0) return [];

  const abi = [];
  const platform = [];
  const other = [];
  const denoUnsupported = [];
  let skipped = null;
  for (const addon of addons) {
    const res = loadAddon(addon.file);
    if (res.skipped) {
      skipped = res.reason;
      break;
    }
    if (res.ok) continue;
    const c = classifyLoadError(res.error || "");
    const firstLine = (res.error || "").split("\n").find((l) => /Error/.test(l)) || res.error || "";
    if (c.kind === "deno-unsupported") denoUnsupported.push(addon);
    else if (c.kind === "abi") abi.push({ ...addon, ...c });
    else if (c.kind === "platform") platform.push(addon);
    else other.push({ ...addon, error: firstLine.replace(`${addon.file}: `, "").trim().slice(0, 160) });
  }

  if (skipped) {
    return [
      finding("info", "native-skipped", `Skipped the native module check: ${skipped}`, {
        details: [
          `${addons.length} native module${addons.length === 1 ? "" : "s"} found; ${
            /allow-run/.test(skipped) ? "re-run with --allow-run" : `install ${runtime === "deno" ? "Deno" : "Node.js"}`
          } to check them.`,
        ],
      }),
    ];
  }

  const findings = [];
  const packagesOf = (list) => [...new Set(list.map((a) => a.package))];
  const filesOf = (list) => list.map((a) => a.file);

  if (denoUnsupported.length > 0) {
    const pkgs = packagesOf(denoUnsupported);
    findings.push(
      finding("error", "native-deno-unsupported", `${pkgs.length} native module${pkgs.length === 1 ? " uses" : "s use"} the legacy addon API, which Deno can't load`, {
        details: [...listSome(pkgs), "Deno only supports Node-API (N-API) addons. Rebuilding won't help."],
        manual: `Use a Node-API build of ${pkgs.join(", ")} (often a newer version), or run this project with Node.js`,
      })
    );
  }

  if (abi.length > 0) {
    const pkgs = packagesOf(abi);
    findings.push(
      finding("error", "native-abi", `${pkgs.length} native module${pkgs.length === 1 ? " was" : "s were"} built for a different Node version`, {
        details: listSome(abi, (a) => `${a.package}: built for ABI ${a.built}, this Node needs ${a.required}`),
        fix: { kind: "rebuild", packages: pkgs, files: filesOf(abi) },
      })
    );
  }
  if (platform.length > 0) {
    const pkgs = packagesOf(platform);
    findings.push(
      finding("error", "native-platform", `${pkgs.length} native module${pkgs.length === 1 ? " was" : "s were"} built for a different OS/CPU`, {
        details: [...listSome(pkgs), "Common when node_modules is shared between a host and a Docker container, or across Rosetta/arm64."],
        fix: { kind: "rebuild", packages: pkgs, files: filesOf(platform) },
      })
    );
  }
  if (other.length > 0) {
    findings.push(
      finding("warn", "native-load", `${other.length} native module${other.length === 1 ? "" : "s"} failed to load`, {
        details: listSome(other, (a) => `${a.package}: ${a.error}`),
        fix: { kind: "rebuild", packages: packagesOf(other), files: filesOf(other) },
      })
    );
  }
  if (findings.length === 0) {
    findings.push(finding("ok", "native", `${addons.length} native module${addons.length === 1 ? "" : "s"} load correctly`));
  }
  return findings;
}

// Manager-specific hints recorded in node_modules state files.
function checkInstallerState(rootDir, packageManager) {
  const findings = [];
  const nm = path.join(rootDir, "node_modules");

  if (packageManager === "pnpm") {
    try {
      const modules = yaml.load(readText(path.join(nm, ".modules.yaml")) || "") || {};
      const ignored = modules.ignoredBuilds || [];
      if (ignored.length > 0) {
        findings.push(
          finding("warn", "pnpm-ignored-builds", `pnpm skipped build scripts for ${ignored.length} package${ignored.length === 1 ? "" : "s"}`, {
            details: [...listSome(ignored), "If one of these misbehaves (missing binary, native module not found), approve its build."],
            manual: "pnpm approve-builds",
          })
        );
      }
    } catch {
      // ignore unreadable state
    }
  }

  if (packageManager === "deno") {
    const lock = readDenoLock(rootDir);
    const store = path.join(nm, ".deno");
    const skippedScripts = Object.entries((lock && lock.npm) || {})
      .filter(([key, entry]) => entry.scripts && isDir(path.join(store, denoDirName(key))))
      .filter(([key]) => !fs.existsSync(path.join(store, denoDirName(key), ".scripts-run")))
      .map(([key]) => nameOfKey(key));
    if (skippedScripts.length > 0) {
      const names = [...new Set(skippedScripts)];
      findings.push(
        finding("warn", "deno-skipped-scripts", `Deno didn't run install scripts for ${names.length} package${names.length === 1 ? "" : "s"}`, {
          details: [...listSome(names), "Deno only runs npm install scripts you allow. If one of these misbehaves (missing binary, native module not found), allow it."],
          manual: `deno install --allow-scripts=${names.map((n) => `npm:${n}`).join(",")}`,
        })
      );
    }
  }

  if (packageManager === "yarn") {
    const integrity = readJson(path.join(nm, ".yarn-integrity"));
    const expected = `${process.platform}-${process.arch}-${process.versions.modules}`;
    if (integrity && integrity.systemParams && integrity.systemParams !== expected) {
      findings.push(
        finding("warn", "yarn-system", `node_modules was installed for ${integrity.systemParams}, this machine is ${expected}`, {
          details: ["The last install used a different Node version or platform."],
          fix: { kind: "install" },
        })
      );
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Diagnose + plan
// ---------------------------------------------------------------------------

function diagnose(rootDirInput, options = {}) {
  const rootDir = path.resolve(rootDirInput || process.cwd());
  const nodeVersion = options.nodeVersion || process.version;
  const pkg = readJson(path.join(rootDir, "package.json"));
  const packageManager = detectPackageManager(rootDir);
  const findings = [];

  if (!pkg) {
    const deno = readDenoConfig(rootDir);
    if (deno) return diagnoseDenoOnly(rootDir, deno, options);
    findings.push(finding("error", "no-package-json", `No package.json in ${rootDir}`));
    return { rootDir, packageManager, findings, plan: planFixes(findings, packageManager) };
  }

  findings.push(...checkNodeVersion(rootDir, pkg, nodeVersion));
  findings.push(...checkPackageManager(rootDir, pkg, packageManager));
  findings.push(...checkDenoProject(rootDir, packageManager));

  const hasNodeModules = isDir(path.join(rootDir, "node_modules"));
  const hasDeps = ["dependencies", "devDependencies", "optionalDependencies"].some(
    (k) => pkg[k] && Object.keys(pkg[k]).length > 0
  );
  const isPnP = fs.existsSync(path.join(rootDir, ".pnp.cjs"));

  if (!hasNodeModules && hasDeps && !isPnP) {
    findings.push(finding("error", "not-installed", "Dependencies are not installed (no node_modules)", { fix: { kind: "install" } }));
  } else if (hasNodeModules) {
    const wrongInstaller = findings.some((f) => f.id === "wrong-installer");
    if (!wrongInstaller) {
      findings.push(...checkLockfileSync(rootDir, packageManager));
      findings.push(...checkDirectDependencies(rootDir));
      findings.push(...checkInstallerState(rootDir, packageManager));
    }
    if (options.native !== false) {
      const runtime = packageManager === "deno" ? "deno" : "node";
      findings.push(...checkNativeModules(rootDir, options.loadAddon || addonLoader(runtime), runtime));
    }
  }

  return { rootDir, packageManager, findings, plan: planFixes(findings, packageManager) };
}

// Deno-native checks: Deno installed, deno.json files valid, workspace
// members present, and deno.lock covering every jsr:/npm: import.
function checkDenoProject(rootDir, packageManager) {
  const findings = [];
  const deno = readDenoConfig(rootDir);
  if (!deno && packageManager !== "deno") return findings;

  if (packageManager === "deno" && !process.versions.deno && !findOnPath("deno")) {
    findings.push(
      finding("warn", "deno-missing", "This is a Deno project, but Deno isn't installed", {
        manual: "install Deno (https://docs.deno.com/runtime/getting_started/installation/)",
      })
    );
  }
  if (!deno) return findings;

  const { dirs: members, missing } = denoWorkspaceMembers(rootDir);
  for (const dir of [rootDir, ...members]) {
    const config = readDenoConfig(dir);
    if (config && config.invalid) {
      const file = path.join(path.relative(rootDir, dir), config.file);
      findings.push(
        finding("error", "deno-config-invalid", `${file} isn't valid JSON`, {
          details: [config.error].filter(Boolean),
          manual: `fix the syntax in ${file}`,
        })
      );
    }
  }
  if (missing.length) {
    findings.push(
      finding("warn", "deno-workspace-missing", `${missing.length} workspace member${missing.length === 1 ? " in deno.json doesn't" : "s in deno.json don't"} exist`, {
        details: [...listSome(missing), "Deno skips them with a warning, so their code and dependencies are silently left out."],
        manual: "fix the \"workspace\" list in deno.json",
      })
    );
  }

  const lock = readDenoLock(rootDir);
  if (lock && lock.workspace) {
    const locked = new Set();
    const addAll = (list) => {
      for (const spec of list || []) {
        const p = parseDenoSpecifier(spec);
        if (p) locked.add(`${p.registry}:${p.name}`);
      }
    };
    addAll(lock.workspace.dependencies);
    addAll(lock.workspace.packageJson && lock.workspace.packageJson.dependencies);
    for (const m of Object.values(lock.workspace.members || {})) {
      addAll(m.dependencies);
      addAll(m.packageJson && m.packageJson.dependencies);
    }
    const wanted = [...new Set([rootDir, ...members].flatMap((d) => denoImports(d)).map((i) => `${i.registry}:${i.name}`))];
    const notLocked = wanted.filter((w) => !locked.has(w));
    if (notLocked.length) {
      findings.push(
        finding("warn", "deno-lock-outdated", `deno.lock is missing ${notLocked.length} import${notLocked.length === 1 ? "" : "s"} from deno.json`, {
          details: [...listSome(notLocked), "Deno updates deno.lock on the next run, but `deno install --frozen` (and CI) fails until the updated lockfile is committed."],
          fix: { kind: "install" },
          manual: "commit the updated deno.lock",
        })
      );
    } else if (wanted.length) {
      findings.push(finding("ok", "deno-lock-config", `deno.lock covers all ${wanted.length} jsr:/npm: imports in deno.json`));
    }
  }
  return findings;
}

// A Deno project with deno.json/deno.jsonc and no package.json.
function diagnoseDenoOnly(rootDir, deno, options) {
  const packageManager = "deno";
  const findings = [];
  const imports = denoNpmImports(rootDir);
  const mode = denoNodeModulesMode(rootDir);
  const hasImports = Object.keys(imports).length > 0;

  if (!deno.invalid) findings.push(finding("ok", "package-manager", `Deno project (${deno.file})`));
  findings.push(...checkDenoProject(rootDir, packageManager));

  if (hasImports && !fs.existsSync(path.join(rootDir, "deno.lock"))) {
    findings.push(
      finding("warn", "no-lockfile", "No deno.lock: every install can resolve different versions", {
        manual: "run deno install and commit deno.lock",
      })
    );
  }

  if (mode === "none") {
    findings.push(
      finding("info", "deno-global-cache", "Deno keeps npm packages in its global cache here (nodeModulesDir isn't set), so there's no node_modules to check", {
        details: hasImports ? [`npm imports: ${Object.keys(imports).join(", ")}`] : [],
      })
    );
    return { rootDir, packageManager, findings, plan: planFixes(findings, packageManager) };
  }

  const nm = path.join(rootDir, "node_modules");
  if (!isDir(nm)) {
    if (hasImports) findings.push(finding("error", "not-installed", "Dependencies are not installed (no node_modules)", { fix: { kind: "install" } }));
  } else {
    const installer = detectInstaller(nm);
    if (installer && installer !== "deno") {
      findings.push(
        finding("error", "wrong-installer", `node_modules was installed by ${installer}, but this project uses deno`, {
          fix: { kind: "reinstall" },
        })
      );
    } else {
      findings.push(...checkLockfileSync(rootDir, packageManager));
      findings.push(...checkDirectDependencies(rootDir));
      findings.push(...checkInstallerState(rootDir, packageManager));
    }
    if (options.native !== false) {
      findings.push(...checkNativeModules(rootDir, options.loadAddon || addonLoader("deno"), "deno"));
    }
  }
  return { rootDir, packageManager, findings, plan: planFixes(findings, packageManager) };
}

// Explain a pasted error in the context of the project, and fold it into
// doctor's findings so one fix plan covers both.
function diagnoseFromError(rootDirInput, text, options = {}) {
  const { explainError } = require("./errors");
  const report = diagnose(rootDirInput, options);
  const matches = explainError(text, {
    rootDir: report.rootDir,
    packageManager: report.packageManager,
    workspaceDirs: workspaceDirs(report.rootDir),
  });
  const related = new Set(matches.flatMap((m) => m.relatedFindings || []));
  for (const f of report.findings) {
    if (related.has(f.id) && f.severity !== "ok") f.related = true;
  }
  const errorFindings = matches.map((m) => ({
    severity: "error",
    id: `error:${m.id}`,
    source: "error",
    title: m.title,
    details: m.explanation || [],
    ...(m.fix ? { fix: m.fix } : {}),
    ...(m.manual ? { manual: m.manual } : {}),
    ...(m.blocksFix ? { blocksFix: true } : {}),
  }));
  const findings = [...errorFindings, ...report.findings];
  return {
    ...report,
    findings,
    plan: planFixes(findings, report.packageManager),
    error: { recognized: matches.length > 0, matches },
  };
}

// The package's own folder in Deno's store, from a path inside it.
function denoStoreDir(file) {
  const m = String(file).replace(/\\/g, "/").match(/^(.*\/node_modules\/\.deno\/[^/]+)\//);
  return m ? m[1] : null;
}

function rebuildCommand(packageManager, packages, files = []) {
  // pnpm has its own rebuild; npm rebuild works on any node_modules layout
  if (packageManager === "pnpm") return { cmd: "pnpm", args: ["rebuild", ...packages] };
  if (packageManager === "deno") {
    // Deno won't re-run scripts for a package it already set up, so remove just
    // that package's folder and let `deno install` set it up again.
    const removePaths = [...new Set(files.map(denoStoreDir).filter(Boolean))];
    return {
      cmd: "deno",
      args: ["install", `--allow-scripts=${packages.map((p) => `npm:${p}`).join(",")}`],
      removePaths,
    };
  }
  return { cmd: "npm", args: ["rebuild", ...packages] };
}

// Turn findings into the smallest set of steps that fixes them.
function planFixes(findings, packageManager) {
  const blockers = findings.filter((f) => f.blocksFix && f.severity === "error");
  const manual = findings.filter((f) => f.manual && f.severity !== "ok").flatMap((f) => [].concat(f.manual));
  if (blockers.length > 0) {
    return { steps: [], blocked: blockers.map((f) => f.title), manual: [...new Set(manual)] };
  }

  const kinds = new Set(findings.filter((f) => f.fix).map((f) => f.fix.kind));
  const steps = [];
  const install = { cmd: packageManager, args: INSTALL_COMMANDS[packageManager] };

  if (kinds.has("reinstall")) {
    steps.push({ kind: "reinstall", label: `remove node_modules and run ${install.cmd} ${install.args.join(" ")}`, ...install });
  } else {
    if (kinds.has("install")) {
      steps.push({ kind: "install", label: `${install.cmd} ${install.args.join(" ")}`, ...install });
    }
    const rebuildPkgs = [
      ...new Set(findings.filter((f) => f.fix && f.fix.kind === "rebuild").flatMap((f) => f.fix.packages)),
    ];
    if (rebuildPkgs.length > 0) {
      const files = findings.filter((f) => f.fix && f.fix.kind === "rebuild").flatMap((f) => f.fix.files || []);
      const rb = rebuildCommand(packageManager, rebuildPkgs, files);
      const prefix = rb.removePaths && rb.removePaths.length ? `remove ${rb.removePaths.map((p) => "node_modules/.deno/" + path.basename(p)).join(", ")}, then ` : "";
      steps.push({ kind: "rebuild", label: `${prefix}${rb.cmd} ${rb.args.join(" ")}`, ...rb });
    }
  }
  return { steps, blocked: [], manual: [...new Set(manual)] };
}

// ---------------------------------------------------------------------------
// Output + CLI entry
// ---------------------------------------------------------------------------

const ICONS = { ok: "✔", info: "ℹ", warn: "⚠", error: "✖" };

function summarize(findings) {
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warn").length;
  return { errors, warnings };
}

const ORDER = { error: 0, warn: 1, info: 2, ok: 3 };

function printFindings(findings, log) {
  for (const f of [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity])) {
    log(`  ${ICONS[f.severity]} ${f.title}${f.related ? "   ← likely related" : ""}`);
    for (const d of f.details) log(`      ${d}`);
  }
}

function printReport(report, log = console.log) {
  log(`\n🩺 cleaninstall-node doctor — ${report.rootDir} (${report.packageManager})\n`);
  printFindings(report.findings, log);
  printPlan(report, log);
}

function printFromErrorReport(report, log = console.log) {
  log(`\n🩺 cleaninstall-node doctor --from-error — ${report.rootDir} (${report.packageManager})\n`);
  const fromError = report.findings.filter((f) => f.source === "error");
  const project = report.findings.filter((f) => f.source !== "error");
  if (fromError.length === 0) {
    log("  ? Didn't recognise this error. Here's what doctor found in the project:\n");
    printFindings(project, log);
  } else {
    log("What the error means");
    printFindings(fromError, log);
    const notable = project.filter((f) => f.severity === "error" || f.severity === "warn");
    const passed = project.length - notable.length;
    log("\nIn this project");
    if (notable.length > 0) printFindings(notable, log);
    if (passed > 0) log(`  ${ICONS.ok} ${passed} other check${passed === 1 ? "" : "s"} passed`);
  }
  printPlan(report, log);
}

function printPlan(report, log) {
  const { errors, warnings } = summarize(report.findings);
  log("");
  if (errors === 0 && warnings === 0) {
    log("All good — no need to delete node_modules. 🎉");
    return;
  }
  log(`${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}.`);
  const { steps, blocked, manual } = report.plan;
  if (blocked.length > 0) {
    log("\nFix the Node version first — reinstalling now would build for the wrong Node:");
  }
  if (manual.length > 0) {
    if (blocked.length === 0) log("\nTo do by hand:");
    for (const m of manual) log(`  → ${m}`);
  }
  if (steps.length > 0) {
    log("\nSmallest fix (run with --fix to apply):");
    for (const s of steps) log(`  → ${s.label}`);
  }
}

// Run one fix step. Used by `doctor --fix` and the MCP apply_fix tool.
async function runFixStep(step, rootDir, { run, cleanupMain, stdio = "inherit" }) {
  if (step.kind === "reinstall") {
    await cleanupMain(
      { dir: rootDir, yes: true, verbose: false, dirsToRemove: ["node_modules"], filesToRemove: [], install: false },
      run
    );
  }
  const store = path.join(rootDir, "node_modules", ".deno") + path.sep;
  for (const p of step.removePaths || []) {
    const target = path.resolve(p);
    // Only ever a single package folder inside Deno's store in this project.
    if (!target.startsWith(store) || target.slice(store.length).includes(path.sep)) {
      throw new Error(`Refusing to remove ${target}: not a package folder in ${store}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
  await run(step.cmd, step.args, { stdio, cwd: rootDir });
}

async function applyFixes(report, { execa, cleanupMain, log = console.log }) {
  for (const step of report.plan.steps) {
    log(`\n🔧 ${step.label}`);
    await runFixStep(step, report.rootDir, { run: execa, cleanupMain });
  }
}

// --from-error value: the text itself, or "-" / no value to read stdin.
function readErrorText(value, readStdin) {
  if (typeof value === "string" && value !== "-") return value;
  if (readStdin) return readStdin();
  if (process.stdin.isTTY) {
    throw new Error(
      'Pass the error text, e.g. --from-error "Cannot find module \'x\'", or pipe it: <command> 2>&1 | npx cleaninstall-node doctor --from-error'
    );
  }
  return fs.readFileSync(0, "utf8");
}

async function runDoctor(options, execa) {
  const json = Boolean(options.json);
  const log = json ? () => {} : console.log;
  const diagOpts = { native: options.native };
  const fromError = options.fromError !== undefined && options.fromError !== false;
  const errorText = fromError ? readErrorText(options.fromError, options.readStdin) : null;
  const run = () => (fromError ? diagnoseFromError(options.dir, errorText, diagOpts) : diagnose(options.dir, diagOpts));
  const print = fromError ? printFromErrorReport : printReport;
  let report = run();

  if (options.fix && report.plan.steps.length > 0 && report.plan.blocked.length === 0) {
    if (!json) print(report, log);
    const { main: cleanupMain } = require("../bin/cleanup.js");
    await applyFixes(report, { execa, cleanupMain, log });
    log("\nRe-checking the project…");
    // The pasted error describes the past; after fixing, check the project itself.
    report = diagnose(options.dir, diagOpts);
    if (fromError) report.error = { fixed: true };
    if (!json) {
      printReport(report, log);
      if (fromError) log("\nRun the command that failed again to confirm the error is gone.");
    }
  } else if (!json) {
    print(report, log);
  }

  if (json) {
    process.stdout.write(JSON.stringify({ ...report, summary: summarize(report.findings) }, null, 2) + "\n");
  }
  if (summarize(report.findings).errors > 0) process.exitCode = 1;
  return report;
}

module.exports = {
  diagnose,
  runFixStep,
  addonLoader,
  denoSync,
  diagnoseFromError,
  readErrorText,
  printFromErrorReport,
  runDoctor,
  planFixes,
  printReport,
  classifyLoadError,
  findNativeAddons,
  parseYarnV1Lock,
  detectInstaller,
};
