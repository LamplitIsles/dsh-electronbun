import { buildSupervisor } from "./build-supervisor";
import { runProjectElectrobun } from "./project-electrobun";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(
    `Windows x64 is required for the Electrobun host (received platform=${process.platform}, arch=${process.arch}).`,
  );
}

buildSupervisor();
runProjectElectrobun(["dev", "--watch"], "development");
