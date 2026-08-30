import { buildSupervisor } from "./build-supervisor";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(
    `Windows x64 is required for the Electrobun host (received platform=${process.platform}, arch=${process.arch}).`,
  );
}

buildSupervisor();
const hutch = Bun.which("hutch");
if (!hutch) throw new Error("Hutch is required; install it from https://hutch.blackboard.sh before developing.");
const result = Bun.spawnSync([hutch, "electrobun", "dev", "--watch"], {
  stdout: "inherit",
  stderr: "inherit",
});
if (result.exitCode !== 0) throw new Error(`Hutch Electrobun development failed with exit code ${result.exitCode}.`);
