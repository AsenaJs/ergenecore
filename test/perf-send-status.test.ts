import { describe, expect, it } from 'bun:test';
import { ErgenecoreContextWrapper } from '../lib/ErgenecoreContextWrapper';

const context = () => new ErgenecoreContextWrapper(new Request('http://localhost/x'));

const entries = (headers: Headers): [string, string][] => {
  const list: [string, string][] = [];

  headers.forEach((value, key) => {
    list.push([key, value]);
  });

  return list;
};

describe('send() with a numeric status', () => {
  it('answers JSON with the status and records it on res', async () => {
    const ctx = context();
    const response = ctx.send({ ok: true }, 201);

    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ ok: true });
    expect(ctx.res.status).toBe(201);
  });

  it('answers 200 JSON identically to the no-status form', async () => {
    const withStatus = context().send({ a: 1 }, 200);
    const without = context().send({ a: 1 });

    expect(withStatus.status).toBe(without.status);
    expect(entries(withStatus.headers)).toEqual(entries(without.headers));
    expect(await withStatus.text()).toBe(await without.text());
  });

  it('answers strings as text with the given status', async () => {
    const ctx = context();
    const response = ctx.send('created', 202);

    const reference = new Response('created', { status: 202, headers: {} });

    expect(response.status).toBe(202);
    expect(entries(response.headers)).toEqual(entries(reference.headers));
    expect(await response.text()).toBe('created');
  });

  it('keeps headers staged by middleware', async () => {
    const ctx = context();

    ctx.setResponseHeader('X-Trace', 'abc');

    const response = ctx.send({ ok: true }, 404);

    expect(response.status).toBe(404);
    expect(response.headers.get('x-trace')).toBe('abc');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(ctx.res.status).toBe(404);
  });

  it('records the status on an existing res without staged headers', () => {
    const ctx = context();

    expect(ctx.res.headers.size).toBe(0);

    ctx.send({ ok: true }, 418);

    expect(ctx.res.status).toBe(418);
  });

  it('does not share header objects between responses', () => {
    const first = context().send({ n: 1 }, 200);
    const second = context().send({ n: 2 }, 200);

    first.headers.set('x-only-first', '1');

    expect(second.headers.get('x-only-first')).toBeNull();
  });
});
