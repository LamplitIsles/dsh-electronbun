// @hutch cli=production

/** Hutch is the build/package owner. Electrobun is pinned by package.json and
 * repeated here so direct Hutch invocations cannot silently float versions. */
export default {
  electrobun: {
    version: "2.0.1",
  },
  packageManager: "bun",
  scripts: {
    install: ["hutch", "install", "--frozen-lockfile"],
    dev: ["bun", "run", "scripts/dev.ts"],
    "build:dev": ["bun", "run", "scripts/build-release.ts", "dev"],
    "build:stable": ["bun", "run", "scripts/build-release.ts", "stable"],
    "build:supervisor": ["bun", "run", "scripts/build-supervisor.ts"],
    "test:zig": ["bun", "run", "test:zig"],
    "test:native": [
      "powershell",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "scripts/windows/native-lifecycle-gate.ps1",
    ],
    "test:packaging": [
      "powershell",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "scripts/windows/packaging-smoke.ps1",
    ],
  },
};
