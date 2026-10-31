import { describe, expect, it } from 'bun:test';
import { ErgenecoreContextWrapper, HttpException } from '../lib';

const post = (body?: BodyInit) => new Request('http://x/', { method: 'POST', body });

describe('getBody promise contract', () => {
  it('returns a promise and caches the parsed body', async () => {
    const context = new ErgenecoreContextWrapper(post('{"a":1}'));
    const pending = context.getBody<{ a: number }>();

    expect(pending).toBeInstanceOf(Promise);

    const first = await pending;

    expect(first).toEqual({ a: 1 });
    expect(await context.getBody<unknown>()).toBe(first);
  });

  it('resolves an empty or whitespace body to an empty object', async () => {
    expect(await new ErgenecoreContextWrapper(post()).getBody<unknown>()).toEqual({});
    expect(await new ErgenecoreContextWrapper(post('  \n ')).getBody<unknown>()).toEqual({});
  });

  it('rejects malformed JSON with a 400 HttpException instead of throwing synchronously', async () => {
    const context = new ErgenecoreContextWrapper(post('{bad'));
    let pending: Promise<unknown> | undefined;

    expect(() => {
      pending = context.getBody();
    }).not.toThrow();

    const error = await pending!.then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).status).toBe(400);
  });

  it('does not cache a failed parse', async () => {
    const context = new ErgenecoreContextWrapper(post('{bad'));

    await expect(context.getBody()).rejects.toBeInstanceOf(HttpException);
    await expect(context.getBody()).rejects.toBeInstanceOf(HttpException);
  });

  it('rejects with a 400 when the body stream was already consumed elsewhere', async () => {
    const request = post('{"a":1}');

    await request.text();

    await expect(new ErgenecoreContextWrapper(request).getBody()).rejects.toBeInstanceOf(HttpException);
  });

  it('returns the validated body once one is set', async () => {
    const context = new ErgenecoreContextWrapper(post('{"a":1,"extra":true}'));

    await context.getBody();
    context.setValidatedBody({ a: 1 });

    expect(await context.getBody<unknown>()).toEqual({ a: 1 });
  });
});

describe('getQuery promise contract', () => {
  it('returns a promise for present, empty and missing parameters', async () => {
    const context = new ErgenecoreContextWrapper(new Request('http://x/p?name=x&empty=&enc=a%20b'));
    const pending = context.getQuery('name');

    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toBe('x');
    expect(await context.getQuery('empty')).toBe('');
    expect(await context.getQuery('missing')).toBeUndefined();
    expect(await context.getQuery('enc')).toBe('a b');
  });

  it('resolves undefined when the URL has no query', async () => {
    expect(await new ErgenecoreContextWrapper(new Request('http://x/p')).getQuery('name')).toBeUndefined();
  });
});

describe('context construction', () => {
  it('leaves routePattern undefined when none is given and keeps the one passed in', () => {
    expect(new ErgenecoreContextWrapper(new Request('http://x/')).routePattern).toBeUndefined();
    expect(new ErgenecoreContextWrapper(new Request('http://x/'), undefined, '/users/:id').routePattern).toBe(
      '/users/:id',
    );
  });

  it('still allows routePattern to be assigned', () => {
    const context = new ErgenecoreContextWrapper(new Request('http://x/'));

    context.routePattern = '/a';

    expect(context.routePattern).toBe('/a');
  });

  it('starts with no values, params or response state', () => {
    const context = new ErgenecoreContextWrapper(new Request('http://x/'));

    expect(context.getValue('anything')).toBeUndefined();
    expect(context.getParam('id')).toBe('');
    expect(context.res.status).toBeUndefined();
    expect(context.res.headers.size).toBe(0);
  });
});
