#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { program } = require("commander");
const pkg = require("../package.json");
const { globSync } = require("glob");
const yaml = require("js-yaml");
const readline = require("readline/promises");

// Default configuration
const DEFAULT_CONFIG = {
  dirsToRemove: [
    "node_modules",
    ".next",        // Next.js
    ".turbo",       // Turborepo
    "dist",         // Common build output
    "build",        // Common build output
    ".cache",       // Parcel, Gatsby, etc.
    ".nuxt",        // Nuxt.js 2
    ".output",      // Nuxt 3 / Nitro
    "out",          // Next.js static export
    ".vite",        // Vite cache (vite 5+)
    ".astro",       // Astro cache
    ".svelte-kit",  // SvelteKit
    "coverage",     // Test coverage
    ".nyc_output",  // NYC coverage
  ],
  // Lockfiles are NOT removed by default: deleting them silently changes resolved
  // dependency versions. Opt in with --lockfiles / removeLockfiles: true.
  filesToRemove: [],
  scanDepth: 2, // How deep to scan for workspaces (1 = only root, 2 = one level of subdirectories)
  skipDirs: [".git"],
  verbose: true,
  workspacePatterns: [],
};

const {
  LOCKFILES,
  INSTALL_COMMANDS,
  detectPackageManager,
} = require("../lib/project");

// Glob only filters by type with withFileTypes; check the real type ourselves.
function isRealDirectory(p) {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFileLike(p) {
  try {
    const st = fs.lstatSync(p);
    // A symlink is removed as a link (never followed), so treat it as a file.
    return st.isFile() || st.isSymbolicLink();
  } catch {
    return false;
  }
}

function formatSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// Function to ask user for confirmation (now accepts rl instance)
async function askConfirmation(rl, question) {
  if (!rl) throw new Error("Readline interface not provided for confirmation.");
  const answer = await rl.question(question);
  return ["y", "yes"].includes(answer.toLowerCase());
}

// Function to load custom config from package.json or .cleaninstallnoderc
function loadConfig(rootDir) {
  let config = { ...DEFAULT_CONFIG, workspacePatterns: [] };

  // Try to load from package.json
  try {
    const packageJsonPath = path.join(rootDir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      // Load cleaninstallNode config if present
      if (packageJson.cleaninstallNode) {
        const userConfig = packageJson.cleaninstallNode;
        // Merge, prioritizing user config arrays only if they exist
        config = {
          ...config,
          ...userConfig,
          dirsToRemove:
            userConfig.dirsToRemove !== undefined
              ? userConfig.dirsToRemove
              : config.dirsToRemove,
          filesToRemove:
            userConfig.filesToRemove !== undefined
              ? userConfig.filesToRemove
              : config.filesToRemove,
          skipDirs:
            userConfig.skipDirs !== undefined
              ? userConfig.skipDirs
              : config.skipDirs,
        };
      }
      // Load workspace patterns from package.json (independent of cleaninstallNode config)
      if (packageJson.workspaces) {
        const patterns = Array.isArray(packageJson.workspaces)
          ? packageJson.workspaces
          : packageJson.workspaces.packages;
        if (Array.isArray(patterns)) {
          config.workspacePatterns.push(...patterns);
        }
      }
    }
  } catch (error) {
    console.warn(
      "Warning: Could not parse package.json for config or workspaces:",
      error.message
    );
  }

  // Try to load from .cleaninstallnoderc
  try {
    const rcPath = path.join(rootDir, ".cleaninstallnoderc");
    if (fs.existsSync(rcPath)) {
      const rcConfig = JSON.parse(fs.readFileSync(rcPath, "utf8"));
      // Merge, prioritizing rc config arrays only if they exist
      config = {
        ...config,
        ...rcConfig,
        dirsToRemove:
          rcConfig.dirsToRemove !== undefined
            ? rcConfig.dirsToRemove
            : config.dirsToRemove,
        filesToRemove:
          rcConfig.filesToRemove !== undefined
            ? rcConfig.filesToRemove
            : config.filesToRemove,
        skipDirs:
          rcConfig.skipDirs !== undefined ? rcConfig.skipDirs : config.skipDirs,
      };
    }
  } catch (error) {
    console.warn(
      "Warning: Could not parse .cleaninstallnoderc:",
      error.message
    );
  }

  // Try to load workspace patterns from pnpm-workspace.yaml
  try {
    const pnpmWorkspacePath = path.join(rootDir, "pnpm-workspace.yaml");
    if (fs.existsSync(pnpmWorkspacePath)) {
      const pnpmWorkspaceContent = fs.readFileSync(pnpmWorkspacePath, "utf8");
      const pnpmWorkspaceConfig = yaml.load(pnpmWorkspaceContent);
      if (pnpmWorkspaceConfig && Array.isArray(pnpmWorkspaceConfig.packages)) {
        config.workspacePatterns.push(...pnpmWorkspaceConfig.packages);
      }
    }
  } catch (error) {
    console.warn(
      "Warning: Could not parse pnpm-workspace.yaml:",
      error.message
    );
  }

  // Deduplicate workspace patterns
  config.workspacePatterns = [...new Set(config.workspacePatterns)];

  return config;
}

// Function to calculate directory size recursively
function getDirectorySize(dirPath) {
  let totalSize = 0;
  let fileCount = 0;

  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      const itemPath = path.join(dirPath, item.name);
      try {
        if (item.isDirectory()) {
          const { size, files } = getDirectorySize(itemPath);
          totalSize += size;
          fileCount += files;
        } else {
          // lstat: don't follow symlinks (pnpm links would be double counted)
          const stats = fs.lstatSync(itemPath);
          totalSize += stats.size;
          fileCount += 1;
        }
      } catch (err) {
        // Skip inaccessible items
      }
    }
  } catch (err) {
    // Skip inaccessible directories
  }

  return { size: totalSize, files: fileCount };
}

