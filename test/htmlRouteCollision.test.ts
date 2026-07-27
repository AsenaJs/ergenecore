import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Ergenecore } from '../lib';
import type { Context } from '../lib';
import { HttpMethod } from '@asenajs/asena/web-types';
import type { ServerLogger } from '@asenajs/asena/logger';

const mockLogger: ServerLogger = {
  profile: mock(() => {}),
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
};

/**
 * A `@Page` and an HTTP route on the same path must be rejected at boot.
 *
 * HTML routes do not go through the adapter at all - they are handed to `Bun.serve({ routes })`,
 * which Bun checks *before* it falls through to the request handler. So a page registered on a
 * path an API route also serves does not conflict at registration time and does not conflict at
 * request time either: the page simply wins. The API route stays in the startup log, stays in
 * the route table, and is unreachable. Every caller gets 200 with a chunk of HTML where it
 * expected JSON, which reads as a client bug for as long as anyone is willing to look.
 *
 * A stand-in `Response` is used for the bundle rather than a real `.html` import - Bun accepts
 * either in `routes`, both shadow `fetch` identically, and the adapter only ever stores the
 * value.
 */
describe('HTML route collisions', () => {
  let server: any;

  afterEach(async () => {
    await server?.stop(true);
    server = undefined;
  });

  const page = () => new Response('<html>page</html>', { headers: { 'Content-Type': 'text/html' } });

  const adapterWith = (apiPath: string, pagePath: string) => {
    const adapter = new Ergenecore(mockLogger);

    adapter.setPort(0);

    adapter.registerRoute({
      method: HttpMethod.GET,
      path: apiPath,
      middlewares: [],
      handler: async (context: Context) => context.send({ from: 'api' }),
    } as any);

    adapter.registerHTMLRoute(pagePath, page(), 'DashboardController', '/');

    return adapter;
  };

  test('a page on the same path as an API route throws at boot', async () => {
    await expect(adapterWith('/dashboard', '/dashboard').start()).rejects.toThrow(/HTML route collision/);
  });

  test('the message names the path that collided', async () => {
    // The two declarations live in different files - a controller and a frontend controller -
    // and neither is wrong on its own. The path is the only thing that leads to both.
    await expect(adapterWith('/dashboard', '/dashboard').start()).rejects.toThrow('/dashboard');
  });

  test('the trailing-slash variant collides too', async () => {
    // registerHTMLRoute writes both `/reports` and `/reports/`, and the router registers both
    // variants of an API path. A check that compared only the string it was given would let
    // this pair through and reintroduce the shadowing on one of the two spellings.
    await expect(adapterWith('/reports/', '/reports').start()).rejects.toThrow(/HTML route collision/);
  });

  test('a page on a free path boots, and both are reachable', async () => {
    const adapter = adapterWith('/api/data', '/ui/dashboard');

    server = await adapter.start();

    const api = await fetch(`http://localhost:${server.port}/api/data`);

    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({ from: 'api' });

    const ui = await fetch(`http://localhost:${server.port}/ui/dashboard`);

    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain('<html>');
  });

  test('a duplicate page path is still rejected at registration', async () => {
    const adapter = new Ergenecore(mockLogger);

    adapter.registerHTMLRoute('/ui/home', page(), 'HomeController', '/');

    // Different failure, different moment - two pages fighting is caught immediately, a page
    // fighting an API route can only be caught once every route is known.
    expect(() => adapter.registerHTMLRoute('/ui/home', page(), 'OtherController', '/')).toThrow(/Duplicate HTML route/);
  });
});
