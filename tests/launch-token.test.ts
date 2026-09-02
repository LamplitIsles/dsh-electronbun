import { createServer } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import { DshLaunchTokenGateway, type NativeSessionCookie } from '../src/host/launch-token';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', (error?: Error) => error ? reject(error) : resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not listen');
  return address.port;
}

test('exchanges one token without a Cookie header and stores only the issued session cookie', async () => {
  let path = '';
  let requestCookie: string | undefined;
  const port = await listen(createServer((request, response) => {
    path = request.url ?? '';
    requestCookie = request.headers.cookie;
    response.writeHead(303, { 'set-cookie': 'dsh-auth-test=issued; Path=/; HttpOnly; SameSite=Strict' });
    response.end();
  }));
  const stored: NativeSessionCookie[] = [];
  const gateway = new DshLaunchTokenGateway(`http://127.0.0.1:${port}/`, { set: (cookie) => { stored.push(cookie); return true; } });

  await expect(gateway.exchange('launch-token')).resolves.toEqual({ kind: 'accepted' });
  expect(path).toBe('/?token=launch-token');
  expect(requestCookie).toBeUndefined();
  expect(stored).toEqual([{ name: 'dsh-auth-test', value: 'issued', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'strict' }]);
});

test('rejects a non-303 response or missing session cookie without writing cookies', async () => {
  const port = await listen(createServer((_request, response) => {
    response.writeHead(401);
    response.end();
  }));
  let writes = 0;
  const gateway = new DshLaunchTokenGateway(`http://127.0.0.1:${port}/`, { set: () => { writes += 1; return true; } });

  await expect(gateway.exchange('invalid-token')).resolves.toEqual({ kind: 'rejected' });
  expect(writes).toBe(0);
});
