# Contributing to CleanInstall Node

First off, thank you for considering contributing to CleanInstall Node! It's people like you that make this tool better for everyone.

## Code of Conduct

This project and everyone participating in it is governed by a respectful and inclusive environment. By participating, you are expected to uphold this standard. Please report unacceptable behavior to the project maintainers.

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the existing issues to avoid duplicates. When you create a bug report, include as many details as possible:

* Use a clear and descriptive title
* Describe the exact steps to reproduce the problem
* Provide specific examples to demonstrate the steps
* Describe the behavior you observed and what you expected
* Include your environment details (OS, Node.js version, package manager)
* Include any relevant configuration files or command output

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) when creating an issue.

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion:

* Use a clear and descriptive title
* Provide a detailed description of the suggested enhancement
* Explain why this enhancement would be useful
* List any examples of how it would work

Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md) when suggesting features.

### Pull Requests

1. **Fork the repository** and create your branch from `main`
   ```bash
   git checkout -b feature/amazing-feature
   ```

2. **Make your changes** following the coding guidelines below

3. **Test your changes thoroughly**
   ```bash
   npm test
   ```

4. **Update documentation** if needed (README.md, CHANGELOG.md)

5. **Commit your changes** with a clear commit message
   ```bash
   git commit -m "Add amazing feature: brief description"
   ```

6. **Push to your fork**
   ```bash
   git push origin feature/amazing-feature
   ```

7. **Open a Pull Request** using the PR template

## Development Setup

### Prerequisites

* Node.js >= 12.0.0
* npm, yarn, or pnpm

### Setup Steps

1. Clone your fork:
   ```bash
   git clone https://github.com/YOUR-USERNAME/cleaninstall-node.git
   cd cleaninstall-node
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Make your changes in a new git branch

4. Test your changes:
   ```bash
   npm test
   ```

### Running Locally

To test the CLI locally:

```bash
# Link the package locally
npm link

# Run it in any directory
cleaninstall-node --dry-run

# Or run directly with node
node bin/cleanup.js --dry-run
```

## Coding Guidelines

### JavaScript Style

* Use ES6+ features where appropriate
* Follow the existing code style (use 2 spaces for indentation)
* Add comments for complex logic
* Keep functions focused and small
* Use meaningful variable and function names

### Commits

* Use the present tense ("Add feature" not "Added feature")
* Use the imperative mood ("Move cursor to..." not "Moves cursor to...")
* Limit the first line to 72 characters or less
* Reference issues and pull requests after the first line

### Testing

* Write tests for new features
* Ensure existing tests pass
* Use descriptive test names
* Test edge cases and error conditions

Example test structure:
```javascript
describe('Feature Name', () => {
  test('should do something specific', () => {
    // Test implementation
  });
});
```

## Project Structure

```
cleaninstall-node/
├── bin/
│   └── cleanup.js       # CLI entry point and main logic
├── index.js             # Programmatic API wrapper
├── tests/               # Test files
│   └── cli.test.js
├── .github/             # GitHub templates and workflows
├── README.md            # Main documentation
├── CHANGELOG.md         # Version history
└── package.json         # Package configuration
```

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run tests with coverage
npm test -- --coverage
```

### Writing Tests

Tests use Jest. When adding new functionality:

1. Add tests in the `tests/` directory
2. Use mock-fs for file system operations
3. Test both success and error cases
4. Test with different configurations

## Release Process

The project uses automated releases via GitHub Actions:

1. Update version in `package.json`
2. Update `CHANGELOG.md` with changes
3. Commit changes
4. Push to `main` branch
5. GitHub Actions will automatically publish to npm if tests pass

Version numbering follows [Semantic Versioning](https://semver.org/):
* MAJOR version for incompatible API changes
* MINOR version for new functionality in a backwards compatible manner
* PATCH version for backwards compatible bug fixes

## Documentation

### README Updates

When adding features, update the README.md:
* Add new options to the Options section
* Update examples if needed
* Update the feature list
* Keep the table of contents current

### CHANGELOG Updates

Follow the format in CHANGELOG.md:
* Add entries under "Unreleased" section
* Use categories: Added, Changed, Deprecated, Removed, Fixed, Security
* Link to related issues and PRs

## Questions?

Feel free to:
* Open an issue for questions
* Start a discussion on GitHub Discussions
* Reach out to the maintainers

## Recognition

Contributors will be recognized in the project documentation. Thank you for your contributions!

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
