# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
