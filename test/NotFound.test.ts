import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Ergenecore } from '../lib';
import type { Context } from '../lib';
import { HttpException } from '../lib/errors';
import { CorsMiddleware } from '../lib/middlewares/CorsMiddleware';
import { HttpMethod } from '@asenajs/asena/web-types';
import type { ServerLogger } from '@asenajs/asena/logger';
import type { NotFoundRequest } from '@asenajs/asena/adapter';

const mockLogger: ServerLogger = {
  profile: mock(() => {}),
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
};

/**
 * Replaces NotFoundError.test.ts.
 *
 * An unmatched route used to be modelled as a thrown `NotFoundError` and pushed through
 * `onError`, which meant every application's error handler had to discriminate between "the
 * router found nothing" and "my code threw". `onNotFound` gives routing its own hook, so
 * `onError` only ever sees something that was actually thrown.
 */
describe('onNotFound', () => {
  let adapter: Ergenecore;
  let server: any;

  const boot = async () => {
    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/known',
      middlewares: [],
      handler: async (ctx: Context) => ctx.send({ ok: true }),
    } as any);

    adapter.setPort(0);
    server = await adapter.start();

    return `http://localhost:${server.port}`;
  };

  afterEach(async () => {
    await server?.stop(true);
    server = undefined;
  });

  test('an unmatched route reaches onNotFound with a normalised path and method', async () => {
    adapter = new Ergenecore(mockLogger);

    let seen: NotFoundRequest | undefined;

    adapter.onNotFound((context: Context, request: NotFoundRequest) => {
      seen = request;

      return context.send({ notFound: true, path: request.path, method: request.method }, 404);
    });

    const baseUrl = await boot();
    const response = await fetch(`${baseUrl}/missing/deep?q=1`, { method: 'POST' });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.notFound).toBe(true);
    // Path only - no origin, no query string. The hono adapter must produce the same string.
    expect(seen?.path).toBe('/missing/deep');
    expect(seen?.method).toBe('POST');
  });

  test('onError does not see an unmatched route', async () => {
    adapter = new Ergenecore(mockLogger);

    const errorHandler = mock((_error: Error, context: Context) => context.send({ fromOnError: true }, 500));

    adapter.onError(errorHandler);

    const baseUrl = await boot();
    const response = await fetch(`${baseUrl}/missing`);

    expect(response.status).toBe(404);
    expect(errorHandler).not.toHaveBeenCalled();
  });

  test('falls back to the default 404 envelope when no handler is registered', async () => {
    adapter = new Ergenecore(mockLogger);

    const baseUrl = await boot();
    const response = await fetch(`${baseUrl}/missing`);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ error: 'Not Found' });
  });

  test('a handler that throws falls back to the default 404 rather than taking the server down', async () => {
    adapter = new Ergenecore(mockLogger);

    adapter.onNotFound(() => {
      throw new Error('handler blew up');
    });

    const baseUrl = await boot();
    const response = await fetch(`${baseUrl}/missing`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not Found' });
  });

  test('global middlewares still run before onNotFound', async () => {
    adapter = new Ergenecore(mockLogger);

    // A 404 must still carry whatever the application applies to every request - CORS headers
    // being the case that actually bites people.
    adapter.use({
      handle: async (context: Context, next: () => Promise<void>) => {
        context.setValue('tagged', true);
        await next();
      },
      override: false,
    } as any);

    adapter.onNotFound((context: Context) => context.send({ tagged: context.getValue('tagged') === true }, 404));

    const baseUrl = await boot();
    const response = await fetch(`${baseUrl}/missing`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ tagged: true });
  });

  test('a matched route is unaffected', async () => {
    adapter = new Ergenecore(mockLogger);

    adapter.onNotFound((context: Context) => context.send({ notFound: true }, 404));

    const baseUrl = await boot();
    const response = await fetch(`${baseUrl}/known`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

/**
 * The 404 has to be *observable*, not merely correct on the wire.
 *
 * An unmatched request never reaches a route handler, so nothing but `respondToUnmatched` is in a
 * position to write the status onto the context. It used to write nothing, and the 404 was
 * produced after the global-middleware chain had already unwound - so a global middleware
 * inspecting the request on the way out saw no status at all. `@asenajs/asena-otel`'s
 * `OtelTracingMiddleware` is exactly that middleware: it reads `ctx.res.status` in the `finally`
 * around `await next()`, so every 404 this server answered was recorded with no
 * `http.response.status_code` - bots, probes and mistyped paths, the traffic an operator most
 * wants to count, all landing in the same shapeless bucket.
 *
 * `finally`, not a plain statement after `await next()`, is deliberate and is what the real
 * consumer does: a terminal Response propagates out of `next()` as a `MiddlewareResponseError`,
 * so any observation not in a `finally` is skipped on *every* request, matched or not.
 */
describe('the unmatched-route status is recorded on the context', () => {
  let adapter: Ergenecore;
  let server: any;

  /** Records what a global middleware can see on the way out, the way OtelTracingMiddleware does. */
  const observeStatus = () => {
    const seen: { status: unknown } = { status: 'never-ran' };

    const middleware = {
      handle: async (context: Context, next: () => Promise<void>) => {
        try {
          await next();
        } finally {
          seen.status = (context.res as { status?: number }).status;
        }
      },
      override: false,
    };

    return { seen, middleware };
  };

  const boot = async () => {
    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/known',
      middlewares: [],
      handler: async (ctx: Context) => ctx.send({ ok: true }),
    } as any);

    adapter.setPort(0);
    server = await adapter.start();

    return `http://localhost:${server.port}`;
  };

  afterEach(async () => {
    await server?.stop(true);
    server = undefined;
  });

  test('a global middleware sees 404 on the way out of an unmatched route', async () => {
    adapter = new Ergenecore(mockLogger);

    const { seen, middleware } = observeStatus();

    adapter.use(middleware as any);

    const baseUrl = await boot();
    const response = await fetch(`${baseUrl}/missing`);

    expect(response.status).toBe(404);
    // The whole point. `undefined` here is the shipped bug: a recorded request with no status.
    expect(seen.status).toBe(404);
  });

  test('a matched route is observed the same way, so the two are comparable', async () => {
    adapter = new Ergenecore(mockLogger);

    const { seen, middleware } = observeStatus();

    adapter.use(middleware as any);

    const baseUrl = await boot();
    const response = await fetch(`${baseUrl}/known`);

    expect(response.status).toBe(200);
    expect(seen.status).toBe(200);
  });

  test('the status recorded is the one onNotFound chose, not a hardcoded 404', async () => {
    adapter = new Ergenecore(mockLogger);

    const { seen, middleware } = observeStatus();

    adapter.use(middleware as any);
    // 410 rather than another 404: reading the response's own status is the only implementation
    // that survives this, and an application that answers Gone for retired paths is the reason
    // to care.
    adapter.onNotFound((context: Context) => context.send({ gone: true }, 410));

    const baseUrl = await boot();
    const response = await fetch(`${baseUrl}/missing`);

    expect(response.status).toBe(410);
    expect(seen.status).toBe(410);
  });

  test('onNotFound still receives the path and method when a global middleware runs', async () => {
    adapter = new Ergenecore(mockLogger);

    const { middleware } = observeStatus();

    adapter.use(middleware as any);

    let seenRequest: NotFoundRequest | undefined;

    adapter.onNotFound((context: Context, request: NotFoundRequest) => {
      seenRequest = request;

      return context.send({ notFound: true }, 404);
    });

    const baseUrl = await boot();

    await fetch(`${baseUrl}/missing/deep?q=1`, { method: 'DELETE' });

    // The fix moved this call into the chain's terminal callback, which is a different pair of
    // arguments computed at a different point - the path must still be the bare pathname.
    expect(seenRequest?.path).toBe('/missing/deep');
    expect(seenRequest?.method).toBe('DELETE');
  });
});

/**
 * The fix changed how the unmatched branch drives the middleware chain, so every way a global
 * middleware can end a request early has to keep working on an unmatched path.
 */
describe('global middleware control flow on an unmatched route', () => {
  let adapter: Ergenecore;
  let server: any;

  const boot = async () => {
    adapter.setPort(0);
    server = await adapter.start();

    return `http://localhost:${server.port}`;
  };

  afterEach(async () => {
    await server?.stop(true);
    server = undefined;
  });

  test('a middleware that never calls next() still short-circuits the 404', async () => {
    adapter = new Ergenecore(mockLogger);

    const notFound = mock((context: Context) => context.send({ notFound: true }, 404));

    adapter.onNotFound(notFound);
    adapter.use({
      handle: async () => new Response(JSON.stringify({ blocked: true }), { status: 401 }),
      override: false,
    } as any);

    const baseUrl = await boot();
    const response = await fetch(`${baseUrl}/missing`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ blocked: true });
    // Running onNotFound behind a middleware that refused the request would answer 404 to a
    // caller the application already rejected.
    expect(notFound).not.toHaveBeenCalled();
  });

  test('a middleware returning false answers 403, not 404', async () => {
    adapter = new Ergenecore(mockLogger);

    adapter.use({ handle: async () => false, override: false } as any);

    const baseUrl = await boot();
    const response = await fetch(`${baseUrl}/missing`);

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Forbidden');
  });

  test('a middleware returning a Response answers it, not the 404', async () => {
    adapter = new Ergenecore(mockLogger);

    adapter.use({
      handle: async () => new Response('teapot', { status: 418 }),
      override: false,
    } as any);

    const baseUrl = await boot();
    const response = await fetch(`${baseUrl}/missing`);

    expect(response.status).toBe(418);
    expect(await response.text()).toBe('teapot');
  });

  test('a CORS preflight on an unmatched path still answers 204 with its headers', async () => {
    adapter = new Ergenecore(mockLogger);

    adapter.use(new CorsMiddleware({ origin: '*' }) as any);

    const baseUrl = await boot();
    const response = await fetch(`${baseUrl}/missing`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://example.com', 'Access-Control-Request-Method': 'GET' },
    });

    // A preflight for a path the API does not serve must still be answered by CORS rather than
    // falling through to the 404 - the browser reports a CORS failure otherwise, which sends
    // people looking in the wrong place entirely.
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  /**
   * The unmatched branch was the one request path in the adapter with no try/catch around it.
   * A global middleware throwing there - an auth middleware raising HttpException(401), or
   * getBody() rejecting a malformed payload - escaped the handler entirely: onError never saw
   * it, nothing was logged, and Bun answered its own 500 page.
   */
  test('a middleware that throws on an unmatched path reaches onError', async () => {
    adapter = new Ergenecore(mockLogger);

    const errorHandler = mock((error: Error, context: Context) =>
      context.send({ reshaped: (error as HttpException).status }, (error as HttpException).status),
    );

    adapter.onError(errorHandler);
    adapter.use({
      handle: async () => {
        throw new HttpException(401, 'Unauthorized');
      },
      override: false,
    } as any);

    const baseUrl = await boot();
    const response = await fetch(`${baseUrl}/missing`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ reshaped: 401 });
    expect(errorHandler).toHaveBeenCalled();
  });

  test('with no onError it answers the adapter envelope, not Bun default page', async () => {
    adapter = new Ergenecore(mockLogger);

    adapter.use({
      handle: async () => {
        throw new Error('middleware exploded');
      },
      override: false,
    } as any);

    const baseUrl = await boot();
    const response = await fetch(`${baseUrl}/missing`);

    expect(response.status).toBe(500);
    // Never the thrown message - the same containment every other error path applies
    expect(await response.json()).toEqual({ error: 'Internal Server Error' });
  });
});

