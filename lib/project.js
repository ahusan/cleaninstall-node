// Shared project detection: lockfiles, package managers, workspaces.
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

// Lockfiles removed when --lockfiles is passed
const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
];

// Lockfile -> package manager, checked in order
const LOCKFILE_MANAGERS = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["deno.lock", "deno"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

// Maps package manager to its default install command arguments
const INSTALL_COMMANDS = {
  npm: ["install"],
  yarn: ["install"],
  pnpm: ["install"],
  bun: ["install"],
  deno: ["install"],
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// deno.json / deno.jsonc (JSONC: comments and trailing commas allowed).
function stripJsonc(text) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] || "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function readDenoConfig(rootDir) {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const file = path.join(rootDir, name);
    if (!fs.existsSync(file)) continue;
    try {
      return { file: name, config: JSON.parse(stripJsonc(fs.readFileSync(file, "utf8"))) || {} };
    } catch {
      return { file: name, config: {}, invalid: true };
    }
  }
  return null;
}

// How a Deno project uses node_modules: "none" (global cache), "auto" or "manual".
function denoNodeModulesMode(rootDir) {
  const deno = readDenoConfig(rootDir);
  const v = deno && deno.config.nodeModulesDir;
  if (v === true || v === "auto") return "auto";
  if (v === "manual") return "manual";
  if (v === false || v === "none") return "none";
  // Unset: Deno uses node_modules when there's a package.json, else its global cache.
  return fs.existsSync(path.join(rootDir, "package.json")) ? "manual" : "none";
}

// npm: imports declared in deno.json, as { name: range }.
function denoNpmImports(rootDir) {
  const deno = readDenoConfig(rootDir);
  const imports = (deno && deno.config.imports) || {};
  const out = {};
  for (const spec of Object.values(imports)) {
    const m = typeof spec === "string" && spec.match(/^npm:\/?((?:@[^/@]+\/)?[^/@]+)(?:@([^/]+))?/);
    if (m) out[m[1]] = m[2] || "*";
  }
  return out;
}

// Find an executable on PATH, skipping Deno's `node` stand-in (Deno puts
// ~/.cache/deno/node_compat_bin first on PATH) and the running binary itself.
function findOnPath(name) {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  let self = null;
  try {
    self = fs.realpathSync(process.execPath);
  } catch {
    // ignore
  }
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    // Deno puts its own `node` stand-in first on PATH; that isn't Node.
    if (!dir || /node_compat_bin/.test(dir)) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile() && fs.realpathSync(candidate) !== self) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

// Package manager named in the `packageManager` field (Corepack), if any.
function declaredPackageManager(rootDir) {
  const pkg = readJson(path.join(rootDir, "package.json"));
  if (pkg && typeof pkg.packageManager === "string") {
    const name = pkg.packageManager.split("@")[0];
    if (INSTALL_COMMANDS[name]) return name;
  }
  return null;
}

// Lockfiles present in rootDir, with the manager each belongs to.
function presentLockfiles(rootDir) {
  return LOCKFILE_MANAGERS.filter(([file]) =>
    fs.existsSync(path.join(rootDir, file))
  ).map(([file, manager]) => ({ file, manager }));
}

// Detect the package manager: `packageManager` field first, then lockfiles.
function detectPackageManager(rootDir) {
  const declared = declaredPackageManager(rootDir);
  if (declared) return declared;
  const locks = presentLockfiles(rootDir);
  if (locks.length > 0) return locks[0].manager;
  if (readDenoConfig(rootDir)) return "deno";
  return "npm";
}

// Workspace patterns from package.json `workspaces` and pnpm-workspace.yaml.
function readWorkspacePatterns(rootDir) {
  const patterns = [];
  const pkg = readJson(path.join(rootDir, "package.json"));
  if (pkg && pkg.workspaces) {
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages;
    if (Array.isArray(ws)) patterns.push(...ws);
  }
  try {
    const file = path.join(rootDir, "pnpm-workspace.yaml");
    if (fs.existsSync(file)) {
      const doc = yaml.load(fs.readFileSync(file, "utf8"));
      if (doc && Array.isArray(doc.packages)) patterns.push(...doc.packages);
    }
  } catch {
    // ignore malformed yaml here; cleanup's loadConfig warns about it
  }
  return [...new Set(patterns)];
}

module.exports = {
  LOCKFILES,
  LOCKFILE_MANAGERS,
  INSTALL_COMMANDS,
  readJson,
  declaredPackageManager,
  presentLockfiles,
  detectPackageManager,
  readWorkspacePatterns,
  readDenoConfig,
  denoNodeModulesMode,
  denoNpmImports,
  stripJsonc,
  findOnPath,
};
