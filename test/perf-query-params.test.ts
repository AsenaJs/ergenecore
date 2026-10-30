import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { BaseMiddleware } from '@asenajs/asena/adapter';
import type { ServerLogger } from '@asenajs/asena/logger';
import { HttpMethod } from '@asenajs/asena/web-types';
import { type Context, Ergenecore, ErgenecoreContextWrapper, ErgenecoreWebsocketAdapter } from '../lib';

const logger: ServerLogger = {
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  profile: mock(() => {}),
};

const QUERIES = [
  '',
  'name=x',
  'name=x&name=y',
  'name',
  'name=',
  'name=&name=y',
  '&&name=x&&',
  '&',
  '=x',
  'names=1&name=2',
  'nam=1&name=2',
  'name=a=b',
  'a=1&b=2&name=3',
  'name=x#frag',
  'name=%41',
  'na%6De=1',
  'name=a+b',
  'na+me=1',
  'name=%zz',
  'name=%',
  'name=%E2%82%AC',
  'name=ü',
  'näme=1',
  'other=1',
  'NAME=1',
];

const NAMES = ['name', 'nam', 'names', 'na me', 'a', 'b', '', 'NAME', 'näme', 'name=a', 'x&name'];

describe('getQuery matches URLSearchParams', () => {
  for (const query of QUERIES) {
    it(`query "${query}"`, async () => {
      const hashStart = query.indexOf('#');
      const oracleSource = hashStart === -1 ? query : query.slice(0, hashStart);
      const oracle = new URLSearchParams(oracleSource);

      for (const name of NAMES) {
        const context = new ErgenecoreContextWrapper(new Request(`http://localhost/path?${query}`));

        expect(await context.getQuery(name)).toBe(oracle.get(name) ?? undefined);
      }
    });
  }

  it('returns undefined without a query string', async () => {
    const context = new ErgenecoreContextWrapper(new Request('http://localhost/path'));

    expect(await context.getQuery('name')).toBeUndefined();
    expect(await context.getQueryAll('name')).toEqual([]);
    expect(context.getAllQueries()).toEqual({});
  });

  it('stays consistent with getQueryAll and getAllQueries in any call order', async () => {
    const first = new ErgenecoreContextWrapper(new Request('http://localhost/path?a=1&a=2&b=3'));

    expect(await first.getQuery('a')).toBe('1');
    expect(await first.getQueryAll('a')).toEqual(['1', '2']);
    expect(await first.getQuery('a')).toBe('1');
    expect(first.getAllQueries()).toEqual({ a: ['1', '2'], b: '3' });

    const second = new ErgenecoreContextWrapper(new Request('http://localhost/path?a=1&a=2&b=3'));

    expect(await second.getQueryAll('a')).toEqual(['1', '2']);
    expect(await second.getQuery('b')).toBe('3');
  });
});

describe('Route params and query through the server', () => {
  let adapter: Ergenecore;

  const register = (
    path: string,
    handler: (ctx: Context) => any,
    method = HttpMethod.GET,
    middlewares: BaseMiddleware<Context>[] = [],
  ) => {
    adapter.registerRoute({
      staticServe: undefined,
      validator: undefined,
      method,
      path,
      middlewares,
      handler,
    });
  };

  const passThrough = (): BaseMiddleware<Context> =>
    ({
      handle: async (_ctx: Context, next: () => Promise<void>) => {
        await next();
        return true;
      },
      override: false,
    }) as any;

  const url = (path: string) => `http://localhost:${adapter['server'].port}${path}`;

  beforeEach(() => {
    adapter = new Ergenecore(logger, new ErgenecoreWebsocketAdapter(logger));
    adapter.setPort(0);
  });

  afterEach(async () => {
    if (adapter['server']) {
      await adapter.stop();
    }
  });

  const paramsHandler = async (ctx: Context) =>
    ctx.send({
      id: ctx.getParam('id'),
      slug: ctx.getParam('slug'),
      missing: ctx.getParam('missing'),
      inherited: ctx.getParam('toString'),
      viaValue: ctx.getValue('param:id') ?? null,
      name: (await ctx.getQuery('name')) ?? null,
      encoded: (await ctx.getQuery('q')) ?? null,
    });

  const expected = {
    id: '42',
    slug: 'hello',
    missing: '',
    inherited: '',
    viaValue: '42',
    name: 'x',
    encoded: 'a b€',
  };

  it('exposes params and query on the fast path', async () => {
    register('/fast/:id/:slug', paramsHandler);
    await adapter.start();

    const response = await fetch(url('/fast/42/hello?name=x&q=a+b%E2%82%AC'));

    expect(await response.json()).toEqual(expected);
  });

  it('exposes params and query on the middleware path', async () => {
    register('/slow/:id/:slug', paramsHandler, HttpMethod.GET, [passThrough()]);
    await adapter.start();

    const response = await fetch(url('/slow/42/hello?name=x&q=a+b%E2%82%AC'));

    expect(await response.json()).toEqual(expected);
  });

  it('lets setValue override a param before and after the values store exists', async () => {
    register('/override/:id', (ctx) => {
      const before = ctx.getParam('id');

      ctx.setValue('param:id', 'changed');

      return ctx.send({ before, after: ctx.getParam('id'), value: ctx.getValue('param:id') });
    });
    register('/store-first/:id', (ctx) => {
      ctx.setValue('other', 1);

      return ctx.send({ id: ctx.getParam('id'), value: ctx.getValue('param:id') });
    });
    await adapter.start();

    expect(await (await fetch(url('/override/7'))).json()).toEqual({
      before: '7',
      after: 'changed',
      value: 'changed',
    });
    expect(await (await fetch(url('/store-first/8'))).json()).toEqual({ id: '8', value: '8' });
  });

  it('returns an empty string for params on a route without any', async () => {
    register('/none', (ctx) => ctx.send({ id: ctx.getParam('id'), value: ctx.getValue('param:id') ?? null }));
    await adapter.start();

    expect(await (await fetch(url('/none'))).json()).toEqual({ id: '', value: null });
  });

  it('keeps the content type available after the body was read', async () => {
    register(
      '/form-after-raw',
      async (ctx) => {
        const raw = await ctx.getArrayBuffer();
        const form = await ctx.getFormData();
        const blob = await ctx.getBlob();

        return ctx.send({ size: raw.byteLength > 0, field: form.get('field'), type: blob.type.split(';')[0] });
      },
      HttpMethod.POST,
    );
    register(
      '/blob-after-json',
      async (ctx) => {
        const body = await ctx.getBody<any>();
        const blob = await ctx.getBlob();

        return ctx.send({ body, type: blob.type });
      },
      HttpMethod.POST,
      [passThrough()],
    );
    await adapter.start();

    const form = new FormData();

    form.append('field', 'value');

    const formResponse = await fetch(url('/form-after-raw'), { method: 'POST', body: form });

    expect(await formResponse.json()).toEqual({ size: true, field: 'value', type: 'multipart/form-data' });

    const jsonResponse = await fetch(url('/blob-after-json'), {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'Content-Type': 'application/json' },
    });

    const json = await jsonResponse.json();

    expect(json.body).toEqual({ a: 1 });
    expect(json.type.startsWith('application/json')).toBe(true);
  });

  it('keeps the derived content type of an in-process FormData request', async () => {
    const form = new FormData();

    form.append('field', 'value');

    const context = new ErgenecoreContextWrapper(new Request('http://localhost/x', { method: 'POST', body: form }));

    await context.getArrayBuffer();

    expect((await context.getFormData()).get('field')).toBe('value');
  });
});
