import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Server } from 'bun';
import type { ServerLogger } from '@asenajs/asena/logger';
import { HttpMethod } from '@asenajs/asena/web-types';
import { Ergenecore, ErgenecoreWebsocketAdapter } from '../lib';
import type { Context } from '../lib';

const mockLogger: ServerLogger = {
  profile: mock(() => {}),
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
};

const parseSetCookie = (header: string) => {
  const [pair, ...rest] = header.split(';').map((part) => part.trim());
  const eq = pair.indexOf('=');
  const attributes = new Map<string, string>();

  for (const attr of rest) {
    const i = attr.indexOf('=');

    attributes.set((i === -1 ? attr : attr.slice(0, i)).toLowerCase(), i === -1 ? '' : attr.slice(i + 1));
  }

  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attributes };
};

// A browser only replaces a __Host-/__Secure- cookie when the deleting Set-Cookie is itself Secure,
// so the deletion has to repeat the attributes the cookie was set with, as hono's deleteCookie does.
describe('deleteCookie - Set-Cookie attributes', () => {
  let adapter: Ergenecore;
  let server: Server<any> | undefined;

  beforeEach(() => {
    adapter = new Ergenecore(mockLogger, new ErgenecoreWebsocketAdapter(mockLogger));
    adapter.setPort(0);
    server = undefined;
  });

  afterEach(async () => {
    if (server) {
      await adapter.stop();
    }
  });

  const deleteVia = async (name: string, extraOptions?: Record<string, unknown>) => {
    adapter.registerRoute({
      staticServe: undefined,
      validator: undefined,
      method: HttpMethod.POST,
      path: '/logout',
      middlewares: [],
      handler: async (ctx: Context) => {
        await ctx.deleteCookie(name, extraOptions ? { extraOptions } : undefined);

        return ctx.send({ ok: true });
      },
    });

    server = await adapter.start();

    const response = await fetch(`http://localhost:${server.port}/logout`, { method: 'POST' });
    const headers = response.headers.getSetCookie();

    expect(response.status).toBe(200);
    expect(headers).toHaveLength(1);

    return parseSetCookie(headers[0]);
  };

  it('clears a __Host- cookie with Secure, HttpOnly, SameSite and Partitioned intact', async () => {
    const cookie = await deleteVia('__Host-session', {
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'strict',
      partitioned: true,
    });

    expect(cookie.name).toBe('__Host-session');
    expect(cookie.value).toBe('');
    expect(cookie.attributes.get('max-age')).toBe('0');
    expect(cookie.attributes.get('path')).toBe('/');
    expect(cookie.attributes.has('domain')).toBe(false);
    expect(cookie.attributes.has('secure')).toBe(true);
    expect(cookie.attributes.has('httponly')).toBe(true);
    expect(cookie.attributes.get('samesite')?.toLowerCase()).toBe('strict');
    expect(cookie.attributes.has('partitioned')).toBe(true);
  });

  it('clears a __Secure- cookie scoped to a domain and path', async () => {
    const cookie = await deleteVia('__Secure-token', {
      path: '/api',
      domain: 'example.com',
      secure: true,
      sameSite: 'none',
    });

    expect(cookie.value).toBe('');
    expect(cookie.attributes.get('max-age')).toBe('0');
    expect(cookie.attributes.get('path')).toBe('/api');
    expect(cookie.attributes.get('domain')).toBe('example.com');
    expect(cookie.attributes.has('secure')).toBe(true);
    expect(cookie.attributes.get('samesite')?.toLowerCase()).toBe('none');
  });

  it('still expires the cookie when the caller reuses setCookie options carrying a lifetime', async () => {
    const cookie = await deleteVia('__Host-session', {
      path: '/',
      secure: true,
      httpOnly: true,
      maxAge: 3600,
      expires: new Date(Date.now() + 3_600_000),
    });

    expect(cookie.value).toBe('');
    expect(cookie.attributes.get('max-age')).toBe('0');
    expect(new Date(cookie.attributes.get('expires')!).getTime()).toBe(0);
  });

  it('defaults to Path=/ and an expired lifetime without options', async () => {
    const cookie = await deleteVia('theme');

    expect(cookie.name).toBe('theme');
    expect(cookie.value).toBe('');
    expect(cookie.attributes.get('path')).toBe('/');
    expect(new Date(cookie.attributes.get('expires')!).getTime()).toBe(0);
    expect(cookie.attributes.get('max-age')).toBe('0');
    expect(cookie.attributes.has('secure')).toBe(false);
  });
});
