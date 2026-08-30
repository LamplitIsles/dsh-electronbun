import type { ValidatedProductManifest } from "./manifest";
import { assertSupportedWindowsX64, type HostPlatform } from "./platform";
import type { BunProvisioningResult, BunResolution } from "./bun-runtime";

export type StartupFailureReason =
  | "unsupported-platform"
  | "manifest-invalid"
  | "bun-missing"
  | "bun-incompatible"
  | "winget-unavailable"
  | "user-declined"
  | "install-failed"
  | "unresolved-executable"
  | "post-install-version-mismatch"
  | "supervisor-failure"
  | "sidecar-exited"
  | "readiness-timeout"
  | "readiness-invalid-response"
  | "cancelled";

export type StartupState =
  | { kind: "loading"; message: string; appName?: string; bunVersion?: string }
  | { kind: "ready"; url: string }
  | {
      kind: "failed";
      reason: StartupFailureReason;
      diagnostic: string;
      canInstall: boolean;
      canRetry: boolean;
      appName?: string;
      bunVersion?: string;
    }
  | { kind: "stopping" };

export interface StartupView {
  showLoading(loading: Extract<StartupState, { kind: "loading" }>): void;
  showFailure(failure: Extract<StartupState, { kind: "failed" }>): void;
  navigate(url: string): void;
}

export interface ReadinessResponse {
  status: number;
  ok: boolean;
}

export interface ReadinessClient {
  request(url: string, signal: AbortSignal): Promise<ReadinessResponse>;
}

export const fetchReadinessClient: ReadinessClient = {
  async request(url, signal) {
    const response = await fetch(url, { method: "GET", signal, redirect: "error" });
    return { status: response.status, ok: response.status >= 200 && response.status < 300 };
  },
};

export interface SupervisorExit {
  exitCode: number | null;
  signal?: string;
  error?: string;
  stderr?: string;
  failure?: SupervisorFailureEvidence;
}

export interface SupervisorFailureEvidence {
  operation: string;
  win32Code: number;
}

export interface SupervisorHandle {
  wait(): Promise<SupervisorExit>;
  stop(): Promise<void>;
}

export interface SupervisorLaunchOptions {
  executablePath: string;
  parentPid: number;
  bunExecutablePath: string;
  sidecarEntrypoint: string;
  args: readonly string[];
}

export interface SupervisorLauncher {
  launch(options: SupervisorLaunchOptions): Promise<SupervisorHandle>;
}

export interface BunRuntimeGateway {
  resolve(expectedVersion: string): Promise<BunResolution>;
  install(expectedVersion: string): Promise<BunProvisioningResult>;
}

export interface StartupControllerOptions {
  manifest: ValidatedProductManifest;
  runtime: BunRuntimeGateway;
  supervisor: SupervisorLauncher;
  readiness?: ReadinessClient;
  view: StartupView;
  platform?: HostPlatform;
  parentPid?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onStateChange?: (state: StartupState) => void;
}

