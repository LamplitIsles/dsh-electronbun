import { expect, test } from "bun:test";

import { referenceManifest } from "../product.manifest";
import type { ValidatedProductManifest } from "../src/host/manifest";
import {
  SAFE_STARTUP_WINDOW_SETTINGS,
  selectStartupWindowSettings,
} from "../src/host/startup-window";

test("uses fixed safe window settings until a manifest has validated", () => {
  expect(selectStartupWindowSettings(undefined)).toEqual({
    title: "Desktop host",
    width: 960,
    height: 640,
  });
  expect(SAFE_STARTUP_WINDOW_SETTINGS).toEqual(selectStartupWindowSettings(undefined));
});

test("takes configured window settings only from a validated manifest", () => {
  const validated = {
    ...referenceManifest,
    resolvedSidecarEntrypoint: "C:\\app\\payload\\sidecar.ts",
    resolvedSupervisorExecutable: "C:\\app\\bin\\supervisor.exe",
  } as ValidatedProductManifest;
  expect(selectStartupWindowSettings(validated)).toEqual(referenceManifest.window);
});
