import { afterEach, describe, expect, test } from 'bun:test';
import type { BaseMiddleware } from '@asenajs/asena/adapter';
import type { ServerLogger } from '@asenajs/asena/logger';
import { HttpMethod } from '@asenajs/asena/web-types';
import { Ergenecore } from '../lib';
import type { Context } from '../lib';

// Core hands onError()/onNotFound() over before use() and before any route; an application or a
// third-party integration calling the adapter directly may do it later. The adapter reads both
// hooks per request, so every order has to answer the same way.

const silentLogger: ServerLogger = { info: () => {}, warn: () => {}, error: () => {}, profile: () => {} };

type Stage = 'before use() and the routes' | 'after use() and the routes' | 'after start()';

const stages: Stage[] = ['before use() and the routes', 'after use() and the routes', 'after start()'];

describe('where onError and onNotFound are registered', () => {
  let adapter: Ergenecore | undefined;

  afterEach(async () => {
    await adapter?.stop();
    adapter = undefined;
  });

  const boot = async (stage: Stage, label = 'hook') => {
    const booted = new Ergenecore(silentLogger, undefined, false);
    const registerHooks = (name: string) => {
      booted.onError((error: Error, context: Context) => context.send({ by: name, error: error.message }, 409));
      booted.onNotFound((context: Context, request) => context.send({ by: name, path: request.path }, 404));
    };
    const failing: BaseMiddleware<Context> = {
      handle: async () => {
        throw new Error('global middleware failed');
      },
      override: false,
    };
    const route = (path: string, middlewares: BaseMiddleware<Context>[] = []) =>
      booted.registerRoute({
        method: HttpMethod.GET,
        path,
        middlewares,
        staticServe: undefined,
        validator: undefined,
        handler: () => {
          throw new Error('handler failed');
        },
      });

    adapter = booted;

    if (stage === 'before use() and the routes') registerHooks(label);

    booted.use(failing, { include: ['/guarded/*'] });
    route('/fast');
    route('/full', [{ handle: async (_ctx, next) => next(), override: false }]);
    route('/guarded/route');

    if (stage === 'after use() and the routes') registerHooks(label);

    // Below the kernel's ephemeral range, see the root CLAUDE.md.
    booted.setPort(10000 + Math.floor(Math.random() * 22000));

    const server = await booted.start();

    if (stage === 'after start()') registerHooks(label);

    return { registerHooks, baseUrl: `http://localhost:${server.port}` };
  };

  const answers = async (baseUrl: string) => {
    const seen: Record<string, unknown> = {};

    for (const path of ['/fast', '/full', '/guarded/route', '/guarded/unmatched', '/unmatched']) {
      const response = await fetch(`${baseUrl}${path}`);

      seen[path] = { status: response.status, ...((await response.json()) as object) };
    }

    return seen;
  };

  const answeredBy = (name: string) => ({
    '/fast': { status: 409, by: name, error: 'handler failed' },
    '/full': { status: 409, by: name, error: 'handler failed' },
    '/guarded/route': { status: 409, by: name, error: 'global middleware failed' },
    '/guarded/unmatched': { status: 409, by: name, error: 'global middleware failed' },
    '/unmatched': { status: 404, by: name, path: '/unmatched' },
  });

  test.each(stages)('%s: every failure and every unmatched route reaches them', async (stage) => {
    const { baseUrl } = await boot(stage);

    expect(await answers(baseUrl)).toEqual(answeredBy('hook'));
  });

  test.each(stages)('%s: a later registration replaces them under a running server', async (stage) => {
    const { baseUrl, registerHooks } = await boot(stage, 'first');

    registerHooks('second');

    expect(await answers(baseUrl)).toEqual(answeredBy('second'));
  });
});
