import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Ergenecore } from '../lib';
import type { Context } from '../lib';
import { HttpException } from '../lib/errors';
import { HttpMethod } from '@asenajs/asena/web-types';
import type { ServerLogger } from '@asenajs/asena/logger';

/**
 * Mirrors `hono-adapter/test/errorLogging.test.ts`. The two adapters must agree on what a
 * failure looks like in the logs, not only on what it looks like on the wire.
 *
 * The rule these tests pin: **the framework's default log fires exactly when the framework's
 * default response fires.** An application that answered from its own hook already knows about
 * the request and gets no line from here; an application that declared no hook, or whose hook
 * declined or threw, would otherwise have no record of the request at all.
 */
const createLogger = () => {
  const calls: { level: string; message: string; meta?: any }[] = [];

  const logger = {
    profile: mock(() => {}),
    info: mock((message: string, meta?: any) => calls.push({ level: 'info', message, meta })),
    error: mock((message: string, meta?: any) => calls.push({ level: 'error', message, meta })),
    warn: mock((message: string, meta?: any) => calls.push({ level: 'warn', message, meta })),
    debug: mock((message: string, meta?: any) => calls.push({ level: 'debug', message, meta })),
  } as unknown as ServerLogger;

  return { logger, calls };
};

interface BootOptions {
  logErrors?: boolean;
  /** How the application's `onError` behaves, or that it declared none */
  onError?: 'none' | 'answers' | 'declines' | 'throws';
  /** How the application's `onNotFound` behaves, or that it declared none */
  onNotFound?: 'none' | 'answers' | 'throws';
}

const boot = async (logger: ServerLogger, options: BootOptions = {}) => {
  const { logErrors = true, onError = 'none', onNotFound = 'none' } = options;

  const adapter = new Ergenecore(logger, undefined, logErrors);

  if (onError === 'answers') {
    adapter.onError((error: Error, context: Context) =>
      context.send({ error: error.message }, error instanceof HttpException ? error.status : 500),
    );
  } else if (onError === 'declines') {
    // The ordinary way to say "not mine, use the default"
    adapter.onError((() => undefined) as any);
  } else if (onError === 'throws') {
    adapter.onError(() => {
      throw new Error('handler exploded');
    });
  }

  if (onNotFound === 'answers') {
    adapter.onNotFound((context: Context) => context.send({ mine: true }, 404));
  } else if (onNotFound === 'throws') {
    adapter.onNotFound(() => {
      throw new Error('notFound exploded');
    });
  }

  adapter.setPort(0);

  adapter.registerRoute({
    method: HttpMethod.GET,
    path: '/boom',
    middlewares: [],
    handler: async () => {
      throw new Error('kaboom');
    },
  } as any);

  adapter.registerRoute({
    method: HttpMethod.GET,
    path: '/denied',
    middlewares: [],
    handler: async () => {
      throw new HttpException(401, 'Unauthorized');
    },
  } as any);

  const server = await adapter.start();

  return { adapter, server, baseUrl: `http://localhost:${server.port}` };
};

