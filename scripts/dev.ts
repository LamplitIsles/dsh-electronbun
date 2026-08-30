import { buildSupervisor } from "./build-supervisor";
import { runProjectElectrobun } from "./project-electrobun";
import { assertSupportedWindows11X64, readHostPlatform } from "../src/host/platform";

assertSupportedWindows11X64(readHostPlatform());

buildSupervisor();
runProjectElectrobun(["dev", "--watch"], "development");