// Delete a single target (throws on failure).
function removeTarget(target) {
  if (target.isDirectory) {
    fs.rmSync(target.path, { recursive: true, force: true });
  } else {
    fs.unlinkSync(target.path);
  }
}

// Run a glob pattern in `dir` and keep only matches of the requested type.
function globTyped(pattern, dir, config, wantDirectories) {
  let matches = [];
  try {
    matches = globSync(pattern, {
      cwd: dir,
      absolute: true,
      dot: true,
      ignore: config.skipDirs.map((d) => `**/${d}/**`),
    });
  } catch (globError) {
    console.warn(
      `Warning: Error processing pattern '${pattern}' in ${dir}:`,
      globError.message
    );
    return [];
  }
  return matches.filter((p) =>
    wantDirectories ? isRealDirectory(p) : isFileLike(p)
  );
}

// Find everything to remove in `dir` (and, without workspace patterns,
// nested packages up to scanDepth). Does not delete anything.
function collectTargets(dir, config, currentDepth = 1) {
  if (config.verbose) console.log(`\nScanning directory: ${dir}`);
  const targets = [];

  for (const pattern of config.dirsToRemove) {
    for (const dirPath of globTyped(pattern, dir, config, true)) {
      // Never remove the directory being cleaned or one of its parents
      if (dirPath !== dir && !dir.startsWith(dirPath + path.sep)) {
        targets.push({ path: dirPath, isDirectory: true });
      }
    }
  }

  for (const pattern of config.filesToRemove) {
    for (const filePath of globTyped(pattern, dir, config, false)) {
      targets.push({ path: filePath, isDirectory: false });
    }
  }

  // Workspaces are enumerated explicitly by main(); only recurse in fallback mode
  if (config.workspacePatterns.length > 0 || currentDepth >= config.scanDepth) {
    return targets;
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(dir, entry.name);

      if (config.skipDirs.includes(entry.name)) {
        if (config.verbose) console.log(`Skipping configured directory: ${subDir}`);
        continue;
      }
      // Don't descend into something we're about to delete anyway
      if (targets.some((t) => t.path === subDir)) continue;

      if (fs.existsSync(path.join(subDir, "package.json"))) {
        if (config.verbose) console.log(`Recursing into potential package: ${subDir}`);
        targets.push(...collectTargets(subDir, config, currentDepth + 1));
      } else if (config.verbose) {
        console.log(`Skipping non-package subdir: ${subDir}`);
      }
    }
  } catch (error) {
    console.error(`Error scanning subdirectories of ${dir}:`, error.message);
  }

  return targets;
}

