import type { ProductManifest } from "./src/host/manifest";

/**
 * The reference product's single build-time manifest. Product repositories
 * replace this file (and stage their own payload) without changing the host.
 */
export const referenceManifest = {
  app: {
    name: "DSH Reference Host",
    identifier: "dev.dsh.reference-host",
    version: "0.1.0",
  },
  bun: {
    version: "1.4.0",
    packageId: "Oven-sh.Bun",
  },
  sidecar: {
    entrypoint: "payload/sidecar/reference-sidecar.ts",
    args: [],
  },
  readiness: {
    url: "http://127.0.0.1:43173/health",
    timeoutMs: 15_000,
  },
  navigation: {
    url: "http://127.0.0.1:43173/",
  },
  window: {
    title: "DSH Reference Host",
    width: 1100,
    height: 720,
  },
  supervisor: {
    executable: "bin/dsh-sidecar-supervisor.exe",
  },
} satisfies ProductManifest;

export default referenceManifest;
