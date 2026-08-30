declare module "electrobun" {
  export interface ElectrobunConfig {
    app: {
      name: string;
      identifier: string;
      version: string;
    };
    build?: Record<string, unknown> & {
      mainProcess?: string;
      cottontail?: { entrypoint: string };
      views?: Record<string, { entrypoint: string }>;
      copy?: Record<string, string>;
      win?: Record<string, unknown>;
    };
    runtime?: Record<string, unknown>;
    [key: string]: unknown;
  }
}

declare module "electrobun/main" {
  export interface BrowserViewLike {
    on(event: string, listener: (event: unknown) => void): void;
    off?(event: string, listener: (event: unknown) => void): void;
    loadURL(url: string): void;
    executeJavascript?(script: string): void;
  }

  export interface BrowserWindowOptions {
    title: string;
    url: string;
    frame?: { width: number; height: number };
    rpc?: unknown;
    renderer?: "native" | "cef";
  }

  export class BrowserWindow {
    readonly webview: BrowserViewLike;
    readonly id: number;
    constructor(options: BrowserWindowOptions);
    on(event: string, listener: (event: unknown) => void): void;
    close(): void;
    setTitle(title: string): void;
  }
}

interface Window {
  __electrobunSendToHost?: (message: unknown) => void;
}
