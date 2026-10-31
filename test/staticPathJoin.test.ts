import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { Ergenecore } from '../lib';
import type { ServerLogger } from '@asenajs/asena/logger';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HttpMethod } from '@asenajs/asena/web-types';

const mockLogger: ServerLogger = {
  profile: mock(() => {}),
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
};

describe('Static serve path joining', () => {
  let adapter: Ergenecore;
  let base: string;
  let root: string;
  const TEST_PORT = 10000 + Math.floor(Math.random() * 22000);
  const url = (p: string) => `http://localhost:${TEST_PORT}${p}`;

  beforeAll(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'ergenecore-join-'));
    root = path.join(base, 'public');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.txt'), 'A');
    fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'B');
    fs.writeFileSync(path.join(root, '.hidden'), 'H');
    fs.writeFileSync(path.join(base, 'secret.txt'), 'SECRET');

    adapter = new Ergenecore(mockLogger);

    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/files/*',
      middlewares: [],
      handler: async (ctx) => ctx.send({ fallthrough: true }),
      staticServe: {
        root: `${root}/`,
        extra: undefined,
        rewriteRequestPath: (requestPath: string) => requestPath.replace(/^\/files/, ''),
      } as any,
      validator: {} as any,
    });

    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/raw/*',
      middlewares: [],
      handler: async (ctx) => ctx.send({ fallthrough: true }),
      staticServe: {
        root,
        extra: undefined,
        rewriteRequestPath: (requestPath: string) => requestPath.slice('/raw/'.length),
      } as any,
      validator: {} as any,
    });

    await adapter.start(TEST_PORT);
  });

  afterAll(async () => {
    await adapter.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('serves plain nested paths', async () => {
    const top = await fetch(url('/files/a.txt'));
    const nested = await fetch(url('/files/sub/b.txt'));

    expect(top.status).toBe(200);
    expect(await top.text()).toBe('A');
    expect(nested.status).toBe(200);
    expect(await nested.text()).toBe('B');
  });

  it('serves dot files whose name is not a dot segment', async () => {
    const response = await fetch(url('/files/.hidden'));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('H');
  });

  it('normalizes empty and dot segments the same way path.join does', async () => {
    const doubled = await fetch(url('/raw//sub//b.txt'));
    const dotted = await fetch(url('/raw/sub/%2E/b.txt'));
    const back = await fetch(url('/raw/sub/%2E%2E/a.txt'));

    expect(await doubled.text()).toBe('B');
    expect(await dotted.text()).toBe('B');
    expect(await back.text()).toBe('A');
  });

  it('still refuses encoded traversal out of the root', async () => {
    const response = await fetch(url('/raw/sub/..%2F..%2Fsecret.txt'));

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('SECRET');
  });

  it('decodes percent-encoded names', async () => {
    fs.writeFileSync(path.join(root, 'with space.txt'), 'S');

    const response = await fetch(url('/files/with%20space.txt'));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('S');
  });

  it('ignores the query string and fragment when resolving the file', async () => {
    const response = await fetch(url('/files/a.txt?v=1&x=%2F..'));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('A');
  });
});