function abortError(): Error {
  return new DOMException("Operation was cancelled", "AbortError");
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function failureFromProvisioning(result: Extract<BunProvisioningResult, { kind: "failed" }>): Extract<StartupState, { kind: "failed" }> {
  return {
    kind: "failed",
    reason: result.code,
    diagnostic: result.diagnostic,
    canInstall: true,
    canRetry: true,
  };
}

function isAbort(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError");
}

/** Coordinates one sidecar startup and owns the only startup state machine. */
export class StartupController {
  private readonly manifest: ValidatedProductManifest;
  private readonly runtime: BunRuntimeGateway;
  private readonly supervisor: SupervisorLauncher;
  private readonly readiness: ReadinessClient;
  private readonly view: StartupView;
  private readonly platform: HostPlatform;
  private readonly parentPid: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly onStateChange?: (state: StartupState) => void;
  private state: StartupState = { kind: "stopping" };
  private activeHandle?: SupervisorHandle;
  private operation?: { id: number; abort: AbortController };
  private nextOperationId = 0;
  private stopPromise?: Promise<void>;
  private stopRequested = false;

  constructor(options: StartupControllerOptions) {
    this.manifest = options.manifest;
    this.runtime = options.runtime;
    this.supervisor = options.supervisor;
    this.readiness = options.readiness ?? fetchReadinessClient;
    this.view = options.view;
    this.platform = options.platform ?? process;
    this.parentPid = options.parentPid ?? process.pid;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.onStateChange = options.onStateChange;
  }

  getState(): StartupState {
    return this.state;
  }

  async start(): Promise<StartupState> {
    await this.stopActiveOperation();
    if (this.stopRequested) return this.state;
    const operation = this.beginOperation();
    this.transition({ kind: "loading", message: `Starting ${this.manifest.app.name}…` });

    try {
      assertSupportedWindowsX64(this.platform);
    } catch (error) {
      return this.fail(operation, "unsupported-platform", error instanceof Error ? error.message : String(error), false);
    }

    let resolution: BunResolution;
    try {
      resolution = await this.runtime.resolve(this.manifest.bun.version);
    } catch (error) {
      return this.fail(
        operation,
        "bun-missing",
        `Bun runtime resolution failed: ${error instanceof Error ? error.message : String(error)}. Retry or choose Install Bun.`,
        true,
      );
    }
    if (!this.isCurrent(operation)) return this.state;
    if (resolution.kind !== "available") {
      return this.fail(
        operation,
        resolution.kind === "missing" ? "bun-missing" : "bun-incompatible",
        resolution.diagnostic,
        true,
      );
    }

    return this.launchAndAwaitReadiness(operation, resolution.executablePath);
  }

  /** Explicit user action. No provisioning is attempted from start(). */
  async installBun(): Promise<StartupState> {
    if (this.state.kind !== "failed" || !this.state.canInstall) return this.state;
    await this.stopActiveOperation();
    if (this.stopRequested) return this.state;
    const operation = this.beginOperation();
    this.transition({ kind: "loading", message: `Installing Bun ${this.manifest.bun.version}…` });
    let result: BunProvisioningResult;
    try {
      result = await this.runtime.install(this.manifest.bun.version);
    } catch (error) {
      const failure: Extract<StartupState, { kind: "failed" }> = {
        kind: "failed",
        reason: "install-failed",
        diagnostic: `Bun provisioning failed: ${error instanceof Error ? error.message : String(error)}. Retry.`,
        canInstall: true,
        canRetry: true,
      };
      if (!this.isCurrent(operation)) return this.state;
      this.transition(failure);
      return this.state;
    }
    if (!this.isCurrent(operation)) return this.state;
    if (result.kind === "failed") {
      const failure = failureFromProvisioning(result);
      this.transition(failure);
      return this.state;
    }
    return this.launchAndAwaitReadiness(operation, result.executablePath);
  }

  async retry(): Promise<StartupState> {
    if (this.state.kind !== "failed") return this.state;
    return this.start();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.transition({ kind: "stopping" });
      this.operation?.abort.abort();
      this.operation = undefined;
      const handle = this.activeHandle;
      this.activeHandle = undefined;
      if (handle) await this.stopHandle(handle);
    })().finally(() => {
      this.stopPromise = undefined;
    });
    return this.stopPromise;
  }

  private async launchAndAwaitReadiness(
    operation: { id: number; abort: AbortController },
    bunExecutablePath: string,
  ): Promise<StartupState> {
    let handle: SupervisorHandle;
    try {
      handle = await this.supervisor.launch({
        executablePath: this.manifest.resolvedSupervisorExecutable,
        parentPid: this.parentPid,
        bunExecutablePath,
        sidecarEntrypoint: this.manifest.resolvedSidecarEntrypoint,
        args: this.manifest.sidecar.args,
      });
    } catch (error) {
      return this.fail(
        operation,
        "supervisor-failure",
        `The Windows sidecar supervisor could not start: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }
    if (!this.isCurrent(operation)) {
      await this.stopHandle(handle);
      return this.state;
    }
    this.activeHandle = handle;
    const readiness = await this.waitForReadiness(operation, handle);
    if (readiness.kind === "ready") {
      // Readiness may resolve in the same turn that stop() wins the close
      // race. Never publish ready or navigate a stale operation.
      if (!this.isCurrent(operation)) {
        if (this.activeHandle === handle) {
          this.activeHandle = undefined;
          await this.stopHandle(handle);
        }
        return this.state;
      }
      this.transition({ kind: "ready", url: this.manifest.navigation.url });
      if (!this.isCurrent(operation)) return this.state;
      this.view.navigate(this.manifest.navigation.url);
      return this.state;
    }
    if (readiness.kind === "cancelled") return this.state;
    if (this.activeHandle === handle) {
      this.activeHandle = undefined;
      await this.stopHandle(handle);
    }
    return this.fail(operation, readiness.reason, readiness.diagnostic, false);
  }

  private async waitForReadiness(
    operation: { id: number; abort: AbortController },
    handle: SupervisorHandle,
  ): Promise<
    | { kind: "ready"; url: string }
    | { kind: "cancelled" }
    | {
        kind: "failed";
        reason:
          | "supervisor-failure"
          | "sidecar-exited"
          | "readiness-timeout"
          | "readiness-invalid-response";
        diagnostic: string;
      }
  > {
    const deadline = this.now() + this.manifest.readiness.timeoutMs;
    let lastStatus: number | undefined;
    let exited: SupervisorExit | undefined;
    let exitError: unknown;
    const exitPromise = handle
      .wait()
      .then((value) => {
        exited = value;
        return { type: "exit" as const, value };
      })
      .catch((error) => {
        exitError = error;
        return { type: "exit-error" as const, error };
      });

    while (this.isCurrent(operation)) {
      if (exited) {
        if (exited.failure) {
          return {
            kind: "failed",
            reason: "supervisor-failure",
            diagnostic: `The Windows sidecar supervisor failed during ${exited.failure.operation} (Win32 error ${exited.failure.win32Code}) before HTTP readiness.`,
          };
        }
        if (exited.error) {
          return {
            kind: "failed",
            reason: "supervisor-failure",
            diagnostic: `The Windows sidecar supervisor failed before HTTP readiness: ${exited.error}`,
          };
        }
        if (exited.stderr?.trim()) {
          return {
            kind: "failed",
            reason: "supervisor-failure",
            diagnostic: "The Windows sidecar supervisor reported an internal failure before HTTP readiness.",
          };
        }
        return {
          kind: "failed",
          reason: "sidecar-exited",
          diagnostic: `The sidecar supervisor exited before HTTP readiness (exit code ${String(exited.exitCode)}).`,
        };
      }
      if (exitError) {
        return {
          kind: "failed",
          reason: "supervisor-failure",
          diagnostic: `The Windows sidecar supervisor wait failed: ${exitError instanceof Error ? exitError.message : String(exitError)}`,
        };
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        return {
          kind: "failed",
          reason: lastStatus === undefined ? "readiness-timeout" : "readiness-invalid-response",
          diagnostic:
            lastStatus === undefined
              ? `The sidecar did not become HTTP-ready within ${this.manifest.readiness.timeoutMs} ms.`
              : `The readiness endpoint returned HTTP ${lastStatus} until the ${this.manifest.readiness.timeoutMs} ms startup timeout expired.`,
        };
      }

      const probeController = new AbortController();
      const deadlineController = new AbortController();
      const onAbort = () => {
        probeController.abort();
        deadlineController.abort();
      };
      operation.abort.signal.addEventListener("abort", onAbort, { once: true });
      const probe = this.readiness
        .request(this.manifest.readiness.url, probeController.signal)
        .then((response) => ({ type: "response" as const, response }))
        .catch((error) => ({ type: "probe-error" as const, error }));
      const result = await Promise.race([
        probe,
        exitPromise,
        this.sleep(remaining, deadlineController.signal).then(
          () => ({ type: "deadline" as const }),
          (error) => ({ type: "cancelled" as const, error }),
        ),
      ]);
      operation.abort.signal.removeEventListener("abort", onAbort);
      probeController.abort();
      deadlineController.abort();

      if (result.type === "cancelled") return { kind: "cancelled" };
      if (result.type === "exit") {
        exited = result.value;
        continue;
      }
      if (result.type === "exit-error") {
        exitError = result.error;
        continue;
      }
      if (result.type === "response") {
        if (result.response.ok) return { kind: "ready", url: this.manifest.navigation.url };
        lastStatus = result.response.status;
        await this.sleep(Math.min(this.pollIntervalMs, Math.max(0, deadline - this.now())), operation.abort.signal).catch(
          () => undefined,
        );
        continue;
      }
      if (result.type === "probe-error") {
        if (isAbort(result.error) && operation.abort.signal.aborted) return { kind: "cancelled" };
        // Connection refused and transient HTTP failures are expected while
        // Bun boots; keep polling until the bounded deadline.
        await this.sleep(Math.min(this.pollIntervalMs, Math.max(0, deadline - this.now())), operation.abort.signal).catch(
          () => undefined,
        );
        continue;
      }
      if (result.type === "deadline") {
        continue;
      }
    }
    return { kind: "cancelled" };
  }

  private beginOperation(): { id: number; abort: AbortController } {
    const operation = { id: ++this.nextOperationId, abort: new AbortController() };
    this.operation = operation;
    return operation;
  }

  private isCurrent(operation: { id: number }): boolean {
    return this.operation?.id === operation.id;
  }

  private transition(state: StartupState): void {
    const enriched = state.kind === "loading" || state.kind === "failed"
      ? {
          ...state,
          appName: this.manifest.app.name,
          bunVersion: this.manifest.bun.version,
        }
      : state;
    this.state = enriched;
    this.onStateChange?.(enriched);
    if (enriched.kind === "loading") this.view.showLoading(enriched);
    if (enriched.kind === "failed") this.view.showFailure(enriched);
  }

  private fail(
    operation: { id: number },
    reason: StartupFailureReason,
    diagnostic: string,
    canInstall: boolean,
  ): StartupState {
    if (!this.isCurrent(operation)) return this.state;
    const failure: Extract<StartupState, { kind: "failed" }> = {
      kind: "failed",
      reason,
      diagnostic,
      canInstall,
      canRetry: true,
    };
    this.transition(failure);
    return this.state;
  }

  private async stopActiveOperation(): Promise<void> {
    this.operation?.abort.abort();
    this.operation = undefined;
    const handle = this.activeHandle;
    this.activeHandle = undefined;
    if (handle) await this.stopHandle(handle);
  }

  private async stopHandle(handle: SupervisorHandle): Promise<void> {
    try {
      await handle.stop();
    } catch {
      // Cleanup is best effort at this seam; the supervisor itself is
      // responsible for fail-closed Job Object cleanup.
    }
  }
}
