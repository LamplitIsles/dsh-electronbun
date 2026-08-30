import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import { WIN_GET_BUN_PACKAGE_ID, type ProductManifest } from "./manifest";

export interface CommandResult {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  /** Set when the executable could not be started at all. */
  errorCode?: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: { signal?: AbortSignal }): Promise<CommandResult>;
}

/** Spawn without a shell. Arguments are passed as an argv array. */
export const processCommandRunner: CommandRunner = {
  run(command, args, options = {}) {
    return new Promise<CommandResult>((resolve) => {
      let child;
      try {
        child = spawn(command, [...args], {
          shell: false,
          windowsHide: true,
          signal: options.signal,
        });
      } catch (error) {
        resolve({ exitCode: null, errorCode: error instanceof Error ? error.name : "spawn-error" });
        return;
      }

      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        resolve({ exitCode: null, stdout, stderr, errorCode: error.code ?? error.name });
      });
      child.once("close", (exitCode: number | null) => {
        resolve({ exitCode, stdout, stderr });
      });
    });
  },
};

export interface BunExecutableFileSystem {
  exists(path: string): boolean;
  isFile(path: string): boolean;
}

const nativeFileSystem: BunExecutableFileSystem = {
  exists: existsSync,
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
};

export type BunResolution =
  | { kind: "available"; executablePath: string; version: string }
  | { kind: "missing"; diagnostic: string }
  | { kind: "incompatible"; diagnostic: string; candidates: readonly { path: string; version: string }[] };

export type BunProvisioningFailureCode =
  | "winget-unavailable"
  | "user-declined"
  | "install-failed"
  | "unresolved-executable"
  | "post-install-version-mismatch";

export type BunProvisioningResult =
  | { kind: "available"; executablePath: string; version: string }
  | { kind: "failed"; code: BunProvisioningFailureCode; diagnostic: string };

export interface BunRuntimeResolverOptions {
  runner?: CommandRunner;
  fileSystem?: BunExecutableFileSystem;
  /** Candidate paths are a test seam and a way to add vendor-specific roots. */
  candidatePaths?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  whereCommand?: string;
}

function absoluteExecutablePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function cleanPath(value: string): string | undefined {
  const cleaned = value.trim().replace(/^"|"$/g, "");
  return absoluteExecutablePath(cleaned) ? cleaned : undefined;
}

function firstVersionLine(stdout: string | undefined): string {
  return (stdout ?? "").split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function candidatePathsFromEnvironment(environment: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  const pathEntries = (environment.Path ?? environment.PATH ?? "").split(delimiter).filter(Boolean);
  for (const entry of pathEntries) candidates.push(join(entry, "bun.exe"));

  const localAppData = environment.LOCALAPPDATA;
  const userProfile = environment.USERPROFILE;
  const programFiles = environment.ProgramFiles;
  if (userProfile) candidates.push(join(userProfile, ".bun", "bin", "bun.exe"));
  if (localAppData) {
    candidates.push(join(localAppData, "Programs", "Bun", "bun.exe"));
    candidates.push(join(localAppData, "Microsoft", "WinGet", "Links", "bun.exe"));
  }
  if (programFiles) candidates.push(join(programFiles, "Bun", "bun.exe"));
  const programFilesX86 = environment["ProgramFiles(x86)"];
  if (programFilesX86) candidates.push(join(programFilesX86, "Bun", "bun.exe"));
  return candidates;
}

function discoverWinGetExecutables(environment: NodeJS.ProcessEnv): string[] {
  const roots = [
    environment.LOCALAPPDATA ? join(environment.LOCALAPPDATA, "Microsoft", "WinGet", "Packages") : undefined,
    environment.ProgramFiles ? join(environment.ProgramFiles, "WinGet", "Packages") : undefined,
  ].filter((root): root is string => Boolean(root));
  const found: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 5) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === "bun.exe") found.push(path);
      else if (entry.isDirectory()) visit(path, depth + 1);
    }
  };
  for (const root of roots) visit(root, 0);
  return found;
}

/**
 * Resolve Bun on every attempt. In particular, this does not cache PATH from
 * process startup: after WinGet changes the machine, `where.exe` and direct
 * install roots are queried again.
 */
export class BunRuntimeResolver {
  private readonly runner: CommandRunner;
  private readonly fileSystem: BunExecutableFileSystem;
  private readonly candidatePaths: readonly string[];
  private readonly environment: NodeJS.ProcessEnv;
  private readonly whereCommand: string;

  constructor(options: BunRuntimeResolverOptions = {}) {
    this.runner = options.runner ?? processCommandRunner;
    this.fileSystem = options.fileSystem ?? nativeFileSystem;
    this.candidatePaths = options.candidatePaths ?? [];
    this.environment = options.environment ?? process.env;
    this.whereCommand = options.whereCommand ?? "where.exe";
  }

  async locateCandidates(): Promise<string[]> {
    const candidates = [
      ...this.candidatePaths,
      ...candidatePathsFromEnvironment(this.environment),
      ...discoverWinGetExecutables(this.environment),
    ];
    const whereResult = await this.runner.run(this.whereCommand, ["bun.exe"]);
    if (whereResult.exitCode === 0) {
      for (const line of (whereResult.stdout ?? "").split(/\r?\n/)) {
        const path = cleanPath(line);
        if (path) candidates.push(path);
      }
    }

    const unique: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const path = cleanPath(candidate);
      if (!path || seen.has(path.toLowerCase()) || !this.fileSystem.isFile(path)) continue;
      seen.add(path.toLowerCase());
      unique.push(path);
    }
    return unique;
  }

  async resolve(expectedVersion: string): Promise<BunResolution> {
    const candidates = await this.locateCandidates();
    if (candidates.length === 0) {
      return {
        kind: "missing",
        diagnostic: `Bun ${expectedVersion} was not found. Choose Install Bun to provision the supported runtime.`,
      };
    }

    const incompatible: { path: string; version: string }[] = [];
    for (const executablePath of candidates) {
      const result = await this.runner.run(executablePath, ["--version"]);
      const version = firstVersionLine(result.stdout);
      if (result.exitCode === 0 && version === expectedVersion) {
        return { kind: "available", executablePath, version };
      }
      incompatible.push({ path: executablePath, version: version || "unreported" });
    }

    return {
      kind: "incompatible",
      diagnostic: `Installed Bun does not report the required exact version ${expectedVersion}. Choose Install Bun to repair it.`,
      candidates: incompatible,
    };
  }
}

