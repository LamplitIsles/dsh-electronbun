import { buildSupervisor } from "./build-supervisor";

const environment = process.argv[2] ?? "stable";
if (environment !== "dev" && environment !== "stable") {
  throw new Error("usage: bun run scripts/build-release.ts [dev|stable]");
}
if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(
    `Windows x64 is required for Electrobun release artifacts (received platform=${process.platform}, arch=${process.arch}).`,
  );
}

buildSupervisor();
const hutch = Bun.which("hutch");
if (!hutch) throw new Error("Hutch is required; install it from https://hutch.blackboard.sh before building.");
const result = Bun.spawnSync([hutch, "electrobun", "build", `--env=${environment}`], {
  stdout: "inherit",
  stderr: "inherit",
});
if (result.exitCode !== 0) throw new Error(`Hutch Electrobun ${environment} build failed with exit code ${result.exitCode}.`);
