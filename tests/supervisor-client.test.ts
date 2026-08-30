import { describe, expect, test } from "bun:test";

import { buildSupervisorArgs, WindowsSupervisorLauncher, type SupervisorSpawner } from "../src/host/supervisor-client";
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
