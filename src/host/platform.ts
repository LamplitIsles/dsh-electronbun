export interface HostPlatform {
  platform: string;
  arch: string;
}

export class UnsupportedPlatformError extends Error {
  readonly platform: string;
  readonly arch: string;

  constructor(platform: string, arch: string) {
    super(
      `Windows x64 is required for the DSH desktop host (received platform=${platform}, arch=${arch}). ` +
        "Run the packaged host on Windows 11 x64.",
    );
    this.name = "UnsupportedPlatformError";
    this.platform = platform;
    this.arch = arch;
  }
}

export function assertSupportedWindowsX64(host: HostPlatform = process): void {
  if (host.platform !== "win32" || host.arch !== "x64") {
    throw new UnsupportedPlatformError(host.platform, host.arch);
  }
}

export function isSupportedWindowsX64(host: HostPlatform = process): boolean {
  return host.platform === "win32" && host.arch === "x64";
}