// Dedupe and drop targets that live inside another directory target.
function normalizeTargets(targets) {
  const byPath = new Map();
  for (const t of targets) byPath.set(path.resolve(t.path), { ...t, path: path.resolve(t.path) });
  const sorted = [...byPath.values()].sort((a, b) => a.path.length - b.path.length);
  const kept = [];
  for (const t of sorted) {
    const inside = kept.some(
      (k) => k.isDirectory && t.path.startsWith(k.path + path.sep)
    );
    if (!inside) kept.push(t);
  }
  return kept.sort((a, b) => a.path.localeCompare(b.path));
}

// Resolve the install command: config.installCommand (string or array) wins.
function resolveInstallCommand(config, packageManager) {
  const custom = config.installCommand;
  if (typeof custom === "string" && custom.trim()) {
    const [cmd, ...args] = custom.trim().split(/\s+/);
    return { cmd, args };
  }
  if (Array.isArray(custom) && custom.length > 0) {
    return { cmd: custom[0], args: custom.slice(1) };
  }
  return { cmd: packageManager, args: INSTALL_COMMANDS[packageManager] };
}

// Why deletions failed, in one actionable line.
function failureHint(errors) {
  const codes = new Set(errors.map((e) => e.code));
  const text = errors.map((e) => String(e.message || "")).join(" ");
  if (codes.has("NotCapable") || /Requires write access|--allow-write/.test(text)) {
    return "Deno needs write access: run with --allow-write (see the README's Deno section).";
  }
  if (codes.has("EBUSY") || codes.has("EPERM") && process.platform === "win32") {
    return "A running program (dev server, editor, antivirus) may have these files open. Close it and try again.";
  }
  if (codes.has("EACCES") || codes.has("EPERM")) {
    return "Permission denied: these files may be owned by another user (e.g. after `sudo npm install` or a Docker container).";
  }
  return "See the errors above for details.";
}

