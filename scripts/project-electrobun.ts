import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const ELECTROBUN_VERSION = "2.0.1";
export const PAIRED_HUTCH_VERSION = "0.24.3";

const bootstrap = resolve(import.meta.dir, "../node_modules/electrobun/bin/electrobun.cjs");

/** Run Electrobun through the versioned npm bootstrap, never a PATH Hutch. */
export function runProjectElectrobun(args: readonly string[], action: string): void {
  if (!existsSync(bootstrap)) {
    throw new Error(`Electrobun ${ELECTROBUN_VERSION} is not installed; run bun install --frozen-lockfile first.`);
  }
  const result = Bun.spawnSync([process.execPath, bootstrap, ...args], {
    env: {
      ...process.env,
      HUTCH_DEFAULT_CLI: PAIRED_HUTCH_VERSION,
      HUTCH_DEFAULT_ELECTROBUN: ELECTROBUN_VERSION,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Project-paired Electrobun ${action} failed with exit code ${result.exitCode}.`);
  }
}
