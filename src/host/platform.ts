import { release as osRelease } from "node:os";

export const WINDOWS_11_MIN_BUILD = 22_000;

export interface HostPlatform {
  platform: string;
  arch: string;
  release: string;
  build: number | undefined;
}

export class UnsupportedPlatformError extends Error {
  readonly platform: string;
  readonly arch: string;
  readonly release: string;
  readonly build: number | undefined;

  constructor(host: HostPlatform) {
    const version =
      host.platform === "win32" && host.arch === "x64"
        ? `Windows release=${host.release || "unknown"}, build=${host.build ?? "unknown"}`
        : `platform=${host.platform}, arch=${host.arch}`;
    super(
      `Windows 11 x64 is required for the DSH desktop host (detected ${version}). ` +
        "Windows 10 x64 and earlier are unsupported; run the packaged host on Windows 11 x64.",
    );
    this.name = "UnsupportedPlatformError";
    this.platform = host.platform;
    this.arch = host.arch;
    this.release = host.release;
    this.build = host.build;
  }
}

export interface HostPlatformProbe {
  platform: string;
  arch: string;
  release: () => string;
}

function parseWindowsBuild(release: string): number | undefined {
  const match = /^\d+\.\d+\.(\d+)(?:$|\D)/.exec(release);
  if (!match) return undefined;
  const build = Number(match[1]);
  return Number.isSafeInteger(build) ? build : undefined;
}

export function readHostPlatform(
  probe: HostPlatformProbe = { platform: process.platform, arch: process.arch, release: osRelease },
): HostPlatform {
  const release = probe.release();
  return {
    platform: probe.platform,
    arch: probe.arch,
    release,
    build: parseWindowsBuild(release),
  };
}

export function assertSupportedWindows11X64(host: HostPlatform = readHostPlatform()): void {
  const releaseMatch = /^(\d+)\.(\d+)\./.exec(host.release);
  const major = releaseMatch ? Number(releaseMatch[1]) : undefined;
  const minor = releaseMatch ? Number(releaseMatch[2]) : undefined;
  const supportedWindowsBuild =
    host.platform === "win32" &&
    host.arch === "x64" &&
    host.build !== undefined &&
    major !== undefined &&
    minor !== undefined &&
    (major > 10 || (major === 10 && minor === 0 && host.build >= WINDOWS_11_MIN_BUILD));
  if (!supportedWindowsBuild) {
    throw new UnsupportedPlatformError(host);
  }
}
