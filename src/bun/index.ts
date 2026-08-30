import { resolve } from "node:path";
import { existsSync } from "node:fs";

import { BrowserWindow } from "electrobun/main";

import referenceManifest from "../../product.manifest";
import {
  ManifestValidationError,
  type ValidatedProductManifest,
  validateProductManifest,
} from "../host/manifest";
import { WindowsBunRuntimeGateway } from "../host/runtime-gateway";
import { assertSupportedWindowsX64 } from "../host/platform";
import { StartupController, type StartupState, type StartupView } from "../host/startup-controller";
import { WindowsSupervisorLauncher } from "../host/supervisor-client";

class ElectrobunStartupView implements StartupView {
  readonly window: BrowserWindow;
  private domReady = false;
  private pendingState?: { kind: string; value: unknown };

  constructor() {
    this.window = new BrowserWindow({
      title: referenceManifest.window.title,
      url: "views://main/index.html",
      frame: {
        width: referenceManifest.window.width,
        height: referenceManifest.window.height,
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
    this.window.webview.on("host-message", (event: unknown) => {
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

  showLoading(message: string): void {
    this.execute("loading", { message });
  }

  showFailure(failure: Extract<StartupState, { kind: "failed" }>): void {
    this.execute("failed", failure);
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

function resourceRoot(): string {
  // Hutch's packaged process starts with its resource directory as cwd. The
  // source-tree fallback keeps the validation seam usable during development.
  if (process.env.DSH_RESOURCE_ROOT) return resolve(process.env.DSH_RESOURCE_ROOT);
  const candidates = [resolve(process.cwd()), resolve(import.meta.dir, "../.."), resolve(import.meta.dir, "..")];
  return (
    candidates.find(
      (candidate) =>
        existsSync(resolve(candidate, referenceManifest.sidecar.entrypoint)) &&
        existsSync(resolve(candidate, referenceManifest.supervisor.executable)),
    ) ?? candidates[0]
  );
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
  const view = new ElectrobunStartupView();
  try {
    assertSupportedWindowsX64(process);
  } catch (error) {
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
    view.showFailure(invalidManifestState(error));
    return;
  }

  const runtime = new WindowsBunRuntimeGateway();
  const controller = new StartupController({
    manifest,
    runtime,
    supervisor: new WindowsSupervisorLauncher(),
    view,
  });

  // The view is deliberately the only command surface. A user click is the
  // explicit consent required before WinGet is ever invoked.
  const onMessage = (message: unknown) => {
    if (typeof message !== "object" || message === null) return;
    const action = (message as { action?: unknown }).action;
    if (action === "install-bun") void controller.installBun();
    if (action === "retry") void controller.retry();
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
  // Unsupported platforms still open the packaged diagnostic view; run()
  // renders the precise platform error before doing any manifest/process work.
  void run();
}

export { ElectrobunStartupView, invalidManifestState, resourceRoot, run };
