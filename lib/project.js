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
];

// Lockfile -> package manager, checked in order
const LOCKFILE_MANAGERS = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

// Maps package manager to its default install command arguments
const INSTALL_COMMANDS = {
  npm: ["install"],
  yarn: ["install"],
  pnpm: ["install"],
  bun: ["install"],
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
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
  return locks.length > 0 ? locks[0].manager : "npm";
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
};
