import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Ergenecore } from '../lib';
import { HttpException } from '../lib/errors';
import { HTTP_EXCEPTION } from '@asenajs/asena/adapter';
import { HttpMethod } from '@asenajs/asena/web-types';
import type { ServerLogger } from '@asenajs/asena/logger';

interface Entry {
  level: string;
  message: string;
  meta?: any;
}

const capturingLogger = () => {
  const entries: Entry[] = [];

  const logger: ServerLogger & { debug: (message: string, meta?: any) => void } = {
    info: (message, meta) => entries.push({ level: 'info', message, meta }),
    warn: (message, meta) => entries.push({ level: 'warn', message, meta }),
    error: (message, meta) => entries.push({ level: 'error', message, meta }),
    profile: () => {},
    debug: (message, meta) => entries.push({ level: 'debug', message, meta }),
  };

  return { logger, entries };
};

/**
 * Two resolved copies of this package, for real.
 *
 * `respondToError` decides the *response* with `isHttpException()` - a registered-symbol brand,
 * which crosses copies. `logHandledError` decided the *log level* with `instanceof`, which does
 * not. A deliberate `throw new HttpException(401)` from an application whose `@asenajs/ergenecore`
 * resolved to a second physical copy therefore answered a correct 401 to the client while the
 * adapter computed 500 for itself and wrote an error-level entry with a full stack.
 *
 * Nothing is broken on the wire, so nothing alerts. What breaks is the log: an unauthenticated
 * request an attacker can repeat at will becomes an ERROR with a stack trace, which is exactly
 * the amplification the 4xx/5xx level split was written to prevent, and it only starts happening
 * on the day a lockfile resolves two copies - long after the code that caused it was reviewed.
 *
 * A hand-built object carrying the brand cannot show this: it is not an instance of *anything*,
 * so `instanceof` was always going to answer false for it, and a test built on one would pass
 * against a `logHandledError` that had never been fixed for a real subclass. So this copies the
 * module that *defines* the class to a second location on disk and imports it as its own module.
 *
 * That module used to be this package's `lib/errors.ts`. `HttpException` now lives in
 * `@asenajs/asena/adapter` and `lib/errors.ts` only re-exports it, so copying `errors.ts` would
 * produce a second module resolving to the *same* class and every assertion below would silently
 * stop testing anything. Copy the built core module instead - it has no imports at all after
 * `import type` erasure, and it declares `Symbol.for('asena.httpException')` in-file, so the copy
 * is a genuinely distinct class carrying an identical registered symbol. That models production
 * more closely than the old version did, where symbol identity came from a shared import rather
 * than from `Symbol.for`.
 */
