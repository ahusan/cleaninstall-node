const path = require("path");
const { execa } = require("execa");
// Import the main logic from the CLI script
const { main } = require("./bin/cleanup.js");
// Re-export DEFAULT_CONFIG if needed for tests or programmatic users
const { DEFAULT_CONFIG } = require("./bin/cleanup.js");

/**
 * Programmatically cleans up a Node.js project using the core logic.
 *
 * Note: This wrapper adapts options for programmatic use.
 * Features like interactive prompts might behave differently than direct CLI usage.
 * Auto-install requires the environment to have the necessary package manager commands (npm, yarn, pnpm).
 *
 * @param {object} options - Cleanup options matching the CLI flags.
 * @param {string} [options.dir=process.cwd()] - Root directory.
 * @param {boolean} [options.verbose=true] - Verbose output.
 * @param {number} [options.depth] - Scan depth (used as fallback).
 * @param {boolean} [options.skipGit=true] - Skip .git folder.
 * @param {boolean} [options.dryRun=false] - Dry run mode.
 * @param {boolean} [options.interactive=false] - Interactive mode.
 * @param {boolean} [options.install=false] - Auto-install mode.
 * @param {string[]} [options.dirsToRemove] - Override default dirsToRemove.
 * @param {string[]} [options.filesToRemove] - Override default filesToRemove.
 * @param {string[]} [options.skipDirs] - Override default skipDirs.
 * @returns {Promise<void>} A promise that resolves when cleanup (and optional install) is complete, or rejects on error.
 */
async function cleanup(options = {}) {
  // Map the programmatic options to the format expected by main() (like commander)
  const mappedOptions = {
    dir: options.dir,
    verbose: options.verbose,
    depth: options.depth,
    skipGit: options.skipGit,
    dryRun: options.dryRun || false,
    interactive: options.interactive || false,
    install: options.install || false,
    dirsToRemove: options.dirsToRemove,
    filesToRemove: options.filesToRemove,
    skipDirs: options.skipDirs,
  };

  // Ensure verbose is explicitly handled after initial mapping
  if (options.verbose === false) {
    mappedOptions.verbose = false;
  } else if (mappedOptions.verbose === undefined) {
    // If not passed and not explicitly false, default to true?
    // The main function's logic handles undefined verbose defaulting to config, which defaults to true.
    // So, we might not strictly need this else-if.
    // Let's remove explicit true default here and let main handle it.
    // mappedOptions.verbose = true;
  }

  // Call the core main function, passing execa
  await main(mappedOptions, execa);
}

module.exports = {
  cleanup,
  DEFAULT_CONFIG, // Keep exporting this for potential test compatibility
};
