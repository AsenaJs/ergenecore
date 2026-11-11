import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { BaseMiddleware } from '@asenajs/asena/adapter';
import type { ServerLogger } from '@asenajs/asena/logger';
import { HttpMethod } from '@asenajs/asena/web-types';
import { Ergenecore } from '../lib';
import type { Context } from '../lib';

// Core's `@Catch()` catch-all receives whatever was thrown, so the adapter has to hand `onError`
// the thrown value itself - not an Error made from it - from every place a request can throw.

const circular: Record<string, unknown> = { code: 'E_CYCLE' };

circular.self = circular;

const thrownValues: [label: string, value: unknown][] = [
  ['a string', 'text'],
  ['a number', 42],
  ['null', null],
  ['undefined', undefined],
  ['a bigint', 10n],
  ['a plain object', { code: 'E_PLAIN' }],
  ['an object with a cycle', circular],
];

const createLogger = () => {
  const errors: { message: string; meta?: any }[] = [];
  const logger = {
    profile: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock((message: string, meta?: any) => errors.push({ message, meta })),
  } as unknown as ServerLogger;

  return { logger, errors };
};

const boot = async (logger: ServerLogger, raise: () => never) => {
  const adapter = new Ergenecore(logger);
  const passThrough: BaseMiddleware<Context> = { handle: async (_ctx, next) => next(), override: false };
  const throwing: BaseMiddleware<Context> = { handle: async () => raise(), override: false };
  const route = (path: string, handler: () => unknown, middlewares: BaseMiddleware<Context>[] = []) =>
    adapter.registerRoute({
      method: HttpMethod.GET,
      path,
      middlewares,
      staticServe: undefined,
      validator: undefined,
      handler: handler as any,
    });

  route('/sync', () => raise());
  route('/async', async () => raise());
  route('/behind-middleware', () => raise(), [passThrough]);
  route('/in-middleware', () => new Response('unreachable'), [throwing]);
  adapter.use(throwing, { include: ['/unmatched/*'] });

  // Below the kernel's ephemeral range, see the root CLAUDE.md.
  adapter.setPort(10000 + Math.floor(Math.random() * 22000));

  const server = await adapter.start();

  return { adapter, baseUrl: `http://localhost:${server.port}` };
};

const paths = ['/sync', '/async', '/behind-middleware', '/in-middleware', '/unmatched/anything'];

describe('a thrown value that is not an Error', () => {
  let adapter: Ergenecore | undefined;

  afterEach(async () => {
    await adapter?.stop();
    adapter = undefined;
  });

  describe.each(thrownValues)('%s', (_label, value) => {
    const raise = (): never => {
      throw value;
    };

    test('reaches onError as thrown, from every place a request can throw', async () => {
      const { logger } = createLogger();
      const booted = await boot(logger, raise);
      const received: unknown[] = [];

      adapter = booted.adapter;
      adapter.onError((error: unknown, context: Context) => {
        received.push(error);

        return context.send({ handled: true }, 422);
      });

      for (const path of paths) {
        const response = await fetch(`${booted.baseUrl}${path}`);

        expect([path, response.status]).toEqual([path, 422]);
      }

      expect(received).toHaveLength(paths.length);
      expect(received.every((error) => Object.is(error, value))).toBe(true);
    });

    test('is answered with the 500 envelope and logged when the handler declines', async () => {
      const { logger, errors } = createLogger();
      const booted = await boot(logger, raise);

      adapter = booted.adapter;
      adapter.onError(() => undefined);

      for (const path of paths) {
        const response = await fetch(`${booted.baseUrl}${path}`);

        expect([path, response.status]).toEqual([path, 500]);
        expect(await response.json()).toEqual({ error: 'Internal Server Error' });
      }

      expect(errors).toHaveLength(paths.length);

      for (const { message, meta } of errors) {
        expect(message).toBe('Application error occurred:');
        expect(meta.status).toBe(500);
        expect(typeof meta.message).toBe('string');
      }
    });
  });

  test('the log line carries what was thrown', async () => {
    const seen: Record<string, string> = {};

    for (const [label, value] of thrownValues) {
      const { logger, errors } = createLogger();
      const booted = await boot(logger, () => {
        throw value;
      });

      adapter = booted.adapter;
      await fetch(`${booted.baseUrl}/sync`);
      await adapter.stop();
      adapter = undefined;

      seen[label] = errors[0].meta.message;
    }

    expect(seen).toEqual({
      'a string': '"text"',
      'a number': '42',
      null: 'null',
      undefined: 'undefined',
      'a bigint': '10',
      'a plain object': '{"code":"E_PLAIN"}',
      'an object with a cycle': '[object Object]',
    });
  });
});
