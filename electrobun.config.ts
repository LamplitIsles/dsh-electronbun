import type { ElectrobunConfig } from "electrobun";
import referenceManifest from "./product.manifest";

const supervisorSource = `supervisor/${referenceManifest.supervisor.executable}`;

/**
 * Electrobun owns the desktop shell; the product manifest owns the sidecar
 * contract. Keep this file limited to packaging and native renderer choices.
 */
const config = {
  app: {
    name: referenceManifest.app.name,
    identifier: referenceManifest.app.identifier,
    version: referenceManifest.app.version,
  },
  build: {
    mainProcess: "cottontail",
    cottontail: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      main: {
        entrypoint: "src/mainview/index.ts",
      },
    },
    copy: {
      "src/mainview/index.html": "views/main/index.html",
      [referenceManifest.sidecar.entrypoint]: referenceManifest.sidecar.entrypoint,
      [supervisorSource]: referenceManifest.supervisor.executable,
    },
    win: {
      // The reference host intentionally uses the system WebView2 renderer.
      defaultRenderer: "native",
      bundleCEF: false,
      bundleWGPU: false,
    },
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
} satisfies ElectrobunConfig;

export default config;