describe('HttpException from a second resolved copy of the package', () => {
  const copyDir = join(import.meta.dir, '.two-copies-fixture');

  let ForeignHttpException: typeof HttpException;
  let server: any;

  beforeAll(async () => {
    rmSync(copyDir, { recursive: true, force: true });
    mkdirSync(copyDir, { recursive: true });

    // Resolve rather than hard-code: `@asenajs/asena` is installed as a real package here, not
    // symlinked, so its path is an implementation detail of whatever installed it.
    const coreAdapterEntry = Bun.resolveSync('@asenajs/asena/adapter', import.meta.dir);

    cpSync(join(dirname(coreAdapterEntry), 'types', 'HttpException.js'), join(copyDir, 'HttpException.js'));

    const foreign = await import(join(copyDir, 'HttpException.js'));

    ForeignHttpException = foreign.HttpException;

    // If the core module ever grows a runtime import, the copy would resolve that import back to
    // the shared module and stop being a second copy in the way that matters. Pin the one property
    // the whole scheme rests on: same registered symbol, different class.
    expect(foreign.HTTP_EXCEPTION).toBe(HTTP_EXCEPTION);
  });

  afterAll(() => {
    rmSync(copyDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await server?.stop(true);
    server = undefined;
  });

  const bootThrowing = async (error: unknown) => {
    const { logger, entries } = capturingLogger();
    const adapter = new Ergenecore(logger);

    adapter.setPort(0);
    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/denied',
      middlewares: [],
      handler: async () => {
        throw error;
      },
    } as any);

    server = await adapter.start();

    const response = await fetch(`http://localhost:${server.port}/denied`);

    return { response, entries };
  };

  test('the copy really is a different class', () => {
    const foreign = new ForeignHttpException(401, 'Unauthorized');

    // If this ever passes, the copy collapsed back into one module and every assertion below
    // silently stops testing anything.
    expect(foreign instanceof HttpException).toBe(false);
    expect(foreign.status).toBe(401);
  });

  test('a foreign 401 is logged as a rejected request, not an application error', async () => {
    const { response, entries } = await bootThrowing(new ForeignHttpException(401, 'Unauthorized'));

    // The response was always right - that is what made this invisible.
    expect(response.status).toBe(401);

    expect(entries.some((entry) => entry.level === 'error')).toBe(false);

    const entry = entries.find((e) => e.message === 'Request rejected:');

    expect(entry?.level).toBe('debug');
    expect(entry?.meta.status).toBe(401);
    // A stack on a 4xx is the payload of the flood, not just the wrong label.
    expect(entry?.meta.stack).toBeUndefined();
  });

  test('a foreign 500 is still an application error with a stack', async () => {
    const { response, entries } = await bootThrowing(new ForeignHttpException(503, 'Upstream down'));

    expect(response.status).toBe(503);

    const entry = entries.find((e) => e.message === 'Application error occurred:');

    // The brand must not turn every foreign exception into a 4xx either - the status it
    // carries is what decides, exactly as for a local one.
    expect(entry?.level).toBe('error');
    expect(entry?.meta.status).toBe(503);
    expect(typeof entry?.meta.stack).toBe('string');
  });

  test('a foreign subclass is treated the same as a foreign base', async () => {
    class ForeignForbidden extends ForeignHttpException {
      public constructor() {
        super(403, 'Forbidden');
      }
    }

    const { response, entries } = await bootThrowing(new ForeignForbidden());

    expect(response.status).toBe(403);
    expect(entries.some((entry) => entry.level === 'error')).toBe(false);
    expect(entries.find((e) => e.message === 'Request rejected:')?.meta.status).toBe(403);
  });

  test('the local copy behaves identically, so the two cannot drift', async () => {
    const { response, entries } = await bootThrowing(new HttpException(401, 'Unauthorized'));

    expect(response.status).toBe(401);
    expect(entries.some((entry) => entry.level === 'error')).toBe(false);
    expect(entries.find((e) => e.message === 'Request rejected:')?.meta.status).toBe(401);
  });

  test('a plain Error is still an application error', async () => {
    const { response, entries } = await bootThrowing(new Error('kaboom'));

    expect(response.status).toBe(500);
    expect(entries.find((e) => e.message === 'Application error occurred:')?.level).toBe('error');
  });

  // `HttpExceptionLike` guarantees `status` and nothing else - `getResponse` is optional, because
  // the hono adapter brands a class it does not own and a foreign exception type may carry neither
  // the method nor a body. `respondToError` used to call it unconditionally, so such an exception
  // threw a TypeError from *inside* the error path. There is no handler above that: `Bun.serve` is
  // configured with no `error` hook, so the request fell through to Bun's own 500 page and the
  // original failure was never logged.
  test('a branded exception with no getResponse() answers its status instead of crashing', async () => {
    const brandedOnly: unknown = Object.assign(Object.create(Error.prototype), {
      [HTTP_EXCEPTION]: true,
      status: 429,
      message: 'slow down',
    });

    const { response, entries } = await bootThrowing(brandedOnly);

    expect(response.status).toBe(429);

    // The status is in the contract, the body is not. Echoing an unrecognised exception's message
    // is how the leakage this adapter was hardened against gets back in.
    expect(await response.json()).toEqual({ error: 'Internal Server Error' });

    expect(entries.some((entry) => entry.level === 'error')).toBe(false);
    expect(entries.find((e) => e.message === 'Request rejected:')?.meta.status).toBe(429);
  });
});
