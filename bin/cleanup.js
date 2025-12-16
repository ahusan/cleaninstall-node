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
  filesToRemove: ["pnpm-lock.yaml", "yarn.lock", "package-lock.json"],
  scanDepth: 2, // How deep to scan for workspaces (1 = only root, 2 = one level of subdirectories)
  skipDirs: [".git"],
  verbose: true,
  workspacePatterns: [],
};

// Maps package manager to its default install command arguments
const INSTALL_COMMANDS = {
  npm: ["install"],
  yarn: ["install"],
  pnpm: ["install"],
};

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
          const stats = fs.statSync(itemPath);
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

// Function to delete a directory or file (now accepts rl instance if interactive and stats object)
async function deleteItem(itemPath, config, rl, stats) {
  try {
    const exists = fs.existsSync(itemPath);

    if (!exists) {
      return { deleted: false, size: 0, files: 0 };
    }

    // Determine if it's a directory *before* asking/logging
    const isDirectory = fs.lstatSync(itemPath).isDirectory();

    // Calculate size and file count before deletion
    let itemSize = 0;
    let itemFiles = 0;
    if (isDirectory) {
      const dirStats = getDirectorySize(itemPath);
      itemSize = dirStats.size;
      itemFiles = dirStats.files;
    } else {
      try {
        const fileStats = fs.statSync(itemPath);
        itemSize = fileStats.size;
        itemFiles = 1;
      } catch (err) {
        // Could not stat file
      }
    }

    if (config.dryRun) {
      console.log(
        `[Dry Run] Would remove ${
          isDirectory ? "directory" : "file"
        }: ${itemPath}`
      );
      return { deleted: true, size: itemSize, files: itemFiles }; // Simulate success with stats
    }

    let shouldDelete = true;

    // Ask for confirmation in interactive mode
    if (config.interactive) {
      if (!rl) {
        console.warn(
          "Warning: Interactive mode requires readline interface, skipping prompt."
        );
      } else {
        const relativePath = path.relative(process.cwd(), itemPath);
        shouldDelete = await askConfirmation(
          rl,
          `Delete ${relativePath}? (y/N) `
        );
        if (!shouldDelete) {
          if (config.verbose) console.log(`Skipping: ${relativePath}`);
          return { deleted: false, size: 0, files: 0 };
        }
      }
    }

    // Proceed with actual deletion if confirmed or not interactive
    if (shouldDelete) {
      if (config.verbose) console.log(`Removing: ${itemPath}`);
      // The actual fs calls are already risky, no need for separate try/catch here
      if (isDirectory) {
        fs.rmSync(itemPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(itemPath);
      }
      return { deleted: true, size: itemSize, files: itemFiles }; // Deletion successful
    }

    // If we reach here, deletion was skipped (e.g., interactive 'no')
    return { deleted: false, size: 0, files: 0 };
  } catch (error) {
    // Catch errors from existsSync, lstatSync, rmSync, unlinkSync
    console.error(`Error processing ${itemPath}:`, error);
    return { deleted: false, size: 0, files: 0 };
  }
}

// Function to find and clean items in a directory (now accepts rl instance and execa and returns stats)
async function cleanDirectory(dir, config, rl, execa, currentDepth = 1) {
  if (config.verbose) console.log(`\nScanning directory: ${dir}`);

  let stats = { totalSize: 0, totalFiles: 0, itemsDeleted: 0 };

  // Remove specified directories using glob patterns
  try {
    for (const pattern of config.dirsToRemove) {
      let foundDirs = [];
      try {
        foundDirs = globSync(pattern, {
          cwd: dir,
          absolute: true,
          onlyDirectories: true,
          dot: true,
          ignore: config.skipDirs.map((d) => `**/${d}/**`),
        });
      } catch (globError) {
        console.log(
          `DEBUG: globSync error for dir pattern '${pattern}' in ${dir}: ${globError.message}`
        );
        console.warn(
          `Warning: Error processing directory pattern '${pattern}' in ${dir}:`,
          globError.message
        );
        continue;
      }
      for (const dirPath of foundDirs) {
        if (dirPath !== dir && !dir.startsWith(dirPath + path.sep)) {
          const result = await deleteItem(dirPath, config, rl, stats);
          if (result.deleted) {
            stats.totalSize += result.size;
            stats.totalFiles += result.files;
            stats.itemsDeleted += 1;
          }
        }
      }
    }
  } catch (error) {
    console.warn(
      `Warning: Unexpected error during directory removal in ${dir}:`,
      error.message
    );
  }

  // Remove specified files using glob patterns
  try {
    for (const pattern of config.filesToRemove) {
      let foundFiles = [];
      try {
        foundFiles = globSync(pattern, {
          cwd: dir,
          absolute: true,
          onlyFiles: true,
          dot: true,
        });
      } catch (globError) {
        console.log(
          `DEBUG: globSync error for file pattern '${pattern}' in ${dir}: ${globError.message}`
        );
        console.warn(
          `Warning: Error processing file pattern '${pattern}' in ${dir}:`,
          globError.message
        );
        continue;
      }
      for (const filePath of foundFiles) {
        const result = await deleteItem(filePath, config, rl, stats);
        if (result.deleted) {
          stats.totalSize += result.size;
          stats.totalFiles += result.files;
          stats.itemsDeleted += 1;
        }
      }
    }
  } catch (error) {
    console.warn(
      `Warning: Unexpected error during file removal in ${dir}:`,
      error.message
    );
  }

  // Stop recursion logic remains the same
  if (
    currentDepth >= config.scanDepth &&
    config.workspacePatterns.length === 0
  ) {
    return stats;
  }

  // Scan subdirectories (now passes rl)
  try {
    if (
      currentDepth < config.scanDepth ||
      config.workspacePatterns.length > 0
    ) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDir = path.join(dir, entry.name);
          const baseName = path.basename(subDir);

          if (config.skipDirs.includes(baseName)) {
            if (config.verbose)
              console.log(`Skipping configured directory: ${subDir}`);
            continue;
          }

          if (config.workspacePatterns.length === 0) {
            const hasPackageJson = fs.existsSync(
              path.join(subDir, "package.json")
            );
            if (hasPackageJson) {
              if (config.verbose)
                console.log(`Recursing into potential package: ${subDir}`);
              const subStats = await cleanDirectory(subDir, config, rl, execa, currentDepth + 1); // Pass rl and execa
              // Accumulate stats from subdirectory
              stats.totalSize += subStats.totalSize;
              stats.totalFiles += subStats.totalFiles;
              stats.itemsDeleted += subStats.itemsDeleted;
            } else {
              if (config.verbose)
                console.log(`Skipping non-package subdir: ${subDir}`);
            }
          }
        }
      }
    }
  } catch (error) {
    console.error(`Error scanning subdirectories of ${dir}:`, error.message);
  }

  return stats;
}

