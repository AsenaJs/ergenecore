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

const BOM_JSON = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"a":1}')]);
const INVALID_UTF8 = new Uint8Array([0x7b, 0x7d, 0xff, 0xfe]);

describe('Raw body replay', () => {
  it('returns the exact request bytes from getArrayBuffer after getBody', async () => {
    const context = new ErgenecoreContextWrapper(new Request('http://x/', { method: 'POST', body: BOM_JSON }));

    expect(await context.getBody<unknown>()).toEqual({ a: 1 });

    const buffer = await context.getArrayBuffer();

    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(buffer)).toEqual(BOM_JSON);
  });

  it('keeps bytes that are not valid UTF-8', async () => {
    const context = new ErgenecoreContextWrapper(new Request('http://x/', { method: 'POST', body: INVALID_UTF8 }));

    await expect(context.getBody()).rejects.toThrow();
    expect(new Uint8Array(await context.getArrayBuffer())).toEqual(INVALID_UTF8);
    expect(new Uint8Array(await (await context.getBlob()).arrayBuffer())).toEqual(INVALID_UTF8);
  });

  it('hands out the same ArrayBuffer on every call', async () => {
    const context = new ErgenecoreContextWrapper(new Request('http://x/', { method: 'POST', body: '{"b":2}' }));
    const [first, second] = await Promise.all([context.getArrayBuffer(), context.getArrayBuffer()]);

    expect(first).toBe(second);
    expect(first.byteLength).toBe(7);
    expect(await context.getBody<unknown>()).toEqual({ b: 2 });
  });

  it('reads the body of a request object that only implements arrayBuffer()', async () => {
    const real = new Request('http://x/', { method: 'POST', body: '{"c":3}' });
    const request = {
      url: real.url,
      headers: real.headers,
      arrayBuffer: () => real.arrayBuffer(),
    } as unknown as Request;
    const context = new ErgenecoreContextWrapper(request);

    expect(await context.getBody<unknown>()).toEqual({ c: 3 });
    expect((await context.getArrayBuffer()).byteLength).toBe(7);
  });
});

describe('Raw body replay through the server', () => {
  let adapter: Ergenecore;

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

  it('serves parsed JSON and the original bytes to the same handler', async () => {
    adapter.registerRoute({
      staticServe: undefined,
      validator: undefined,
      method: HttpMethod.POST,
      path: '/echo',
      middlewares: [],
      handler: async (ctx: Context) => {
        const body = await ctx.getBody<{ a: number }>();
        const bytes = new Uint8Array(await ctx.getArrayBuffer());

        return ctx.send({ a: body.a, bytes: Array.from(bytes) });
      },
    });
    await adapter.start();

    const response = await fetch(url('/echo'), { method: 'POST', body: BOM_JSON });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ a: 1, bytes: Array.from(BOM_JSON) });
  });

  it('answers getParam with an empty string on routes without parameters', async () => {
    adapter.registerRoute({
      staticServe: undefined,
      validator: undefined,
      method: HttpMethod.GET,
      path: '/static',
      middlewares: [],
      handler: (ctx: Context) => ctx.send({ id: ctx.getParam('id'), value: ctx.getValue('param:id') ?? null }),
    });
    adapter.registerRoute({
      staticServe: undefined,
      validator: undefined,
      method: HttpMethod.GET,
      path: '/item/:id',
      middlewares: [],
      handler: (ctx: Context) => ctx.send({ id: ctx.getParam('id'), value: ctx.getValue('param:id') ?? null }),
    });
    await adapter.start();

    expect(await (await fetch(url('/static'))).json()).toEqual({ id: '', value: null });
    expect(await (await fetch(url('/item/7'))).json()).toEqual({ id: '7', value: '7' });
  });

  it('routes a rejected async handler to the error envelope', async () => {
    adapter.registerRoute({
      staticServe: undefined,
      validator: undefined,
      method: HttpMethod.GET,
      path: '/boom',
      middlewares: [],
      handler: async () => {
        await Promise.resolve();
        throw new Error('secret detail');
      },
    });
    await adapter.start();

    const response = await fetch(url('/boom'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal Server Error' });
  });
});
