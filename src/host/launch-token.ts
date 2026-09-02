import { request as httpRequest } from 'node:http';

export const MAX_LAUNCH_TOKEN_BYTES = 2048;

export interface NativeSessionCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'no_restriction' | 'lax' | 'strict';
  expirationDate?: number;
}

export interface NativeSessionCookies {
  set(cookie: NativeSessionCookie): boolean;
}

export type LaunchTokenExchangeResult =
  | { kind: 'accepted' }
  | { kind: 'rejected' }
  | { kind: 'unavailable' };

export interface LaunchTokenGateway {
  exchange(token: string): Promise<LaunchTokenExchangeResult>;
}

interface HttpExchangeResponse {
  statusCode?: number;
  headers: { 'set-cookie'?: string[] };
  resume(): void;
  on(event: 'error' | 'end', listener: () => void): void;
}

export interface LaunchTokenGatewayOptions {
  request?: typeof httpRequest;
  timeoutMs?: number;
}

function validToken(token: string): boolean {
  return token.trim().length > 0 && Buffer.byteLength(token, 'utf8') <= MAX_LAUNCH_TOKEN_BYTES;
}

function parseSetCookie(header: string, origin: URL): NativeSessionCookie | undefined {
  const [pair, ...attributes] = header.split(';');
  const separator = pair?.indexOf('=') ?? -1;
  if (separator < 1) return undefined;
  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  if (!name || /[\u0000-\u001f\u007f()<>@,;:\\\"/\[\]?={} \t]/.test(name)) return undefined;

  const cookie: NativeSessionCookie = { name, value, domain: origin.hostname, path: '/' };
  for (const attribute of attributes) {
    const [rawName, ...rawValue] = attribute.trim().split('=');
    const attributeName = rawName.toLowerCase();
    const attributeValue = rawValue.join('=').trim();
    if (attributeName === 'domain') {
      const domain = attributeValue.replace(/^\./, '').toLowerCase();
      if (domain !== origin.hostname) return undefined;
      cookie.domain = domain;
    } else if (attributeName === 'path') {
      if (!attributeValue.startsWith('/')) return undefined;
      cookie.path = attributeValue;
    } else if (attributeName === 'secure') {
      cookie.secure = true;
    } else if (attributeName === 'httponly') {
      cookie.httpOnly = true;
    } else if (attributeName === 'samesite') {
      const sameSite = attributeValue.toLowerCase();
      if (sameSite === 'strict' || sameSite === 'lax') cookie.sameSite = sameSite;
      else if (sameSite === 'none') cookie.sameSite = 'no_restriction';
      else return undefined;
    } else if (attributeName === 'max-age') {
      const seconds = Number(attributeValue);
      if (!Number.isInteger(seconds)) return undefined;
      cookie.expirationDate = Math.floor(Date.now() / 1000) + seconds;
    }
  }
  return cookie;
}

/**
 * Exchanges one launch token without a Cookie header, then transfers the one
 * DSH-issued session cookie to the WebView's native session. Tokens never
 * become part of navigation, diagnostics, or retained controller state.
 */
export class DshLaunchTokenGateway implements LaunchTokenGateway {
  private readonly origin: URL;
  private readonly request: typeof httpRequest;
  private readonly timeoutMs: number;

  constructor(
    tokenExchangeUrl: string,
    private readonly cookies: NativeSessionCookies,
    options: LaunchTokenGatewayOptions = {},
  ) {
    this.origin = new URL(tokenExchangeUrl);
    this.request = options.request ?? httpRequest;
    this.timeoutMs = options.timeoutMs ?? 3_000;
  }

  async exchange(token: string): Promise<LaunchTokenExchangeResult> {
    if (!validToken(token)) return { kind: 'rejected' };
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: LaunchTokenExchangeResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      let request;
      try {
        request = this.request({
          host: this.origin.hostname,
          port: this.origin.port || 80,
          method: 'GET',
          path: `/?token=${encodeURIComponent(token)}`,
          // Deliberately omit Cookie: DSH must authenticate this single token.
          headers: { host: this.origin.host },
        }, (response: HttpExchangeResponse) => {
          response.resume();
          response.on('error', () => finish({ kind: 'unavailable' }));
          response.on('end', () => {
            const headers = response.headers['set-cookie'];
            if (response.statusCode !== 303 || !Array.isArray(headers) || headers.length !== 1 || !headers[0]) {
              finish({ kind: 'rejected' });
              return;
            }
            const cookie = parseSetCookie(headers[0], this.origin);
            finish(cookie && this.cookies.set(cookie) ? { kind: 'accepted' } : { kind: 'rejected' });
          });
        });
      } catch {
        finish({ kind: 'unavailable' });
        return;
      }
      request.setTimeout(this.timeoutMs, () => {
        request.destroy();
        finish({ kind: 'unavailable' });
      });
      request.on('error', () => finish({ kind: 'unavailable' }));
      request.end();
    });
  }
}
