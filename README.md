# CleanInstall Node

[![npm version](https://badge.fury.io/js/cleaninstall-node.svg)](https://www.npmjs.com/package/cleaninstall-node)
[![Downloads](https://img.shields.io/npm/dm/cleaninstall-node.svg)](https://www.npmjs.com/package/cleaninstall-node)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/ahusan/cleaninstall-node/actions/workflows/ci.yml/badge.svg)](https://github.com/ahusan/cleaninstall-node/actions/workflows/ci.yml)

**Stop deleting `node_modules` blindly.** `cleaninstall-node` finds out *why* an install is broken and applies the smallest fix, warns you right after a `git pull` changes your dependencies, and cleans safely when you really do want a fresh start. Works with npm, pnpm, yarn and bun, in single projects and monorepos.

**[Website](https://cleaninstall-node.ahusan.dev/)** · [npm](https://www.npmjs.com/package/cleaninstall-node) · [Changelog](https://github.com/ahusan/cleaninstall-node/blob/main/CHANGELOG.md)

```bash
npx cleaninstall-node doctor         # what's wrong? (and --fix to repair it)
npx cleaninstall-node hook install   # warn after pull/checkout/rebase
npx cleaninstall-node --install      # clean + reinstall, safely
```

> **Upgrading from 2.x?** Lockfiles are now kept unless you pass `--lockfiles`, the CLI asks once before deleting (use `-y` in scripts), and Node.js 20+ is required. See the [changelog](https://github.com/ahusan/cleaninstall-node/blob/main/CHANGELOG.md#300---2026-11-25).

## Features

- Removes common clutter (`node_modules`, build output, etc.)
- **Workspace Aware:** Automatically detects workspaces defined in `package.json` or `pnpm-workspace.yaml`.
- **Glob Pattern Support:** Use glob patterns (e.g., `*.log`, `dist-*`) in configuration for flexible matching.
- **Dry Run Mode:** See what would be deleted without actually removing anything.
- **`doctor`:** Diagnoses *why* an install is broken (stale lockfile, wrong Node, native ABI mismatch, mixed package managers) and applies the smallest fix.
- **Git hook:** Warns (or reinstalls) right after a pull, branch switch or rebase changes your dependencies.
- **Safe by default:** Shows what will be removed and asks once before deleting (skip with `-y`). Lockfiles are kept unless you pass `--lockfiles`.
- **Interactive Mode:** Confirm each deletion individually.
- **Auto-Install:** Runs `npm`, `yarn`, `pnpm` or `bun` install after cleanup, detected from the `packageManager` field or your lockfile.
- Configurable via CLI, `package.json`, or `.cleaninstallnoderc`.

## Why CleanInstall Node?

Compared to manual deletion or other tools:

- **vs `rm -rf node_modules && npm install`**: Workspace-aware, handles monorepos automatically, safer with dry-run mode
- **vs `npx rimraf`**: Built-in monorepo support, auto-reinstall, interactive mode, glob patterns
- **vs manual deletion**: Cross-platform, configurable, preview before deletion, handles multiple workspaces

## Quick Start

```bash
# Clean and reinstall dependencies in one command
npx cleaninstall-node --install

# Full reset, including lockfiles (resolves fresh dependency versions!)
npx cleaninstall-node --lockfiles --install

# Non-interactive (CI / scripts): skip the confirmation prompt
npx cleaninstall-node -y

# Preview what would be deleted (dry run)
npx cleaninstall-node --dry-run

# Interactive mode - confirm each deletion
npx cleaninstall-node -i
```

## `doctor`: find out *why* before you delete

Most "nuke `node_modules`" moments have a specific cause. `doctor` finds it and applies the smallest fix that works:

```bash
npx cleaninstall-node doctor          # diagnose
npx cleaninstall-node doctor --fix    # apply the smallest fix
npx cleaninstall-node doctor --json   # machine-readable, exit code 1 on errors
```

```
🩺 cleaninstall-node doctor — ~/code/app (npm)

  ✖ node_modules is out of sync with package-lock.json (1 difference)
      ms: installed 2.1.3, lockfile 2.1.2
      Usually happens after git pull / switching branches without reinstalling.
  ✖ 1 native module was built for a different Node version
      better-sqlite3: built for ABI 115, this Node needs 127
  ✔ Node v22.11.0 matches .nvmrc (22)

2 errors, 0 warnings.

Smallest fix (run with --fix to apply):
  → npm install
  → npm rebuild better-sqlite3
```

| Check | Detects | Fix |
| --- | --- | --- |
| Node version | Running Node vs `.nvmrc`, `.node-version`, `.tool-versions`, `volta.node`, `engines.node` | Manual (`nvm use`). Blocks `--fix` so nothing is rebuilt for the wrong Node |
| Lockfile sync | `node_modules` doesn't match the lockfile, e.g. after a `git pull` (npm, pnpm, yarn v1) | `install` |
| Direct dependencies | A dependency is missing or installed outside its `package.json` range (all package managers, workspaces included) | `install` |
| Native modules | A `.node` addon was built for another Node ABI, or for another OS/CPU (Docker volume, Rosetta) | `rebuild <only those packages>` |
| Installer | `node_modules` was written by a different package manager than the project uses | remove `node_modules` + install |
| Lockfiles | More than one package manager's lockfile, a mismatch with `packageManager`, no lockfile at all | Manual |
| pnpm builds | pnpm 10 skipped a package's build scripts (`ignoredBuilds`) | Manual (`pnpm approve-builds`) |
| yarn system | yarn v1 installed under a different Node ABI or platform | `install` |

Native addons are loaded in a separate short-lived process, so a crashing addon can't take `doctor` down. Skip that check with `--no-native`.

## Git hook: know when to reinstall

You pull, switch branches or rebase, the lockfile changes, nobody reinstalls, and an hour later something fails in a confusing way. The hook catches that moment:

```bash
npx cleaninstall-node hook install                 # warn (default)
npx cleaninstall-node hook install --mode install  # run the install / rebuild automatically
npx cleaninstall-node hook uninstall
```

```
$ git pull
📦 cleaninstall-node: dependencies changed (package-lock.json, package.json)
   ✖ node_modules is out of sync with package-lock.json (3 differences)
   → run: npm install
   (or: npx cleaninstall-node doctor --fix)
```

- Runs on `post-checkout` (branch switch), `post-merge` (pull/merge) and `post-rewrite` (rebase, reported once at the end).
- **Fast:** it first checks which files changed. Unless a lockfile, `package.json`, `pnpm-workspace.yaml`, `.nvmrc`/`.node-version`, `.npmrc` or `.yarnrc.yml` changed, it exits immediately. When one did, it runs `doctor`'s checks and stays **silent if `node_modules` already matches**.
- **Safe:** `--mode install` only ever runs an install or a targeted rebuild. It never deletes `node_modules`, and does nothing when you're on the wrong Node version. A hook can't fail your git command.
- **Plays well with others:** if husky manages your hooks, the hook goes into `.husky/` so you can commit it for the whole team. Existing hook scripts are kept, and only a marked block is added or removed.
- Skipped when `CI` is set. Skip once with `CLEANINSTALL_SKIP_HOOK=1 git pull`; override the mode per shell with `CLEANINSTALL_HOOK_MODE=warn|install`.

To give every teammate the hook without husky, add it to `prepare` (this needs `cleaninstall-node` in `devDependencies`):

```json
{ "scripts": { "prepare": "cleaninstall-node hook install" } }
```

## Installation

### Global Installation

```bash
npm install -g cleaninstall-node
```

### Local Installation

```bash
npm install --save-dev cleaninstall-node
```

## Usage

### Command Line

After installing globally, you can run:

```bash
cleaninstall-node [options]
```

Or if installed locally:

```bash
npx cleaninstall-node [options]
```

#### Options

```
Usage: cleaninstall-node [options]

A utility to clean up Node.js project files

Options:
  -V, --version          output the version number
  -d, --dir <directory>  root directory to clean (defaults to current directory)
  -v, --verbose          print verbose output (default: true)
  --no-verbose           disable verbose output
  --depth <number>       how deep to scan for packages when no workspaces are defined
  --skip-git             skip .git directories (default)
  --no-skip-git          do not skip .git directories
  --dry-run              show what would be deleted without deleting (default: false)
  -i, --interactive      prompt before deleting each item (default: false)
  -y, --yes              don't ask for confirmation before deleting
  --lockfiles            also remove lockfiles (package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lock)
  --install              run the package manager's install after cleanup (default: false)
  -h, --help             display help for command
```

When run in a terminal, the tool lists everything it will remove with sizes and asks once before deleting. The prompt is skipped with `-y`, in `--dry-run` / `-i` mode, and when stdin isn't a terminal (CI, pipes).

#### Common Use Cases

```bash
# Clean a monorepo and reinstall all dependencies
npx cleaninstall-node --install

# Preview what would be removed
npx cleaninstall-node --dry-run

# Clean before committing to save disk space
npx cleaninstall-node

# Add to package.json scripts for convenience
{
  "scripts": {
    "clean": "cleaninstall-node -y",
    "fresh": "cleaninstall-node -y --install",
    "clean:preview": "cleaninstall-node --dry-run"
  }
}
```

### Programmatic Usage

```javascript
const { cleanup } = require("cleaninstall-node");

const result = await cleanup({
  dir: "/path/to/project",
  dryRun: true,              // report only
  removeLockfiles: false,    // keep lockfiles (default)
  dirsToRemove: ["node_modules", "dist"],
  verbose: false,
});

console.log(result.removed);      // absolute paths removed (or that would be, in dry run)
console.log(result.totalSize);    // bytes freed
console.log(result.packageManager); // "npm" | "yarn" | "pnpm" | "bun"
```

`cleanup()` does not show the up-front confirmation prompt (it acts as if `yes: true`). It resolves to `{ dryRun, packageManager, targets, removed, skipped, failed, totalSize, totalFiles, itemsDeleted, installed }`.

## Key Features Explained

### Workspace Detection

The tool automatically looks for `workspaces` definitions in your root `package.json` and `packages` definitions in `pnpm-workspace.yaml`. If found, it uses these patterns (via `glob`) to identify workspace directories and cleans them alongside the root directory. The `--depth` option is mainly used as a fallback if no workspace definitions are found, controlling how deep to look for nested `package.json` files.

### Glob Patterns

You can use [glob patterns](https://github.com/isaacs/node-glob#glob-primer) in the `dirsToRemove` and `filesToRemove` configuration arrays. For example:

- `"*.log"`: Removes all files ending in `.log`.
- `"temp-*"`: Removes all files or directories starting with `temp-`.
- `".cache"`: Removes a directory named `.cache`. (Dot files/dirs are included by default).

### Dry Run (`--dry-run`)

Simulates the cleanup process. It prints all files and directories that _would_ be deleted according to the configuration and workspace detection, but doesn't actually modify the file system. Useful for verifying your setup.

### Interactive (`-i`, `--interactive`)

Prompts for confirmation (Y/N) before deleting each identified file or directory. This gives you fine-grained control over the cleanup process.

### Auto-Install (`--install`)

After a successful cleanup (and if not in dry-run mode), this runs your package manager's install in the root directory. The package manager is detected before anything is deleted: first from the `packageManager` field in `package.json` (Corepack), then from `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`/`bun.lockb` or `package-lock.json`, defaulting to `npm`. Set `installCommand` in config (e.g. `"npm ci"`) to run something else.

### Lockfiles (`--lockfiles`)

Lockfiles are **kept by default**: deleting them makes the next install resolve new dependency versions, which is rarely what a "clean reinstall" should do. Pass `--lockfiles` (or `removeLockfiles: true` in config/API) to remove `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock` and `bun.lockb`.

## Configuration

Configure using command-line options (highest precedence), a `.cleaninstallnoderc` file (JSON format) in the project root, or a `cleaninstallNode` key in your root `package.json`.

### Example `package.json` Configuration

```json
{
  "name": "your-project",
  "version": "1.0.0",
  "cleaninstallNode": {
    "dirsToRemove": [
      "node_modules",
      ".next",
      "dist",
      "build",
      "coverage",
      "*.tmp"
    ],
    "filesToRemove": [
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "*.log"
    ],
    "skipDirs": [".git", "docs", ".vscode"]
  }
}
```

### Example `.cleaninstallnoderc` File

```json
{
  "dirsToRemove": ["node_modules", "dist", "build", ".cache"],
  "filesToRemove": ["*-lock.json", "yarn.lock", "pnpm-lock.yaml"],
  "skipDirs": [".git", "artifacts"]
}
```

### Configuration Options

| Option          | Type     | Default                                                                                                                                                            | Description                                                                                                    |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `dirsToRemove`  | string[] | `["node_modules", ".next", ".turbo", "dist", "build", ".cache", ".nuxt", ".output", "out", ".vite", ".astro", ".svelte-kit", "coverage", ".nyc_output"]` | Directories to remove (supports glob patterns). Matched relative to each directory being cleaned.              |
| `filesToRemove` | string[] | `[]`                                                                                                                                                               | Files to remove (supports glob patterns). Matched relative to each directory being cleaned.                    |
| `removeLockfiles` | boolean | `false`                                                                                                                                                         | Also remove all known lockfiles (same as `--lockfiles`).                                                       |
| `installCommand` | string \| string[] | detected                                                                                                                                                | Command run by `--install`, e.g. `"npm ci"`.                                                                   |
| `scanDepth`     | number   | `2`                                                                                                                                                                | Fallback scan depth if no workspaces detected (1 = root only, 2 = root + immediate children with package.json) |
| `skipDirs`      | string[] | `[".git"]`                                                                                                                                                         | Base names of directories to completely ignore during scanning and glob matching.                              |
| `verbose`       | boolean  | `true`                                                                                                                                                             | Whether to print verbose output.                                                                               |

_(Note: `workspacePatterns` are automatically detected and not typically set manually in config)_

## Development

### Testing

This project uses Jest for testing. To run the tests:

```bash
npm test
```

The tests should ideally use mocking libraries (like `mock-fs`, or Jest's mocking capabilities for `fs`, `glob`, `execa`, `readline`) to simulate file system operations and external processes without side effects.

### Publishing

To publish this package to npm:

1. Make sure you have an npm account and are logged in:

   ```bash
   npm login
   ```

2. Update the version in package.json:

   ```bash
   npm version patch  # or minor, or major
   ```

3. Publish the package:
   ```bash
   npm publish
   ```

## License

MIT
