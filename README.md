# CleanInstall Node

[![npm version](https://badge.fury.io/js/cleaninstall-node.svg)](https://www.npmjs.com/package/cleaninstall-node)
[![Downloads](https://img.shields.io/npm/dm/cleaninstall-node.svg)](https://www.npmjs.com/package/cleaninstall-node)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/ahusan/cleaninstall-node/workflows/Node.js%20CI/badge.svg)](https://github.com/ahusan/cleaninstall-node/actions)

A powerful, workspace-aware utility to clean up Node.js project files like `node_modules`, lock files, build artifacts, and more. Perfect for monorepos and single projects alike.

## Features

- Removes common clutter (`node_modules`, build output, etc.)
- **Workspace Aware:** Automatically detects workspaces defined in `package.json` or `pnpm-workspace.yaml`.
- **Glob Pattern Support:** Use glob patterns (e.g., `*.log`, `dist-*`) in configuration for flexible matching.
- **Dry Run Mode:** See what would be deleted without actually removing anything.
- **Interactive Mode:** Confirm each deletion individually.
- **Auto-Install:** Automatically run `npm install`, `yarn install`, or `pnpm install` after cleanup.
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

# Preview what would be deleted (dry run)
npx cleaninstall-node --dry-run

# Interactive mode - confirm each deletion
npx cleaninstall-node -i
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
  -V, --version           output the version number
  -d, --dir <directory>   specify the root directory to clean (defaults to current directory)
  -v, --verbose           print verbose output (default: true)
  --no-verbose            disable verbose output
  --depth <number>        how deep to scan for workspaces (used as fallback if no workspace patterns found)
  --skip-git              skip .git directories (default: true)
  --dry-run               show what would be deleted without actually deleting (default: false)
  -i, --interactive       prompt before deleting each item (default: false)
  --install               automatically run install command after cleanup (default: false)
  -h, --help              display help for command
```

#### Common Use Cases

```bash
# Clean a monorepo and reinstall all dependencies
npx cleaninstall-node --install

# Remove only lock files, keep node_modules
npx cleaninstall-node --dry-run  # preview first

# Clean before committing to save disk space
npx cleaninstall-node

# Add to package.json scripts for convenience
{
  "scripts": {
    "clean": "cleaninstall-node",
    "fresh": "cleaninstall-node --install",
    "clean:preview": "cleaninstall-node --dry-run"
  }
}
```

### Programmatic Usage

_(Note: The programmatic API may not expose all features available via the CLI, such as interactive mode or auto-install.)_

You can use CleanInstall Node programmatically:

```javascript
// Assuming index.js exports a main function or similar
// const { main: cleanup } = require("cleaninstall-node"); // Example import
const { exec } = require("child_process");

// Example: Running the CLI command programmatically
exec(
  "npx cleaninstall-node --dir /path/to/project",
  (error, stdout, stderr) => {
    if (error) {
      console.error(`Error during cleanup: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(`Cleanup stderr: ${stderr}`);
    }
    console.log(`Cleanup stdout: ${stdout}`);
  }
);

// Direct function call (if exposed and suitable)
cleanup({
  dir: "/path/to/project",
  dirsToRemove: ["node_modules", "dist", "coverage"],
  filesToRemove: ["package-lock.json"],
  verbose: true,
  // other options...
})
  .then(() => {
    console.log("Custom cleanup completed!");
  })
  .catch((err) => {
    console.error("Error:", err);
  });
```

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

After a successful cleanup (and if not in dry-run mode), this option automatically detects your package manager based on the presence of `pnpm-lock.yaml`, `yarn.lock`, or `package-lock.json` (defaulting to `npm`). It then runs the corresponding install command (`pnpm install`, `yarn install`, or `npm install`) in the root directory.

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
| `filesToRemove` | string[] | `["pnpm-lock.yaml", "yarn.lock", "package-lock.json"]`                                                                                                             | Files to remove (supports glob patterns). Matched relative to each directory being cleaned.                    |
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
