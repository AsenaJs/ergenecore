import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ServerLogger } from '@asenajs/asena/logger';
import { HttpMethod } from '@asenajs/asena/web-types';
import { type Context, Ergenecore, ErgenecoreContextWrapper, ErgenecoreWebsocketAdapter } from '../lib';

const logger: ServerLogger = {
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  profile: mock(() => {}),
};

describe('Fast path handler results', () => {
  let adapter: Ergenecore;

  const register = (path: string, handler: (ctx: Context) => any, method = HttpMethod.GET) => {
    adapter.registerRoute({
      staticServe: undefined,
      validator: undefined,
      method,
      path,
      middlewares: [],
      handler,
    });
  };

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

  it('answers synchronous string, object and raw Response results', async () => {
    register('/text', (ctx) => ctx.send('Hello'));
    register('/object', (ctx) => ctx.send({ a: 1 }));
    register('/plain', () => ({ b: 2 }));
    register('/raw', () => new Response('raw', { status: 201 }));

    await adapter.start();

    const text = await fetch(url('/text'));

    expect(text.status).toBe(200);
    expect(text.headers.get('content-type')).toBe('text/plain;charset=utf-8');
    expect(await text.text()).toBe('Hello');

    const object = await fetch(url('/object'));

    expect(object.headers.get('content-type')).toBe('application/json');
    expect(await object.text()).toBe('{"a":1}');

    const plain = await fetch(url('/plain'));

    expect(plain.status).toBe(200);
    expect(plain.headers.get('content-type')).toBe('application/json');
    expect(await plain.text()).toBe('{"b":2}');

    const raw = await fetch(url('/raw'));

    expect(raw.status).toBe(201);
    expect(await raw.text()).toBe('raw');
  });

  it('routes a synchronous throw and an async rejection through onError', async () => {
    const errorHandler = mock((error: Error) => new Response(`handled:${error.message}`, { status: 418 }));

    adapter.onError(errorHandler);
    register('/sync-throw', () => {
      throw new Error('sync');
    });
    register('/async-throw', async () => {
      throw new Error('async');
    });

    await adapter.start();

    const sync = await fetch(url('/sync-throw'));

    expect(sync.status).toBe(418);
    expect(await sync.text()).toBe('handled:sync');

    const asyncResponse = await fetch(url('/async-throw'));

    expect(asyncResponse.status).toBe(418);
    expect(await asyncResponse.text()).toBe('handled:async');
    expect(errorHandler).toHaveBeenCalledTimes(2);
  });

  it('awaits non-Promise thenables returned by a handler', async () => {
    register('/thenable', () => ({
      then: (resolve: (value: unknown) => void) => resolve({ c: 3 }),
    }));

    await adapter.start();

    const response = await fetch(url('/thenable'));

    expect(await response.json()).toEqual({ c: 3 });
  });

  it('passes route params and query to async handlers', async () => {
    register('/user/:id', async (ctx) => ctx.send({ id: ctx.getParam('id'), name: await ctx.getQuery('name') }));

    await adapter.start();

    const response = await fetch(url('/user/42?name=x'));

    expect(await response.json()).toEqual({ id: '42', name: 'x' });
  });
});

describe('Context response status', () => {
  it('records the status of send() on context.res, whenever res is first read', () => {
    const before = new ErgenecoreContextWrapper(new Request('http://localhost/'));

    expect(before.res.status).toBeUndefined();
    before.send('x');
    expect(before.res.status).toBe(200);

    const after = new ErgenecoreContextWrapper(new Request('http://localhost/'));

    after.send({ a: 1 });
    expect(after.res.status).toBe(200);
    expect(after.res.headers.size).toBe(0);

    const explicit = new ErgenecoreContextWrapper(new Request('http://localhost/'));

    explicit.send('x');
    explicit.send('y', 404);
    expect(explicit.res.status).toBe(404);
  });

  it('keeps staged middleware headers on send() without options', async () => {
    const ctx = new ErgenecoreContextWrapper(new Request('http://localhost/'));

    ctx.setResponseHeader('X-Test', 'yes');

    const text = ctx.send('x');

    expect(text.headers.get('x-test')).toBe('yes');

    const json = ctx.send({ a: 1 });

    expect(json.headers.get('x-test')).toBe('yes');
    expect(json.headers.get('content-type')).toBe('application/json');
    expect(await json.text()).toBe('{"a":1}');
  });

  it('does not share header state between JSON responses', () => {
    const first = new ErgenecoreContextWrapper(new Request('http://localhost/')).send({ a: 1 });

    first.headers.set('x-mutated', '1');

    const second = new ErgenecoreContextWrapper(new Request('http://localhost/')).send({ a: 2 });

    expect(second.headers.has('x-mutated')).toBe(false);
  });
});

describe('Context query parsing', () => {
  const ctx = (url: string) => new ErgenecoreContextWrapper(new Request(url));

  it('matches URL.searchParams semantics', async () => {
    const urls = [
      'http://localhost/a',
      'http://localhost/a?',
      'http://localhost/a?name=',
      'http://localhost/a?name',
      'http://localhost/a?name=x&name=y&other=z',
      'http://localhost/a?name=a+b&sp=%20c&bad=%zz',
      'http://localhost/a?name=x#frag?name=y',
      'http://localhost/a?q=1?2&name=caf%C3%A9',
      'http://localhost/a b?name=a b',
      'http://localhost/a?name=é&x[]=1&x[]=2',
    ];

    for (const raw of urls) {
      const context = ctx(raw);
      const expected = new URL(new Request(raw).url).searchParams;

      for (const key of ['name', 'other', 'sp', 'bad', 'q', 'x[]', 'missing']) {
        expect(await context.getQuery(key)).toBe(expected.get(key) ?? undefined);
        expect(await context.getQueryAll(key)).toEqual(expected.getAll(key));
      }

      const all: Record<string, string | string[]> = {};

      for (const [key, value] of expected.entries()) {
        const existing = all[key];

        all[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
      }

      expect(context.getAllQueries()).toEqual(all);
    }
  });

  it('distinguishes an empty parameter from an absent one', async () => {
    expect(await ctx('http://localhost/a?name=').getQuery('name')).toBe('');
    expect(await ctx('http://localhost/a').getQuery('name')).toBeUndefined();
  });
});

describe('Context JSON body', () => {
  it('parses repeated reads, empty bodies and multibyte text', async () => {
    const post = (body: string) =>
      new ErgenecoreContextWrapper(
        new Request('http://localhost/', { method: 'POST', body, headers: { 'content-type': 'application/json' } }),
      );

    const multibyte = post('{"message":"Merhaba dünya ✓"}');

    expect(await multibyte.getBody<unknown>()).toEqual({ message: 'Merhaba dünya ✓' });
    expect(await multibyte.getBody<unknown>()).toEqual({ message: 'Merhaba dünya ✓' });
    expect(await post('').getBody<unknown>()).toEqual({});
    expect(await post('   ').getBody<unknown>()).toEqual({});
    await expect(post('{bad').getBody()).rejects.toMatchObject({ status: 400 });
  });
});
