import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Ergenecore } from '../lib';
import type { Context } from '../lib';
import { HttpException } from '../lib/errors';
import { HttpMethod } from '@asenajs/asena/web-types';
import type { ServerLogger } from '@asenajs/asena/logger';

const mockLogger: ServerLogger = {
  profile: mock(() => {}),
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
};

/**
 * An unhandled 500 must not echo the thrown message to the caller.
 *
 * `respondToError`'s last resort used to answer `{ error: error.message }`. That message is the
 * one string in the system the application never chose for publication: a failed query carries
 * the SQL and often the table names, a failed `fetch` carries the internal hostname and port, a
 * failed file read carries the deployment path. The client gets it, verbatim, for free.
 *
 * Three existing suites asserted `expect(data.error).toBe('Unhandled error')` - the leak was not
 * merely untested, it was pinned as the contract, which is why reading the adapter never
 * flagged it. The assertions below are written the other way round: a body that must *not*
 * contain a string. `toBe('Internal Server Error')` alone would still pass if a future change
 * moved the message into a second field.
 *
 * The message is not lost - `logHandledError` writes it, with a stack, to the ServerLogger.
 * Covered in errorLogging.test.ts.
 */
describe('an unhandled error does not leak its message to the client', () => {
  let adapter: Ergenecore;
  let server: any;

  const SECRET = 'secret internal detail';

  afterEach(async () => {
    await server?.stop(true);
    server = undefined;
  });

  const boot = async () => {
    adapter.setPort(0);
    server = await adapter.start();

    return `http://localhost:${server.port}`;
  };

  /** Nothing the caller can read may carry the message - not the body, not the status text. */
  const assertNoLeak = async (response: Response) => {
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain(SECRET);
    expect(response.statusText).not.toContain(SECRET);
    expect(JSON.parse(text)).toEqual({ error: 'Internal Server Error' });
  };

  test('thrown from a handler on the fast path', async () => {
    adapter = new Ergenecore(mockLogger);

    // No middlewares, no validator, no static serve: this route is built by
    // createFastPathHandler, a separate catch block from the one below.
    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/fast',
      middlewares: [],
      handler: async () => {
        throw new Error(SECRET);
      },
    } as any);

    const baseUrl = await boot();

    await assertNoLeak(await fetch(`${baseUrl}/fast`));
  });

  test('thrown from a handler behind a middleware', async () => {
    adapter = new Ergenecore(mockLogger);

    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/guarded',
      middlewares: [{ handle: async (_c: Context, next: () => Promise<void>) => next() } as any],
      handler: async () => {
        throw new Error(SECRET);
      },
    } as any);

    const baseUrl = await boot();

    await assertNoLeak(await fetch(`${baseUrl}/guarded`));
  });

  test('thrown from a global middleware', async () => {
    adapter = new Ergenecore(mockLogger);

    adapter.use({
      handle: async () => {
        throw new Error(SECRET);
      },
      override: false,
    } as any);

    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/anything',
      middlewares: [],
      handler: async (context: Context) => context.send({ ok: true }),
    } as any);

    const baseUrl = await boot();

    await assertNoLeak(await fetch(`${baseUrl}/anything`));
  });

  test('when the application handler declines to answer', async () => {
    adapter = new Ergenecore(mockLogger);

    // Returning nothing is how an application says "not mine" - the adapter's fallback answers,
    // and that fallback is the leaking branch.
    adapter.onError(() => undefined as any);

    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/declined',
      middlewares: [],
      handler: async () => {
        throw new Error(SECRET);
      },
    } as any);

    const baseUrl = await boot();

    await assertNoLeak(await fetch(`${baseUrl}/declined`));
  });

  test('when the application handler itself throws', async () => {
    adapter = new Ergenecore(mockLogger);

    adapter.onError(() => {
      throw new Error('the handler blew up too');
    });

    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/double-fault',
      middlewares: [],
      handler: async () => {
        throw new Error(SECRET);
      },
    } as any);

    const baseUrl = await boot();

    await assertNoLeak(await fetch(`${baseUrl}/double-fault`));
  });

  test('a deliberate HttpException still answers its own body', async () => {
    adapter = new Ergenecore(mockLogger);

    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/deliberate',
      middlewares: [],
      handler: async () => {
        throw new HttpException(403, { error: 'Insufficient scope' });
      },
    } as any);

    const baseUrl = await boot();
    const response = await fetch(`${baseUrl}/deliberate`);

    // The generic envelope applies only to what nobody anticipated. An HttpException body is
    // chosen by the application for publication, so blanketing it would be the opposite bug:
    // every 4xx collapsing into an unactionable 500-shaped message.
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Insufficient scope' });
  });

  /**
   * `serveStaticFile` answered its own catch with `{ error: error.message }` - the same leak
   * the rest of this file exists to prevent, and the worst place for it: a message thrown out
   * of `path.resolve` or `Bun.file` is specifically a filesystem path. It also never reached
   * `onError`, so an application could not reshape it either.
   */
  test('thrown while serving a static file', async () => {
    adapter = new Ergenecore(mockLogger);

    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/assets/*',
      middlewares: [],
      handler: async (context: Context) => context.send({ fellThrough: true }),
      staticServe: {
        root: '/tmp',
        extra: {},
        rewriteRequestPath: () => {
          throw new Error(SECRET);
        },
      },
      validator: {} as any,
    } as any);

    const baseUrl = await boot();

    await assertNoLeak(await fetch(`${baseUrl}/assets/anything.txt`));
  });

  test('a static file failure reaches onError', async () => {
    const errorHandler = mock((_error: Error, context: Context) => context.send({ reshaped: true }, 503));

    adapter = new Ergenecore(mockLogger);
    adapter.onError(errorHandler);

    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/assets/*',
      middlewares: [],
      handler: async (context: Context) => context.send({ fellThrough: true }),
      staticServe: {
        root: '/tmp',
        extra: {},
        rewriteRequestPath: () => {
          throw new Error(SECRET);
        },
      },
      validator: {} as any,
    } as any);

    const baseUrl = await boot();
    const response = await fetch(`${baseUrl}/assets/anything.txt`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ reshaped: true });
    expect(errorHandler).toHaveBeenCalled();
  });

  test('the message is still written to the log', async () => {
    const errorLog = mock(() => {});

    adapter = new Ergenecore({ ...mockLogger, error: errorLog });

    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/logged',
      middlewares: [],
      handler: async () => {
        throw new Error(SECRET);
      },
    } as any);

    const baseUrl = await boot();

    await fetch(`${baseUrl}/logged`);

    // Withholding it from the client is only defensible because the operator still gets it.
    const logged = errorLog.mock.calls.map((call: unknown[]) => JSON.stringify(call)).join('\n');

    expect(logged).toContain(SECRET);
  });
});
