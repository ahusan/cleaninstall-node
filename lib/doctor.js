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

function checkLockfileSync(rootDir, packageManager) {
  const result =
    packageManager === "npm" ? npmSync(rootDir) :
    packageManager === "pnpm" ? pnpmSync(rootDir) :
    packageManager === "yarn" ? yarnSync(rootDir) : null;
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
    const pkg = readJson(path.join(dir, "package.json"));
    if (!pkg) continue;
    const where = dir === rootDir ? "" : `${path.relative(rootDir, dir)}: `;
    for (const type of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, specRaw] of Object.entries(pkg[type] || {})) {
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
          mismatched.push(`${where}${name}: installed ${installed.version}, package.json wants ${spec}`);
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
      if (e.name === ".pnpm") {
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

// Load an addon in a throwaway process so a crash can't take us down.
function defaultLoadAddon(file) {
  const res = spawnSync(
    process.execPath,
    ["-e", "process.dlopen({ exports: {} }, process.argv[1])", file],
    { encoding: "utf8", timeout: 15000 }
  );
  if (res.status === 0) return { ok: true };
  return { ok: false, error: (res.stderr || res.error?.message || `exit ${res.status}`).trim() };
}

function classifyLoadError(message) {
  const abi = message.match(/NODE_MODULE_VERSION (\d+)\.[\s\S]*?requires\s+NODE_MODULE_VERSION (\d+)/);
  if (abi) return { kind: "abi", built: Number(abi[1]), required: Number(abi[2]) };
  if (/invalid ELF header|wrong ELF class|not a mach-o|mach-o file, but is an incompatible architecture|is not a valid Win32 application|Exec format error/i.test(message)) {
    return { kind: "platform" };
  }
  return { kind: "other" };
}

function checkNativeModules(rootDir, loadAddon = defaultLoadAddon) {
  const addons = findNativeAddons(rootDir);
  if (addons.length === 0) return [];

  const abi = [];
  const platform = [];
  const other = [];
  for (const addon of addons) {
    const res = loadAddon(addon.file);
    if (res.ok) continue;
    const c = classifyLoadError(res.error || "");
    const firstLine = (res.error || "").split("\n").find((l) => /Error/.test(l)) || res.error || "";
    if (c.kind === "abi") abi.push({ ...addon, ...c });
    else if (c.kind === "platform") platform.push(addon);
    else other.push({ ...addon, error: firstLine.replace(`${addon.file}: `, "").trim().slice(0, 160) });
  }

  const findings = [];
  const packagesOf = (list) => [...new Set(list.map((a) => a.package))];

  if (abi.length > 0) {
    const pkgs = packagesOf(abi);
    findings.push(
      finding("error", "native-abi", `${pkgs.length} native module${pkgs.length === 1 ? " was" : "s were"} built for a different Node version`, {
        details: listSome(abi, (a) => `${a.package}: built for ABI ${a.built}, this Node needs ${a.required}`),
        fix: { kind: "rebuild", packages: pkgs },
      })
    );
  }
  if (platform.length > 0) {
    const pkgs = packagesOf(platform);
    findings.push(
      finding("error", "native-platform", `${pkgs.length} native module${pkgs.length === 1 ? " was" : "s were"} built for a different OS/CPU`, {
        details: [...listSome(pkgs), "Common when node_modules is shared between a host and a Docker container, or across Rosetta/arm64."],
        fix: { kind: "rebuild", packages: pkgs },
      })
    );
  }
  if (other.length > 0) {
    findings.push(
      finding("warn", "native-load", `${other.length} native module${other.length === 1 ? "" : "s"} failed to load`, {
        details: listSome(other, (a) => `${a.package}: ${a.error}`),
        fix: { kind: "rebuild", packages: packagesOf(other) },
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
    findings.push(finding("error", "no-package-json", `No package.json in ${rootDir}`));
    return { rootDir, packageManager, findings, plan: planFixes(findings, packageManager) };
  }

  findings.push(...checkNodeVersion(rootDir, pkg, nodeVersion));
  findings.push(...checkPackageManager(rootDir, pkg, packageManager));

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
      findings.push(...checkNativeModules(rootDir, options.loadAddon));
    }
  }

  return { rootDir, packageManager, findings, plan: planFixes(findings, packageManager) };
}

function rebuildCommand(packageManager, packages) {
  // pnpm has its own rebuild; npm rebuild works on any node_modules layout
  if (packageManager === "pnpm") return { cmd: "pnpm", args: ["rebuild", ...packages] };
  return { cmd: "npm", args: ["rebuild", ...packages] };
}

// Turn findings into the smallest set of steps that fixes them.
function planFixes(findings, packageManager) {
  const blockers = findings.filter((f) => f.blocksFix && f.severity === "error");
  const manual = findings.filter((f) => f.manual && f.severity !== "ok").map((f) => f.manual);
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
      const rb = rebuildCommand(packageManager, rebuildPkgs);
      steps.push({ kind: "rebuild", label: `${rb.cmd} ${rb.args.join(" ")}`, ...rb });
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

function printReport(report, log = console.log) {
  log(`\n🩺 cleaninstall-node doctor — ${report.rootDir} (${report.packageManager})\n`);
  const order = { error: 0, warn: 1, info: 2, ok: 3 };
  for (const f of [...report.findings].sort((a, b) => order[a.severity] - order[b.severity])) {
    log(`  ${ICONS[f.severity]} ${f.title}`);
    for (const d of f.details) log(`      ${d}`);
  }

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

async function applyFixes(report, { execa, cleanupMain, log = console.log }) {
  for (const step of report.plan.steps) {
    log(`\n🔧 ${step.label}`);
    if (step.kind === "reinstall") {
      await cleanupMain(
        {
          dir: report.rootDir,
          yes: true,
          verbose: false,
          dirsToRemove: ["node_modules"],
          filesToRemove: [],
          install: false,
        },
        execa
      );
    }
    await execa(step.cmd, step.args, { stdio: "inherit", cwd: report.rootDir });
  }
}

async function runDoctor(options, execa) {
  const json = Boolean(options.json);
  const log = json ? () => {} : console.log;
  let report = diagnose(options.dir, { native: options.native });

  if (options.fix && report.plan.steps.length > 0 && report.plan.blocked.length === 0) {
    if (!json) printReport(report, log);
    const { main: cleanupMain } = require("../bin/cleanup.js");
    await applyFixes(report, { execa, cleanupMain, log });
    log("\nRe-checking…");
    report = diagnose(options.dir, { native: options.native });
  }

  if (json) {
    process.stdout.write(JSON.stringify({ ...report, summary: summarize(report.findings) }, null, 2) + "\n");
  } else {
    printReport(report, log);
  }
  if (summarize(report.findings).errors > 0) process.exitCode = 1;
  return report;
}

module.exports = {
  diagnose,
  runDoctor,
  planFixes,
  printReport,
  classifyLoadError,
  findNativeAddons,
  parseYarnV1Lock,
  detectInstaller,
};
