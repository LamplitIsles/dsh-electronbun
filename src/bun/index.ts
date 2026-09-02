import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import Electrobun, { BrowserWindow, PATHS, Session } from "electrobun/main";

import referenceManifest from "../../product.manifest";
import {
  type ValidatedProductManifest,
  validateProductManifest,
} from "../host/manifest";
import { WindowsBunRuntimeGateway } from "../host/runtime-gateway";
import { assertSupportedWindows11X64, readHostPlatform } from "../host/platform";
import { StartupController, type StartupState, type StartupView } from "../host/startup-controller";
import { WindowsSupervisorLauncher } from "../host/supervisor-client";
import { DshLaunchTokenGateway } from "../host/launch-token";
import {
  SAFE_STARTUP_WINDOW_SETTINGS,
  selectStartupWindowSettings,
  type StartupWindowSettings,
} from "../host/startup-window";

class ElectrobunStartupView implements StartupView {
  readonly window: BrowserWindow;
  private domReady = false;
  private pendingState?: { kind: string; value: unknown };

  constructor(windowSettings: Readonly<StartupWindowSettings>) {
    this.window = new BrowserWindow({
      title: windowSettings.title,
      url: "views://main/index.html",
      frame: {
        width: windowSettings.width,
        height: windowSettings.height,
      },
      renderer: "native",
    });
    this.window.webview.on("dom-ready", () => {
      this.domReady = true;
      const pending = this.pendingState;
      if (pending) this.executeNow(pending.kind, pending.value);
    });
  }

  onMessage(onMessage: (message: unknown) => void): void {
    Electrobun.events.on(`host-message-${this.window.webview.id}`, (event: unknown) => {
      const envelope = event as { data?: unknown; detail?: unknown };
      const data = envelope.data ?? envelope.detail ?? event;
      const payload =
        typeof data === "object" && data !== null && "detail" in data
          ? (data as { detail?: unknown }).detail
          : data;
      if (typeof payload === "string") {
        try {
          onMessage(JSON.parse(payload));
        } catch {
          // Ignore malformed event details; the startup view can only send
          // structured action packets through the Electrobun bridge.
        }
        return;
      }
      onMessage(payload);
    });
  }

  showLoading(loading: Extract<StartupState, { kind: "loading" }>): void {
    this.execute("loading", loading);
  }

  showFailure(failure: Extract<StartupState, { kind: "failed" }>): void {
    this.execute("failed", failure);
  }

  showLaunchToken(gate: Extract<StartupState, { kind: "launch-token" }>): void {
    this.execute("launch-token", gate);
  }

  navigate(url: string): void {
    this.window.webview.loadURL(url);
  }

  private execute(kind: string, value: unknown): void {
    this.pendingState = { kind, value };
    if (!this.domReady) return;
    this.executeNow(kind, value);
  }

  private executeNow(kind: string, value: unknown): void {
    const json = JSON.stringify(value).replaceAll("</", "<\\/");
    this.window.webview.executeJavascript?.(
      `window.__dshHostState && window.__dshHostState(${JSON.stringify(kind)}, ${json});`,
    );
  }
}

function sourceTreeResourceRoot(): string {
  const candidates = [resolve(process.cwd()), resolve(import.meta.dir, "../.."), resolve(import.meta.dir, "..")];
  return (
    candidates.find(
      (candidate) =>
        existsSync(resolve(candidate, referenceManifest.sidecar.entrypoint)) &&
        existsSync(resolve(candidate, referenceManifest.supervisor.executable)),
    ) ?? candidates[0]
  );
}

function resourceRoot(): string {
  // Electrobun 2.0.1 stages copied payloads below Resources/app. The source
  // tree is considered only when an explicit developer seam is requested;
  // packaged startup must never fall back to the current working directory.
  if (process.env.DSH_SOURCE_TREE_DEV === "1") return sourceTreeResourceRoot();
  return resolve(PATHS.RESOURCES_FOLDER, "app");
}

function recordNavigationMarker(marker: string): void {
  const markerFile = process.env.DSH_NAVIGATION_MARKER_FILE;
  if (!markerFile) return;
  try {
    writeFileSync(markerFile, `${marker}\n`, { encoding: "utf8" });
  } catch {
    // The marker is a disposable packaging-smoke seam; never make the host
    // fail because the optional evidence file cannot be written.
  }
}

function invalidManifestState(error: unknown): Extract<StartupState, { kind: "failed" }> {
  const diagnostic = error instanceof Error ? error.message : String(error);
  return {
    kind: "failed",
    reason: "manifest-invalid",
    diagnostic: `The packaged product manifest is invalid: ${diagnostic}`,
    canInstall: false,
    canRetry: false,
  };
}

async function run(): Promise<void> {
  try {
    assertSupportedWindows11X64(readHostPlatform());
  } catch (error) {
    const view = new ElectrobunStartupView(SAFE_STARTUP_WINDOW_SETTINGS);
    view.showFailure({
      kind: "failed",
      reason: "unsupported-platform",
      diagnostic: error instanceof Error ? error.message : String(error),
      canInstall: false,
      canRetry: false,
    });
    return;
  }
  let manifest: ValidatedProductManifest;
  try {
    manifest = validateProductManifest(referenceManifest, { stagedRoot: resourceRoot() });
  } catch (error) {
    const view = new ElectrobunStartupView(SAFE_STARTUP_WINDOW_SETTINGS);
    view.showFailure(invalidManifestState(error));
    return;
  }

  const view = new ElectrobunStartupView(selectStartupWindowSettings(manifest));
  const runtime = new WindowsBunRuntimeGateway();
  const controller = new StartupController({
    manifest,
    runtime,
    supervisor: new WindowsSupervisorLauncher(),
    view,
    ...(manifest.authentication ? {
      launchTokenGateway: new DshLaunchTokenGateway(
        manifest.authentication.tokenExchangeUrl,
        Session.defaultSession.cookies,
      ),
    } : {}),
  });

  // The view is deliberately the only command surface. A user click is the
  // explicit consent required before WinGet is ever invoked.
  const onMessage = (message: unknown) => {
    if (typeof message !== "object" || message === null) return;
    const action = (message as { action?: unknown }).action;
    if (action === "install-bun") void controller.installBun();
    if (action === "retry") void controller.retry();
    if (action === "submit-launch-token" && typeof (message as { token?: unknown }).token === "string") {
      void controller.submitLaunchToken((message as { token: string }).token);
    }
    if (
      action === "navigation-marker" &&
      (message as { marker?: unknown }).marker === "reference-sidecar-ready"
    ) {
      recordNavigationMarker("reference-sidecar-ready");
    }
  };
  view.onMessage(onMessage);
  view.window.on("close", () => {
    void controller.stop();
  });

  // Keep startup asynchronous so the packaged loading view is painted before
  // runtime resolution or supervisor launch begins.
  void controller.start();
}

if (typeof process !== "undefined" && process.env.NODE_ENV !== "test") {
  // Unsupported platforms still open the safe packaged diagnostic view; run()
  // renders the precise platform error before configured window construction.
  void run();
}
