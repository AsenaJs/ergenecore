import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Ergenecore } from '../lib';
import type { Context } from '../lib';
import { HttpException } from '../lib/errors';
import { HttpMethod } from '@asenajs/asena/web-types';
import type { ServerLogger } from '@asenajs/asena/logger';

const mockLogger: ServerLogger = {
  profile: mock(() => {}),
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
};

type Handle = (context: Context, next: () => Promise<void>) => unknown;

describe('middleware code after next()', () => {
  let adapter: Ergenecore;
  let server: any;

  const boot = async (handle: Handle, routeHandle?: Handle) => {
    adapter = new Ergenecore(mockLogger);
    adapter.use({ handle, override: false } as any);

    const route = (method: HttpMethod, path: string, handler: (ctx: Context) => unknown) =>
      adapter.registerRoute({
        method,
        path,
        middlewares: routeHandle ? [{ handle: routeHandle, override: false } as any] : [],
        handler,
      } as any);

    route(HttpMethod.GET, '/ok', (ctx) => ctx.send({ ok: true }));
    route(HttpMethod.POST, '/created', (ctx) => ctx.send({ created: true }, 201));
    route(HttpMethod.GET, '/raw', () => new Response('raw', { status: 202 }));
    route(HttpMethod.GET, '/forbidden', () => {
      throw new HttpException(403, { error: 'forbidden' });
    });

    adapter.setPort(0);
    server = await adapter.start();

    return `http://localhost:${server.port}`;
  };

  afterEach(async () => {
    await server?.stop(true);
    server = undefined;
  });

  test('a header a global middleware sets after next() is on the response', async () => {
    const baseUrl = await boot(async (context, next) => {
      await next();
      context.res.headers.set('x-after-next', 'added');
    });

    const response = await fetch(`${baseUrl}/ok`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('x-after-next')).toBe('added');
  });

  test('an error a middleware throws after next() reaches onError', async () => {
    const handled: string[] = [];
    const baseUrl = await boot(async (_context, next) => {
      await next();
      throw new Error('after-next');
    });

    adapter.onError((error: Error, context: Context) => {
      handled.push(error.message);

      return context.send({ handled: error.message }, 503);
    });

    const response = await fetch(`${baseUrl}/ok`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ handled: 'after-next' });
    expect(handled).toEqual(['after-next']);
  });

  test('the produced status is readable after next() on matched and unmatched requests', async () => {
    const seen: Array<[string, number | undefined]> = [];
    const baseUrl = await boot(async (context, next) => {
      await next();
      seen.push([new URL(context.req.url).pathname, context.res.status]);
    });

    const statuses = [
      (await fetch(`${baseUrl}/ok`)).status,
      (await fetch(`${baseUrl}/created`, { method: 'POST' })).status,
      (await fetch(`${baseUrl}/raw`)).status,
      (await fetch(`${baseUrl}/forbidden`)).status,
      (await fetch(`${baseUrl}/nowhere`)).status,
    ];

    expect(statuses).toEqual([200, 201, 202, 403, 404]);
    expect(seen).toEqual([
      ['/ok', 200],
      ['/created', 201],
      ['/raw', 202],
      ['/forbidden', 403],
      ['/nowhere', 404],
    ]);
  });

  test('a downstream short-circuit still answers and upstream code after next() still runs', async () => {
    const after: Array<number | undefined> = [];
    const baseUrl = await boot(
      async (context, next) => {
        await next();
        after.push(context.res.status);
      },
      () => new Response('blocked', { status: 401 }),
    );

    const response = await fetch(`${baseUrl}/ok`);

    expect(response.status).toBe(401);
    expect(await response.text()).toBe('blocked');
    expect(after).toEqual([401]);
  });

  test('a downstream false still answers 403 after the upstream code runs', async () => {
    const after: string[] = [];
    const baseUrl = await boot(
      async (_context, next) => {
        await next();
        after.push('ran');
      },
      () => false,
    );

    const response = await fetch(`${baseUrl}/ok`);

    expect(response.status).toBe(403);
    expect(after).toEqual(['ran']);
  });

  test('a middleware that returns a Response without calling next() short-circuits the handler', async () => {
    let handlerRan = false;

    adapter = new Ergenecore(mockLogger);
    adapter.use({ handle: () => new Response('early', { status: 418 }), override: false } as any);
    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/ok',
      middlewares: [],
      handler: (ctx: Context) => {
        handlerRan = true;

        return ctx.send({ ok: true });
      },
    } as any);
    adapter.setPort(0);
    server = await adapter.start();

    const response = await fetch(`http://localhost:${server.port}/ok`);

    expect(response.status).toBe(418);
    expect(await response.text()).toBe('early');
    expect(handlerRan).toBe(false);
  });
});