describe('thrown errors still go to onError', () => {
  let adapter: Ergenecore;
  let server: any;

  afterEach(async () => {
    await server?.stop(true);
    server = undefined;
  });

  test('an HttpException thrown by a handler reaches onError before getResponse()', async () => {
    adapter = new Ergenecore(mockLogger);

    const errorHandler = mock((error: Error, context: Context) =>
      context.send({ reshaped: true, status: (error as HttpException).status }, (error as HttpException).status),
    );

    adapter.onError(errorHandler);

    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/forbidden',
      middlewares: [],
      handler: async () => {
        throw new HttpException(403, 'Forbidden');
      },
    } as any);

    adapter.setPort(0);
    server = await adapter.start();

    const response = await fetch(`http://localhost:${server.port}/forbidden`);

    expect(response.status).toBe(403);
    // Previously answered straight from HttpException.getResponse(), so an app could not
    // reshape its own 4xx envelopes on ergenecore while it could on hono.
    expect(await response.json()).toEqual({ reshaped: true, status: 403 });
    expect(errorHandler).toHaveBeenCalled();
  });

  test('an HttpException still answers itself when no onError is registered', async () => {
    adapter = new Ergenecore(mockLogger);

    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/teapot',
      middlewares: [],
      handler: async () => {
        throw new HttpException(418, "I'm a teapot");
      },
    } as any);

    adapter.setPort(0);
    server = await adapter.start();

    const response = await fetch(`http://localhost:${server.port}/teapot`);

    expect(response.status).toBe(418);
    expect(await response.text()).toBe("I'm a teapot");
  });
});
