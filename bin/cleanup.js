#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { program } = require("commander");
const pkg = require("../package.json");
const { globSync } = require("glob");
const yaml = require("js-yaml");
const readline = require("readline/promises");
const { execa } = require("execa");

// Default configuration
const DEFAULT_CONFIG = {
  dirsToRemove: ["node_modules", ".next", ".turbo", "dist", "build"],
  filesToRemove: ["pnpm-lock.yaml", "yarn.lock", "package-lock.json"],
  scanDepth: 2, // How deep to scan for workspaces (1 = only root, 2 = one level of subdirectories)
  skipDirs: [".git"],
  verbose: true,
  workspacePatterns: [],
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

// Function to delete a directory or file (now accepts rl instance if interactive)
async function deleteItem(itemPath, config, rl) {
  try {
    const exists = fs.existsSync(itemPath);

    if (!exists) {
      return false;
    }

    // Determine if it's a directory *before* asking/logging
    const isDirectory = fs.lstatSync(itemPath).isDirectory();

    if (config.dryRun) {
      console.log(
        `[Dry Run] Would remove ${
          isDirectory ? "directory" : "file"
        }: ${itemPath}`
      );
      return true; // Simulate success
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
          return false;
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
      return true; // Deletion successful
    }

    // If we reach here, deletion was skipped (e.g., interactive 'no')
    return false;
  } catch (error) {
    // Catch errors from existsSync, lstatSync, rmSync, unlinkSync
    console.error(`Error processing ${itemPath}:`, error);
    return false;
  }
}

// Function to find and clean items in a directory (now accepts rl instance)
async function cleanDirectory(dir, config, rl, currentDepth = 1) {
  if (config.verbose) console.log(`\nScanning directory: ${dir}`);

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
          await deleteItem(dirPath, config, rl);
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
        await deleteItem(filePath, config, rl);
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
    return;
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
              await cleanDirectory(subDir, config, rl, currentDepth + 1); // Pass rl
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
}

// Function to detect package manager and install command
function detectPackageManager(rootDir) {
  if (fs.existsSync(path.join(rootDir, "pnpm-lock.yaml"))) {
    return { command: "pnpm", args: ["install"] };
  }
  if (fs.existsSync(path.join(rootDir, "yarn.lock"))) {
    return { command: "yarn", args: ["install"] }; // yarn v2+ use 'yarn install'
  }
  if (fs.existsSync(path.join(rootDir, "package-lock.json"))) {
    return { command: "npm", args: ["install"] };
  }
  // Default to npm if no lock file is found
  return { command: "npm", args: ["install"] };
}

// Main function (now conditionally creates and closes rl)
async function main(options) {
  let rl = null;
  let closeRl = false;

  console.log("🧹 Starting cleanup process...");

  const rootDir = options.dir || process.cwd();
  // Load configuration from defaults and files
  let config = loadConfig(rootDir);

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

  // Detect package manager early
  const pm = detectPackageManager(rootDir);

  if (config.dryRun) {
    console.log("\n*** Dry Run Mode Active: No files will be deleted. ***");
  } else if (config.interactive) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    closeRl = true; // Mark that it needs closing
    console.log(
      "\n*** Interactive Mode Active: You will be prompted for deletions. ***"
    );
  } else if (config.install) {
    console.log(
      `\n*** Auto-Install Active: Will run '${pm.command} ${pm.args.join(
        " "
      )}' after cleanup. ***`
    );
  }

  let cleanedDirs = [];
  let cleanupError = null;

  try {
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
        await cleanDirectory(dir, config, rl, 1);
        cleanedDirs.push(dir);
      }
    } else {
      // --- Fallback Logic (No Workspaces Found) ---
      if (config.verbose) {
        console.log(
          "\nNo workspace patterns found or defined. Using scanDepth based cleaning."
        );
      }
      await cleanDirectory(rootDir, config, rl, 1);
      cleanedDirs.push(rootDir);
    }

    console.log(
      `\n✅ Cleanup ${config.dryRun ? "(Dry Run) " : ""}${
        config.interactive ? "(Interactive) " : ""
      }completed successfully!`
    );
    if (cleanedDirs.length > 0 && config.verbose) {
      console.log("Checked directories:", cleanedDirs);
    }
  } catch (error) {
    cleanupError = error; // Store error to report later
    console.error("\n❌ Cleanup process encountered an error:", error);
  } finally {
    // Close readline ONLY if it was created
    if (rl && closeRl) {
      rl.close();
    }
  }

  // --- Auto-Install Logic ---
  // Run install only if cleanup completed without errors, not in dry-run, and --install flag is set
  if (!cleanupError && !config.dryRun && config.install) {
    console.log(`\n📦 Running '${pm.command} ${pm.args.join(" ")}'...`);
    try {
      // Run the install command, inherit stdio to show progress
      await execa(pm.command, pm.args, {
        cwd: rootDir,
        stdio: "inherit", // Show output directly in the terminal
      });
      console.log("\n✅ Installation completed successfully!");
    } catch (installError) {
      console.error(
        `\n❌ Installation failed: ${pm.command} ${pm.args.join(" ")}`,
        installError.shortMessage || installError // Show concise error
      );
      // Optionally exit with error code if install fails?
      // process.exit(1);
    }
  } else if (!config.dryRun && !config.install) {
    // Only show this message if not installing and not dry run
    console.log(
      "\nℹ️ To reinstall dependencies, run your package manager's install command."
    );
  }

  // Exit with error if cleanup failed
  if (cleanupError) {
    process.exit(1);
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
      await main(options);
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
