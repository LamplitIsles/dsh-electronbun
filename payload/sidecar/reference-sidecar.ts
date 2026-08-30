import { spawn } from "node:child_process";

const port = Number(process.env.DSH_FIXTURE_PORT ?? "43173");
const childPidFile = process.env.DSH_FIXTURE_CHILD_PID_FILE;
const descendantMode = process.argv.includes("--fixture-descendant");

if (descendantMode) {
  // A deliberately boring descendant used by the native lifecycle gate. The
  // supervisor Job Object, rather than application protocol, owns its lifetime.
  setInterval(() => undefined, 1_000);
} else {
  const descendant = spawn(process.execPath, [import.meta.filename, "--fixture-descendant"], {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });

  if (childPidFile) {
    await Bun.write(childPidFile, `${descendant.pid}\n`);
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/health") {
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
      }
      if (path === "/") {
        return new Response(
          `<!doctype html><meta charset="utf-8"><title>DSH Reference Sidecar</title><h1>DSH Reference Sidecar</h1><p data-ready="true">HTTP readiness confirmed.</p><script>window.__electrobunSendToHost?.({action:"navigation-marker",marker:"reference-sidecar-ready"});</script>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });

  const shutdown = () => {
    server.stop(true);
    if (!descendant.killed) descendant.kill();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("exit", shutdown);

  console.log(`reference sidecar listening on ${server.url}`);
}
