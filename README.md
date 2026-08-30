# DSH Windows sidecar host

This repository is a small, reusable Windows 11 x64 desktop host for a DSH
product sidecar. It uses Electrobun **2.0.1**, a Cottontail TypeScript main
process, and the native WebView2 renderer. CEF and WGPU are disabled. The host
owns process lifetime; the product sidecar continues to own its HTTP/API and
domain behavior.

## Product boundary

[`product.manifest.ts`](product.manifest.ts) is the one build-time contract a
product replaces. It declares:

- app identity and window dimensions;
- exact Bun `1.4.0` and the exact WinGet package ID `Oven-sh.Bun`;
- a relative, staged sidecar entrypoint and argv array;
- an HTTP readiness URL and loopback navigation URL; and
- a bounded startup timeout plus the staged supervisor executable.

The entrypoint and supervisor must be staged inside the application resource
root. Absolute host paths, `..` traversal, remote URLs, `localhost`, IPv6
loopback, shell command strings, and malformed timeouts are rejected before a
process is launched. See [`src/host/manifest.ts`](src/host/manifest.ts) for
the validation contract.

The reference payload in `payload/sidecar` is intentionally only a fixture. It
serves `/health`, serves a tiny UI, and starts one descendant so the native
cleanup gate can prove complete Job ownership.

## Startup and recovery

The Cottontail host has one state machine: `loading`, `ready`, `failed`, and
`stopping`. It resolves an absolute Bun executable and accepts it only when
`bun.exe --version` exactly matches the manifest. It starts the staged Zig
supervisor without a shell, polls for an application-level 2xx HTTP readiness
response, and only then navigates the same native WebView2 view to the product
URL.

When Bun is missing or incompatible, the packaged startup view remains usable.
WinGet is never called automatically: the user must click **Install Bun**. The
direct invocation is equivalent to:

```text
winget.exe install --id Oven-sh.Bun --version 1.4.0 --exact \
  --accept-source-agreements --accept-package-agreements --silent
```

After installation the resolver searches fresh absolute candidates again; it
does not assume that this process inherited a refreshed `PATH`. WinGet
unavailability, decline, failure, an unresolved executable, and a post-install
version mismatch all return an actionable diagnostic with retry.

## Supervisor guarantees

`supervisor/src/main.zig` is a standalone Windows x64 executable. It requires
Zig **0.16.0** at build time and is not shipped as a compiler. The supervisor:

1. opens and waits on the desktop parent PID;
2. creates a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`;
3. creates Bun with `CREATE_SUSPENDED` and no breakaway/detached flags;
4. assigns Bun to the Job before `ResumeThread`; and
5. waits for the parent or Bun, terminates the Job on shutdown, and propagates
   Bun's exit result.

Every Job setup or assignment failure terminates the suspended child and exits
with a diagnostic containing the failed operation and Win32 error code. There
is no taskkill-only success path. [`src/host/startup-controller.ts`](src/host/startup-controller.ts)
keeps cleanup idempotent at the application seam.

## Build and verification

Install Bun using the version selected by the repository lockfile, then run:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
```

The Windows supervisor build checks the compiler version itself and cross-builds
the x64 executable into the ignored `supervisor/bin` directory:

```sh
bun run build:supervisor
```

On a Windows x64 maintainer machine, the native lifecycle gate uses a
test-owned temporary root and verifies normal supervisor close, forced parent
termination, descendant cleanup, bounded port release, and a second launch:

```powershell
bun run test:native
```

The release task builds the supervisor first and then asks Hutch for its normal
Electrobun artifact. Stable output includes Hutch's `win-x64-DSH Reference
Host-Setup.zip`-style Setup ZIP:

```sh
bun run build:stable
```

The optional packaging smoke gate extracts a Setup ZIP into a disposable root,
launches it, and waits for the fixture readiness endpoint through native
WebView2 startup:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass \
  -File scripts/windows/packaging-smoke.ps1
```

Hutch is the build/package orchestrator. A fresh checkout may install it with
the official command and initialize a separate throwaway template if desired:

```sh
curl -fsSL https://hutch.blackboard.sh/hutch/install.sh | sh
hutch electrobun init
```

Initialization is not needed for this repository; `hutch.config.ts` and
`electrobun.config.ts` are already committed and pin Electrobun 2.0.1.

## Release gates and unsupported targets

The portable checks do not install or modify the machine's Bun, invoke real
WinGet, or touch production services. The following remain explicit, unrun
release gates: stable installer execution on a clean machine, real WinGet
provisioning, code signing, update delivery, and deployment. The host and
supervisor reject non-Windows or non-x64 targets with a precise diagnostic;
macOS, Linux, Windows ARM64-native artifacts, CEF, WGPU, multiple windows, and
tray integration are outside this slice.

`dsh-rpgmaker-mv` is not changed here. Its future adapter is responsible for
producing a staged entrypoint and manifest for this host; launcher, lease,
profile, repair, and logging logic remain product-owned.
