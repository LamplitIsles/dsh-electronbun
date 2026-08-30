import { spawn, type ChildProcess } from "node:child_process";

import type {
  SupervisorExit,
  SupervisorFailureEvidence,
  SupervisorHandle,
  SupervisorLaunchOptions,
  SupervisorLauncher,
} from "./startup-controller";

export const MAX_SUPERVISOR_STDERR_BYTES = 16 * 1024;
const STDERR_TRUNCATION_MARKER = "\n[…truncated]";

const SUPERVISOR_FAILURE = /\b(OpenProcess|CreateJobObjectW|SetInformationJobObject|CreateProcessW|AssignProcessToJobObject|ResumeThread|WaitForMultipleObjects|GetExitCodeProcess) failed \(Win32 error (\d+)\)/;

/** Extracts the supervisor's stable internal failure marker from stderr. */
export function parseSupervisorFailureEvidence(stderr: string): SupervisorFailureEvidence | undefined {
  const match = SUPERVISOR_FAILURE.exec(stderr);
  if (!match) return undefined;
  return { operation: match[1], win32Code: Number(match[2]) };
}

/** Keeps captured supervisor evidence bounded before it reaches diagnostics. */
export function boundSupervisorStderr(stderr: string): string {
  if (Buffer.byteLength(stderr, "utf8") <= MAX_SUPERVISOR_STDERR_BYTES) return stderr;
  const markerBytes = Buffer.byteLength(STDERR_TRUNCATION_MARKER, "utf8");
  const prefix = Buffer.from(stderr, "utf8")
    .subarray(0, Math.max(0, MAX_SUPERVISOR_STDERR_BYTES - markerBytes))
    .toString("utf8");
  return `${prefix}${STDERR_TRUNCATION_MARKER}`;
}

function appendBoundedStderr(current: string, chunk: string): string {
  const remaining = MAX_SUPERVISOR_STDERR_BYTES - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return current;
  const bytes = Buffer.from(chunk, "utf8");
  return current + bytes.subarray(0, remaining).toString("utf8");
}

export interface SupervisorChild {
  wait(): Promise<SupervisorExit>;
  stop(): Promise<void>;
}

export type SupervisorSpawner = (
  executablePath: string,
  args: readonly string[],
) => SupervisorChild;

function childProcessSpawner(executablePath: string, args: readonly string[]): SupervisorChild {
  let child: ChildProcess;
  try {
    child = spawn(executablePath, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    throw new Error(`spawn failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let waitPromise: Promise<SupervisorExit> | undefined;
  return {
    wait() {
      if (!waitPromise) {
        waitPromise = new Promise<SupervisorExit>((resolve) => {
          let settled = false;
          let stderr = "";
          let stderrTruncated = false;
          child.stderr?.setEncoding("utf8");
          child.stderr?.on("data", (chunk: string) => {
            const before = Buffer.byteLength(stderr, "utf8");
            const incoming = Buffer.byteLength(chunk, "utf8");
            const next = appendBoundedStderr(stderr, chunk);
            if (before + incoming > MAX_SUPERVISOR_STDERR_BYTES) stderrTruncated = true;
            stderr = next;
          });
          const finish = (exit: SupervisorExit) => {
            if (settled) return;
            settled = true;
            const boundedStderr = boundSupervisorStderr(
              stderrTruncated ? `${stderr}${STDERR_TRUNCATION_MARKER}` : stderr,
            );
            const failure = parseSupervisorFailureEvidence(boundedStderr);
            resolve({ ...exit, stderr: boundedStderr || undefined, failure });
          };
          child.once("error", (error: NodeJS.ErrnoException) =>
            finish({ exitCode: null, error: `${error.code ?? error.name}: ${error.message}` }),
          );
          child.once("close", (exitCode, signal) =>
            finish({ exitCode, signal: signal ?? undefined }),
          );
        });
      }
      return waitPromise;
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await this.wait().catch(() => undefined);
    },
  };
}

export function buildSupervisorArgs(options: Omit<SupervisorLaunchOptions, "executablePath">): readonly string[] {
  return [
    "--parent-pid",
    String(options.parentPid),
    "--bun",
    options.bunExecutablePath,
    "--entrypoint",
    options.sidecarEntrypoint,
    "--",
    ...options.args,
  ];
}

function absolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** Starts the standalone Windows supervisor without a command shell. */
export class WindowsSupervisorLauncher implements SupervisorLauncher {
  private readonly spawnChild: SupervisorSpawner;

  constructor(spawnChild: SupervisorSpawner = childProcessSpawner) {
    this.spawnChild = spawnChild;
  }

  async launch(options: SupervisorLaunchOptions): Promise<SupervisorHandle> {
    if (!absolutePath(options.executablePath)) throw new Error("supervisor executable path must be absolute");
    if (!absolutePath(options.bunExecutablePath)) throw new Error("Bun executable path must be absolute");
    if (!absolutePath(options.sidecarEntrypoint)) throw new Error("sidecar entrypoint must be absolute");
    if (!Number.isInteger(options.parentPid) || options.parentPid <= 0) throw new Error("parent PID is invalid");
    const child = this.spawnChild(options.executablePath, buildSupervisorArgs(options));
    return {
      wait: () => child.wait(),
      stop: () => child.stop(),
    };
  }
}
