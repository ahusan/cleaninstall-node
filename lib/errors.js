// Map a pasted error message to what it means for the project and the fix.
// Used by `doctor --from-error`. Every signature here is tested against the
// real (or documented) output of npm, pnpm, yarn, bun, Node and bundlers in
// tests/fixtures/errors.
const fs = require("fs");
const path = require("path");
const { builtinModules } = require("module");
const semver = require("semver");
const { readJson } = require("./project");

// NODE_MODULE_VERSION -> Node major, for readable ABI messages.
const ABI_TO_NODE = {
  93: 16, 102: 17, 108: 18, 111: 19, 115: 20, 120: 21, 127: 22, 131: 23, 137: 24, 141: 25,
};
const nodeForAbi = (abi) => (ABI_TO_NODE[abi] ? `Node ${ABI_TO_NODE[abi]}` : `ABI ${abi}`);

// Common CLI commands and the package that provides them.
const KNOWN_BINS = {
  tsc: "typescript", tsserver: "typescript", next: "next", vite: "vite", vitest: "vitest",
  "react-scripts": "react-scripts", nodemon: "nodemon", jest: "jest", eslint: "eslint",
  prettier: "prettier", tsx: "tsx", "ts-node": "ts-node", nuxt: "nuxt", nuxi: "nuxi",
  astro: "astro", webpack: "webpack-cli", "webpack-cli": "webpack-cli", turbo: "turbo",
  nx: "nx", playwright: "@playwright/test", prisma: "prisma", expo: "expo",
  "svelte-kit": "@sveltejs/kit", remix: "@remix-run/dev", ng: "@angular/cli",
  "vue-cli-service": "@vue/cli-service", concurrently: "concurrently", "cross-env": "cross-env",
  rimraf: "rimraf", husky: "husky", "lint-staged": "lint-staged", tailwindcss: "tailwindcss",
  esbuild: "esbuild", rollup: "rollup", parcel: "parcel", gatsby: "gatsby-cli",
  electron: "electron", storybook: "storybook", "drizzle-kit": "drizzle-kit", wrangler: "wrangler",
};
const TOOLCHAIN_BINS = new Set(["node", "npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx", "corepack"]);

// Native binaries shipped as per-platform optional dependencies.
const PLATFORM_PKG = /(?:^|[-.])(linux|darwin|win32|freebsd|android|openbsd|sunos|aix)[-.](x64|arm64|ia32|arm|ppc64|s390x|riscv64|loong64|mips64el)\b/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function packageFromPath(p) {
  const norm = String(p).replace(/\\/g, "/");
  const idx = norm.lastIndexOf("node_modules/");
  if (idx === -1) return null;
  const parts = norm.slice(idx + "node_modules/".length).split("/");
  if (!parts[0]) return null;
  return parts[0].startsWith("@") && parts[1] ? `${parts[0]}/${parts[1]}` : parts[0];
}

function packageFromSpecifier(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function isBuiltin(spec) {
  const bare = spec.replace(/^node:/, "").split("/")[0];
  return spec.startsWith("node:") || builtinModules.includes(bare);
}

function isLocalPath(spec) {
  return /^(\.{1,2}\/|\/|[a-zA-Z]:[\\/]|file:)/.test(spec) || spec === "." || spec === "..";
}

function addCommand(pm, name, dev = false) {
  if (pm === "npm") return `npm install ${dev ? "-D " : ""}${name}`;
  if (pm === "deno") return `deno add ${dev ? "-D " : ""}npm:${name}`;
  if (pm === "bun") return `bun add ${dev ? "-d " : ""}${name}`;
  return `${pm} add ${dev ? "-D " : ""}${name}`; // pnpm, yarn
}

function installCommand(pm) {
  return `${pm} install`;
}

// Every dependency name declared by the root and workspace packages.
function declaredDependencies(rootDir, workspaceDirs) {
  const declared = new Map(); // name -> { range, type, where }
  for (const dir of [rootDir, ...workspaceDirs]) {
    const pkg = readJson(path.join(dir, "package.json"));
    if (!pkg) continue;
    for (const type of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, range] of Object.entries(pkg[type] || {})) {
        if (!declared.has(name)) declared.set(name, { range, type, where: dir });
      }
    }
  }
  return declared;
}