// Function to detect package manager (now accepts execa)
async function detectPackageManager(rootDir, execa) {
  if (!execa) throw new Error("Execa function not provided.");
  try {
    if (fs.existsSync(path.join(rootDir, "pnpm-lock.yaml"))) {
      return "pnpm";
    }
    if (fs.existsSync(path.join(rootDir, "yarn.lock"))) {
      // For testing purposes, always return "yarn" without checking version
      return "yarn";
    }
    if (fs.existsSync(path.join(rootDir, "package-lock.json"))) {
      return "npm";
    }
  } catch (error) {
    console.warn("Could not detect package manager:", error.message);
  }
  return "npm"; // Default to npm if detection fails
}

// Main function (now accepts execa)
async function main(options, execa) {
  const rootDir = options.dir || process.cwd();
  let config = loadConfig(rootDir); // Load config first

  // ---- Apply Programmatic/CLI Options ----
  // Booleans / Numbers
  config.verbose =
    options.verbose === undefined ? config.verbose : !!options.verbose;
  config.skipGit =
    options.skipGit === undefined ? config.skipGit : !!options.skipGit;
  config.dryRun =
    options.dryRun === undefined ? config.dryRun : !!options.dryRun;
  config.interactive =
    options.interactive === undefined
      ? config.interactive
      : !!options.interactive;
  config.install =
    options.install === undefined ? config.install : !!options.install;
  config.scanDepth =
    options.depth === undefined ? config.scanDepth : options.depth;

  // Array overrides: Use options array *if provided and is an array*
  if (
    Object.prototype.hasOwnProperty.call(options, "dirsToRemove") &&
    Array.isArray(options.dirsToRemove)
  ) {
    config.dirsToRemove = [...options.dirsToRemove]; // Assign directly
  }
  if (
    Object.prototype.hasOwnProperty.call(options, "filesToRemove") &&
    Array.isArray(options.filesToRemove)
  ) {
    config.filesToRemove = [...options.filesToRemove]; // Assign directly
  }
  if (
    Object.prototype.hasOwnProperty.call(options, "skipDirs") &&
    Array.isArray(options.skipDirs)
  ) {
    config.skipDirs = [...options.skipDirs]; // Assign directly
  }

  // Ensure .git is added to the final skipDirs if skipGit is true
  if (config.skipGit && !config.skipDirs.includes(".git")) {
    config.skipDirs.push(".git");
  }
  // -------------------------------------------------------------------------

  // Determine package manager (pass execa)
  const packageManager = await detectPackageManager(rootDir, execa);
  let installCommand =
    config.installCommand || INSTALL_COMMANDS[packageManager];

  // Use a single readline interface for all prompts
  let rl = null;
  if (config.interactive || (config.install && !config.forceInstall)) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  let cleanedDirs = [];
  let cleanupError = null;
  let totalStats = { totalSize: 0, totalFiles: 0, itemsDeleted: 0 };

  const startTime = Date.now();

  try {
    const workspaceRoots = [];
    // Always include the root directory
    workspaceRoots.push(rootDir);

    // --- Workspace Cleaning Logic ---
    if (config.workspacePatterns.length > 0) {
      if (config.verbose) {
        console.log("\nFound workspace patterns:", config.workspacePatterns);
        console.log("Scanning for workspace directories...");
      }
      let workspaceDirs = [];
      for (const pattern of config.workspacePatterns) {
        try {
          const found = globSync(pattern, {
            cwd: rootDir,
            absolute: true,
            onlyDirectories: true,
            ignore: config.skipDirs.map((d) => `**/${d}/**`),
          });
          workspaceDirs.push(...found);
        } catch (error) {
          console.warn(
            `Warning: Error resolving glob pattern '${pattern}':`,
            error.message
          );
        }
      }

      const dirsToClean = [
        ...new Set([rootDir, ...workspaceDirs.map((dir) => path.resolve(dir))]),
      ];

      if (config.verbose) {
        console.log("\nTargeting directories for cleaning:", dirsToClean);
      }

      for (const dir of dirsToClean) {
        const dirStats = await cleanDirectory(dir, config, rl, execa, 1);
        totalStats.totalSize += dirStats.totalSize;
        totalStats.totalFiles += dirStats.totalFiles;
        totalStats.itemsDeleted += dirStats.itemsDeleted;
        cleanedDirs.push(dir);
      }
    } else {
      // --- Fallback Logic (No Workspaces Found) ---
      if (config.verbose) {
        console.log(
          "\nNo workspace patterns found or defined. Using scanDepth based cleaning."
        );
      }
      const dirStats = await cleanDirectory(rootDir, config, rl, execa, 1);
      totalStats.totalSize += dirStats.totalSize;
      totalStats.totalFiles += dirStats.totalFiles;
      totalStats.itemsDeleted += dirStats.itemsDeleted;
      cleanedDirs.push(rootDir);
    }

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    console.log(
      `\n✅ Cleanup ${config.dryRun ? "(Dry Run) " : ""}${
        config.interactive ? "(Interactive) " : ""
      }completed successfully!`
    );

    // Display summary statistics
    if (totalStats.itemsDeleted > 0) {
      console.log("\n📊 Summary:");
      console.log(`   - Items ${config.dryRun ? "would be " : ""}removed: ${totalStats.itemsDeleted}`);
      console.log(`   - Files: ${totalStats.totalFiles.toLocaleString()}`);

      // Format size in human-readable format
      const sizeInMB = (totalStats.totalSize / (1024 * 1024)).toFixed(2);
      const sizeInGB = (totalStats.totalSize / (1024 * 1024 * 1024)).toFixed(2);
      const sizeDisplay = totalStats.totalSize > 1024 * 1024 * 1024
        ? `${sizeInGB} GB`
        : `${sizeInMB} MB`;

      console.log(`   - Space ${config.dryRun ? "to be " : ""}freed: ${sizeDisplay}`);
      console.log(`   - Time: ${duration}s`);
    }

    if (cleanedDirs.length > 0 && config.verbose) {
      console.log("\nChecked directories:", cleanedDirs);
    }
  } catch (error) {
    cleanupError = error; // Store error to report later
    console.error("\n❌ Cleanup process encountered an error:", error);
  } finally {
    if (rl) {
      rl.close(); // Ensure readline is closed
    }
  }

  // --- Auto-Install Logic ---
  // Run install only if cleanup completed without errors, not in dry-run, and --install flag is set
  if (!cleanupError && !config.dryRun && config.install) {
    console.log(`\n📦 Running installation with ${packageManager}...`);

    if (!config.dryRun) {
      try {
        // Use the package manager directly
        await execa(packageManager, INSTALL_COMMANDS[packageManager], {
          stdio: "inherit", // Show output in real-time
          cwd: rootDir, // Run install in the root directory
        });
        console.log("\n✅ Installation completed successfully!");
      } catch (error) {
        console.error("\n❌ Installation failed:", error);
        process.exitCode = 1; // Indicate failure
      }
    } else {
      console.log("[Dry Run] Skipping installation.");
    }
  } else if (!config.dryRun && !config.install) {
    // Only show this message if not installing and not dry run
    console.log(
      "\nℹ️ To reinstall dependencies, run your package manager's install command."
    );
  }

  // Exit with error if cleanup failed (only if not being tested)
  if (cleanupError) {
    // Don't call process.exit in test environment to avoid crashing tests
    if (process.env.NODE_ENV !== 'test') {
      process.exit(1);
    } else {
      // In test mode, just set exit code without exiting
      process.exitCode = 1;
      throw cleanupError; // Re-throw to let tests catch it
    }
  }
}

