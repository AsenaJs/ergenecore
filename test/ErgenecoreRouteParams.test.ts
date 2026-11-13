import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { ServerLogger } from '@asenajs/asena/logger';
import { HttpMethod } from '@asenajs/asena/web-types';
import { Ergenecore, type Context, type ErgenecoreRouteParams } from '../index';

const logger: ServerLogger = {
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  profile: mock(() => {}),
};

describe('ErgenecoreRouteParams', () => {
  let adapter: Ergenecore | undefined;

  afterEach(async () => {
    await adapter?.stop();
    adapter = undefined;
  });

  it('types a route registered without staticServe and validator', async () => {
    const route: ErgenecoreRouteParams = {
      method: HttpMethod.GET,
      path: '/ping',
      middlewares: [],
      handler: async (ctx: Context) => ctx.send({ pong: true }),
    };

    adapter = new Ergenecore(logger);
    adapter.setPort(0);
    adapter.registerRoute(route);

    const server = await adapter.start();
    const response = await fetch(`http://localhost:${server.port}/ping`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pong: true });
  });
});
