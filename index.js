const { execa } = require("execa");
const { main, DEFAULT_CONFIG, LOCKFILES } = require("./bin/cleanup.js");

/**
 * Programmatically clean up a Node.js project.
 *
 * Unlike the CLI, this never asks for a single up-front confirmation
 * (it behaves as if `--yes` was passed) unless `yes: false` is set.
 *
 * @param {object} [options]
 * @param {string} [options.dir=process.cwd()] - Root directory.
 * @param {boolean} [options.verbose=true] - Verbose output.
 * @param {number} [options.depth] - Scan depth when no workspaces are defined.
 * @param {boolean} [options.skipGit=true] - Skip .git folders.
 * @param {boolean} [options.dryRun=false] - Report what would be removed without removing.
 * @param {boolean} [options.interactive=false] - Prompt before each item.
 * @param {boolean} [options.install=false] - Run the package manager's install afterwards.
 * @param {boolean} [options.removeLockfiles=false] - Also remove lockfiles.
 * @param {boolean} [options.yes=true] - Skip the up-front confirmation.
 * @param {string[]} [options.dirsToRemove] - Override directories to remove.
 * @param {string[]} [options.filesToRemove] - Override files to remove.
 * @param {string[]} [options.skipDirs] - Override directories to skip.
 * @returns {Promise<{dryRun: boolean, packageManager: string, targets: object[],
 *   removed: string[], skipped: string[], failed: string[], totalSize: number,
 *   totalFiles: number, itemsDeleted: number, installed: boolean}>}
 */
async function cleanup(options = {}) {
  return main({ yes: true, ...options }, execa);
}

module.exports = {
  cleanup,
  DEFAULT_CONFIG,
  LOCKFILES,
};
