import { afterEach, describe, expect, it, mock } from 'bun:test';
import { VALIDATOR_METHODS } from '@asenajs/asena/adapter';
import { HttpMethod } from '@asenajs/asena/web-types';
import type { ServerLogger } from '@asenajs/asena/logger';
import { Ergenecore, ErgenecoreWebsocketAdapter, type Context } from '../lib';
import { z } from 'zod';
import { VALIDATOR_TARGETS, validatorTargetsOf } from '../lib/utils/validatorTargets';

describe('validator targets', () => {
  let adapter: Ergenecore | undefined;

  afterEach(async () => {
    await adapter?.stop().catch(() => {});
    adapter = undefined;
  });

  it('match the core VALIDATOR_METHODS in order', () => {
    const targets: string[] = [...VALIDATOR_TARGETS];

    expect(targets).toEqual(VALIDATOR_METHODS);
  });

  it('map every core target to an adapter target', () => {
    expect(validatorTargetsOf(VALIDATOR_METHODS)).toEqual([...VALIDATOR_TARGETS]);
  });

  it('refuse a core target the adapter does not handle', () => {
    expect(() => validatorTargetsOf([...VALIDATOR_METHODS, 'cookie'])).toThrow('cookie');
  });

  it('validate json and ignore a validator key the adapter does not handle', async () => {
    const logger: ServerLogger = {
      info: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      profile: mock(() => {}),
    };
    adapter = new Ergenecore(logger, new ErgenecoreWebsocketAdapter(logger));
    adapter.setPort(0);
    const validator = {
      json: { handle: () => ({ schema: z.object({ name: z.string() }) }), override: false },
      cookie: { handle: () => ({ schema: z.object({ session: z.string() }) }), override: false },
    };

    adapter.registerRoute({
      staticServe: undefined,
      method: HttpMethod.POST,
      path: '/users',
      middlewares: [],
      validator,
      handler: async (ctx: Context) => ctx.send({ ok: true }),
    });

    const server = await adapter.start();
    const url = `http://localhost:${server.port}/users`;
    const post = (body: unknown) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect((await post({})).status).toBe(400);

    const accepted = await post({ name: 'asena' });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true });
  });
});
