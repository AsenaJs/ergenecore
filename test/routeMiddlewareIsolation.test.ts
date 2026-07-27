import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { Ergenecore } from '../lib';
import { HttpMethod } from '@asenajs/asena/web-types';
import type { ServerLogger } from '@asenajs/asena/logger';
import type { Context } from '../lib';

const mockLogger: ServerLogger = {
  profile: mock(() => {}),
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
};

/**
 * Replaces the old route-optimization suite.
 *
 * That suite unit-tested `extractBasePath` / `extractCommonMiddlewares` / `groupRoutesByBasePath`,
 * which have been removed - the "common middleware" optimisation compared middlewares by
 * `mw.constructor.name`, and by the time a middleware reaches an adapter it is the plain
 * `{ handle, override }` object PrepareMiddlewareService builds, so every name was `"Object"`
 * and every comparison was true. Its own tests missed that because they passed real class
 * instances, a shape the framework never produces.
 *
 * What matters is the property those functions were supposed to preserve, so that is what is
 * tested here: a route runs its own middlewares and nobody else's. Middlewares are built in the
 * exact shape the framework hands the adapter.
 */
describe('Route middleware isolation', () => {
  // Random, not a literal: 3008 was also hard-coded in static-serve.test.ts, and a server
  // leaked there would have this suite quietly fetching the wrong one.
  // 10000-31999: above the well-known range and below the kernel's ephemeral floor
  // (net.ipv4.ip_local_port_range, 32768-60999). Drawing a *server* port from the
  // ephemeral range collides with the outbound sockets the suite itself holds open -
  // including their 60s TIME_WAIT - and Bun.serve then fails with EADDRINUSE.
  const TEST_PORT = 10000 + Math.floor(Math.random() * 22000);

  let adapter: Ergenecore;
  let calls: string[] = [];

  // The literal PrepareMiddlewareService produces - no class, so no constructor identity.
  const tracking = (tag: string) => ({
    handle: async (_context: Context, next: () => Promise<void>): Promise<void> => {
      calls.push(tag);
      await next();
    },
    override: false,
  });

  beforeAll(async () => {
    adapter = new Ergenecore(mockLogger);

    // Same base path, one route-level middleware each, different middleware per route:
    // the precondition the removed optimisation keyed on.
    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/api/items/:id',
      middlewares: [tracking('read-guard')],
      handler: async (ctx: Context) => ctx.send({ action: 'read' }),
    } as any);

    adapter.registerRoute({
      method: HttpMethod.DELETE,
      path: '/api/items/:id',
      middlewares: [tracking('admin-guard')],
      handler: async (ctx: Context) => ctx.send({ action: 'delete' }),
    } as any);

    adapter.registerRoute({
      method: HttpMethod.POST,
      path: '/api/items',
      middlewares: [tracking('write-guard')],
      handler: async (ctx: Context) => ctx.send({ action: 'create' }),
    } as any);

    await adapter.start(TEST_PORT);
  });

  afterAll(async () => {
    await adapter.stop();
  });

  test('a route runs only its own middleware', async () => {
    calls = [];

    const response = await fetch(`http://localhost:${TEST_PORT}/api/items/42`, { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: 'delete' });

    // The whole point: not ['read-guard'], and not ['read-guard', 'admin-guard'] either.
    expect(calls).toEqual(['admin-guard']);
  });

  test('a sibling route on the same base path runs its own middleware', async () => {
    calls = [];

    const response = await fetch(`http://localhost:${TEST_PORT}/api/items/42`);

    expect(response.status).toBe(200);
    expect(calls).toEqual(['read-guard']);
  });

  test('a shorter path under the same prefix is unaffected', async () => {
    calls = [];

    const response = await fetch(`http://localhost:${TEST_PORT}/api/items`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(calls).toEqual(['write-guard']);
  });

  test('every route still resolves its own handler and params', async () => {
    calls = [];

    const read = await fetch(`http://localhost:${TEST_PORT}/api/items/7`);
    const remove = await fetch(`http://localhost:${TEST_PORT}/api/items/7`, { method: 'DELETE' });
    const create = await fetch(`http://localhost:${TEST_PORT}/api/items`, { method: 'POST' });

    expect(await read.json()).toEqual({ action: 'read' });
    expect(await remove.json()).toEqual({ action: 'delete' });
    expect(await create.json()).toEqual({ action: 'create' });

    // The whole sequence, in order, once each - the hono twin asserts this and the ergenecore
    // one only re-checked handler bodies two earlier tests already pin.
    expect(calls).toEqual(['read-guard', 'admin-guard', 'write-guard']);
  });
});
