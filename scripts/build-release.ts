import { buildSupervisor } from "./build-supervisor";
import { runProjectElectrobun } from "./project-electrobun";
import { assertSupportedWindows11X64, readHostPlatform } from "../src/host/platform";

const environment = process.argv[2] ?? "stable";
if (environment !== "dev" && environment !== "stable") {
  throw new Error("usage: bun run scripts/build-release.ts [dev|stable]");
}
assertSupportedWindows11X64(readHostPlatform());

buildSupervisor();
runProjectElectrobun(["build", `--env=${environment}`], `${environment} build`);