describe('Ergenecore error logging', () => {
  let server: any;

  afterEach(async () => {
    await server?.stop(true);
    server = undefined;
  });

  describe('no application handler - the framework answers, so the framework records it', () => {
    test('logs a 5xx at error level with a stack', async () => {
      const { logger, calls } = createLogger();
      const booted = await boot(logger);

      server = booted.server;

      const response = await fetch(`${booted.baseUrl}/boom`);

      expect(response.status).toBe(500);

      const logged = calls.find((call) => call.message.includes('Application error occurred'));

      expect(logged?.level).toBe('error');
      expect(logged?.meta.message).toBe('kaboom');
      expect(logged?.meta.path).toBe('/boom');
      expect(logged?.meta.method).toBe('GET');
      expect(logged?.meta.stack).toBeString();
    });

    test('logs a 4xx at debug level without a stack', async () => {
      const { logger, calls } = createLogger();
      const booted = await boot(logger);

      server = booted.server;

      const response = await fetch(`${booted.baseUrl}/denied`);

      expect(response.status).toBe(401);

      const logged = calls.find((call) => call.message.includes('Request rejected'));

      // A bot scanning for /wp-admin must not be able to fill the error stream.
      expect(logged?.level).toBe('debug');
      expect(logged?.meta.status).toBe(401);
      expect(logged?.meta.stack).toBeUndefined();

      expect(calls.some((call) => call.level === 'error')).toBe(false);
    });

    test('logErrors: false silences both', async () => {
      const { logger, calls } = createLogger();
      const booted = await boot(logger, { logErrors: false });

      server = booted.server;

      await fetch(`${booted.baseUrl}/boom`);
      await fetch(`${booted.baseUrl}/denied`);

      expect(calls.some((call) => call.message.includes('Application error occurred'))).toBe(false);
      expect(calls.some((call) => call.message.includes('Request rejected'))).toBe(false);
    });
  });

  describe('an application handler that answers - the framework stays quiet', () => {
    test('an onError that returns a Response produces no framework line', async () => {
      const { logger, calls } = createLogger();
      const booted = await boot(logger, { onError: 'answers' });

      server = booted.server;

      const response = await fetch(`${booted.baseUrl}/boom`);

      expect(response.status).toBe(500);
      // The application's own body, so the application is the one that logged it - with whatever
      // correlation id it carries. A second line from the adapter would only duplicate it.
      expect(await response.json()).toEqual({ error: 'kaboom' });

      expect(calls.some((call) => call.message.includes('Application error occurred'))).toBe(false);
      expect(calls.some((call) => call.message.includes('Request rejected'))).toBe(false);
    });

    test('the same holds for a 4xx', async () => {
      const { logger, calls } = createLogger();
      const booted = await boot(logger, { onError: 'answers' });

      server = booted.server;

      const response = await fetch(`${booted.baseUrl}/denied`);

      expect(response.status).toBe(401);

      expect(calls.some((call) => call.message.includes('Request rejected'))).toBe(false);
      expect(calls.some((call) => call.message.includes('Application error occurred'))).toBe(false);
    });
  });

  describe('an application handler that does not answer - the framework records it anyway', () => {
    test('an onError that returns nothing still logs the original error', async () => {
      const { logger, calls } = createLogger();
      const booted = await boot(logger, { onError: 'declines' });

      server = booted.server;

      const response = await fetch(`${booted.baseUrl}/boom`);

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal Server Error' });

      // Without this the ordinary "not mine, use the default" return would swallow a 500 with
      // no trace anywhere - neither the application nor the framework would have recorded it.
      const logged = calls.find((call) => call.message.includes('Application error occurred'));

      expect(logged?.level).toBe('error');
      expect(logged?.meta.message).toBe('kaboom');
    });

    test('an onError that throws records both its own failure and the original error', async () => {
      const { logger, calls } = createLogger();
      const booted = await boot(logger, { onError: 'throws' });

      server = booted.server;

      const response = await fetch(`${booted.baseUrl}/boom`);

      expect(response.status).toBe(500);

      expect(calls.some((call) => call.message.includes('Error handler threw an error'))).toBe(true);

      const original = calls.find((call) => call.message.includes('Application error occurred'));

      expect(original?.meta.message).toBe('kaboom');
    });
  });

  describe('unmatched routes', () => {
    test('the default 404 is logged at info', async () => {
      const { logger, calls } = createLogger();
      const booted = await boot(logger);

      server = booted.server;

      const response = await fetch(`${booted.baseUrl}/nope/deep?x=1`, { method: 'POST' });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not Found' });

      const logged = calls.find((call) => call.message.includes('Route not found'));

      // info, not warn: a scanner walking /wp-admin and /.env must not fill the warning stream.
      // Not debug either: a 404 nobody can see is how a mistyped route survives to production.
      expect(logged?.level).toBe('info');
      expect(logged?.meta).toEqual({ path: '/nope/deep', method: 'POST', status: 404 });
    });

    test('an onNotFound that answers produces no framework line', async () => {
      const { logger, calls } = createLogger();
      const booted = await boot(logger, { onNotFound: 'answers' });

      server = booted.server;

      const response = await fetch(`${booted.baseUrl}/nope`);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ mine: true });

      expect(calls.some((call) => call.message.includes('Route not found'))).toBe(false);
    });

    test('an onNotFound that throws falls back to the default and logs it', async () => {
      const { logger, calls } = createLogger();
      const booted = await boot(logger, { onNotFound: 'throws' });

      server = booted.server;

      const response = await fetch(`${booted.baseUrl}/nope`);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not Found' });

      expect(calls.some((call) => call.message.includes('onNotFound threw an error'))).toBe(true);
      expect(calls.some((call) => call.message.includes('Route not found'))).toBe(true);
    });

    test('logErrors: false silences the 404 line too', async () => {
      const { logger, calls } = createLogger();
      const booted = await boot(logger, { logErrors: false });

      server = booted.server;

      const response = await fetch(`${booted.baseUrl}/nope`);

      expect(response.status).toBe(404);
      expect(calls.some((call) => call.message.includes('Route not found'))).toBe(false);
    });
  });
});