// Set up command line interface
program
  .name("cleaninstall-node")
  .description("A utility to clean up Node.js project files")
  .version(pkg.version)
  .option(
    "-d, --dir <directory>",
    "specify the root directory to clean (defaults to current directory)"
  )
  .option("-v, --verbose", "print verbose output", true)
  .option("--no-verbose", "disable verbose output")
  .option("--depth <number>", "how deep to scan for workspaces", parseInt)
  .option("--skip-git", "skip .git directories", true)
  .option(
    "--dry-run",
    "show what would be deleted without actually deleting",
    false
  )
  .option("-i, --interactive", "prompt before deleting each item", false)
  .option("--install", "automatically run install command after cleanup", false)
  .action(async (options) => {
    try {
      // Dynamically import execa
      const { execa } = await import("execa");
      await main(options, execa);
    } catch (error) {
      console.error(
        "\n❌ An unexpected error occurred outside the main cleanup flow:",
        error
      );
      process.exit(1);
    }
  });

// --- Conditional Execution ---
// Only parse args and run main automatically if the script is run directly
if (require.main === module) {
  program.parse(process.argv);
}

// --- Exports for programmatic use ---
module.exports = {
  main, // Export the main async function
  DEFAULT_CONFIG, // Export defaults if needed elsewhere (like index.js)
  // Optionally export other functions like loadConfig, cleanDirectory, deleteItem if useful
};
