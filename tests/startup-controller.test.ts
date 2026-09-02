import { describe, expect, test } from "bun:test";

import { referenceManifest } from "../product.manifest";
import type { BunProvisioningResult, BunResolution } from "../src/host/bun-runtime";
import type { ValidatedProductManifest } from "../src/host/manifest";
import {
  StartupController,
  type ReadinessClient,
  type StartupState,
  type StartupView,
  type SupervisorExit,
  type SupervisorHandle,
  type SupervisorLaunchOptions,
  type SupervisorLauncher,
} from "../src/host/startup-controller";
import type { LaunchTokenExchangeResult, LaunchTokenGateway } from "../src/host/launch-token";

const windows11Platform = {
  platform: "win32",
  arch: "x64",
  release: "10.0.22621",
  build: 22621,
} as const;

function manifest(overrides: Partial<ValidatedProductManifest> = {}): ValidatedProductManifest {
  return {
    ...referenceManifest,
    resolvedSidecarEntrypoint: "C:\\app\\payload\\sidecar.ts",
    resolvedSupervisorExecutable: "C:\\app\\bin\\supervisor.exe",
    ...overrides,
  } as ValidatedProductManifest;
}

class FakeView implements StartupView {
  states: StartupState[] = [];
  navigations: string[] = [];
  launchTokenStates: Extract<StartupState, { kind: "launch-token" }>[] = [];
  showLoading(loading: Extract<StartupState, { kind: "loading" }>): void {
    this.states.push(loading);
  }
  showFailure(failure: Extract<StartupState, { kind: "failed" }>): void {
    this.states.push(failure);
  }
  showLaunchToken(gate: Extract<StartupState, { kind: "launch-token" }>): void {
    this.launchTokenStates.push(gate);
  }
  navigate(url: string): void {
    this.navigations.push(url);
  }
}

class FakeLaunchTokenGateway implements LaunchTokenGateway {
  tokens: string[] = [];
  constructor(private readonly result: LaunchTokenExchangeResult) {}
  async exchange(token: string): Promise<LaunchTokenExchangeResult> {
    this.tokens.push(token);
    return this.result;
  }
}

class FakeRuntime {
  resolveCalls = 0;
  installCalls = 0;
  constructor(
    private readonly resolution: BunResolution,
    private readonly provisioning: BunProvisioningResult = {
      kind: "available",
      executablePath: "C:\\Bun\\bun.exe",
      version: "1.4.0",
    },
  ) {}
  resolve(): Promise<BunResolution> {
    this.resolveCalls += 1;
    return Promise.resolve(this.resolution);
  }
  install(): Promise<BunProvisioningResult> {
    this.installCalls += 1;
    return Promise.resolve(this.provisioning);
  }
}

