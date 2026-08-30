import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

const port = Number(process.env.DSH_FIXTURE_PORT ?? "43173");
const childPidFile = process.env.DSH_FIXTURE_CHILD_PID_FILE;
const descendant = spawn(process.execPath, [join(dirname(import.meta.filename), "descendant.ts")], {
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
        `<!doctype html><meta charset="utf-8"><title>DSH Reference Sidecar</title><h1>DSH Reference Sidecar</h1><p data-ready="true">HTTP readiness confirmed.</p>`,
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
