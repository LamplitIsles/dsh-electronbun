import { describe, expect, test } from "bun:test";

import {
  boundSupervisorStderr,
  buildSupervisorArgs,
  MAX_SUPERVISOR_STDERR_BYTES,
  parseSupervisorFailureEvidence,
  WindowsSupervisorLauncher,
  type SupervisorSpawner,
} from "../src/host/supervisor-client";
import type { SupervisorChild } from "../src/host/supervisor-client";

test("passes supervisor and sidecar arguments as argv without a shell", async () => {
  const calls: { executable: string; args: readonly string[] }[] = [];
  const child: SupervisorChild = {
    wait: async () => ({ exitCode: 0 }),
    stop: async () => undefined,
  };
  const spawner: SupervisorSpawner = (executable, args) => {
    calls.push({ executable, args });
    return child;
  };
  const launcher = new WindowsSupervisorLauncher(spawner);
  await launcher.launch({
    executablePath: "C:\\app\\supervisor.exe",
    parentPid: 99,
    bunExecutablePath: "C:\\Program Files\\Bun\\bun.exe",
    sidecarEntrypoint: "C:\\app\\sidecar.ts",
    args: ["--title", "a value", "$(never-shell)"]
  });
  expect(calls).toEqual([{
    executable: "C:\\app\\supervisor.exe",
    args: [
      "--parent-pid",
      "99",
      "--bun",
      "C:\\Program Files\\Bun\\bun.exe",
      "--entrypoint",
      "C:\\app\\sidecar.ts",
      "--",
      "--title",
      "a value",
      "$(never-shell)",
    ],
  }]);
});

test("builds deterministic supervisor arguments", () => {
  expect(buildSupervisorArgs({
    parentPid: 7,
    bunExecutablePath: "/bun.exe",
    sidecarEntrypoint: "/sidecar.ts",
    args: [],
  })).toEqual(["--parent-pid", "7", "--bun", "/bun.exe", "--entrypoint", "/sidecar.ts", "--"]);
});

test("extracts stable Win32 operation evidence from supervisor stderr", () => {
  for (const [operation, win32Code] of [
    ["CreateJobObjectW", 6],
    ["SetInformationJobObject", 87],
    ["CreateProcessW", 2],
    ["AssignProcessToJobObject", 5],
  ] as const) {
    expect(parseSupervisorFailureEvidence(`error: ${operation} failed (Win32 error ${win32Code})`))
      .toEqual({ operation, win32Code });
  }
  expect(parseSupervisorFailureEvidence("sidecar exited normally")).toBeUndefined();
});

test("bounds captured supervisor stderr evidence", () => {
  const bounded = boundSupervisorStderr("x".repeat(MAX_SUPERVISOR_STDERR_BYTES + 100));
  expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(MAX_SUPERVISOR_STDERR_BYTES);
  expect(bounded).toContain("[…truncated]");
});

describe("supervisor path validation", () => {
  test("rejects relative executable paths", async () => {
    const launcher = new WindowsSupervisorLauncher(() => ({ wait: async () => ({ exitCode: 0 }), stop: async () => undefined }));
    await expect(launcher.launch({
      executablePath: "supervisor.exe",
      parentPid: 1,
      bunExecutablePath: "C:\\bun.exe",
      sidecarEntrypoint: "C:\\sidecar.ts",
      args: [],
    })).rejects.toThrow(/absolute/);
  });
});