class FakeHandle implements SupervisorHandle {
  stopCalls = 0;
  private readonly exitPromise: Promise<SupervisorExit>;
  constructor(exit: Promise<SupervisorExit> = new Promise(() => undefined)) {
    this.exitPromise = exit;
  }
  wait(): Promise<SupervisorExit> {
    return this.exitPromise;
  }
  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

class FakeSupervisor implements SupervisorLauncher {
  launches: SupervisorLaunchOptions[] = [];
  readonly handles: FakeHandle[] = [];
  constructor(private readonly handleFactory: () => FakeHandle = () => new FakeHandle()) {}
  async launch(options: SupervisorLaunchOptions): Promise<SupervisorHandle> {
    this.launches.push(options);
    const handle = this.handleFactory();
    this.handles.push(handle);
    return handle;
  }
}

class FakeReadiness implements ReadinessClient {
  calls = 0;
  constructor(private readonly response: () => Promise<{ status: number; ok: boolean }>) {}
  request(): Promise<{ status: number; ok: boolean }> {
    this.calls += 1;
    return this.response();
  }
}

test("starts the sidecar, waits for HTTP success, then navigates", async () => {
  const view = new FakeView();
  const runtime = new FakeRuntime({ kind: "available", executablePath: "C:\\Bun\\bun.exe", version: "1.4.0" });
  const supervisor = new FakeSupervisor();
  const readiness = new FakeReadiness(async () => ({ status: 200, ok: true }));
  const controller = new StartupController({
    manifest: manifest(),
    runtime,
    supervisor,
    readiness,
    view,
    platform: windows11Platform,
  });

  await expect(controller.start()).resolves.toMatchObject({ kind: "ready", url: referenceManifest.navigation.url });
  expect(readiness.calls).toBe(1);
  expect(view.states[0]).toMatchObject({
    kind: "loading",
    appName: referenceManifest.app.name,
    bunVersion: referenceManifest.bun.version,
  });
  expect(view.navigations).toEqual([referenceManifest.navigation.url]);
  expect(supervisor.launches[0]).toMatchObject({
    parentPid: process.pid,
    bunExecutablePath: "C:\\Bun\\bun.exe",
    sidecarEntrypoint: "C:\\app\\payload\\sidecar.ts",
  });
});

test("holds the ready sidecar at a launch-token gate before navigation", async () => {
  const view = new FakeView();
  const gateway = new FakeLaunchTokenGateway({ kind: "accepted" });
  const controller = new StartupController({
    manifest: manifest({ authentication: { tokenExchangeUrl: "http://127.0.0.1:43173/" } }),
    runtime: new FakeRuntime({ kind: "available", executablePath: "C:\\Bun\\bun.exe", version: "1.4.0" }),
    supervisor: new FakeSupervisor(),
    readiness: new FakeReadiness(async () => ({ status: 200, ok: true })),
    launchTokenGateway: gateway,
    view,
    platform: windows11Platform,
  });

  await expect(controller.start()).resolves.toMatchObject({ kind: "launch-token" });
  expect(view.navigations).toEqual([]);
  expect(view.launchTokenStates).toEqual([{ kind: "launch-token" }]);

  await expect(controller.submitLaunchToken("test-launch-token")).resolves.toMatchObject({ kind: "ready" });
  expect(gateway.tokens).toEqual(["test-launch-token"]);
  expect(view.navigations).toEqual([referenceManifest.navigation.url]);
});

test("uses a validated token navigation fallback without retaining it in ready state", async () => {
  const view = new FakeView();
  const navigationUrl = "http://127.0.0.1:43173/?token=test-launch-token";
  const gateway = new FakeLaunchTokenGateway({ kind: "accepted", navigationUrl });
  const controller = new StartupController({
    manifest: manifest({ authentication: { tokenExchangeUrl: "http://127.0.0.1:43173/" } }),
    runtime: new FakeRuntime({ kind: "available", executablePath: "C:\\Bun\\bun.exe", version: "1.4.0" }),
    supervisor: new FakeSupervisor(),
    readiness: new FakeReadiness(async () => ({ status: 200, ok: true })),
    launchTokenGateway: gateway,
    view,
    platform: windows11Platform,
  });

  await controller.start();
  await expect(controller.submitLaunchToken("test-launch-token")).resolves.toEqual({
    kind: "ready",
    url: referenceManifest.navigation.url,
  });
  expect(view.navigations).toEqual([navigationUrl]);
});

test("treats HTTP 401 as ready when a launch-token gate owns authentication", async () => {
  const view = new FakeView();
  let now = 0;
  const controller = new StartupController({
    manifest: manifest({
      readiness: { ...referenceManifest.readiness, timeoutMs: 1_000 },
      authentication: { tokenExchangeUrl: "http://127.0.0.1:43173/" },
    }),
    runtime: new FakeRuntime({ kind: "available", executablePath: "C:\\Bun\\bun.exe", version: "1.4.0" }),
    supervisor: new FakeSupervisor(),
    readiness: new FakeReadiness(async () => ({ status: 401, ok: false })),
    launchTokenGateway: new FakeLaunchTokenGateway({ kind: "accepted" }),
    view,
    platform: windows11Platform,
    now: () => now,
    sleep: async (milliseconds) => {
      if (milliseconds === 1_000) return new Promise<void>(() => undefined);
      now = 1_000;
    },
  });

  await expect(controller.start()).resolves.toMatchObject({ kind: "launch-token" });
  expect(view.launchTokenStates).toEqual([{ kind: "launch-token" }]);
  expect(view.navigations).toEqual([]);
});

test("keeps the gate visible when the launch token is rejected", async () => {
  const view = new FakeView();
  const controller = new StartupController({
    manifest: manifest({ authentication: { tokenExchangeUrl: "http://127.0.0.1:43173/" } }),
    runtime: new FakeRuntime({ kind: "available", executablePath: "C:\\Bun\\bun.exe", version: "1.4.0" }),
    supervisor: new FakeSupervisor(),
    readiness: new FakeReadiness(async () => ({ status: 200, ok: true })),
    launchTokenGateway: new FakeLaunchTokenGateway({ kind: "rejected" }),
    view,
    platform: windows11Platform,
  });

  await controller.start();
  await expect(controller.submitLaunchToken("expired-token")).resolves.toMatchObject({ kind: "launch-token" });
  expect(view.navigations).toEqual([]);
  expect(view.launchTokenStates.at(-1)).toMatchObject({ message: expect.stringContaining("invalid or expired") });
});

test("keeps the startup view usable and does not provision before consent", async () => {
  const view = new FakeView();
  const runtime = new FakeRuntime({
    kind: "missing",
    diagnostic: "Bun 1.4.0 was not found",
  }, {
    kind: "available",
    executablePath: "C:\\Bun\\bun.exe",
    version: "1.4.0",
  });
  const supervisor = new FakeSupervisor();
  const controller = new StartupController({
    manifest: manifest(),
    runtime,
    supervisor,
    readiness: new FakeReadiness(async () => ({ status: 200, ok: true })),
    view,
    platform: windows11Platform,
  });

  await expect(controller.start()).resolves.toMatchObject({ kind: "failed", reason: "bun-missing", canInstall: true });
  expect(runtime.installCalls).toBe(0);
  await expect(controller.installBun()).resolves.toMatchObject({ kind: "ready" });
  expect(runtime.installCalls).toBe(1);
  expect(supervisor.launches).toHaveLength(1);
});

test("reports early sidecar exit and never navigates", async () => {
  const view = new FakeView();
  const supervisor = new FakeSupervisor(
    () => new FakeHandle(Promise.resolve({ exitCode: 17 })),
  );
  const controller = new StartupController({
    manifest: manifest(),
    runtime: new FakeRuntime({ kind: "available", executablePath: "C:\\Bun\\bun.exe", version: "1.4.0" }),
    supervisor,
    readiness: new FakeReadiness(() => new Promise(() => undefined)),
    view,
    platform: windows11Platform,
  });
  await expect(controller.start()).resolves.toMatchObject({ kind: "failed", reason: "sidecar-exited" });
  expect(view.navigations).toHaveLength(0);
  expect(supervisor.handles[0].stopCalls).toBe(1);
});

test("reports a supervisor process-start failure separately from a sidecar exit", async () => {
  const view = new FakeView();
  const supervisor = new FakeSupervisor(
    () => new FakeHandle(Promise.resolve({ exitCode: null, error: "ENOENT: missing supervisor" })),
  );
  const controller = new StartupController({
    manifest: manifest(),
    runtime: new FakeRuntime({ kind: "available", executablePath: "C:\\Bun\\bun.exe", version: "1.4.0" }),
    supervisor,
    readiness: new FakeReadiness(() => new Promise(() => undefined)),
    view,
    platform: windows11Platform,
  });
  await expect(controller.start()).resolves.toMatchObject({ kind: "failed", reason: "supervisor-failure" });
  expect(view.navigations).toHaveLength(0);
});

test("classifies Win32 supervisor setup failures with operation and code", async () => {
  const view = new FakeView();
  const supervisor = new FakeSupervisor(
    () => new FakeHandle(Promise.resolve({
      exitCode: 1,
      stderr: "error: AssignProcessToJobObject failed (Win32 error 5)",
      failure: { operation: "AssignProcessToJobObject", win32Code: 5 },
    })),
  );
  const controller = new StartupController({
    manifest: manifest(),
    runtime: new FakeRuntime({ kind: "available", executablePath: "C:\\Bun\\bun.exe", version: "1.4.0" }),
    supervisor,
    readiness: new FakeReadiness(() => new Promise(() => undefined)),
    view,
    platform: windows11Platform,
  });
  await expect(controller.start()).resolves.toMatchObject({
    kind: "failed",
    reason: "supervisor-failure",
    diagnostic: expect.stringContaining("AssignProcessToJobObject (Win32 error 5)"),
  });
});

test("treats bounded supervisor stderr as internal supervisor failure evidence", async () => {
  const view = new FakeView();
  const supervisor = new FakeSupervisor(
    () => new FakeHandle(Promise.resolve({ exitCode: 1, stderr: "internal supervisor failure" })),
  );
  const controller = new StartupController({
    manifest: manifest(),
    runtime: new FakeRuntime({ kind: "available", executablePath: "C:\\Bun\\bun.exe", version: "1.4.0" }),
    supervisor,
    readiness: new FakeReadiness(() => new Promise(() => undefined)),
    view,
    platform: windows11Platform,
  });
  await expect(controller.start()).resolves.toMatchObject({
    kind: "failed",
    reason: "supervisor-failure",
    diagnostic: expect.stringContaining("internal failure"),
  });
});

test("times out non-success responses with an actionable state", async () => {
  const view = new FakeView();
  const controller = new StartupController({
    manifest: manifest({ readiness: { ...referenceManifest.readiness, timeoutMs: 250 } }),
    runtime: new FakeRuntime({ kind: "available", executablePath: "C:\\Bun\\bun.exe", version: "1.4.0" }),
    supervisor: new FakeSupervisor(),
    readiness: new FakeReadiness(async () => ({ status: 503, ok: false })),
    view,
    platform: windows11Platform,
    pollIntervalMs: 100,
  });
  await expect(controller.start()).resolves.toMatchObject({ kind: "failed", reason: "readiness-invalid-response" });
  expect(view.navigations).toHaveLength(0);
});

test("stop is idempotent and cleanup owns the active supervisor", async () => {
  const handle = new FakeHandle();
  const supervisor = new FakeSupervisor(() => handle);
  const controller = new StartupController({
    manifest: manifest(),
    runtime: new FakeRuntime({ kind: "available", executablePath: "C:\\Bun\\bun.exe", version: "1.4.0" }),
    supervisor,
    readiness: new FakeReadiness(() => new Promise(() => undefined)),
    view: new FakeView(),
    platform: windows11Platform,
  });
  const start = controller.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.all([controller.stop(), controller.stop()]);
  await start;
  expect(handle.stopCalls).toBe(1);
  expect(controller.getState()).toEqual({ kind: "stopping" });
});

test("rejects unsupported platforms before resolving Bun or launching", async () => {
  const runtime = new FakeRuntime({ kind: "available", executablePath: "C:\\Bun\\bun.exe", version: "1.4.0" });
  const supervisor = new FakeSupervisor();
  const controller = new StartupController({
    manifest: manifest(),
    runtime,
    supervisor,
    view: new FakeView(),
    platform: { platform: "linux", arch: "x64", release: "6.8.0", build: undefined },
  });
  await expect(controller.start()).resolves.toMatchObject({ kind: "failed", reason: "unsupported-platform" });
  expect(runtime.resolveCalls).toBe(0);
  expect(supervisor.launches).toHaveLength(0);
});

test("rejects Windows 10 x64 before resolving Bun or launching", async () => {
  const runtime = new FakeRuntime({ kind: "available", executablePath: "C:\\Bun\\bun.exe", version: "1.4.0" });
  const supervisor = new FakeSupervisor();
  const controller = new StartupController({
    manifest: manifest(),
    runtime,
    supervisor,
    view: new FakeView(),
    platform: { platform: "win32", arch: "x64", release: "10.0.19045", build: 19045 },
  });
  await expect(controller.start()).resolves.toMatchObject({
    kind: "failed",
    reason: "unsupported-platform",
    diagnostic: expect.stringContaining("Windows 10 x64 and earlier are unsupported"),
  });
  expect(runtime.resolveCalls).toBe(0);
  expect(supervisor.launches).toHaveLength(0);
});

test("does not launch after an early stop wins the startup race", async () => {
  const runtime = new FakeRuntime({ kind: "available", executablePath: "C:\\Bun\\bun.exe", version: "1.4.0" });
  const supervisor = new FakeSupervisor();
  const controller = new StartupController({
    manifest: manifest(),
    runtime,
    supervisor,
    view: new FakeView(),
    platform: windows11Platform,
  });
  const start = controller.start();
  await controller.stop();
  await start;
  expect(supervisor.launches).toHaveLength(0);
});

test("does not publish ready or navigate when stop wins after readiness", async () => {
  const view = new FakeView();
  const handle = new FakeHandle();
  const supervisor = new FakeSupervisor(() => handle);
  let controller!: StartupController;
  const readiness = new FakeReadiness(() =>
    Promise.resolve({ status: 200, ok: true }).then((response) => {
      void controller.stop();
      return response;
    }),
  );
  controller = new StartupController({
    manifest: manifest(),
    runtime: new FakeRuntime({ kind: "available", executablePath: "C:\\Bun\\bun.exe", version: "1.4.0" }),
    supervisor,
    readiness,
    view,
    platform: windows11Platform,
  });

  await controller.start();
  expect(controller.getState()).toEqual({ kind: "stopping" });
  expect(view.navigations).toHaveLength(0);
  expect(handle.stopCalls).toBe(1);
});
