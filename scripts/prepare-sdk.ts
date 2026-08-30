import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { runProjectElectrobun } from "./project-electrobun";

const projection = resolve(import.meta.dir, "../.hutch/devkit/tsconfig.json");

if (!existsSync(projection)) {
  runProjectElectrobun(["prepare"], "SDK preparation");
}
if (!existsSync(projection)) {
  throw new Error(`Hutch did not project the Electrobun devkit at ${projection}.`);
}
