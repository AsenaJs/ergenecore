import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { ServerLogger } from '@asenajs/asena/logger';
import { HttpMethod } from '@asenajs/asena/web-types';
import { Ergenecore, ErgenecoreWebsocketAdapter, type Context } from '../lib';
import { CorsMiddleware } from '../lib/defaults';

const logger: ServerLogger = {
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  profile: mock(() => {}),
};

describe('a user route at top-level /*', () => {
  const root = mkdtempSync(join(tmpdir(), 'ergenecore-spa-'));

  writeFileSync(join(root, 'index.html'), '<html>spa</html>');
  writeFileSync(join(root, 'app.js'), 'console.log("app");');

  let adapter: Ergenecore | undefined;

  afterEach(async () => {
    await adapter?.stop();
    adapter = undefined;
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function createAdapter(): Ergenecore {
    adapter = new Ergenecore(logger, new ErgenecoreWebsocketAdapter(logger));
    adapter.setPort(0);

    return adapter;
  }

  function route(method: HttpMethod, path: string, handler: (ctx: Context) => Response | Promise<Response>) {
    return { method, path, middlewares: [], handler, staticServe: undefined, validator: undefined };
  }

  async function start(app: Ergenecore): Promise<string> {
    const server = await app.start();

    return `http://localhost:${server.port}`;
  }

  it('answers its GET for any path no other route serves', async () => {
    const app = createAdapter();

    app.registerRoute(route(HttpMethod.GET, '/api/users', (ctx) => ctx.send({ users: [] })));
    app.registerRoute(route(HttpMethod.GET, '/*', (ctx) => ctx.send({ handler: 'catch-all' })));

    const baseUrl = await start(app);

    for (const path of ['/', '/about', '/users/123']) {
      const response = await fetch(`${baseUrl}${path}`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ handler: 'catch-all' });
    }

    expect(await (await fetch(`${baseUrl}/api/users`)).json()).toEqual({ users: [] });
    expect((await fetch(`${baseUrl}/about`, { method: 'HEAD' })).status).toBe(200);
  });

  it('serves the documented SPA static route', async () => {
    const app = createAdapter();

    app.registerRoute({
      ...route(HttpMethod.GET, '/*', async () => new Response('handler')),
      staticServe: {
        root,
        rewriteRequestPath: (requestPath: string) => (extname(requestPath) ? requestPath : '/index.html'),
      },
    } as any);

    const baseUrl = await start(app);

    const page = await fetch(`${baseUrl}/users/123`);

    expect(page.status).toBe(200);
    expect(await page.text()).toBe('<html>spa</html>');

    const asset = await fetch(`${baseUrl}/app.js`);

    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('console.log("app");');

    const missing = await fetch(`${baseUrl}/missing.png`);

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Not Found' });
  });

  it('leaves methods it does not register to the unmatched handling', async () => {
    const app = createAdapter();
    const notFound: { path: string; method: string }[] = [];

    app.onNotFound((ctx, request) => {
      notFound.push(request);

      return ctx.send({ notFound: true }, 404);
    });
    app.registerRoute(route(HttpMethod.GET, '/*', (ctx) => ctx.send({ handler: 'catch-all' })));

    const baseUrl = await start(app);

    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await fetch(`${baseUrl}/about`, { method });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ notFound: true });
    }

    expect(notFound.map(({ method }) => method)).toEqual(['POST', 'PUT', 'DELETE', 'PATCH']);
  });

  it('still answers an OPTIONS preflight through the global middleware chain', async () => {
    const app = createAdapter();

    // @ts-ignore
    app.use(new CorsMiddleware());
    app.registerRoute(route(HttpMethod.GET, '/*', (ctx) => ctx.send({ handler: 'catch-all' })));

    const baseUrl = await start(app);

    const preflight = await fetch(`${baseUrl}/about`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com' },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*');

    const page = await fetch(`${baseUrl}/about`, { headers: { Origin: 'https://example.com' } });

    expect(await page.json()).toEqual({ handler: 'catch-all' });
    expect(page.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('runs a path-scoped global middleware by the request path, not the /* pattern', async () => {
    const app = createAdapter();
    const seen: string[] = [];

    app.use(
      {
        override: false,
        handle: async (ctx: Context) => ctx.send({ error: 'Unauthorized' }, 401),
      },
      { include: ['/api/*'] },
    );
    app.use(
      {
        override: false,
        handle: async (ctx: Context, next: () => Promise<void>) => {
          seen.push(new URL(ctx.req.url).pathname);
          await next();
        },
      },
      { exclude: ['/health'] },
    );
    app.registerRoute(route(HttpMethod.GET, '/*', (ctx) => ctx.send({ handler: 'catch-all' })));

    const baseUrl = await start(app);

    const privateGet = await fetch(`${baseUrl}/api/private`);

    expect(privateGet.status).toBe(401);
    expect(await privateGet.json()).toEqual({ error: 'Unauthorized' });
    expect((await fetch(`${baseUrl}/api/private`, { method: 'POST' })).status).toBe(401);

    const page = await fetch(`${baseUrl}/about`);

    expect(page.status).toBe(200);
    expect(await page.json()).toEqual({ handler: 'catch-all' });

    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    expect(seen).toEqual(['/about']);
  });

  it('runs a path-scoped global middleware for a catch-all declared as /*/', async () => {
    const app = createAdapter();

    app.use(
      {
        override: false,
        handle: async (ctx: Context) => ctx.send({ error: 'Unauthorized' }, 401),
      },
      { include: ['/api/*'] },
    );
    app.registerRoute(route(HttpMethod.GET, '/*/', (ctx) => ctx.send({ handler: 'catch-all' })));

    const baseUrl = await start(app);

    const privateGet = await fetch(`${baseUrl}/api/private`);

    expect(privateGet.status).toBe(401);
    expect(await privateGet.json()).toEqual({ error: 'Unauthorized' });

    const page = await fetch(`${baseUrl}/about`);

    expect(page.status).toBe(200);
    expect(await page.json()).toEqual({ handler: 'catch-all' });
  });

  it('owns every method when registered for all of them', async () => {
    const app = createAdapter();

    app.registerRoute(route(HttpMethod.ALL, '/*', (ctx) => ctx.send({ method: ctx.req.method })));

    const baseUrl = await start(app);

    for (const method of ['GET', 'POST', 'DELETE']) {
      const response = await fetch(`${baseUrl}/anything`, { method });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ method });
    }
  });
});
