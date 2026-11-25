# CleanInstall Node

[![npm version](https://badge.fury.io/js/cleaninstall-node.svg)](https://www.npmjs.com/package/cleaninstall-node)
[![Downloads](https://img.shields.io/npm/dm/cleaninstall-node.svg)](https://www.npmjs.com/package/cleaninstall-node)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/ahusan/cleaninstall-node/actions/workflows/ci.yml/badge.svg)](https://github.com/ahusan/cleaninstall-node/actions/workflows/ci.yml)

**Stop deleting `node_modules` blindly.** `cleaninstall-node` finds out *why* an install is broken and applies the smallest fix, warns you right after a `git pull` changes your dependencies, and cleans safely when you really do want a fresh start. Works with npm, pnpm, yarn and bun, in single projects and monorepos.

**[Website](https://cleaninstall-node.ahusan.dev/)** · [npm](https://www.npmjs.com/package/cleaninstall-node) · [Changelog](https://github.com/ahusan/cleaninstall-node/blob/main/CHANGELOG.md)

```bash
npx cleaninstall-node doctor         # what's wrong? (and --fix to repair it)
npm run dev 2>&1 | npx cleaninstall-node doctor --from-error   # explain this error
npx cleaninstall-node hook install   # warn after pull/checkout/rebase
npx cleaninstall-node --install      # clean + reinstall, safely
```

**Using an AI coding agent?** Give it the [MCP server](#use-it-from-ai-agents-mcp) so it diagnoses broken installs instead of running `rm -rf node_modules package-lock.json`:

```bash
claude mcp add cleaninstall -- npx -y cleaninstall-node mcp   # tools for the agent
npx cleaninstall-node agent install                            # guidance + a guard hook
```

> **Upgrading from 2.x?** Lockfiles are now kept unless you pass `--lockfiles`, the CLI asks once before deleting (use `-y` in scripts), and Node.js 20+ is required. See the [changelog](https://github.com/ahusan/cleaninstall-node/blob/main/CHANGELOG.md#300---2026-11-25).

## Features

- Removes common clutter (`node_modules`, build output, etc.)
- **Workspace Aware:** Automatically detects workspaces defined in `package.json` or `pnpm-workspace.yaml`.
- **Glob Pattern Support:** Use glob patterns (e.g., `*.log`, `dist-*`) in configuration for flexible matching.
- **Dry Run Mode:** See what would be deleted without actually removing anything.
- **`doctor`:** Diagnoses *why* an install is broken (stale lockfile, wrong Node, native ABI mismatch, mixed package managers) and applies the smallest fix.
- **`doctor --from-error`:** Paste or pipe an error; get what it means for *this* project and the fix.
- **Agent setup:** `agent install` adds guidance to AGENTS.md / CLAUDE.md and a Claude Code hook that blocks `rm -rf node_modules` and lockfile deletion.
- **MCP server for AI agents:** Claude Code, Cursor, VS Code and others can diagnose and fix installs through structured tools.
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

### Paste the error: `--from-error`

Start from the error you actually got. `doctor --from-error` explains what it means **for this project** and folds it into the fix plan:

```bash
npm run dev 2>&1 | npx cleaninstall-node doctor --from-error     # pipe it in
npx cleaninstall-node doctor --from-error "Cannot find module 'axios'"
npx cleaninstall-node doctor --from-error --fix                   # and fix it
```

```
🩺 cleaninstall-node doctor --from-error — ~/code/app (npm)

What the error means
  ✖ axios is in package.json but not installed
      axios (^1.7.0) is declared, but node_modules doesn't have it: the install is missing or out of date.

In this project
  ✖ 2 dependencies are not installed   ← likely related
  ✔ 1 other check passed

Smallest fix (run with --fix to apply):
  → npm install
```

The same error can need different fixes. `Cannot find module 'x'` gets a different answer when `x` is declared but not installed (install it), only present through another package (add it to package.json), installed at the wrong version, a relative import (a code problem, so no reinstall), or a Node built-in. Recognised errors:

| Error | Example | What it suggests |
| --- | --- | --- |
| Native module, wrong Node | `NODE_MODULE_VERSION 115 … requires 127` | Rebuild that one package |
| Native module, wrong OS/CPU | `invalid ELF header` | Rebuild that package, and stop sharing node_modules with Docker |
| Platform binary missing | rollup, esbuild, sharp, swc `…-linux-x64` | Clean reinstall |
| Module not found | Node CJS/ESM, Vite, webpack, Next.js, `TS2307` | Depends on the project (see above) |
| Command not found | `sh: vite: not found`, `'tsc' is not recognized` | Install, `npx`, or which package to add |
| ESM-only package | `ERR_REQUIRE_ESM` | Newer Node, `import()`, or pin the old major |
| Subpath not exported | `ERR_PACKAGE_PATH_NOT_EXPORTED` | Check the installed major |
| Lockfile out of sync | `npm ci`, `ERR_PNPM_OUTDATED_LOCKFILE`, yarn `--frozen-lockfile` | Install locally and commit the lockfile |
| Peer conflict | `ERESOLVE` | Align versions (`--legacy-peer-deps` only as a last resort) |
| Wrong Node for a dependency | `EBADENGINE`, yarn/pnpm engine errors | Switch Node (blocks `--fix`) |
| Wrong package manager | Corepack mismatch, npm on `workspace:` | Use the declared package manager |
| Broken install | `ENOTEMPTY`, interrupted installs | Clean reinstall |
| Other | `EINTEGRITY`, `EACCES`, disk full vs. file-watcher `ENOSPC`, `gyp ERR!` | Specific steps |

With `--json`, the report includes `error.matches` for agents and scripts. An error it doesn't recognise still gets the normal doctor checks.

## Use it from AI agents (MCP)

When an install breaks, AI coding agents tend to run `rm -rf node_modules package-lock.json && npm install`. That throws away the lockfile, quietly upgrades dependencies, and often doesn't fix the real cause. `cleaninstall-node mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives the agent the diagnosis and the smallest fix instead.

| Tool | What it does | Changes files |
| --- | --- | --- |
| `explain_error` | Explains an error message for this project (everything `--from-error` knows) and returns a fix plan | No |
| `diagnose` | Full `doctor` health check and fix plan | No |
| `apply_fix` | Runs the plan: targeted rebuild, install, or (rarely) a clean reinstall. Never touches lockfiles | Yes |
| `plan_clean` | Lists what a cleanup would delete, with sizes | No |
| `clean` | Deletes exactly what `plan_clean` listed; can reinstall | Yes |

**Built-in safety:**
- **Plans must be shown first.** `apply_fix` and `clean` only run with the `plan_id` from a preceding read-only call. If the project changed in between, they refuse and the agent has to re-plan, so it can't delete or install something nobody was shown.
- **Hard limits.** The tools refuse to run on `/`, your home folder, or a folder without a `package.json`. Lockfiles are only removed when asked, and fixes are blocked while you're on the wrong Node version.
- **Guidance for the agent.** The server's instructions tell it to call `explain_error` before deleting `node_modules`.
- **No extra install weight.** The server adds no runtime dependencies.

### Setup

**Claude Code** (add `--scope project` to share it with your team via `.mcp.json`):

```bash
claude mcp add cleaninstall -- npx -y cleaninstall-node mcp
```

**Cursor** (`.cursor/mcp.json`), **Windsurf**, **Claude Desktop** (`claude_desktop_config.json`) and other clients using the `mcpServers` format:

```json
{
  "mcpServers": {
    "cleaninstall": { "command": "npx", "args": ["-y", "cleaninstall-node", "mcp"] }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "cleaninstall": { "type": "stdio", "command": "npx", "args": ["-y", "cleaninstall-node", "mcp"] }
  }
}
```

Tools default to the folder the client starts the server in, which is normally your project. Every tool also takes a `dir` argument, and `mcp --dir <path>` changes the default; use one of these with clients that don't start in a project, such as Claude Desktop. On Windows, if a client can't find `npx`, use `"command": "cmd", "args": ["/c", "npx", "-y", "cleaninstall-node", "mcp"]`.

### Agent setup: `agent install`

An MCP tool only helps when the agent decides to use it. `agent install` changes the default:

```bash
npx cleaninstall-node agent install            # guidance + Claude Code guard hook
npx cleaninstall-node agent install --ask      # hook asks you instead of blocking
npx cleaninstall-node agent install --no-hook  # guidance only
npx cleaninstall-node agent uninstall
```

| File | What it gets |
| --- | --- |
| `AGENTS.md` | A short "diagnose before deleting" section, read by most coding agents |
| `CLAUDE.md` | The same section. If you don't have a CLAUDE.md, it creates one that imports `@AGENTS.md`, because Claude Code ignores AGENTS.md once a CLAUDE.md exists |
| `.github/copilot-instructions.md`, `.cursor/rules/` | The same guidance, only if you already use Copilot instructions or Cursor rules |
| `.claude/settings.json` + `.claude/hooks/cleaninstall-guard.js` | A Claude Code **PreToolUse hook** that blocks Bash commands deleting `node_modules` or a lockfile, and tells the agent what to run instead |

The guard catches `rm -rf node_modules` (also `./`, `*/`, `**/` and `node_modules/*` forms), `rimraf`, `find … -exec rm` / `-delete` / `| xargs rm`, `git clean -x`, PowerShell `Remove-Item`, `rd /s`, `bash -c "…"`, `fs.rmSync(…)` one-liners, and any deletion of `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml` or `bun.lock(b)`. It allows targeted cache clears such as `rm -rf node_modules/.vite`, and commands that only mention these names. The safe alternatives it suggests (`npx cleaninstall-node -y --install`, `--lockfiles` when the user asks) aren't blocked, so the agent always has a sanctioned way forward.

Notes:
- The guard script has no dependencies, so it works even when node_modules is missing or broken, and adds about 30 ms (one Node start-up) to each Bash call.
- If anything goes wrong inside the guard, it allows the command rather than block the agent.
- Turn it off for a session with `CLEANINSTALL_GUARD=off`. Try it on any command with `npx cleaninstall-node agent check <command>`.
- Settings are merged: your permissions and other hooks are kept, and an invalid `settings.json` is left untouched. Everything installed is printed; commit it so your team gets it.
- Claude Code runs project hooks without asking each person to approve them. So review the guard script before you commit it.
- Tested in a real headless Claude Code session (Bash allowed): the hook stopped `rm -rf node_modules` and the agent relayed the reason. Behaviour in `bypassPermissions` mode is up to Claude Code and isn't verified here.

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
