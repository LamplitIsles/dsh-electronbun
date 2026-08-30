import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("reference sidecar descendant mode is self-contained", async () => {
  const child = Bun.spawn([
    process.execPath,
    resolve(import.meta.dir, "../payload/sidecar/reference-sidecar.ts"),
    "--fixture-descendant",
  ], {
    stdout: "ignore",
    stderr: "pipe",
  });

  try {
    await Bun.sleep(25);
    expect(child.exitCode).toBeNull();
  } finally {
    child.kill();
    await child.exited;
  }
});
