import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Ergenecore, ErgenecoreWebsocketAdapter } from '../lib';
import type { ServerLogger } from '@asenajs/asena/logger';
import type { BaseValidator } from '@asenajs/asena/adapter';
import { HttpMethod } from '@asenajs/asena/web-types';
import type { Context, ValidationSchemaWithHook } from '../lib';
import type { Server } from 'bun';
import { z } from 'zod';

const mockLogger: ServerLogger = {
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  profile: mock(() => {}),
};

/**
 * `getBody()` must hand the handler what the schema describes, not what the client sent.
 *
 * These encode a security property, not a convenience: `validateRequest()` ran `safeParse`, threw
 * on failure, and dropped `result.data` on success - so `getBody()` kept returning the raw
 * `JSON.parse` output from the body cache. A route could declare a strict schema, pass validation,
 * and still hand `updateById({ ...body })` every extra key the client attached, because
 * `z.object()` strips unknown keys rather than rejecting them. The schema looked like it prevented
 * mass assignment and prevented nothing, and unlike the Hono adapter there was not even a raw
 * accessor to reach the parsed value.
 */
describe('getBody() returns validated data', () => {
  let adapter: Ergenecore;
  let server: Server<any>;

  beforeEach(() => {
    adapter = new Ergenecore(mockLogger, new ErgenecoreWebsocketAdapter(mockLogger));
    adapter.setPort(0);
  });

  afterEach(async () => {
    if (server) {
      await adapter.stop();
    }
  });

  /** Registers POST /body echoing whatever getBody() yields, optionally behind a json validator. */
  async function boot(schema?: z.ZodType) {
    const validator: BaseValidator<ValidationSchemaWithHook> | undefined = schema
      ? { json: { handle: () => ({ schema }), override: false } }
      : undefined;

    adapter.registerRoute({
      staticServe: undefined,
      method: HttpMethod.POST,
      path: '/body',
      middlewares: [],
      validator,
      handler: async (ctx: Context) => ctx.send({ body: await ctx.getBody() }),
    } as any);

    server = await adapter.start();

    return `http://localhost:${server.port}`;
  }

  function post(baseUrl: string, body: unknown) {
    return fetch(`${baseUrl}/body`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('strips keys the schema does not declare', async () => {
    const baseUrl = await boot(z.object({ voteLock: z.boolean() }));

    const response = await post(baseUrl, {
      voteLock: true,
      ownerId: 'attacker-id',
      password: 'plaintext',
    });

    expect(response.status).toBe(200);

    const { body } = await response.json();

    // The two extra keys are the mass-assignment payload. Reaching the handler at all is the bug.
    expect(body).toEqual({ voteLock: true });
    expect(body.ownerId).toBeUndefined();
    expect(body.password).toBeUndefined();
  });

  it('applies schema defaults', async () => {
    const baseUrl = await boot(
      z.object({
        name: z.string(),
        role: z.string().default('member'),
      }),
    );

    const response = await post(baseUrl, { name: 'Alice' });

    expect((await response.json()).body).toEqual({ name: 'Alice', role: 'member' });
  });

  it('applies schema coercions', async () => {
    const baseUrl = await boot(z.object({ count: z.coerce.number() }));

    const { body } = await (await post(baseUrl, { count: '42' })).json();

    expect(body.count).toBe(42);
    expect(typeof body.count).toBe('number');
  });

  it('leaves routes without a validator on the raw body', async () => {
    const baseUrl = await boot();

    const response = await post(baseUrl, { anything: 'goes', nested: { deep: 1 } });

    expect((await response.json()).body).toEqual({ anything: 'goes', nested: { deep: 1 } });
  });

  it('returns the same validated body on repeated calls', async () => {
    // The validator writes through the same body cache getBody() reads, so a second call must not
    // fall back to the raw payload - and must not attempt a second read of a consumed stream.
    adapter.registerRoute({
      staticServe: undefined,
      method: HttpMethod.POST,
      path: '/twice',
      middlewares: [],
      validator: { json: { handle: () => ({ schema: z.object({ keep: z.string() }) }), override: false } },
      handler: async (ctx: Context) => {
        const first = await ctx.getBody();
        const second = await ctx.getBody();

        return ctx.send({ first, second });
      },
    } as any);

    server = await adapter.start();

    const response = await fetch(`http://localhost:${server.port}/twice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keep: 'yes', drop: 'no' }),
    });

    const { first, second } = await response.json();

    expect(first).toEqual({ keep: 'yes' });
    expect(second).toEqual({ keep: 'yes' });
  });

  it('does not write back for non-body validation targets', async () => {
    // query/param/header validation deliberately leaves getBody() alone - it has nothing to do
    // with the body, and swapping the cache from a query schema's output would be a real bug.
    adapter.registerRoute({
      staticServe: undefined,
      method: HttpMethod.POST,
      path: '/query',
      middlewares: [],
      validator: { query: { handle: () => ({ schema: z.object({ page: z.string() }) }), override: false } },
      handler: async (ctx: Context) => ctx.send({ body: await ctx.getBody() }),
    } as any);

    server = await adapter.start();

    const response = await fetch(`http://localhost:${server.port}/query?page=2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ untouched: true }),
    });

    expect((await response.json()).body).toEqual({ untouched: true });
  });
});
