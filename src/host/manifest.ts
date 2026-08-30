import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const WIN_GET_BUN_PACKAGE_ID = "Oven-sh.Bun" as const;

export interface ProductManifest {
  app: {
    name: string;
    identifier: string;
    version: string;
  };
  bun: {
    version: string;
    packageId: typeof WIN_GET_BUN_PACKAGE_ID;
  };
  sidecar: {
    /** Relative path to a file staged in the application payload. */
    entrypoint: string;
    args: string[];
  };
  readiness: {
    /** HTTP URL polled before the application view is navigated. */
    url: string;
    timeoutMs: number;
  };
  navigation: {
    /** HTTP URL loaded by the native WebView2 view after readiness. */
    url: string;
  };
  window: {
    title: string;
    width: number;
    height: number;
  };
  supervisor: {
    /** Relative path to the staged supervisor executable. */
    executable: string;
  };
}

export interface ValidatedProductManifest extends ProductManifest {
  resolvedSidecarEntrypoint: string;
  resolvedSupervisorExecutable: string;
}

export interface ManifestValidationOptions {
  /** Root containing the staged payload and supervisor. */
  stagedRoot: string;
  fileSystem?: {
    statSync: typeof statSync;
    lstatSync?: typeof lstatSync;
    realpathSync: typeof realpathSync;
  };
}

export type ManifestErrorCode =
  | "manifest-shape"
  | "app-name"
  | "app-identifier"
  | "app-version"
  | "bun-version"
  | "bun-package-id"
  | "sidecar-entrypoint"
  | "sidecar-arguments"
  | "readiness-url"
  | "navigation-url"
  | "startup-timeout"
  | "window-settings"
  | "supervisor-path"
  | "staged-payload";

export class ManifestValidationError extends Error {
  readonly code: ManifestErrorCode;

  constructor(code: ManifestErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "ManifestValidationError";
    this.code = code;
  }
}

const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const APP_IDENTIFIER = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const MAX_STARTUP_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_WINDOW_DIMENSION = 10_000;

function fail(code: ManifestErrorCode, message: string): never {
  throw new ManifestValidationError(code, message);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("manifest-shape", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, code: ManifestErrorCode, name: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(code, `${name} must be a non-empty string without control characters`);
  }
  return value;
}

function exactVersion(value: unknown, code: ManifestErrorCode, name: string): string {
  const version = stringValue(value, code, name);
  if (!EXACT_VERSION.test(version)) {
    fail(code, `${name} must be an exact numeric version such as 1.4.0`);
  }
  return version;
}

function relativeStagedPath(
  value: unknown,
  code: ManifestErrorCode,
  name: string,
  stagedRoot: string,
  fileSystem: NonNullable<ManifestValidationOptions["fileSystem"]>,
): { relativePath: string; absolutePath: string } {
  const input = stringValue(value, code, name).replaceAll("\\", "/");
  if (
    input.startsWith("/") ||
    /^[a-zA-Z]:\//.test(input) ||
    input.split("/").some((segment) => segment === ".." || segment.length === 0)
  ) {
    fail(code, `${name} must be a relative staged path without drive letters or traversal`);
  }

  const root = resolve(stagedRoot);
  const absolutePath = resolve(root, input);
  const outside = relative(root, absolutePath);
  if (outside.startsWith("..") || isAbsolute(outside)) {
    fail(code, `${name} resolves outside the staged payload root`);
  }

  // Lexical containment is not enough when a staged directory is a symlink.
  // Resolve both sides before the file is opened so an intermediate link can
  // never redirect a manifest path outside the packaged resource root.
  let realRoot: string;
  let realPath: string;
  try {
    realRoot = fileSystem.realpathSync(root);
    realPath = fileSystem.realpathSync(absolutePath);
  } catch {
    fail(code, `${name} could not be resolved inside the staged payload root`);
  }
  const realOutside = relative(realRoot, realPath);
  if (realOutside.startsWith("..") || isAbsolute(realOutside)) {
    fail(code, `${name} resolves outside the staged payload root`);
  }

  return { relativePath: input, absolutePath };
}