// Main function
async function main(options, execa) {
  const rootDir = path.resolve(options.dir || process.cwd());
  let config = loadConfig(rootDir);

  // ---- Apply Programmatic/CLI Options ----
  const pickBool = (opt, current) => (opt === undefined ? current : !!opt);
  config.verbose = pickBool(options.verbose, config.verbose);
  config.skipGit = pickBool(options.skipGit, config.skipGit === undefined ? true : config.skipGit);
  config.dryRun = pickBool(options.dryRun, config.dryRun);
  config.interactive = pickBool(options.interactive, config.interactive);
  config.install = pickBool(options.install, config.install);
  config.yes = pickBool(options.yes, config.yes);
  config.removeLockfiles = pickBool(
    options.removeLockfiles !== undefined ? options.removeLockfiles : options.lockfiles,
    config.removeLockfiles
  );
  config.scanDepth = options.depth === undefined ? config.scanDepth : options.depth;

  for (const key of ["dirsToRemove", "filesToRemove", "skipDirs"]) {
    if (Array.isArray(options[key])) config[key] = [...options[key]];
  }
  config.skipDirs = [...config.skipDirs];
  config.filesToRemove = [...config.filesToRemove];

  if (config.removeLockfiles) {
    for (const lock of LOCKFILES) {
      if (!config.filesToRemove.includes(lock)) config.filesToRemove.push(lock);
    }
  }

  if (config.skipGit && !config.skipDirs.includes(".git")) {
    config.skipDirs.push(".git");
  } else if (!config.skipGit) {
    config.skipDirs = config.skipDirs.filter((d) => d !== ".git");
  }

  // Detect before anything is deleted (lockfiles may be removed below)
  const packageManager = detectPackageManager(rootDir);

  // Ask once before deleting, unless told not to or nobody can answer.
  const needsConfirm =
    !config.dryRun &&
    !config.interactive &&
    !config.yes &&
    Boolean(process.stdin.isTTY) &&
    process.env.NODE_ENV !== "test";

  let rl = null;
  const getRl = () => {
    if (!rl) {
      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    }
    return rl;
  };

  const result = {
    dryRun: !!config.dryRun,
    packageManager,
    targets: [],
    removed: [],
    skipped: [],
    failed: [],
    errors: [],
    totalSize: 0,
    totalFiles: 0,
    itemsDeleted: 0,
    installed: false,
  };

  let cleanupError = null;
  const startTime = Date.now();

  try {
    // --- Collect ---
    let dirsToClean = [rootDir];
    if (config.workspacePatterns.length > 0) {
      if (config.verbose) {
        console.log("\nFound workspace patterns:", config.workspacePatterns);
      }
      const positive = config.workspacePatterns.filter((p) => !p.startsWith("!"));
      const negative = config.workspacePatterns
        .filter((p) => p.startsWith("!"))
        .map((p) => p.slice(1));
      for (const pattern of positive) {
        try {
          const found = globSync(pattern, {
            cwd: rootDir,
            absolute: true,
            ignore: [...negative, ...config.skipDirs.map((d) => `**/${d}/**`)],
          }).filter(isRealDirectory);
          dirsToClean.push(...found.map((d) => path.resolve(d)));
        } catch (error) {
          console.warn(`Warning: Error resolving glob pattern '${pattern}':`, error.message);
        }
      }
      dirsToClean = [...new Set(dirsToClean)];
      if (config.verbose) console.log("\nTargeting directories for cleaning:", dirsToClean);
    } else if (config.verbose) {
      console.log("\nNo workspace patterns found or defined. Using scanDepth based cleaning.");
    }

    let targets = [];
    for (const dir of dirsToClean) targets.push(...collectTargets(dir, config, 1));
    targets = normalizeTargets(targets);

    for (const t of targets) {
      if (t.isDirectory) {
        const { size, files } = getDirectorySize(t.path);
        t.size = size;
        t.files = files;
      } else {
        try {
          t.size = fs.lstatSync(t.path).size;
        } catch {
          t.size = 0;
        }
        t.files = 1;
      }
    }
    result.targets = targets;

    if (targets.length === 0) {
      console.log("\nNothing to clean.");
    } else if (config.dryRun || needsConfirm) {
      const total = targets.reduce((n, t) => n + t.size, 0);
      console.log(config.dryRun ? "\n[Dry Run] Would remove:" : "\nWill remove:");
      for (const t of targets) {
        console.log(
          `  ${path.relative(rootDir, t.path) || "."}${t.isDirectory ? "/" : ""}  (${formatSize(t.size)})`
        );
      }
      if (needsConfirm) {
        const ok = await askConfirmation(
          getRl(),
          `\nDelete ${targets.length} item(s), ${formatSize(total)}? (y/N) `
        );
        if (!ok) {
          console.log("Aborted. Nothing was deleted.");
          result.skipped = targets.map((t) => t.path);
          return result;
        }
      }
    }

    // --- Delete ---
    for (const t of targets) {
      if (config.dryRun) {
        result.removed.push(t.path);
      } else {
        if (config.interactive) {
          const rel = path.relative(process.cwd(), t.path);
          if (!(await askConfirmation(getRl(), `Delete ${rel}? (y/N) `))) {
            if (config.verbose) console.log(`Skipping: ${rel}`);
            result.skipped.push(t.path);
            continue;
          }
        }
        try {
          if (config.verbose) console.log(`Removing: ${t.path}`);
          removeTarget(t);
          result.removed.push(t.path);
        } catch (error) {
          console.error(`Error processing ${t.path}:`, error);
          result.failed.push(t.path);
          result.errors.push({ path: t.path, code: error && error.code, message: error && error.message });
          continue;
        }
      }
      result.totalSize += t.size;
      result.totalFiles += t.files;
      result.itemsDeleted += 1;
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    if (result.failed.length > 0) {
      // A partial cleanup is a failure: say so, and exit non-zero for scripts/CI.
      process.exitCode = 1;
      console.error(`\n❌ Cleanup finished, but ${result.failed.length} item(s) couldn't be removed:`);
      for (const p of result.failed.slice(0, 10)) console.error(`   - ${path.relative(rootDir, p) || p}`);
      console.error(`   ${failureHint(result.errors)}`);
    } else {
      console.log(
        `\n✅ Cleanup ${config.dryRun ? "(Dry Run) " : ""}${
          config.interactive ? "(Interactive) " : ""
        }completed successfully!`
      );
    }

    if (result.itemsDeleted > 0) {
      console.log("\n📊 Summary:");
      console.log(`   - Items ${config.dryRun ? "would be " : ""}removed: ${result.itemsDeleted}`);
      console.log(`   - Files: ${result.totalFiles.toLocaleString()}`);
      console.log(`   - Space ${config.dryRun ? "to be " : ""}freed: ${formatSize(result.totalSize)}`);
      console.log(`   - Time: ${duration}s`);
    }
  } catch (error) {
    cleanupError = error;
    console.error("\n❌ Cleanup process encountered an error:", error);
  } finally {
    if (rl) rl.close();
  }

  if (cleanupError) {
    process.exitCode = 1;
    throw cleanupError;
  }

  // --- Auto-Install ---
  if (!config.dryRun && config.install && result.failed.length > 0) {
    console.error("\n⏭️  Skipping install because the cleanup didn't finish. Fix the items above, then run it again.");
  } else if (!config.dryRun && config.install) {
    const { cmd, args } = resolveInstallCommand(config, packageManager);
    console.log(`\n📦 Running ${[cmd, ...args].join(" ")}...`);
    try {
      await execa(cmd, args, { stdio: "inherit", cwd: rootDir });
      result.installed = true;
      console.log("\n✅ Installation completed successfully!");
    } catch (error) {
      console.error("\n❌ Installation failed:", error);
      process.exitCode = 1;
    }
  } else if (!config.dryRun && result.itemsDeleted > 0) {
    console.log(`\nℹ️ To reinstall dependencies, run: ${packageManager} install`);
  }

  return result;
}

// Set up command line interface
program
  .name("cleaninstall-node")
  .enablePositionalOptions()
  .description("A utility to clean up Node.js project files")
  .version(pkg.version)
  .option("-d, --dir <directory>", "root directory to clean (defaults to current directory)")
  .option("-v, --verbose", "print verbose output", true)
  .option("--no-verbose", "disable verbose output")
  .option("--depth <number>", "how deep to scan for packages when no workspaces are defined", (v) => parseInt(v, 10))
  .option("--skip-git", "skip .git directories (default)")
  .option("--no-skip-git", "do not skip .git directories")
  .option("--dry-run", "show what would be deleted without deleting", false)
  .option("-i, --interactive", "prompt before deleting each item", false)
  .option("-y, --yes", "don't ask for confirmation before deleting")
  .option("--lockfiles", "also remove lockfiles (package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lock)")
  .option("--install", "run the package manager's install after cleanup", false)
  .action(async (options) => {
    try {
      await main(options, require("../lib/run").run);
    } catch (error) {
      console.error("\n❌ An unexpected error occurred:", error && error.message ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("doctor")
  .description("diagnose why an install is broken and suggest (or apply) the smallest fix")
  .option("-d, --dir <directory>", "project root (defaults to current directory)")
  .option("--fix", "apply the suggested fix (rebuild, install, or clean reinstall)")
  .option("--json", "print the report as JSON")
  .option("--no-native", "skip loading native modules")
  .option("--from-error [text]", "explain an error message in the context of this project (pass the text, or pipe it in)")
  .action(async (options) => {
    try {
      await require("../lib/doctor").runDoctor(options, require("../lib/run").run);
    } catch (error) {
      console.error("\n❌ doctor failed:", error && error.message ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("mcp")
  .description("run as an MCP server over stdio, for AI agents (Claude Code, Cursor, VS Code, ...)")
  .option("-d, --dir <directory>", "default project directory for tools (defaults to current directory)")
  .action((options) => {
    require("../lib/mcp").startStdioServer({ cwd: options.dir ? path.resolve(options.dir) : process.cwd() });
  });

const agentCmd = program
  .command("agent")
  .description("set up AI coding agents to diagnose broken installs instead of deleting node_modules");

agentCmd
  .command("install")
  .description("add guidance to AGENTS.md/CLAUDE.md and a Claude Code hook that blocks deleting node_modules/lockfiles")
  .option("-d, --dir <directory>", "project root (defaults to current directory)")
  .option("--no-hook", "only write the instruction files, not the Claude Code hook")
  .option("--ask", "make the hook ask you instead of blocking")
  .option("--dry-run", "show what would be written")
  .action((options) => {
    try {
      const res = require("../lib/agent").installAgent({
        dir: options.dir,
        hook: options.hook,
        mode: options.ask ? "ask" : "deny",
        dryRun: options.dryRun,
      });
      console.log(`${options.dryRun ? "Would set up" : "✅ Set up"} AI agent guidance in ${res.dir}`);
      for (const c of res.changes) console.log(`   ${c.action.padEnd(12)} ${c.file}`);
      if (res.hook) {
        console.log(
          `\nThe Claude Code hook ${res.mode === "ask" ? "asks you before" : "blocks"} Bash commands that delete node_modules or lockfiles, and tells the agent to run \`cleaninstall-node doctor --from-error\` instead.`
        );
        console.log("Commit these files so your whole team (and their agents) get them. Disable for a session with CLEANINSTALL_GUARD=off.");
      }
    } catch (error) {
      console.error(`❌ ${error.message}`);
      process.exit(1);
    }
  });

agentCmd
  .command("uninstall")
  .description("remove cleaninstall-node's agent guidance and hook (other content is kept)")
  .option("-d, --dir <directory>", "project root (defaults to current directory)")
  .action((options) => {
    try {
      const res = require("../lib/agent").uninstallAgent({ dir: options.dir });
      if (!res.changes.length) console.log("Nothing to remove.");
      for (const c of res.changes) console.log(`   ${c.action.padEnd(14)} ${c.file}`);
    } catch (error) {
      console.error(`❌ ${error.message}`);
      process.exit(1);
    }
  });

agentCmd
  .command("check <command...>")
  .description("test whether the guard would block a shell command (exit 1 if blocked)")
  .allowUnknownOption()
  .helpOption(false)
  .action((parts) => {
    const res = require("../lib/agent-guard").checkCommand(parts.join(" "));
    if (res.blocked) {
      console.log(res.reason);
      process.exitCode = 1;
    } else {
      console.log("allowed");
    }
  });

const hookCmd = program
  .command("hook")
  .description("git hooks that warn (or install) when a checkout, pull or rebase changes dependencies");

hookCmd
  .command("install")
  .description("add post-checkout, post-merge and post-rewrite hooks (uses .husky/ when husky is set up)")
  .option("-d, --dir <directory>", "repository directory (defaults to current directory)")
  .option("--mode <mode>", "warn: print what to run (default); install: run install/rebuild automatically", "warn")
  .action((options) => {
    try {
      const res = require("../lib/hook").installHooks(options);
      const where = res.kind === "husky" ? " (husky — commit these so your team gets them)" : "";
      console.log(`✅ Installed cleaninstall-node hooks in ${res.dir}${where}`);
      for (const f of res.files) console.log(`   ${f}`);
      console.log(`   mode: ${res.mode}. Skip once with CLEANINSTALL_SKIP_HOOK=1.`);
    } catch (error) {
      console.error("❌ Could not install hooks:", error.message);
      process.exit(1);
    }
  });

hookCmd
  .command("uninstall")
  .description("remove cleaninstall-node from the git hooks (other hook content is kept)")
  .option("-d, --dir <directory>", "repository directory (defaults to current directory)")
  .action((options) => {
    try {
      const res = require("../lib/hook").uninstallHooks(options);
      console.log(res.files.length ? `✅ Removed cleaninstall-node from ${res.files.length} hook(s) in ${res.dir}` : "Nothing to remove.");
    } catch (error) {
      console.error("❌ Could not uninstall hooks:", error.message);
      process.exit(1);
    }
  });

hookCmd
  .command("run <event> [args...]")
  .description("run by the installed git hooks")
  .option("--mode <mode>", "warn or install", "warn")
  .allowUnknownOption()
  .action(async (event, args, options) => {
    // A hook must never break the git command that triggered it.
    try {
      await require("../lib/hook").runHook(event, args || [], { mode: options.mode, execa: require("../lib/run").run });
    } catch {
      // swallow
    }
    process.exitCode = 0;
  });

if (require.main === module) {
  program.parse(process.argv);
}

module.exports = {
  main,
  DEFAULT_CONFIG,
  LOCKFILES,
  detectPackageManager,
  loadConfig,
};
