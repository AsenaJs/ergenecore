import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  ASENA_CONTEXT_ADAPTER,
  ASENA_CONTEXT_CONTRACT,
  isValidationError,
  type SchemaResult,
} from '@asenajs/asena/adapter';
import { HttpMethod } from '@asenajs/asena/web-types';
import { z } from 'zod';
import { Context, Ergenecore, ErgenecoreWebsocketAdapter } from '../lib';

const logger = { info: mock(() => {}), error: mock(() => {}), warn: mock(() => {}), profile: mock(() => {}) };
const schema = <T>(validate: (value: unknown) => SchemaResult<T> | Promise<SchemaResult<T>>) => ({
  '~standard': {
    version: 1 as const,
    vendor: 'test',
    validate,
    types: undefined as unknown as { input: unknown; output: T },
  },
});

describe('Ergenecore route context contracts', () => {
  const active: Ergenecore[] = [];
  afterEach(async () => {
    for (const adapter of active.splice(0)) await adapter.stop();
  });

  function makeAdapter() {
    const adapter = new Ergenecore(logger, new ErgenecoreWebsocketAdapter(logger));
    adapter.setPort(0);
    active.push(adapter);
    return adapter;
  }

  it('creates the real subclass and publishes transformed input after middleware', async () => {
    const order: string[] = [];
    class RouteContext extends Context.define({
      body: schema<{ count: number }>(async (value) => {
        order.push('body');
        const body = value as { count: string };
        return { value: { count: Number(body.count) } };
      }),
      query: schema<Record<string, string | string[]>>((value) => {
        order.push('query');
        return { value: value as Record<string, string | string[]> };
      }),
      params: schema<Record<string, string>>((value) => {
        order.push('params');
        return { value: value as Record<string, string> };
      }),
      headers: schema<Record<string, string>>((value) => {
        order.push('headers');
        return { value: value as Record<string, string> };
      }),
    }) {
      get doubled() {
        return this.input.body.count * 2;
      }
    }
    const adapter = makeAdapter();
    adapter.registerRoute({
      method: HttpMethod.POST,
      path: '/contract/:id',
      contextClass: RouteContext,
      middlewares: [
        {
          handle: async (ctx, next) => {
            order.push('middleware');
            await ctx.getBody();
            return next();
          },
        },
      ],
      handler: async (ctx) => {
        order.push('handler');
        const route = ctx as RouteContext;
        return route.send({
          subclass: route instanceof RouteContext,
          doubled: route.doubled,
          body: await route.getBody(),
          query: route.input.query,
          rawQuery: await route.getQuery('tag'),
          params: route.input.params,
          rawParam: route.getParam('id'),
          header: route.input.headers['x-test'],
          frozen: Object.isFrozen(route.input),
        });
      },
    } as any);
    const server = await adapter.start();
    const response = await fetch(`http://localhost:${server.port}/contract/42?tag=a&tag=b`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test': 'yes' },
      body: JSON.stringify({ count: '8' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      subclass: true,
      doubled: 16,
      body: { count: 8 },
      query: { tag: ['a', 'b'] },
      rawQuery: 'a',
      params: { id: '42' },
      rawParam: '42',
      header: 'yes',
      frozen: true,
    });
    expect(order).toEqual(['middleware', 'body', 'query', 'params', 'headers', 'handler']);
  });

  it('tracks successful undefined output and isolates concurrent requests', async () => {
    class RouteContext extends Context.define({
      body: schema(async (value) => {
        await Bun.sleep((value as { wait: number }).wait);
        return { value: undefined };
      }),
      query: schema((value) => ({ value })),
    }) {}
    const adapter = makeAdapter();
    adapter.registerRoute({
      method: HttpMethod.POST,
      path: '/concurrent',
      contextClass: RouteContext,
      middlewares: [],
      handler: async (ctx) => {
        const route = ctx as RouteContext;
        return route.send({ bodyIsUndefined: (await route.getBody()) === undefined, query: route.input.query });
      },
    } as any);
    const server = await adapter.start();
    const post = (name: string, wait: number) =>
      fetch(`http://localhost:${server.port}/concurrent?name=${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wait }),
      }).then((response) => response.json());
    expect(await Promise.all([post('slow', 15), post('fast', 1)])).toEqual([
      { bodyIsUndefined: true, query: { name: 'slow' } },
      { bodyIsUndefined: true, query: { name: 'fast' } },
    ]);
  });

  it('preserves repeated form values and publishes transformed form output', async () => {
    class FormContext extends Context.define({
      form: schema<{ tags: string[]; count: number }>((value) => {
        const form = value as { tags: string[]; count: string };
        return { value: { tags: form.tags, count: Number(form.count) } };
      }),
    }) {}
    const adapter = makeAdapter();
    adapter.registerRoute({
      method: HttpMethod.POST,
      path: '/form',
      contextClass: FormContext,
      middlewares: [],
      handler: async (ctx) => {
        const route = ctx as FormContext;
        return route.send({ input: route.input.form, parsed: await route.getParseBody() });
      },
    } as any);
    const server = await adapter.start();
    const response = await fetch(`http://localhost:${server.port}/form`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'tags=one&tags=two&count=3',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      input: { tags: ['one', 'two'], count: 3 },
      parsed: { tags: ['one', 'two'], count: 3 },
    });
  });

  it('rejects contract issues, invalid JSON and wrong content type before the handler', async () => {
    let handled = 0;
    let errorTarget: string | undefined;
    class RouteContext extends Context.define({
      body: schema((value) =>
        value && typeof value === 'object' ? { issues: [{ message: 'Bad body', path: [{ key: 'name' }] }] } : { value },
      ),
    }) {}
    const adapter = makeAdapter();
    adapter.onError((error, ctx) => {
      if (isValidationError(error)) errorTarget = error.target;
      return ctx.send({ status: (error as any).status }, (error as any).status ?? 500);
    });
    adapter.registerRoute({
      method: HttpMethod.POST,
      path: '/invalid',
      contextClass: RouteContext,
      middlewares: [],
      handler: async (ctx) => {
        handled++;
        return ctx.send({ ok: true });
      },
    } as any);
    const server = await adapter.start();
    const url = `http://localhost:${server.port}/invalid`;
    expect(
      (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status,
    ).toBe(400);
    expect(errorTarget).toBe('body');
    expect(
      (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status,
    ).toBe(400);
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })).status).toBe(
      415,
    );
    expect(handled).toBe(0);
  });

  it('rejects conflicting or foreign direct registrations at registration time', () => {
    class RouteContext extends Context.define({ query: schema((value) => ({ value })) }) {}
    const adapter = makeAdapter();
    const base = {
      method: HttpMethod.GET,
      path: '/guard',
      middlewares: [],
      handler: async (ctx: any) => ctx.send({ ok: true }),
    };
    expect(() => adapter.registerRoute({ ...base, contextClass: RouteContext, validator: {} } as any)).toThrow('both');
    expect(() =>
      adapter.registerRoute({ ...base, contextContract: RouteContext[ASENA_CONTEXT_CONTRACT] } as any),
    ).toThrow('requires contextClass');
    expect(() => adapter.registerRoute({ ...base, validatorCache: false } as any)).toThrow(
      'requires a legacy validator',
    );
    expect(() => adapter.registerRoute({ ...base, validator: {}, validatorCache: 'yes' } as any)).toThrow('boolean');
    class ForeignContext extends RouteContext {}
    Object.defineProperty(ForeignContext, ASENA_CONTEXT_ADAPTER, { value: 'hono' });
    expect(() => adapter.registerRoute({ ...base, contextClass: ForeignContext } as any)).toThrow('hono');
  });

  it('caches async legacy factories by default and invokes uncached factories per request', async () => {
    const cachedFactory = mock(async () => z.object({ count: z.coerce.number() }));
    const uncachedFactory = mock(async () => z.object({ count: z.coerce.number() }));
    const adapter = makeAdapter();
    for (const [path, factory, validatorCache] of [
      ['/cached', cachedFactory, undefined],
      ['/uncached', uncachedFactory, false],
    ] as const) {
      adapter.registerRoute({
        method: HttpMethod.POST,
        path,
        validatorCache,
        middlewares: [],
        validator: { json: { handle: factory } },
        handler: async (ctx) => ctx.send(await ctx.getBody()),
      } as any);
    }
    const server = await adapter.start();
    expect(cachedFactory).toHaveBeenCalledTimes(1);
    expect(uncachedFactory).toHaveBeenCalledTimes(0);
    for (let i = 0; i < 2; i++) {
      for (const path of ['/cached', '/uncached']) {
        const response = await fetch(`http://localhost:${server.port}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ count: '2' }),
        });
        expect(await response.json()).toEqual({ count: 2 });
      }
    }
    expect(cachedFactory).toHaveBeenCalledTimes(1);
    expect(uncachedFactory).toHaveBeenCalledTimes(2);
  });

  it('keeps cached schemas and hooks per route while uncached factories see changed settings', async () => {
    let minimum = 1;
    let hookCalls = 0;
    const factory = mock(async () => ({
      schema: z.object({ count: z.number().min(minimum) }),
      hook: () => {
        hookCalls++;
      },
    }));
    const adapter = makeAdapter();
    for (const [path, cache] of [
      ['/cached-dynamic', true],
      ['/uncached-dynamic', false],
    ] as const) {
      adapter.registerRoute({
        method: HttpMethod.POST,
        path,
        validatorCache: cache,
        middlewares: [],
        validator: { json: { handle: factory } },
        handler: async (ctx) => ctx.send(await ctx.getBody()),
      } as any);
    }
    const server = await adapter.start();
    expect(factory).toHaveBeenCalledTimes(1);
    minimum = 5;
    const send = (path: string) =>
      fetch(`http://localhost:${server.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"count":2}',
      });
    expect((await send('/cached-dynamic')).status).toBe(200);
    expect((await send('/uncached-dynamic')).status).toBe(400);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(hookCalls).toBe(1);
  });

  it('reports route and target when a cached factory fails during startup', async () => {
    const adapter = makeAdapter();
    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/broken',
      middlewares: [],
      validator: {
        query: {
          handle: async () => {
            throw new Error('factory failed');
          },
        },
      },
      handler: async (ctx) => ctx.send({ ok: true }),
    } as any);
    await expect(adapter.start()).rejects.toThrow('GET /broken (query)');
  });
});