function installedManifest(rootDir, name, fromDir = rootDir) {
  let dir = fromDir;
  for (;;) {
    const p = path.join(dir, "node_modules", name, "package.json");
    if (fs.existsSync(p)) return { dir: path.dirname(p), manifest: readJson(p) || {} };
    if (dir === rootDir || path.dirname(dir) === dir) return null;
    dir = path.dirname(dir);
  }
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

// ---------------------------------------------------------------------------
// Signatures: each returns zero or more matches for the text.
// ---------------------------------------------------------------------------

const SIGNATURES = [
  {
    id: "deno-legacy-addon",
    suppresses: ["native-platform"],
    match(text) {
      const m = text.match(/Cannot load native addon at (\S+?\.node): it was built against the legacy Node\.js native addon API/);
      if (!m && !/Only Node-API \(N-API\) addons are supported/.test(text)) return null;
      const pkg = m ? packageFromPath(m[1]) : null;
      return {
        title: `${pkg || "A native module"} uses the legacy addon API, which Deno can't load`,
        explanation: [
          `${pkg || "This package"} was built with the older NODE_MODULE / nan addon API. Deno only supports Node-API (N-API) addons, so rebuilding won't help.`,
        ],
        packages: pkg ? [pkg] : [],
        manual: [
          pkg ? `Use a version of ${pkg} built with Node-API (often a newer release), or an alternative package` : "Use a Node-API build of the package",
          "Or run this project with Node.js instead of Deno",
        ],
      };
    },
  },
  {
    id: "deno-min-dependency-age",
    suppresses: ["module-not-found", "deno-version-not-found"],
    match(text) {
      if (!/minimum dependency (age|date)|blocked by the minimum dependency age policy/.test(text)) return null;
      const m = text.match(/Could not find npm package '([^']+)' matching '([^']+)'/);
      return {
        title: `Deno is holding back ${m ? `${m[1]}@${m[2]}` : "a package version"}: it was published less than a day ago`,
        explanation: [
          "Deno 2.9+ won't install npm versions newer than its minimum dependency age (24 hours by default), to reduce supply-chain risk.",
        ],
        packages: m ? [m[1]] : [],
        manual: [
          "Wait until the version is a day old",
          "Or allow it: pass --minimum-dependency-age=0 (or a shorter duration), or set \"minimumDependencyAge\" in deno.json",
        ],
      };
    },
  },
  {
    id: "deno-not-a-dependency",
    suppresses: ["module-not-found"],
    match(text) {
      const m = text.match(/Import "([^"]+)" not a dependency/);
      if (!m) return null;
      const hint = text.match(/try running `(deno add [^`]+)`/);
      return {
        title: `"${m[1]}" isn't in deno.json's imports`,
        explanation: [
          `Deno resolves bare imports like "${m[1]}" only through the "imports" map in deno.json (or package.json dependencies). Nothing maps "${m[1]}" yet.`,
        ],
        packages: [m[1]],
        manual: [
          hint ? `Add it: ${hint[1]}` : `Add it: deno add npm:${m[1]} (or deno add jsr:@scope/${m[1]} for a JSR package)`,
          "Or import it with a full specifier: npm:… or jsr:…",
        ],
      };
    },
  },
  {
    id: "deno-version-not-found",
    match(text) {
      let m = text.match(/Could not find version of '([^']+)' that matches specified version constraint '([^']+)'/);
      let registry = "jsr";
      if (!m) {
        m = text.match(/Could not find npm package '([^']+)' matching '([^']+)'/);
        registry = "npm";
      }
      if (!m) return null;
      const [, name, range] = m;
      return {
        title: `No published version of ${name} matches ${range}`,
        explanation: [`The ${registry === "jsr" ? "JSR" : "npm"} registry has ${name}, but no version satisfies ${range}. Usually a typo in the version, or a range copied from a newer release than exists.`],
        packages: [name],
        manual: [
          registry === "jsr" ? `Check the published versions at https://jsr.io/${name}` : `Check the published versions: npm view ${name} versions`,
          "Then fix the range in deno.json (or the import), or run: deno outdated",
        ],
      };
    },
  },
  {
    id: "deno-jsr-not-found",
    match(text) {
      const m = text.match(/JSR package not found: (\S+)/);
      if (!m) return null;
      return {
        title: `${m[1]} doesn't exist on JSR`,
        explanation: ["The JSR registry has no package with that name: usually a typo in the scope or name, or a package that was never published to JSR (it may be on npm instead)."],
        packages: [m[1]],
        manual: ["Check the name at https://jsr.io; if it isn't there, it may be on npm under another name (then: deno add npm:<name>)"],
      };
    },
  },
  {
    id: "deno-integrity",
    match(text) {
      const jsr = text.match(/Integrity check failed for package[\s\S]*?Package: (\S+)/);
      const npm = text.match(/Tarball checksum did not match what was provided by npm registry for (\S+?)\.?\n/);
      if (!jsr && !npm && !/Integrity check failed/.test(text)) return null;
      const pkg = (jsr && jsr[1]) || (npm && npm[1]) || "a package";
      return {
        title: `${pkg} doesn't match the checksum in deno.lock`,
        explanation: [
          "What Deno downloaded (or has cached) differs from the hash recorded in deno.lock. Either the cached copy is corrupt, or the lockfile entry is wrong (hand-edited, or mangled by a merge conflict).",
        ],
        packages: [pkg.replace(/@[^@/]+$/, "")],
        manual: [
          "First re-download it: deno cache --reload <your entry file> (or deno install --reload)",
          "If it still fails, deno.lock is wrong: restore it from git, or regenerate it (delete deno.lock, run deno install) and review the diff before committing",
        ],
      };
    },
  },
  {
    id: "deno-lockfile-version",
    match(text) {
      const m = text.match(/Unsupported lockfile version '([^']+)'/);
      if (!m) return null;
      return {
        title: `deno.lock (version ${m[1]}) was written by a newer Deno`,
        explanation: ["Your Deno is older than the one that last wrote deno.lock, so it can't read the lockfile format."],
        manual: ["Upgrade Deno: deno upgrade (and agree on a Deno version with your team, e.g. in CI)"],
      };
    },
  },
  {
    id: "deno-permission",
    match(text) {
      const m = text.match(/Requires (\w+) access to "?([^",]*?)"?, run again with the (--allow-[\w-]+) flag/);
      if (!m) return null;
      const [, kind, target, flag] = m;
      return {
        title: `The program needs ${flag}${target ? ` for ${target}` : ""}`,
        explanation: [
          `Deno is secure by default: code can't use ${kind} access unless you grant it. This isn't an install problem.`,
        ],
        manual: [
          target ? `Grant just that: ${flag}=${target}` : `Grant it: ${flag}`,
          "Or add the flag to the task in deno.json; avoid -A unless you trust all the code",
        ],
      };
    },
  },
  {
    id: "deno-config-invalid",
    match(text) {
      const m = text.match(/Failed (?:deserializing|to parse) config file '([^']+)'[\s\S]*?Caused by:\s*\n\s*([^\n]+)/);
      if (!m) return null;
      const file = m[1].replace(/^file:\/\//, "");
      return {
        title: `${path.basename(file)} isn't valid JSON`,
        explanation: [`Deno couldn't read ${file}: ${m[2].trim()}.`],
        manual: [`Fix the syntax in ${path.basename(file)} (deno.jsonc allows comments and trailing commas; deno.json doesn't)`],
      };
    },
  },
  {
    id: "deno-workspace-missing",
    match(text) {
      const m = text.match(/Workspace member "([^"]+)" not found/);
      if (!m) return null;
      return {
        title: `Workspace member ${m[1]} doesn't exist`,
        explanation: ["deno.json lists a workspace member folder that isn't there. Deno skips it, so its code and dependencies are silently left out."],
        manual: ["Fix the \"workspace\" list in deno.json (or restore the folder)"],
      };
    },
  },
  {
    id: "native-abi",
    match(text) {
      const abi = text.match(/NODE_MODULE_VERSION (\d+)\.[\s\S]*?requires\s+NODE_MODULE_VERSION (\d+)/);
      if (!abi) return null;
      const mod = text.match(/The module '([^']+)'/);
      const pkg = mod ? packageFromPath(mod[1]) : null;
      const built = Number(abi[1]);
      const needed = Number(abi[2]);
      return {
        title: "A native module was built for a different Node version",
        explanation: [
          `${pkg || "A native module"} was compiled for ${nodeForAbi(built)} (ABI ${built}), but the Node that loaded it is ${nodeForAbi(needed)} (ABI ${needed}).`,
          "This happens after switching Node versions (nvm, Volta, a Docker image update) without rebuilding.",
        ],
        packages: pkg ? [pkg] : [],
        fix: pkg ? { kind: "rebuild", packages: [pkg] } : { kind: "install" },
      };
    },
  },
  {
    id: "native-platform",
    match(text) {
      const m =
        text.match(/([^\s'"]+\.node)['"]?:\s*(invalid ELF header|wrong ELF class[^\n]*|[^\n]*not a mach-o file[^\n]*|[^\n]*incompatible architecture[^\n]*)/i) ||
        text.match(/([^\s'"]+\.node)[^\n]*is not a valid Win32 application/i);
      if (!m) return null;
      const pkg = packageFromPath(m[1]);
      return {
        title: "A native module was built for a different OS or CPU",
        explanation: [
          `${pkg || "A native module"}'s compiled binary is for another platform (${m[2] ? m[2].trim() : "wrong binary format"}).`,
          "Usually node_modules was installed on the host (e.g. macOS) and reused in a Linux container, or across Apple Silicon/Rosetta.",
          "Don't share node_modules between host and container: install inside the container, or mount node_modules as a separate volume.",
        ],
        packages: pkg ? [pkg] : [],
        fix: pkg ? { kind: "rebuild", packages: [pkg] } : { kind: "reinstall" },
      };
    },
  },
  {
    id: "platform-binary-missing",
    suppresses: ["module-not-found"],
    match(text) {
      let pkg = null;
      let needed = null;
      let m;
      if ((m = text.match(/Cannot find module (@rollup\/rollup-[\w-]+)/))) {
        pkg = "rollup";
        needed = m[1];
      } else if ((m = text.match(/The package "(@esbuild\/[\w-]+)" could not be found, and is needed by esbuild/))) {
        pkg = "esbuild";
        needed = m[1];
      } else if (/You installed esbuild for another platform/.test(text)) {
        pkg = "esbuild";
        m = text.match(/needs the "(@esbuild\/[\w-]+)" package/);
        needed = m ? m[1] : null;
      } else if ((m = text.match(/Could not load the "sharp" module using the ([\w-]+) runtime/))) {
        pkg = "sharp";
        needed = `@img/sharp-${m[1]}`;
      } else {
        // Generic: Cannot find module '<something-linux-x64...>'
        const all = [...text.matchAll(/Cannot find (?:module|package) '([^']+)'/g)].map((x) => x[1]);
        const platformSpec = all.find((s) => !isLocalPath(s) && PLATFORM_PKG.test(s));
        if (!platformSpec) return null;
        needed = packageFromSpecifier(platformSpec);
        pkg = needed.replace(/[-.](linux|darwin|win32|freebsd|android)[-.].*$/, "");
      }
      return {
        title: `${pkg} is missing its native binary for this platform`,
        explanation: [
          `${pkg} ships its compiled code as a separate package per OS/CPU${needed ? ` (here: ${needed})` : ""}, installed as an optional dependency. That package isn't installed.`,
          "Common causes: node_modules or the lockfile came from another OS (macOS → Docker/CI), optional dependencies were skipped (--omit=optional), or npm's optional-dependency bug (npm/cli#4828).",
        ],
        packages: [pkg],
        fix: { kind: "reinstall" },
        manual: [
          "If it still fails after reinstalling, the lockfile was generated without this platform's entry: run `npx cleaninstall-node --lockfiles --install` once and commit the new lockfile",
        ],
      };
    },
  },
  {
    id: "require-esm",
    match(text) {
      if (!/ERR_REQUIRE_ESM|require\(\) of ES Module/.test(text)) return null;
      const m = text.match(/require\(\) of ES Module (\S+?) from (\S+?) not supported/);
      const pkg = m ? packageFromPath(m[1]) : null;
      return {
        title: `${pkg || "A dependency"} is ESM-only, but your code uses require()`,
        explanation: [
          `The installed version of ${pkg || "this package"} only ships ES modules. CommonJS require() of ES modules is only supported natively from Node 20.19 / 22.12.`,
          "Usually a dependency was upgraded to a new major version (many packages went ESM-only), or the error comes from an older Node in CI.",
        ],
        packages: pkg ? [pkg] : [],
        manual: unique([
          "Run on Node 20.19+ or 22.12+ (they support require() of ES modules)",
          "or load it with `await import()` instead of require()",
          pkg ? `or pin ${pkg} to its last CommonJS major version` : null,
        ]),
      };
    },
  },
  {
    id: "subpath-not-exported",
    match(text) {
      const m = text.match(/Package subpath '([^']+)' is not defined by "exports" in (\S+?package\.json)/);
      if (!m) return null;
      const pkg = packageFromPath(m[2]);
      return {
        title: `${pkg || "A package"} doesn't export '${m[1]}'`,
        explanation: [
          `The code imports ${pkg ? `${pkg}/${m[1].replace(/^\.\//, "")}` : m[1]}, but the installed version only exposes the paths listed in its package.json "exports".`,
          "Usually the installed version is a newer major than the code was written for (deep imports are often removed in majors).",
        ],
        packages: pkg ? [pkg] : [],
        manual: [
          pkg ? `Check the installed version: npm ls ${pkg}` : "Check the installed version of the package",
          "Import from the package's public entry point, or install the version the code was written for",
        ],
        relatedFindings: ["dep-versions", "lockfile-sync"],
      };
    },
  },
  {
    id: "lockfile-out-of-sync",
    match(text) {
      let pm = null;
      let detail = null;
      let m;
      if (/`npm ci` can only install packages when your package\.json and package-lock\.json/.test(text)) {
        pm = "npm";
        m = text.match(/Missing: (\S+) from lock file/);
        detail = m ? `missing from the lockfile: ${m[1]}` : null;
      } else if (/ERR_PNPM_OUTDATED_LOCKFILE/.test(text)) {
        pm = "pnpm";
        m = text.match(/\d+ dependencies were (?:added|removed|changed): ([^\n]+)/);
        detail = m ? m[0].replace(/^\* /, "").trim() : null;
      } else if (/Your lockfile needs to be updated, but yarn was run with `--frozen-lockfile`/.test(text)) {
        pm = "yarn";
      } else if (/YN0028|The lockfile would have been modified by this install, which is explicitly forbidden/.test(text)) {
        pm = "yarn";
      } else if (/lockfile had changes, but lockfile is frozen/.test(text)) {
        pm = "bun";
      } else if (/The lockfile is out of date\. Run `deno install --frozen=false`/.test(text)) {
        pm = "deno";
      } else {
        return null;
      }
      return {
        title: pm === "deno" ? "deno.lock doesn't match deno.json / package.json" : "The lockfile doesn't match package.json",
        explanation: unique([
          "package.json was changed (a dependency added, removed or re-ranged) without updating the lockfile, so a frozen/CI install refuses to continue.",
          detail ? `Detail: ${detail}.` : null,
        ]),
        manual: [
          pm === "deno"
            ? "Run `deno install --frozen=false` locally and commit the updated deno.lock"
            : `Run \`${installCommand(pm)}\` locally and commit the updated lockfile`,
        ],
      };
    },
  },
  {
    id: "peer-conflict",
    match(text) {
      if (!/ERESOLVE/.test(text)) return null;
      const clean = text.replace(/^npm (?:error|ERR!|warn) ?/gm, "");
      const found = clean.match(/Found: (\S+)/);
      const peer = clean.match(/Could not resolve dependency:\s*\n\s*peer (\S+) from (\S+)/);
      const explanation = peer
        ? [`${peer[2]} needs ${peer[1]} as a peer dependency, but the project has ${found ? found[1] : "a different version"}.`]
        : ["Two packages need incompatible versions of a shared (peer) dependency."];
      explanation.push("npm 7+ refuses to install conflicting peer dependencies instead of silently installing a broken tree.");
      return {
        title: "Peer dependency conflict",
        explanation,
        manual: unique([
          peer ? `Make the versions compatible: upgrade/downgrade so ${peer[1]} is satisfied (e.g. npm install ${peer[1].replace(/"/g, "")})` : "Upgrade or downgrade one side so the peer range is satisfied",
          "Last resort: `npm install --legacy-peer-deps` (installs anyway; the conflicting packages may misbehave). Avoid --force",
        ]),
      };
    },
  },
  {
    id: "node-engine",
    match(text) {
      let pkg = null;
      let wanted = null;
      let got = null;
      let m;
      if (/EBADENGINE|Unsupported engine/.test(text)) {
        m = text.match(/Not compatible with your version of node\/npm: (\S+)/);
        pkg = m ? m[1] : null;
        m = text.match(/Required: (\{[^}]*\})/);
        try {
          wanted = m ? JSON.parse(m[1]).node : null;
        } catch {
          wanted = null;
        }
        m = text.match(/Actual:\s+\{[^}]*"node":"([^"]+)"/);
        got = m ? m[1] : null;
      } else if ((m = text.match(/error (\S+): The engine "node" is incompatible with this module\. Expected version "([^"]+)"\. Got "([^"]+)"/))) {
        [, pkg, wanted, got] = m;
      } else if (/ERR_PNPM_UNSUPPORTED_ENGINE/.test(text)) {
        m = text.match(/Your Node version is incompatible with "([^"]+)"/);
        pkg = m ? m[1] : null;
        m = text.match(/Expected version: ([^\n]+)/);
        wanted = m ? m[1].trim() : null;
        m = text.match(/\nGot: (\S+)/);
        got = m ? m[1] : null;
      } else {
        return null;
      }
      if (!wanted && !pkg) return null;
      return {
        title: `${pkg || "A dependency"} needs a different Node version`,
        explanation: [
          `${pkg || "A dependency"} requires Node ${wanted || "(see its engines field)"}${got ? `, but the install ran on ${got.startsWith("v") ? got : `v${got}`}` : ""}.`,
        ],
        packages: pkg ? [pkg.replace(/@[^@/]+$/, "")] : [],
        blocksFix: true,
        manual: [wanted ? `Switch to a Node version matching ${wanted} (and pin it in .nvmrc so everyone uses it)` : "Switch to the Node version the project expects"],
        relatedFindings: ["node-version", "node-engines"],
      };
    },
  },
  {
    id: "wrong-package-manager",
    match(text, ctx) {
      let m;
      if ((m = text.match(/This project is configured to use (\w+)/))) {
        return {
          title: `This project uses ${m[1]}`,
          explanation: [`package.json's "packageManager" field says ${m[1]}, and Corepack refuses to run a different package manager.`],
          manual: [`Use ${m[1]}: \`corepack enable\` then \`${m[1]} install\``],
        };
      }
      if (/EUNSUPPORTEDPROTOCOL/.test(text) && /workspace:/.test(text)) {
        const pm = ctx.packageManager !== "npm" ? ctx.packageManager : "pnpm or yarn";
        return {
          title: "npm can't install `workspace:` dependencies",
          explanation: ["The `workspace:` protocol is a pnpm/yarn/bun feature; this project expects one of those, not npm."],
          manual: [`Install with ${pm} instead of npm`],
        };
      }
      return null;
    },
  },
  {
    id: "corrupted-install",
    match(text) {
      if (
        !/ENOTEMPTY: directory not empty, rename|Cannot read properties of null \(reading '(?:matches|edgesOut)'\)|Tracker "idealTree" already exists|EEXIST: file already exists[^\n]*node_modules/.test(text)
      ) {
        return null;
      }
      return {
        title: "node_modules is in a half-written state",
        explanation: ["An earlier install was interrupted or two installs ran at once, leaving node_modules inconsistent."],
        fix: { kind: "reinstall" },
      };
    },
  },
  {
    id: "integrity",
    match(text, ctx) {
      if (!/EINTEGRITY|integrity checksum failed/.test(text)) return null;
      return {
        title: "A downloaded package didn't match its checksum",
        explanation: [
          "The tarball's hash differs from the one in the lockfile: a corrupted package-manager cache, or a lockfile written against a different registry/mirror.",
        ],
        manual: [
          ctx.packageManager === "npm" ? "Run `npm cache verify`, then reinstall" : `Clear the ${ctx.packageManager} cache, then reinstall`,
          "If it persists, the lockfile entry is wrong for your registry: reinstall that package to refresh its integrity hash",
        ],
      };
    },
  },
  {
    id: "native-build-failed",
    match(text) {
      if (!/gyp ERR!|node-pre-gyp|No prebuilt binaries found/.test(text)) return null;
      const pathMatch = text.match(/npm (?:error|ERR!) path (\S+)/) || text.match(/(\S*node_modules\/\S+)/);
      const pkg = pathMatch ? packageFromPath(pathMatch[1]) : null;
      const target = text.match(/No prebuilt binaries found \(target=([\d.]+)/);
      const needsPython = /find Python|Could not find any Python/.test(text);
      return {
        title: `${pkg || "A native module"} failed to compile`,
        explanation: unique([
          `${pkg || "The package"} has no prebuilt binary for this Node version/platform${target ? ` (Node ${target[1]})` : ""}, so it tried to compile from source and the build failed.`,
          "Most often the Node version is newer than the package supports yet.",
          needsPython ? "The build also couldn't find Python, which node-gyp needs." : null,
        ]),
        packages: pkg ? [pkg] : [],
        manual: unique([
          "Use the project's Node version (LTS, or what .nvmrc says), or upgrade the package to a version with prebuilt binaries",
          needsPython ? "Or install build tools: Python 3, make and a C++ compiler (build-essential / Xcode Command Line Tools / VS Build Tools)" : "Or install build tools: Python 3, make and a C++ compiler",
        ]),
        relatedFindings: ["node-version", "node-engines"],
      };
    },
  },
  {
    id: "disk-full",
    match(text) {
      if (!/ENOSPC: no space left on device/.test(text)) return null;
      return {
        title: "The disk is full",
        explanation: ["The install ran out of disk space."],
        manual: [
          "Free space: preview what can go with `npx cleaninstall-node --dry-run` in your projects",
          "Clear the package manager cache (npm cache clean --force / pnpm store prune / yarn cache clean)",
        ],
      };
    },
  },
  {
    id: "file-watchers",
    match(text) {
      if (!/System limit for number of file watchers reached/.test(text)) return null;
      return {
        title: "Linux file-watcher limit reached (not a disk problem)",
        explanation: ["Dev servers watch every file; the OS limit on inotify watchers is too low for this project. The ENOSPC code is misleading."],
        manual: ["Raise the limit: echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p"],
      };
    },
  },
  {
    id: "permissions",
    match(text, ctx) {
      const m = text.match(/EACCES: permission denied,? \w+ '([^']+)'/);
      if (!m) return null;
      const p = m[1];
      const inProject = p.replace(/\\/g, "/").includes("/node_modules") && !/\/(usr|opt)\/(local\/)?lib\/node_modules/.test(p);
      if (inProject) {
        return {
          title: "node_modules is owned by another user",
          explanation: [`Can't write ${p}. node_modules was likely created by \`sudo npm install\` or a Docker container running as root.`],
          manual: ["Take ownership back: sudo chown -R \"$(whoami)\" node_modules, then reinstall. Don't use sudo for project installs"],
        };
      }
      return {
        title: "No permission to write a global install location",
        explanation: [`Can't write ${p}: global installs into the system Node need root.`],
        manual: [
          "Install Node with a version manager (nvm, fnm, Volta) so global installs don't need sudo",
          `Or skip the global install and use npx / ${ctx.packageManager === "npm" ? "npm exec" : `${ctx.packageManager} dlx`}`,
        ],
      };
    },
  },
  {
    id: "command-not-found",
    match(text, ctx) {
      const m =
        text.match(/sh: \d+: ([\w.@/-]+): not found/) ||
        text.match(/command not found: ([\w.@/-]+)/) ||
        text.match(/([\w.@/-]+): command not found/) ||
        text.match(/'([\w.@/-]+)' is not recognized as an internal or external command/);
      if (!m) return null;
      const cmd = m[1];
      const { rootDir, packageManager: pm, declared } = ctx;

      if (TOOLCHAIN_BINS.has(cmd)) {
        return {
          title: `${cmd} isn't installed`,
          explanation: [`The shell couldn't find ${cmd} itself.`],
          manual: [
            cmd === "node" || cmd === "npm" || cmd === "npx"
              ? "Install Node.js (ideally via nvm, fnm or Volta)"
              : `Run \`corepack enable\` (ships with Node) to get ${cmd}`,
          ],
        };
      }

      if (fs.existsSync(path.join(rootDir, "node_modules", ".bin", cmd))) {
        return {
          title: `${cmd} is installed, but not on your PATH`,
          explanation: [`node_modules/.bin/${cmd} exists. Project binaries are only on the PATH inside package.json scripts.`],
          manual: [`Run it as \`npx ${cmd}\`, or from a package.json script`],
        };
      }

      // Which declared dependency provides this command?
      let provider = null;
      for (const [name] of declared) {
        const inst = installedManifest(rootDir, name);
        const bin = inst && inst.manifest.bin;
        const bins = typeof bin === "string" ? [name.split("/").pop()] : Object.keys(bin || {});
        if (bins.includes(cmd)) {
          provider = name;
          break;
        }
      }
      if (!provider && KNOWN_BINS[cmd] && declared.has(KNOWN_BINS[cmd])) provider = KNOWN_BINS[cmd];

      if (provider) {
        return {
          title: provider === cmd ? `${cmd} isn't installed` : `${cmd} comes from ${provider}, which isn't installed`,
          explanation: [
            `${provider} is in package.json, but node_modules/.bin/${cmd} is missing: dependencies aren't installed (or were installed with --omit=dev / NODE_ENV=production).`,
          ],
          packages: [provider],
          fix: { kind: "install" },
        };
      }
      const guess = KNOWN_BINS[cmd] || cmd;
      return {
        title: `Nothing in package.json provides \`${cmd}\``,
        explanation: [`No dependency of this project installs a \`${cmd}\` command${KNOWN_BINS[cmd] ? `; it usually comes from the ${guess} package` : ""}.`],
        packages: [guess],
        manual: [`Add it: ${addCommand(pm, guess, true)}`],
      };
    },
  },
  {
    id: "module-not-found",
    match(text, ctx) {
      const specs = [];
      const push = (s, kind) => s && !specs.some((x) => x.spec === s) && specs.push({ spec: s, kind });
      for (const m of text.matchAll(/Cannot find module '([^']+)' or its corresponding type declarations/g)) push(m[1], "types");
      for (const m of text.matchAll(/Cannot find module '([^']+)'(?! or its)/g)) push(m[1], "runtime");
      for (const m of text.matchAll(/Cannot find package '([^']+)' imported from/g)) push(m[1], "runtime");
      for (const m of text.matchAll(/Failed to resolve import "([^"]+)" from/g)) push(m[1], "runtime");
      for (const m of text.matchAll(/Can't resolve '([^']+)'/g)) push(m[1], "runtime");
      if (specs.length === 0) return null;

      return specs.map(({ spec, kind }) => explainMissingModule(spec, kind, ctx));
    },
  },
];

function explainMissingModule(spec, kind, ctx) {
  const { rootDir, packageManager: pm, declared } = ctx;

  if (isLocalPath(spec)) {
    return {
      title: `A local file can't be found: ${spec}`,
      explanation: [
        "This is an import of a file in your own code, not a dependency, so reinstalling won't help.",
        "Check the path, the file extension (ESM needs `.js` on relative imports) and letter case (Linux/CI are case-sensitive, macOS/Windows aren't).",
      ],
      code: true,
    };
  }
  if (isBuiltin(spec)) {
    return {
      title: `Built-in module '${spec}' isn't available`,
      explanation: [
        `${spec} is part of Node itself. It's missing because this code is running in a browser bundle, or on a Node version too old to have it.`,
      ],
      manual: ["If this is frontend code, don't import Node built-ins (or add a polyfill); otherwise check your Node version"],
      relatedFindings: ["node-version", "node-engines"],
    };
  }

  const name = packageFromSpecifier(spec);
  const subpath = spec.length > name.length ? spec.slice(name.length) : "";
  const dec = declared.get(name);
  const inst = installedManifest(rootDir, name);
  const typesName = name.startsWith("@") ? `@types/${name.slice(1).replace("/", "__")}` : `@types/${name}`;

  if (kind === "types" && inst) {
    const hasTypes = inst.manifest.types || inst.manifest.typings || fs.existsSync(path.join(inst.dir, "index.d.ts"));
    if (!hasTypes && !declared.has(typesName)) {
      return {
        title: `${name} is installed but has no TypeScript types`,
        explanation: [`${name} doesn't ship type declarations; they live in ${typesName}.`],
        packages: [name],
        manual: [`Add the types: ${addCommand(pm, typesName, true)}`],
      };
    }
  }

  if (dec && !inst) {
    return {
      title: `${name} is in package.json but not installed`,
      explanation: [`${name} (${dec.range}) is declared, but node_modules doesn't have it: the install is missing or out of date.`],
      packages: [name],
      fix: { kind: "install" },
      relatedFindings: ["not-installed", "missing-deps", "lockfile-sync"],
    };
  }
  if (dec && inst) {
    const version = inst.manifest.version;
    const range = String(dec.range);
    if (version && semver.validRange(range) && !semver.satisfies(version, range, { includePrerelease: true })) {
      return {
        title: `${name} ${version} is installed, but package.json wants ${range}`,
        explanation: [`The installed copy is out of date with package.json${subpath ? `, which is why ${spec} can't be found` : ""}.`],
        packages: [name],
        fix: { kind: "install" },
        relatedFindings: ["dep-versions", "lockfile-sync"],
      };
    }
    if (subpath) {
      return {
        title: `${name} is installed, but '${spec}' doesn't exist in it`,
        explanation: [
          `The code imports ${spec}. ${name}@${version || "?"} doesn't provide that path: it was probably moved or removed in a newer version, or the import is a typo.`,
        ],
        packages: [name],
        manual: [`Check the import path against ${name}@${version || "the installed version"}'s documentation`],
      };
    }
    return {
      title: `${name} is installed but can't be loaded`,
      explanation: [`node_modules/${name} exists but its entry file couldn't be resolved: the package is likely incomplete (an interrupted install).`],
      packages: [name],
      fix: { kind: "reinstall" },
    };
  }
  if (!dec && inst) {
    return {
      title: `${name} is used but not listed in package.json`,
      explanation: [
        `${name} is only present because another package depends on it (a "phantom dependency"). It can disappear on any install, and does under pnpm.`,
      ],
      packages: [name],
      manual: [`Add it explicitly: ${addCommand(pm, name)}`],
    };
  }
  return {
    title: `${name} isn't a dependency of this project`,
    explanation: [`Nothing in package.json provides ${name}${kind === "types" ? " or its types" : ""}. It was never added, or the import is a typo.`],
    packages: [name],
    manual: [`Add it: ${addCommand(pm, name)}${kind === "types" ? ` (and ${typesName} if it has no bundled types)` : ""}`],
  };
}

/**
 * Explain an error message in the context of a project.
 * @param {string} text - The pasted error output.
 * @param {{rootDir: string, packageManager: string, workspaceDirs?: string[]}} ctx
 * @returns {Array<{id: string, title: string, explanation: string[], packages?: string[],
 *   fix?: object, manual?: string[], blocksFix?: boolean, relatedFindings?: string[], code?: boolean}>}
 */
function explainError(text, ctx) {
  const context = {
    ...ctx,
    declared: declaredDependencies(ctx.rootDir, ctx.workspaceDirs || []),
  };
  const matches = [];
  const suppressed = new Set();
  for (const sig of SIGNATURES) {
    if (suppressed.has(sig.id)) continue;
    let result;
    try {
      result = sig.match(String(text || "").replace(/\x1b\[[0-9;]*m/g, ""), context);
    } catch {
      result = null;
    }
    if (!result) continue;
    for (const r of [].concat(result)) matches.push({ id: sig.id, ...r });
    for (const s of sig.suppresses || []) suppressed.add(s);
  }
  return matches;
}

module.exports = { explainError, packageFromPath, packageFromSpecifier, nodeForAbi, KNOWN_BINS };