function loopbackUrl(value: unknown, code: ManifestErrorCode, name: string): string {
  const text = stringValue(value, code, name);
  // URL normalisation removes dot segments, so inspect the raw path first and
  // reject traversal before constructing the URL object.
  const authorityStart = text.indexOf("://");
  const firstPath = authorityStart >= 0 ? text.indexOf("/", authorityStart + 3) : -1;
  if (firstPath >= 0) {
    const queryOrHash = text.search(/[?#]/u);
    const rawPath = text.slice(firstPath, queryOrHash >= 0 ? queryOrHash : text.length);
    let decodedRawPath: string;
    try {
      decodedRawPath = decodeURIComponent(rawPath);
    } catch {
      fail(code, `${name} contains an invalid percent-encoded path`);
    }
    if (
      decodedRawPath.includes("\\") ||
      decodedRawPath.split("/").some((segment) => segment === ".." || segment === ".")
    ) {
      fail(code, `${name} contains an invalid path`);
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    fail(code, `${name} must be a valid absolute HTTP URL`);
  }

  // WHATWG URL parsing canonicalises alternate IPv4 spellings (for example
  // `127.0.0.01` and the integer form) to `127.0.0.1`. The product contract
  // intentionally permits only the literal loopback spelling, so inspect the
  // authority before relying on the normalised hostname.
  const authorityEnd = text.slice(authorityStart + 3).search(/[/?#]/u);
  const authority = text.slice(
    authorityStart + 3,
    authorityEnd < 0 ? text.length : authorityStart + 3 + authorityEnd,
  );
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const rawHost = hostPort.startsWith("[")
    ? hostPort.slice(0, hostPort.indexOf("]") + 1)
    : hostPort.split(":", 1)[0];

  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    rawHost !== "127.0.0.1" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    fail(code, `${name} must use HTTP and the literal host 127.0.0.1`);
  }

  const port = parsed.port === "" ? 80 : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(code, `${name} must specify a port from 1 to 65535`);
  }

  // Do not allow an encoded or literal path traversal to become a different
  // endpoint after a URL implementation normalizes it.
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    fail(code, `${name} contains an invalid percent-encoded path`);
  }
  if (
    decodedPath.includes("\\") ||
    decodedPath.split("/").some((segment) => segment === "..") ||
    /[\u0000-\u001f\u007f]/.test(decodedPath)
  ) {
    fail(code, `${name} contains an invalid path`);
  }

  return parsed.toString();
}

function stagedFile(
  path: string,
  name: string,
  fileSystem: { statSync: typeof statSync; lstatSync?: typeof lstatSync },
): void {
  try {
    const metadata = fileSystem.lstatSync?.(path) ?? fileSystem.statSync(path);
    if (metadata.isSymbolicLink?.()) {
      fail("staged-payload", `${name} must point to a regular staged file: ${path}`);
    }
    if (!metadata.isFile()) {
      fail("staged-payload", `${name} must point to a staged file: ${path}`);
    }
  } catch (error) {
    if (error instanceof ManifestValidationError) throw error;
    fail("staged-payload", `${name} is missing from the staged payload: ${path}`);
  }
}

/**
 * Parse and validate the build-time product manifest before any process or
 * network operation starts. The returned paths are absolute and confined to
 * the supplied staging root.
 */
export function validateProductManifest(
  input: unknown,
  options: ManifestValidationOptions,
): ValidatedProductManifest {
  const root = stringValue(options.stagedRoot, "staged-payload", "stagedRoot");
  if (!isAbsolute(root)) {
    fail("staged-payload", "stagedRoot must be an absolute directory");
  }
  const source = record(input, "manifest");
  const app = record(source.app, "app");
  const bun = record(source.bun, "bun");
  const sidecar = record(source.sidecar, "sidecar");
  const readiness = record(source.readiness, "readiness");
  const navigation = record(source.navigation, "navigation");
  const windowSettings = record(source.window, "window");
  const supervisor = record(source.supervisor, "supervisor");

  const name = stringValue(app.name, "app-name", "app.name");
  const identifier = stringValue(app.identifier, "app-identifier", "app.identifier");
  if (!APP_IDENTIFIER.test(identifier) || !identifier.includes(".")) {
    fail("app-identifier", "app.identifier must be a reverse-DNS style identifier");
  }
  const appVersion = exactVersion(app.version, "app-version", "app.version");
  const bunVersion = exactVersion(bun.version, "bun-version", "bun.version");
  if (bun.packageId !== WIN_GET_BUN_PACKAGE_ID) {
    fail("bun-package-id", `bun.packageId must be exactly ${WIN_GET_BUN_PACKAGE_ID}`);
  }

  const fileSystem = options.fileSystem ?? { statSync, lstatSync, realpathSync };
  const sidecarPath = relativeStagedPath(
    sidecar.entrypoint,
    "sidecar-entrypoint",
    "sidecar.entrypoint",
    root,
    fileSystem,
  );
  const supervisorPath = relativeStagedPath(
    supervisor.executable,
    "supervisor-path",
    "supervisor.executable",
    root,
    fileSystem,
  );
  stagedFile(sidecarPath.absolutePath, "sidecar.entrypoint", fileSystem);
  stagedFile(supervisorPath.absolutePath, "supervisor.executable", fileSystem);

  if (!Array.isArray(sidecar.args) || sidecar.args.some((arg) => typeof arg !== "string" || /[\u0000-\u001f\u007f]/.test(arg))) {
    fail("sidecar-arguments", "sidecar.args must be an array of strings without control characters");
  }
  const args = sidecar.args.map((arg) => {
    if (/[\u0000-\u001f\u007f]/.test(arg)) fail("sidecar-arguments", "sidecar.args cannot contain control characters");
    return arg;
  });

  const readinessUrl = loopbackUrl(readiness.url, "readiness-url", "readiness.url");
  const navigationUrl = loopbackUrl(navigation.url, "navigation-url", "navigation.url");
  const timeoutMs = readiness.timeoutMs;
  const timeoutNumber = typeof timeoutMs === "number" ? timeoutMs : Number.NaN;
  if (
    !Number.isInteger(timeoutNumber) ||
    timeoutNumber < 1 ||
    timeoutNumber > MAX_STARTUP_TIMEOUT_MS
  ) {
    fail(
      "startup-timeout",
      `readiness.timeoutMs must be an integer from 1 to ${MAX_STARTUP_TIMEOUT_MS}`,
    );
  }

  const title = stringValue(windowSettings.title, "window-settings", "window.title");
  const width = windowSettings.width;
  const height = windowSettings.height;
  const widthNumber = typeof width === "number" ? width : Number.NaN;
  const heightNumber = typeof height === "number" ? height : Number.NaN;
  if (
    !Number.isInteger(widthNumber) ||
    !Number.isInteger(heightNumber) ||
    widthNumber < 1 ||
    heightNumber < 1 ||
    widthNumber > MAX_WINDOW_DIMENSION ||
    heightNumber > MAX_WINDOW_DIMENSION
  ) {
    fail("window-settings", "window.width/height must be positive integers no larger than 10000");
  }

  return {
    app: { name, identifier, version: appVersion },
    bun: { version: bunVersion, packageId: WIN_GET_BUN_PACKAGE_ID },
    sidecar: { entrypoint: sidecarPath.relativePath, args },
    readiness: { url: readinessUrl, timeoutMs: timeoutNumber },
    navigation: { url: navigationUrl },
    window: { title, width: widthNumber, height: heightNumber },
    supervisor: { executable: supervisorPath.relativePath },
    resolvedSidecarEntrypoint: sidecarPath.absolutePath,
    resolvedSupervisorExecutable: supervisorPath.absolutePath,
  };
}

export function tryValidateProductManifest(
  input: unknown,
  options: ManifestValidationOptions,
): { ok: true; manifest: ValidatedProductManifest } | { ok: false; error: ManifestValidationError } {
  try {
    return { ok: true, manifest: validateProductManifest(input, options) };
  } catch (error) {
    if (error instanceof ManifestValidationError) return { ok: false, error };
    throw error;
  }
}
