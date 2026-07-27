import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Ergenecore } from '../lib';
import { HttpException } from '../lib/errors';
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
 * against a `logHandledError` that had never been fixed for a real subclass. So this copies
 * `lib/errors.ts` to a second location on disk and imports it as its own module. The file's only
 * imports are `@asenajs/asena/*` and a `zod` type, so it resolves from inside the package
 * unchanged, and `Symbol.for('asena.httpException')` is the same symbol in both copies while the
 * two `HttpException` classes are not the same class. That is the production topology, produced
 * the way production produces it.
 */
describe('HttpException from a second resolved copy of the package', () => {
  const copyDir = join(import.meta.dir, '.two-copies-fixture');

  let ForeignHttpException: typeof HttpException;
  let server: any;

  beforeAll(async () => {
    rmSync(copyDir, { recursive: true, force: true });
    mkdirSync(copyDir, { recursive: true });
    cpSync(join(import.meta.dir, '..', 'lib', 'errors.ts'), join(copyDir, 'errors.ts'));

    const foreign = await import(join(copyDir, 'errors.ts'));

    ForeignHttpException = foreign.HttpException;
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
});
