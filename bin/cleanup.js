#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { program } = require("commander");
const pkg = require("../package.json");

// Default configuration
const DEFAULT_CONFIG = {
  dirsToRemove: ["node_modules", ".next", ".turbo", "dist", "build"],
  filesToRemove: ["pnpm-lock.yaml", "yarn.lock", "package-lock.json"],
  scanDepth: 2, // How deep to scan for workspaces (1 = only root, 2 = one level of subdirectories)
  skipDirs: [".git"],
  verbose: true,
};

// Function to load custom config from package.json or .cleaninstallnoderc
function loadConfig(rootDir) {
  let config = { ...DEFAULT_CONFIG };

  // Try to load from package.json
  try {
    const packageJsonPath = path.join(rootDir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      if (packageJson.cleaninstallNode) {
        config = { ...config, ...packageJson.cleaninstallNode };
      }
    }
  } catch (error) {
    console.warn(
      "Warning: Could not parse package.json for config:",
      error.message
    );
  }

  // Try to load from .cleaninstallnoderc
  try {
    const rcPath = path.join(rootDir, ".cleaninstallnoderc");
    if (fs.existsSync(rcPath)) {
      const rcConfig = JSON.parse(fs.readFileSync(rcPath, "utf8"));
      config = { ...config, ...rcConfig };
    }
  } catch (error) {
    console.warn(
      "Warning: Could not parse .cleaninstallnoderc:",
      error.message
    );
  }

  return config;
}

// Function to delete a directory or file
function deleteItem(itemPath, verbose) {
  try {
    if (fs.existsSync(itemPath)) {
      if (verbose) console.log(`Removing: ${itemPath}`);
      if (fs.lstatSync(itemPath).isDirectory()) {
        fs.rmSync(itemPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(itemPath);
      }
      return true;
    }
    return false;
  } catch (error) {
    console.error(`Error removing ${itemPath}:`, error.message);
    return false;
  }
}

// Function to find and clean items in a directory
function cleanDirectory(dir, config, currentDepth = 1) {
  if (config.verbose) console.log(`\nScanning directory: ${dir}`);

  // Remove specified directories
  for (const dirName of config.dirsToRemove) {
    const dirPath = path.join(dir, dirName);
    deleteItem(dirPath, config.verbose);
  }

  // Remove specified files
  for (const fileName of config.filesToRemove) {
    const filePath = path.join(dir, fileName);
    deleteItem(filePath, config.verbose);
  }

  // Stop if we've reached the maximum scan depth
  if (currentDepth >= config.scanDepth) {
    return;
  }

  // Scan subdirectories
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDir = path.join(dir, entry.name);

        // Skip specified directories
        if (config.skipDirs.includes(entry.name)) {
          continue;
        }

        // Check if the subdirectory has a package.json (indicating it's a workspace)
        const hasPackageJson = fs.existsSync(path.join(subDir, "package.json"));
        if (hasPackageJson) {
          cleanDirectory(subDir, config, currentDepth + 1);
        }
      }
    }
  } catch (error) {
    console.error(`Error scanning ${dir}:`, error.message);
  }
}

// Main function
function main(options) {
  console.log("🧹 Starting cleanup process...");

  // Get the root directory
  const rootDir = options.dir || process.cwd();

  // Load configuration
  const config = loadConfig(rootDir);

  // Override config with command line options
  if (options.verbose !== undefined) config.verbose = options.verbose;
  if (options.depth !== undefined) config.scanDepth = options.depth;
  if (options.skipGit !== undefined && options.skipGit) {
    if (!config.skipDirs.includes(".git")) {
      config.skipDirs.push(".git");
    }
  }

  // Clean root directory
  cleanDirectory(rootDir, config);

  // Clean apps directory if it exists (common in monorepos)
  const appsDir = path.join(rootDir, "apps");
  if (fs.existsSync(appsDir)) {
    const appEntries = fs.readdirSync(appsDir, { withFileTypes: true });
    for (const entry of appEntries) {
      if (entry.isDirectory()) {
        cleanDirectory(path.join(appsDir, entry.name), config, 2);
      }
    }
  }

  // Clean packages directory if it exists (common in monorepos)
  const packagesDir = path.join(rootDir, "packages");
  if (fs.existsSync(packagesDir)) {
    const packageEntries = fs.readdirSync(packagesDir, { withFileTypes: true });
    for (const entry of packageEntries) {
      if (entry.isDirectory()) {
        cleanDirectory(path.join(packagesDir, entry.name), config, 2);
      }
    }
  }

  console.log("\n✅ Cleanup completed successfully!");
  console.log(
    "To reinstall dependencies, run your package manager's install command (npm install, yarn, pnpm install, etc.)"
  );
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
  .action((options) => {
    main(options);
  });

// Parse command line arguments
program.parse(process.argv);
