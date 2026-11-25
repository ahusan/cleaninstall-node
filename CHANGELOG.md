# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.3.1] - 2026-11-25

### Fixed
- **Cleanup exits with code 1 when something couldn't be deleted.** It previously printed "completed successfully" and exited 0, so scripts and CI treated a partial cleanup as success. It now lists what failed, explains why (permission denied, files in use on Windows, or Deno lacking `--allow-write`), skips `--install` on top of a half-cleaned project, and adds an `errors` array (path, code, message) to the programmatic result.
- Under Deno without `--allow-run`, the native-module check reported every addon as "failed to load" (Deno's `spawnSync` returns an empty result when refused). It's now reported as skipped, with the permission it needs.
- `hook install` errors now say what's wrong: "isn't inside a git repository", "git isn't installed", or under Deno "Deno needs --allow-run=git", instead of "Command failed: git rev-parse".
- The MCP server's home-directory guard used `os.homedir()`, which needs `--allow-sys` under Deno, so every MCP tool failed with Deno's default permissions. It now falls back to `HOME`/`USERPROFILE` (covered by `--allow-env`); the guard still refuses the home directory.

### Changed
- Deno docs, the website and llms.txt show least-privilege permissions instead of `-A`: `--allow-read --allow-env` for diagnosis, `--allow-write` and `--allow-run` (optionally `--allow-run=node,deno,npm,pnpm,yarn,bun,git`) for fixes, cleanup and installs. Each set was verified against Deno 2.9.

## [3.3.0] - 2026-11-25

### Added
- **Deno support.** Deno projects (`deno.lock`, `deno.json`/`deno.jsonc`, or `package.json` installed with `deno install`) are detected and fixed with `deno install`. doctor checks `node_modules/.deno` against `deno.lock` (skipping other platforms' optional binaries), checks `npm:` imports in deno.json, reports install scripts Deno skipped (with the `--allow-scripts` command), loads native modules with Deno, and reports legacy (non-Node-API) addons as unsupported by Deno rather than suggesting a rebuild. Native rebuilds remove only that package's folder in `node_modules/.deno` and re-run `deno install --allow-scripts`. `deno.json`-only projects using Deno's global cache are explained instead of reported as "not installed". `--lockfiles` removes `deno.lock`. `--from-error` recognises Deno's frozen-lockfile, legacy-addon and minimum-dependency-age errors (and strips colour codes). The git hook reacts to deno.lock/deno.json changes; the agent guard blocks deleting deno.lock and runs under Deno on machines without Node.
- The CLI runs under Deno (`deno run -A npm:cleaninstall-node …`).

### Changed
- **Fewer dependencies: 36 → 13 packages installed.** `execa` (and its ~20 dependencies) replaced with a small built-in runner using `child_process`. This also fixes the npm page's "Check bundle size" (Bundlephobia failed to build execa's `unicorn-magic` dependency) and loading the programmatic API on Node 20 before 20.19, which couldn't `require()` the ESM-only execa.
- `commander` 11 → 14 (latest that supports Node 20), `js-yaml` 4 → 5.
- The Claude Code guard is installed as `.claude/hooks/cleaninstall-guard.cjs` so Node and Deno both run it; the 3.2.0 `.js` copy and hook entry are migrated.

### Fixed
- Running under Deno, the native module check used Deno to imitate Node and misreported every addon as "failed to load". It now uses the real `node` (skipping Deno's `node` stand-in on PATH), or skips the check with a clear message when Node isn't installed.
- Native modules installed only as transitive dependencies in Deno's `node_modules/.deno` store were not checked.

## [3.2.0] - 2026-11-25

### Added
- **`cleaninstall-node agent install`**: sets up AI coding agents to diagnose broken installs instead of deleting them. Adds a "diagnose before deleting" section to `AGENTS.md` and `CLAUDE.md` (creating a CLAUDE.md that imports AGENTS.md when there is none, since Claude Code ignores AGENTS.md once CLAUDE.md exists), plus Copilot instructions and a Cursor rule when those are already set up. Adds a Claude Code **PreToolUse hook** that blocks (or with `--ask`, asks about) Bash commands deleting `node_modules` or lockfiles (`rm -rf`, `rimraf`, `find -exec rm`/`-delete`/`xargs rm`, `git clean -x`, PowerShell/cmd, `bash -c`, `fs.rmSync`) and tells the agent to run `doctor --from-error` or the safe `cleaninstall-node -y --install`. `agent uninstall` removes only what it added; `agent check <command>` tests the guard. Settings are merged without losing existing permissions or hooks; an invalid settings.json is never overwritten.
- **`llms.txt`** on the website, summarising the tool and its commands for AI assistants.

## [3.1.0] - 2026-11-25

### Added
- **MCP server: `cleaninstall-node mcp`** for AI coding agents (Claude Code, Cursor, VS Code, Windsurf, Claude Desktop). Tools: `explain_error`, `diagnose`, `apply_fix`, `plan_clean`, `clean`. Mutating tools require the `plan_id` of a preceding read-only call and refuse if the plan changed; tools refuse `/`, the home directory and folders without `package.json`; install/rebuild output is captured and returned; progress notifications are sent. No new runtime dependencies (stdio JSON-RPC implemented directly; tested with the official MCP SDK client and checked against Claude Code).
- **`doctor --from-error`**: paste or pipe an error message and get what it means for this project, plus the fix (merged into doctor's plan, `--fix` applies it). Recognises native module ABI/platform errors, missing platform binaries (rollup, esbuild, sharp, swc), module-not-found from Node/Vite/webpack/Next.js/TypeScript (answered differently depending on whether the package is declared, installed, phantom, out of range, a local file or a built-in), command not found, `ERR_REQUIRE_ESM`, `ERR_PACKAGE_PATH_NOT_EXPORTED`, out-of-sync lockfiles (npm/pnpm/yarn/bun), `ERESOLVE` peer conflicts, engine errors, Corepack/`workspace:` package-manager mismatches, interrupted installs, `EINTEGRITY`, `EACCES`, disk-full vs. file-watcher `ENOSPC`, and node-gyp build failures. Tested against real npm, pnpm, yarn and Node output.

### Fixed
- Release workflow: the GitHub Release step (`softprops/action-gh-release`) upgraded to v2 after v1 failed on an empty API response.
- Website workflow: deploy runs in its own job after the upload, fixing "No artifacts named github-pages were found".

## [3.0.1] - 2026-11-25

### Fixed
- Installing printed `npm warn deprecated glob@11.1.0`. Upgraded `glob` to 14, which isn't deprecated and still supports Node.js 20.
- The npm publish workflow broke when npm 12 (which dropped Node.js 20) became `latest`; releases now run on Node.js 24 with npm pinned to 11.

### Changed
- The website (https://cleaninstall-node.ahusan.dev/) shows a link preview in chat apps and social media, and is now the package `homepage`.

## [3.0.0] - 2026-11-25

### Breaking
- **Lockfiles are no longer removed by default.** Use `--lockfiles` (CLI) or `removeLockfiles: true` (config/API) to remove them.
- **The CLI asks for confirmation** before deleting when run in a terminal. Use `-y`/`--yes` to skip. Non-TTY runs (CI, pipes) and the programmatic API don't prompt.
- Requires Node.js 20+ (already required in practice by `glob` 11).

### Fixed
- Files matching a directory pattern (e.g. a script named `build`) were deleted, and directories matching a file pattern were attempted with `unlink`. Matches are now type-checked.
- `installCommand` from config was ignored.
- `--skip-git` could not be turned off; added `--no-skip-git`.
- Workspace exclusion patterns (`!packages/foo`) were ignored.
- Items inside an already-targeted directory were counted twice.
- Symlinks are no longer followed when measuring size (pnpm over-counting).
- Removed stray `DEBUG:` console output.

### Added
- **`cleaninstall-node doctor`**: diagnoses why an install is broken (Node version vs `.nvmrc`/`engines`, node_modules out of sync with the lockfile for npm/pnpm/yarn, missing or out-of-range dependencies, native modules built for another Node ABI or platform, node_modules written by a different package manager, multiple lockfiles, pnpm ignored builds) and with `--fix` applies the smallest fix: targeted `rebuild`, `install`, or a clean reinstall. `--json` for CI; exits 1 on errors.
- **`cleaninstall-node hook install`**: `post-checkout`, `post-merge` and `post-rewrite` hooks that notice when a branch switch, pull or rebase changed dependency files and `node_modules` is now stale, then warn with the exact command (default) or run the install/targeted rebuild (`--mode install`). Silent and fast when nothing relevant changed; uses `.husky/` when husky is set up; keeps existing hook content; skipped in CI.
- Bun support: `bun.lock` / `bun.lockb` detection and `bun install`.
- `packageManager` field (Corepack) is used for package manager detection.
- `cleanup()` now resolves to a result object (`removed`, `skipped`, `failed`, `totalSize`, ...).
- Real-filesystem behaviour tests replacing assertion-less placeholders.

## [2.2.2] - 2025-12-16

### Fixed
- Fixed cross-platform path format handling in tests
- Fixed stats object return in early exit cases
- Added GitHub Release automation to workflow

## [2.2.0] - 2025-12-16

### Added

- **Summary Statistics**: Now displays cleanup summary including items removed, file count, space freed (in MB/GB), and execution time
- **Expanded Framework Support**: Added default cleaning for 9 additional build directories:
  - `.cache` (Parcel, Gatsby)
  - `.nuxt` (Nuxt.js 2)
  - `.output` (Nuxt 3/Nitro)
  - `out` (Next.js static export)
  - `.vite` (Vite cache)
  - `.astro` (Astro cache)
  - `.svelte-kit` (SvelteKit)
  - `coverage` (Test coverage)
  - `.nyc_output` (NYC coverage)
- **Documentation Improvements**:
  - Added npm badges (version, downloads, license, CI) to README
  - Created comprehensive CHANGELOG.md with full version history
  - Added CONTRIBUTING.md with development guidelines
  - Created GitHub issue templates (bug report, feature request)
  - Added pull request template
  - Added "Why CleanInstall Node?" comparison section
  - Added "Quick Start" and "Common Use Cases" sections
- **Enhanced Discoverability**: Expanded npm keywords from 5 to 20 (added: clean, fresh-install, reinstall, workspace, turborepo, nx, pnpm, yarn, npm, lockfile, build-artifacts, disk-space, maintenance, dev-tools, cli)
- Added author information to package.json

### Changed

- Improved README organization and marketing presentation
- Updated configuration table to reflect new default directories

### Fixed

- Fixed test script command in package.json

## [2.1.5] - 2024-12-16

### Changed

- Updated GitHub Actions workflow for better release automation
- Fixed GitHub Packages publishing configuration

## [2.1.4] - 2024-12-16

### Fixed

- npm authentication issues in CI/CD pipeline

## [2.1.3] - 2024-12-16

### Fixed

- Release workflow improvements

## [2.1.2] - 2024-12-16

### Changed

- Updated GitHub Actions configuration

## [2.1.1] - 2024-12-16

### Added

- Initial implementation of workspace-aware cleaning
- Support for glob patterns in file/directory matching
- Auto-detection of workspaces from `package.json` and `pnpm-workspace.yaml`

## [2.0.2] - 2024-12-16

### Changed

- Improved error handling
- Enhanced verbose output

## [2.0.1] - 2024-12-16

### Fixed

- Bug fixes and stability improvements

## [2.0.0] - 2024-12-16

### Added

- **Dry Run Mode** (`--dry-run`): Preview what would be deleted without actually removing anything
- **Interactive Mode** (`-i`, `--interactive`): Confirm each deletion individually
- **Auto-Install** (`--install`): Automatically run package manager install after cleanup
- **Workspace Detection**: Automatic detection of npm/pnpm/yarn workspaces
- **Glob Pattern Support**: Use glob patterns for flexible file/directory matching
- Package manager auto-detection (npm, yarn, pnpm)

### Changed

- Major refactoring to support new features
- Improved configuration handling
- Better error messages and logging

### Dependencies

- Added `execa` for running external commands
- Added `glob` for pattern matching
- Added `js-yaml` for pnpm-workspace.yaml parsing
- Updated `commander` to v11.1.0

## [1.0.2] - 2024-03-12

### Fixed

- Minor bug fixes
- Improved documentation

## [1.0.1] - 2024-03-12

### Changed

- Updated README with better examples
- Improved error handling

## [1.0.0] - 2024-03-12

### Added

- Initial release
- Basic cleanup functionality for Node.js projects
- Support for cleaning `node_modules`, lock files, and build artifacts
- Basic monorepo support (apps/, packages/ directories)
- Configuration via `package.json` or `.cleaninstallnoderc`
- Command-line interface with options for directory, verbosity, and scan depth
- MIT License

### Features

- Clean specified directories and files
- Configurable scan depth for nested projects
- Skip specific directories (e.g., `.git`)
- Verbose output option

[2.2.2]: https://github.com/ahusan/cleaninstall-node/compare/v2.2.0...v2.2.2
[2.2.0]: https://github.com/ahusan/cleaninstall-node/compare/v2.1.5...v2.2.0
[2.1.5]: https://github.com/ahusan/cleaninstall-node/compare/v2.1.4...v2.1.5
[2.1.4]: https://github.com/ahusan/cleaninstall-node/compare/v2.1.3...v2.1.4
[2.1.3]: https://github.com/ahusan/cleaninstall-node/compare/v2.1.2...v2.1.3
[2.1.2]: https://github.com/ahusan/cleaninstall-node/compare/v2.1.1...v2.1.2
[2.1.1]: https://github.com/ahusan/cleaninstall-node/compare/v2.0.2...v2.1.1
[2.0.2]: https://github.com/ahusan/cleaninstall-node/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/ahusan/cleaninstall-node/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/ahusan/cleaninstall-node/compare/v1.0.2...v2.0.0
[1.0.2]: https://github.com/ahusan/cleaninstall-node/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/ahusan/cleaninstall-node/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/ahusan/cleaninstall-node/releases/tag/v1.0.0
