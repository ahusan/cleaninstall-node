# Node Cleanup

A utility to clean up Node.js project files like node_modules, lock files, and build artifacts.

## Installation

### Global Installation

```bash
npm install -g node-cleanup
```

### Local Installation

```bash
npm install --save-dev node-cleanup
```

## Usage

### Command Line

After installing globally, you can run:

```bash
node-cleanup
```

Or if installed locally:

```bash
npx node-cleanup
```

#### Options

```
Usage: node-cleanup [options]

A utility to clean up Node.js project files

Options:
  -V, --version           output the version number
  -d, --dir <directory>   specify the root directory to clean (defaults to current directory)
  -v, --verbose           print verbose output (default: true)
  --no-verbose            disable verbose output
  --depth <number>        how deep to scan for workspaces
  --skip-git              skip .git directories (default: true)
  -h, --help              display help for command
```

### Programmatic Usage

You can also use Node Cleanup programmatically in your Node.js scripts:

```javascript
const { cleanup } = require("node-cleanup");

// With default options
cleanup()
  .then(() => {
    console.log("Cleanup completed!");
  })
  .catch((err) => {
    console.error("Error during cleanup:", err);
  });

// With custom options
cleanup({
  dir: "/path/to/project",
  dirsToRemove: ["node_modules", "dist", "coverage"],
  filesToRemove: ["package-lock.json"],
  verbose: true,
  scanDepth: 3,
}).then(() => {
  console.log("Custom cleanup completed!");
});
```

## Configuration

You can configure Node Cleanup using one of these methods:

### 1. Command Line Options

See the options section above.

### 2. Package.json Configuration

Add a `nodeCleanup` section to your package.json:

```json
{
  "name": "your-project",
  "version": "1.0.0",
  "nodeCleanup": {
    "dirsToRemove": ["node_modules", "dist", "build"],
    "filesToRemove": ["package-lock.json", "yarn.lock"],
    "scanDepth": 2,
    "skipDirs": [".git", "docs"]
  }
}
```

### 3. .nodecleanuprc File

Create a `.nodecleanuprc` file in your project root:

```json
{
  "dirsToRemove": ["node_modules", "dist", "build"],
  "filesToRemove": ["package-lock.json", "yarn.lock"],
  "scanDepth": 2,
  "skipDirs": [".git", "docs"]
}
```

### 4. Programmatic Options

Pass options directly to the `cleanup()` function as shown in the Programmatic Usage section.

## Configuration Options

| Option          | Type     | Default                                                | Description                                                                      |
| --------------- | -------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `dirsToRemove`  | string[] | `["node_modules", ".next", ".turbo", "dist", "build"]` | Directories to remove                                                            |
| `filesToRemove` | string[] | `["pnpm-lock.yaml", "yarn.lock", "package-lock.json"]` | Files to remove                                                                  |
| `scanDepth`     | number   | `2`                                                    | How deep to scan for workspaces (1 = only root, 2 = one level of subdirectories) |
| `skipDirs`      | string[] | `[".git"]`                                             | Directories to skip                                                              |
| `verbose`       | boolean  | `true`                                                 | Whether to print verbose output                                                  |
| `cleanMonorepo` | boolean  | `true`                                                 | Whether to clean monorepo directories (apps/, packages/)                         |

## Development

### Testing

This project uses Jest for testing. To run the tests:

```bash
npm test
```

The tests use mock-fs to simulate file system operations without actually modifying your file system.

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
