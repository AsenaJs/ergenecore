import { afterEach, describe, expect, it, mock } from 'bun:test';
import { type SchemaResult } from '@asenajs/asena/adapter';
import { HttpMethod } from '@asenajs/asena/web-types';
import { Context, Ergenecore, ErgenecoreWebsocketAdapter, HttpException } from '../lib';

const logger = { info: mock(() => {}), error: mock(() => {}), warn: mock(() => {}), profile: mock(() => {}) };
const schema = <T>(validate: (value: unknown) => SchemaResult<T>) => ({
  '~standard': {
    version: 1 as const,
    vendor: 'test',
    validate,
    types: undefined as unknown as { input: unknown; output: T },
  },
});

describe('Ergenecore context subclass constructor errors', () => {
  const active: Ergenecore[] = [];

  afterEach(async () => {
    for (const adapter of active.splice(0)) await adapter.stop();
  });

  for (const middlewares of [[], [{ handle: async (_ctx: any, next: () => Promise<void>) => next() }]]) {
    it(`routes a throwing constructor through onError (${middlewares.length ? 'middleware' : 'fast'} path)`, async () => {
      class RouteContext extends Context.define({ query: schema((value) => ({ value })) }) {
        public constructor(request: Request) {
          super(request);
          throw new HttpException(401, { error: 'no session' });
        }
      }

      const adapter = new Ergenecore(logger, new ErgenecoreWebsocketAdapter(logger));

      adapter.setPort(0);
      active.push(adapter);

      const seen: unknown[] = [];

      adapter.onError(async (error, ctx) => {
        seen.push(error);
        return ctx.send({ handled: true }, 401);
      });
      adapter.registerRoute({
        method: HttpMethod.GET,
        path: '/guarded',
        contextClass: RouteContext,
        middlewares,
        handler: async (ctx: Context) => ctx.send({ reached: true }),
      } as any);

      const server = await adapter.start();
      const response = await fetch(`http://localhost:${server.port}/guarded`);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ handled: true });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBeInstanceOf(HttpException);
    });
  }
});