export interface BunProvisionerOptions {
  runner?: CommandRunner;
  resolver: BunRuntimeResolver;
  packageId?: string;
}

export const WINGET_DECLINED_EXIT_CODES = new Set([1223, 1224, 0x800704c7, 0x8a15002b]);

function wasDeclined(result: CommandResult): boolean {
  return (
    (result.exitCode !== null && WINGET_DECLINED_EXIT_CODES.has(result.exitCode)) ||
    result.errorCode === "USER_DECLINED" ||
    result.errorCode === "ERROR_CANCELLED" ||
    result.errorCode === "DECLINED"
  );
}

export function buildWingetInstallArgs(version: string, packageId = "Oven-sh.Bun"): readonly string[] {
  return [
    "install",
    "--id",
    packageId,
    "--version",
    version,
    "--exact",
    "--accept-source-agreements",
    "--accept-package-agreements",
    "--silent",
  ];
}

/** WinGet is invoked directly; this value is never evaluated by a shell. */
export class BunProvisioner {
  private readonly runner: CommandRunner;
  private readonly resolver: BunRuntimeResolver;
  private readonly packageId: string;

  constructor(options: BunProvisionerOptions) {
    this.runner = options.runner ?? processCommandRunner;
    this.resolver = options.resolver;
    this.packageId = options.packageId ?? WIN_GET_BUN_PACKAGE_ID;
    if (this.packageId !== WIN_GET_BUN_PACKAGE_ID) {
      throw new Error(`WinGet package ID must be exactly ${WIN_GET_BUN_PACKAGE_ID}`);
    }
  }

  async install(manifest: Pick<ProductManifest, "bun">): Promise<BunProvisioningResult> {
    if (manifest.bun.packageId !== WIN_GET_BUN_PACKAGE_ID || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.bun.version)) {
      return {
        kind: "failed",
        code: "install-failed",
        diagnostic: "The product manifest does not declare an exact supported Bun package and version.",
      };
    }
    let wingetProbe: CommandResult;
    try {
      wingetProbe = await this.runner.run("winget.exe", ["--version"]);
    } catch {
      return {
        kind: "failed",
        code: "winget-unavailable",
        diagnostic: "WinGet could not be started. Install or repair App Installer, then retry.",
      };
    }
    if (wingetProbe.exitCode === null && wingetProbe.errorCode === "ENOENT") {
      return {
        kind: "failed",
        code: "winget-unavailable",
        diagnostic: "WinGet is unavailable on this Windows installation. Install App Installer, then retry.",
      };
    }
    if (wingetProbe.exitCode !== 0) {
      return {
        kind: "failed",
        code: "winget-unavailable",
        diagnostic: "WinGet could not be started. Install or repair App Installer, then retry.",
      };
    }

    let installResult: CommandResult;
    try {
      installResult = await this.runner.run(
        "winget.exe",
        buildWingetInstallArgs(manifest.bun.version, this.packageId),
      );
    } catch {
      return {
        kind: "failed",
        code: "install-failed",
        diagnostic: `WinGet could not install Bun ${manifest.bun.version}. Retry or install it with WinGet manually.`,
      };
    }
    if (installResult.exitCode !== 0) {
      if (wasDeclined(installResult)) {
        return {
          kind: "failed",
          code: "user-declined",
          diagnostic: "Bun installation was declined. Choose Install Bun again to retry.",
        };
      }
      return {
        kind: "failed",
        code: "install-failed",
        diagnostic: `WinGet could not install Bun ${manifest.bun.version} (exit code ${String(installResult.exitCode)}). Retry or install it with WinGet manually.`,
      };
    }

    // Resolve from fresh direct candidates after installation; do not assume
    // that this process inherited a refreshed PATH.
    let resolution: BunResolution;
    try {
      resolution = await this.resolver.resolve(manifest.bun.version);
    } catch {
      return {
        kind: "failed",
        code: "unresolved-executable",
        diagnostic: `WinGet completed, but Bun ${manifest.bun.version} could not be resolved to an absolute executable path. Retry.`,
      };
    }
    if (resolution.kind === "available") return resolution;
    if (resolution.kind === "incompatible") {
      return {
        kind: "failed",
        code: "post-install-version-mismatch",
        diagnostic: `WinGet completed, but no Bun executable reports exact version ${manifest.bun.version}. Retry after checking the installation.`,
      };
    }
    return {
      kind: "failed",
      code: "unresolved-executable",
      diagnostic: `WinGet completed, but Bun ${manifest.bun.version} could not be resolved to an absolute executable path. Retry.`,
    };
  }
}

export function createBunRuntimeProvisioner(options: {
  manifest: Pick<ProductManifest, "bun">;
  resolver: BunRuntimeResolver;
  runner?: CommandRunner;
}): BunProvisioner {
  return new BunProvisioner({ resolver: options.resolver, runner: options.runner });
}
