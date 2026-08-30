import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const REQUIRED_ZIG_VERSION = "0.16.0";
const root = resolve(import.meta.dir, "..");
const output = resolve(root, "supervisor/bin/dsh-sidecar-supervisor.exe");

function run(command: string, args: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

export function buildSupervisor(): string {
  const zig = Bun.which("zig");
  if (!zig) {
    throw new Error(
      `Zig ${REQUIRED_ZIG_VERSION} is required to build the Windows x64 supervisor; install that exact compiler and retry.`,
    );
  }

  const version = run(zig, ["version"]);
  if (version.exitCode !== 0 || version.stdout.trim() !== REQUIRED_ZIG_VERSION) {
    throw new Error(
      `The supervisor build requires Zig ${REQUIRED_ZIG_VERSION} (found ${version.stdout.trim() || "unavailable"}).`,
    );
  }

  mkdirSync(dirname(output), { recursive: true });
  const build = run(zig, [
    "build-exe",
    resolve(root, "supervisor/src/main.zig"),
    "-target",
    "x86_64-windows-msvc",
    "-O",
    "ReleaseSafe",
    "-femit-bin=" + output,
  ]);
  if (build.exitCode !== 0) {
    throw new Error(`Zig supervisor build failed (exit code ${build.exitCode}).\n${build.stderr}`);
  }
  if (!existsSync(output)) {
    throw new Error(`Zig reported success but did not produce the supervisor executable: ${output}`);
  }

  console.log(`Built Windows x64 supervisor with Zig ${REQUIRED_ZIG_VERSION}: ${output}`);
  return output;
}

if (import.meta.main) buildSupervisor();
