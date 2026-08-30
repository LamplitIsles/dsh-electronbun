import { describe, expect, test } from "bun:test";

import {
  BunProvisioner,
  BunRuntimeResolver,
  buildWingetInstallArgs,
  type CommandResult,
  type CommandRunner,
} from "../src/host/bun-runtime";

class FakeRunner implements CommandRunner {
  readonly calls: { command: string; args: readonly string[] }[] = [];
  constructor(private readonly responses: (command: string, args: readonly string[]) => CommandResult) {}
  async run(command: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    return this.responses(command, args);
  }
}

const fakeFileSystem = {
  isFile: (_path: string) => true,
};

describe("Bun runtime resolution", () => {
  test("selects an absolute candidate with the exact version", async () => {
    const runner = new FakeRunner((command, args) => {
      if (command === "where.exe") return { exitCode: 0, stdout: "C:\\Bun\\bun.exe\r\n" };
      if (args[0] === "--version") return { exitCode: 0, stdout: "1.4.0\n" };
      return { exitCode: 1 };
    });
    const resolver = new BunRuntimeResolver({
      runner,
      fileSystem: fakeFileSystem,
      candidatePaths: ["C:\\Bun\\bun.exe"],
      environment: {},
    });
    await expect(resolver.resolve("1.4.0")).resolves.toEqual({
      kind: "available",
      executablePath: "C:\\Bun\\bun.exe",
      version: "1.4.0",
    });
    expect(runner.calls.some((call) => call.args[0] === "--version")).toBe(true);
  });

  test("reports incompatible candidates without accepting them", async () => {
    const runner = new FakeRunner((command, args) =>
      command === "where.exe" ? { exitCode: 0, stdout: "/tmp/bun.exe\n" } : { exitCode: 0, stdout: "1.3.13\n" },
    );
    const resolver = new BunRuntimeResolver({ runner, fileSystem: fakeFileSystem, environment: {} });
    const result = await resolver.resolve("1.4.0");
    expect(result.kind).toBe("incompatible");
    if (result.kind === "incompatible") expect(result.candidates[0]).toEqual({ path: "/tmp/bun.exe", version: "1.3.13" });
  });

  test("constructs a direct exact WinGet invocation", () => {
    expect(buildWingetInstallArgs("1.4.0")).toEqual([
      "install",
      "--id",
      "Oven-sh.Bun",
      "--version",
      "1.4.0",
      "--exact",
      "--accept-source-agreements",
      "--accept-package-agreements",
      "--silent",
    ]);
  });

  test("rejects an invalid install declaration before invoking WinGet", async () => {
    const runner = new FakeRunner(() => ({ exitCode: 0 }));
    const resolver = new BunRuntimeResolver({ runner, fileSystem: fakeFileSystem, environment: {} });
    await expect(new BunProvisioner({ resolver, runner }).install({
      bun: { version: "1.4", packageId: "Oven-sh.Bun" },
    })).resolves.toMatchObject({ kind: "failed", code: "install-failed" });
    expect(runner.calls).toHaveLength(0);
  });

  test("classifies WinGet unavailable, decline, and install failure", async () => {
    const resolver = new BunRuntimeResolver({ runner: new FakeRunner(() => ({ exitCode: 1 })), fileSystem: fakeFileSystem, environment: {} });
    const unavailableRunner = new FakeRunner((command) =>
      command === "winget.exe" ? { exitCode: null, errorCode: "ENOENT" } : { exitCode: 1 },
    );
    await expect(new BunProvisioner({ resolver, runner: unavailableRunner }).install({ bun: { version: "1.4.0", packageId: "Oven-sh.Bun" } })).resolves.toMatchObject({
      kind: "failed",
      code: "winget-unavailable",
    });

    const declinedRunner = new FakeRunner((_command, args) =>
      args[0] === "--version" ? { exitCode: 0 } : { exitCode: 1223 },
    );
    await expect(new BunProvisioner({ resolver, runner: declinedRunner }).install({ bun: { version: "1.4.0", packageId: "Oven-sh.Bun" } })).resolves.toMatchObject({
      kind: "failed",
      code: "user-declined",
    });

    const failureRunner = new FakeRunner((_command, args) =>
      args[0] === "--version" ? { exitCode: 0 } : { exitCode: 42 },
    );
    await expect(new BunProvisioner({ resolver, runner: failureRunner }).install({ bun: { version: "1.4.0", packageId: "Oven-sh.Bun" } })).resolves.toMatchObject({
      kind: "failed",
      code: "install-failed",
    });
  });

  test("does not invoke WinGet until install is called", async () => {
    const runner = new FakeRunner((command, args) => {
      if (command === "where.exe") return { exitCode: 1 };
      return args[0] === "--version" ? { exitCode: 0, stdout: "1.4.0" } : { exitCode: 0 };
    });
    const resolver = new BunRuntimeResolver({ runner, fileSystem: fakeFileSystem, candidatePaths: [], environment: {} });
    await resolver.resolve("1.4.0");
    expect(runner.calls.some((call) => call.command === "winget.exe")).toBe(false);
  });

  test("re-resolves a fresh absolute path after successful provisioning", async () => {
    const runner = new FakeRunner((command, args) => {
      if (command === "winget.exe" && args[0] === "--version") return { exitCode: 0, stdout: "v1" };
      if (command === "winget.exe") return { exitCode: 0 };
      if (command === "where.exe") return { exitCode: 0, stdout: "C:\\Users\\me\\.bun\\bin\\bun.exe\r\n" };
      return { exitCode: 0, stdout: "1.4.0\n" };
    });
    const resolver = new BunRuntimeResolver({ runner, fileSystem: fakeFileSystem, environment: {} });
    const result = await new BunProvisioner({ resolver, runner }).install({
      bun: { version: "1.4.0", packageId: "Oven-sh.Bun" },
    });
    expect(result).toEqual({
      kind: "available",
      executablePath: "C:\\Users\\me\\.bun\\bin\\bun.exe",
      version: "1.4.0",
    });
    expect(runner.calls.some((call) => call.command === "winget.exe" && call.args[0] === "install")).toBe(true);
  });

  test("distinguishes unresolved and post-install version mismatch", async () => {
    const unavailable = new FakeRunner((command, args) => {
      if (command === "winget.exe") return { exitCode: 0 };
      return { exitCode: 1 };
    });
    const noPathResolver = new BunRuntimeResolver({ runner: unavailable, fileSystem: fakeFileSystem, environment: {} });
    await expect(new BunProvisioner({ resolver: noPathResolver, runner: unavailable }).install({
      bun: { version: "1.4.0", packageId: "Oven-sh.Bun" },
    })).resolves.toMatchObject({ kind: "failed", code: "unresolved-executable" });

    const mismatch = new FakeRunner((command, args) => {
      if (command === "winget.exe") return { exitCode: 0 };
      if (command === "where.exe") return { exitCode: 0, stdout: "C:\\Bun\\bun.exe\n" };
      return { exitCode: 0, stdout: "1.3.13\n" };
    });
    const mismatchResolver = new BunRuntimeResolver({ runner: mismatch, fileSystem: fakeFileSystem, environment: {} });
    await expect(new BunProvisioner({ resolver: mismatchResolver, runner: mismatch }).install({
      bun: { version: "1.4.0", packageId: "Oven-sh.Bun" },
    })).resolves.toMatchObject({ kind: "failed", code: "post-install-version-mismatch" });
  });
});
