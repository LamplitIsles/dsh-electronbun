import type { ValidatedProductManifest } from "./manifest";

export interface StartupWindowSettings {
  title: string;
  width: number;
  height: number;
}

/** Safe settings used when platform or manifest validation fails. */
export const SAFE_STARTUP_WINDOW_SETTINGS: Readonly<StartupWindowSettings> = Object.freeze({
  title: "Desktop host",
  width: 960,
  height: 640,
});

/** Select configured settings only from a manifest that has already validated. */
export function selectStartupWindowSettings(
  manifest: ValidatedProductManifest | undefined,
): Readonly<StartupWindowSettings> {
  return manifest?.window ?? SAFE_STARTUP_WINDOW_SETTINGS;
}
