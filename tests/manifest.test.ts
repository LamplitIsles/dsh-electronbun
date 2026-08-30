import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { referenceManifest } from "../product.manifest";
import {
  ManifestValidationError,
  tryValidateProductManifest,
  validateProductManifest,
} from "../src/host/manifest";

function stagedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-electronbun-manifest-"));
  mkdirSync(join(root, "payload", "sidecar"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "payload", "sidecar", "reference-sidecar.ts"), "export {};\n");
  writeFileSync(join(root, "bin", "dsh-sidecar-supervisor.exe"), "fixture\n");
  return root;
}

describe("product manifest", () => {
  test("accepts the reference contract and resolves staged files", () => {
    const root = stagedRoot();
    try {
      const manifest = validateProductManifest(referenceManifest, { stagedRoot: root });
      expect(manifest.bun.version).toBe("1.4.0");
      expect(manifest.bun.packageId).toBe("Oven-sh.Bun");
      expect(manifest.resolvedSidecarEntrypoint).toBe(join(root, "payload", "sidecar", "reference-sidecar.ts"));
      expect(manifest.resolvedSupervisorExecutable).toBe(join(root, "bin", "dsh-sidecar-supervisor.exe"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts the literal loopback host with the default HTTP port", () => {
    const root = stagedRoot();
    try {
      const candidate = structuredClone(referenceManifest) as Record<string, any>;
      candidate.readiness.url = "http://127.0.0.1/health";
      candidate.navigation.url = "http://127.0.0.1/";
      const manifest = validateProductManifest(candidate, { stagedRoot: root });
      expect(manifest.readiness.url).toBe("http://127.0.0.1/health");
      expect(manifest.navigation.url).toBe("http://127.0.0.1/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["non-loopback readiness", { readiness: { url: "http://localhost:43173/health" } }],
    ["alternate IPv4 spelling", { readiness: { url: "http://127.0.0.01:43173/health" } }],
    ["https readiness", { readiness: { url: "https://127.0.0.1:43173/health" } }],
    ["readiness traversal", { readiness: { url: "http://127.0.0.1:43173/../secret" } }],
    ["traversal entrypoint", { sidecar: { entrypoint: "../outside.ts" } }],
    ["absolute entrypoint", { sidecar: { entrypoint: "/tmp/sidecar.ts" } }],
    ["control-character argument", { sidecar: { args: ["--label\nunsafe"] } }],
    ["invalid Bun version", { bun: { version: "^1.4.0" } }],
    ["invalid timeout", { readiness: { timeoutMs: 0 } }],
    ["invalid window", { window: { width: 0, height: 0 } }],
  ])("rejects %s before process launch", (_name, override) => {
    const root = stagedRoot();
    try {
      const candidate = structuredClone(referenceManifest) as Record<string, unknown>;
      for (const [key, value] of Object.entries(override)) {
        candidate[key] = { ...(candidate[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
      }
      const result = tryValidateProductManifest(candidate, { stagedRoot: root });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(ManifestValidationError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects missing staged payload", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-electronbun-missing-"));
    try {
      expect(() => validateProductManifest(referenceManifest, { stagedRoot: root })).toThrow(/staged payload|missing/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an intermediate symlink that escapes the staged root", () => {
    const root = stagedRoot();
    const outside = mkdtempSync(join(tmpdir(), "dsh-electronbun-manifest-outside-"));
    try {
      const escapedSidecarRoot = join(outside, "sidecar");
      mkdirSync(escapedSidecarRoot, { recursive: true });
      writeFileSync(join(escapedSidecarRoot, "reference-sidecar.ts"), "export {}\n");
      rmSync(join(root, "payload", "sidecar"), { recursive: true, force: true });
      symlinkSync(
        escapedSidecarRoot,
        join(root, "payload", "sidecar"),
        process.platform === "win32" ? "junction" : "dir",
      );

      expect(() => validateProductManifest(referenceManifest, { stagedRoot: root })).toThrow(
        /outside the staged payload root/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects a supervisor path through an intermediate symlink", () => {
    const root = stagedRoot();
    const outside = mkdtempSync(join(tmpdir(), "dsh-electronbun-supervisor-outside-"));
    try {
      const escapedBinRoot = join(outside, "bin");
      mkdirSync(escapedBinRoot, { recursive: true });
      writeFileSync(join(escapedBinRoot, "dsh-sidecar-supervisor.exe"), "fixture\n");
      rmSync(join(root, "bin"), { recursive: true, force: true });
      symlinkSync(
        escapedBinRoot,
        join(root, "bin"),
        process.platform === "win32" ? "junction" : "dir",
      );

      expect(() => validateProductManifest(referenceManifest, { stagedRoot: root })).toThrow(
        /outside the staged payload root/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
