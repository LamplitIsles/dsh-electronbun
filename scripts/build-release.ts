import { buildSupervisor } from "./build-supervisor";
import { runProjectElectrobun } from "./project-electrobun";

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
runProjectElectrobun(["build", `--env=${environment}`], `${environment} build`);
