import { describe, expect, it, mock } from 'bun:test';
import { VALIDATOR_METHODS } from '@asenajs/asena/adapter';
import { HttpMethod } from '@asenajs/asena/web-types';
import type { ServerLogger } from '@asenajs/asena/logger';
import { Ergenecore, ErgenecoreWebsocketAdapter, type Context } from '../lib';
import { z } from 'zod';
import { VALIDATOR_TARGETS } from '../lib/utils/validatorTargets';

describe('validator targets', () => {
  it('match the core VALIDATOR_METHODS in order', () => {
    const targets: string[] = [...VALIDATOR_TARGETS];

    expect(targets).toEqual(VALIDATOR_METHODS);
  });

  it('refuse to start when a route declares a target the adapter does not handle', async () => {
    const logger: ServerLogger = {
      info: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      profile: mock(() => {}),
    };
    const adapter = new Ergenecore(logger, new ErgenecoreWebsocketAdapter(logger));
    adapter.setPort(0);
    const validator = {
      json: { handle: () => ({ schema: z.object({}) }), override: false },
      cookie: { handle: () => ({ schema: z.object({}) }), override: false },
    };

    adapter.registerRoute({
      staticServe: undefined,
      method: HttpMethod.POST,
      path: '/users',
      middlewares: [],
      validator,
      handler: async (ctx: Context) => ctx.send({ ok: true }),
    });

    const outcome = await adapter.start().then(
      () => 'started',
      (error: Error) => error.message,
    );

    expect(outcome).toContain("'cookie'");
    await adapter.stop().catch(() => {});
  });
});
