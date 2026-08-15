import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Ergenecore } from '../lib';
import { ErgenecoreWebsocketAdapter } from '../lib';
import { CorsMiddleware } from '../lib/defaults';
import type { ServerLogger } from '@asenajs/asena/logger';
import { HttpMethod } from '@asenajs/asena/web-types';
import type { Context } from '../lib';
import type { Server } from 'bun';

// Mock logger
const mockLogger: ServerLogger = {
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  profile: mock(() => {}),
};

describe('CORS Middleware', () => {
  let adapter: Ergenecore;
  let server: Server<any>;
  let baseUrl: string;

  beforeEach(() => {
    const wsAdapter = new ErgenecoreWebsocketAdapter(mockLogger);

    adapter = new Ergenecore(mockLogger, wsAdapter);
    adapter.setPort(0);
  });

  afterEach(async () => {
    if (server) {
      await adapter.stop();
    }
  });

  describe('Default Configuration (*)', () => {
    it('should allow all origins with default config', async () => {
      const corsMiddleware = new CorsMiddleware();

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [corsMiddleware],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'CORS test' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`, {
        headers: {
          Origin: 'https://example.com',
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('should handle requests without Origin header', async () => {
      const corsMiddleware = new CorsMiddleware();

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [corsMiddleware],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'No CORS' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`);

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    it('should handle preflight OPTIONS request', async () => {
      const corsMiddleware = new CorsMiddleware();

      // Register OPTIONS route for preflight
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.OPTIONS,
        path: '/test',
        // @ts-ignore
        middlewares: [corsMiddleware],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Should not reach here for OPTIONS' });
        },
      });

      // Also register actual GET route
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [corsMiddleware],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'GET handler' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://example.com',
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
      expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
      expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
    });
  });

  describe('Specific Origins (Array)', () => {
    it('should allow requests from whitelisted origins', async () => {
      const corsMiddleware = new CorsMiddleware({
        origin: ['https://example.com', 'https://app.example.com'],
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [corsMiddleware],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Allowed origin' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`, {
        headers: {
          Origin: 'https://example.com',
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
    });

    it('should serve non-whitelisted origins without CORS headers instead of 403', async () => {
      const corsMiddleware = new CorsMiddleware({
        origin: ['https://example.com'],
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [corsMiddleware],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'reached' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`, {
        headers: {
          Origin: 'https://malicious.com',
        },
      });

      // Refusing with 403 would make CORS a server-side denial, which it is not: the browser is
      // what enforces the policy, and it does so by refusing to expose a response that carries no
      // Access-Control-Allow-Origin. A 403 additionally turns away non-browser callers that merely
      // happen to send an Origin header, which is why applications had to register this middleware
      // conditionally when CORS was already terminated at the ingress.
      expect(response.status).toBe(200);
      expect((await response.json()).message).toBe('reached');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(response.headers.get('Vary')).toContain('Origin');
    });
  });

  describe('Dynamic Origin Validation (Function)', () => {
    it('should validate origin using custom function', async () => {
      const corsMiddleware = new CorsMiddleware({
        origin: (origin: string) => origin.endsWith('.example.com') || origin === 'https://example.com',
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [corsMiddleware],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Dynamic origin' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      // Should allow subdomain
      const response1 = await fetch(`${baseUrl}/test`, {
        headers: {
          Origin: 'https://app.example.com',
        },
      });

      expect(response1.status).toBe(200);
      expect(response1.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');

      // Should allow main domain
      const response2 = await fetch(`${baseUrl}/test`, {
        headers: {
          Origin: 'https://example.com',
        },
      });

      expect(response2.status).toBe(200);
      expect(response2.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');

      // Should serve other domains, but without the CORS headers the browser needs
      const response3 = await fetch(`${baseUrl}/test`, {
        headers: {
          Origin: 'https://malicious.com',
        },
      });

      expect(response3.status).toBe(200);
      expect(response3.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });

  describe('Credentials Support', () => {
    it('should set credentials header when enabled', async () => {
      const corsMiddleware = new CorsMiddleware({
        credentials: true,
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [corsMiddleware],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'With credentials' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`, {
        headers: {
          Origin: 'https://example.com',
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    });

    it('should not set credentials header when disabled', async () => {
      const corsMiddleware = new CorsMiddleware({
        credentials: false,
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [corsMiddleware],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Without credentials' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`, {
        headers: {
          Origin: 'https://example.com',
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    });
  });

  describe('Custom Methods and Headers', () => {
    it('should allow custom methods in preflight', async () => {
      const corsMiddleware = new CorsMiddleware({
        methods: ['GET', 'POST'],
      });

      // Register OPTIONS route
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.OPTIONS,
        path: '/test',
        // @ts-ignore
        middlewares: [corsMiddleware],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Should not reach here' });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [corsMiddleware],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Custom methods' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://example.com',
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST');
    });

    it('should allow custom headers in preflight', async () => {
      const corsMiddleware = new CorsMiddleware({
        allowedHeaders: ['X-Custom-Header', 'Authorization'],
      });

      // Register OPTIONS route
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.OPTIONS,
        path: '/test',
        // @ts-ignore
        middlewares: [corsMiddleware],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Should not reach here' });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [corsMiddleware],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Custom headers' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://example.com',
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe('X-Custom-Header, Authorization');
    });
  });

  describe('Exposed Headers', () => {
    it('should expose custom headers', async () => {
      const corsMiddleware = new CorsMiddleware({
        exposedHeaders: ['X-Total-Count', 'X-Page-Number'],
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [corsMiddleware],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Exposed headers' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`, {
        headers: {
          Origin: 'https://example.com',
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Expose-Headers')).toBe('X-Total-Count, X-Page-Number');
    });
  });

  describe('Max Age Configuration', () => {
    it('should set custom max age for preflight cache', async () => {
      const corsMiddleware = new CorsMiddleware({
        maxAge: 3600, // 1 hour
      });

      // Register OPTIONS route
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.OPTIONS,
        path: '/test',
        // @ts-ignore
        middlewares: [corsMiddleware],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Should not reach here' });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [corsMiddleware],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Custom max age' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://example.com',
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Max-Age')).toBe('3600');
    });
  });

  describe('Integration with Response Methods', () => {
    it('should merge CORS headers with handler response', async () => {
      const corsMiddleware = new CorsMiddleware({
        credentials: true,
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [corsMiddleware],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Merged headers' }, { headers: { 'X-Custom': 'value' } });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`, {
        headers: {
          Origin: 'https://example.com',
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
      expect(response.headers.get('X-Custom')).toBe('value');
      const data = await response.json();

      expect(data.message).toBe('Merged headers');
    });
  });

  /**
   * Why these matter: with any non-'*' config the allowed-origin header is computed from the
   * request's own Origin. A shared cache that does not know this will hand one origin's response -
   * complete with its Access-Control-Allow-Origin - to a request from a different origin. `Vary`
   * is the only thing that tells it to key on the header. For a public API behind a CDN this is
   * the difference between a policy and a cache-poisoning primitive.
   */
  describe('Vary: Origin', () => {
    /**
     * Registers GET /test behind CORS plus an optional middleware that runs before it, and the
     * matching OPTIONS route - this router matches on method, so without it a preflight is a 404
     * and never reaches the middleware chain at all.
     */
    async function boot(corsOptions?: ConstructorParameters<typeof CorsMiddleware>[0], before?: any) {
      const corsMiddleware = new CorsMiddleware(corsOptions);
      const middlewares = before ? [before, corsMiddleware] : [corsMiddleware];

      for (const method of [HttpMethod.GET, HttpMethod.OPTIONS]) {
        adapter.registerRoute({
          staticServe: undefined,
          validator: undefined,
          method,
          path: '/test',
          middlewares: middlewares as any,
          handler: async (ctx: Context) => ctx.send({ message: 'ok' }),
        });
      }

      server = await adapter.start();

      return `http://localhost:${server.port}`;
    }

    it('should set Vary: Origin for an array config', async () => {
      const url = await boot({ origin: ['https://example.com'] });

      const response = await fetch(`${url}/test`, { headers: { Origin: 'https://example.com' } });

      expect(response.headers.get('Vary')).toContain('Origin');
    });

    it('should not set Vary for the wildcard config', async () => {
      const url = await boot({ origin: '*' });

      const response = await fetch(`${url}/test`, { headers: { Origin: 'https://anywhere.com' } });

      // '*' is the same answer for every origin, so the response does not vary and forcing a
      // per-origin cache key would only cost hit rate.
      expect(response.headers.get('Vary')).toBeNull();
    });

    it('should keep an existing Vary value instead of overwriting it', async () => {
      // setResponseHeader writes into a Map here, so a plain set would drop the upstream value -
      // a caching bug of its own, and one the Hono adapter cannot hit because it appends.
      const url = await boot(
        { origin: ['https://example.com'] },
        {
          handle: async (ctx: any, next: () => Promise<void>) => {
            ctx.setResponseHeader('Vary', 'Accept-Encoding');

            return await next();
          },
        },
      );

      const response = await fetch(`${url}/test`, { headers: { Origin: 'https://example.com' } });
      const vary = response.headers.get('Vary');

      expect(vary).toContain('Accept-Encoding');
      expect(vary).toContain('Origin');
    });

    it('should set Vary: Origin on the preflight 204 too', async () => {
      const url = await boot({ origin: ['https://example.com'] });

      const response = await fetch(`${url}/test`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('Vary')).toContain('Origin');
    });
  });

  describe('Preflight header preservation', () => {
    it('should keep headers set by an earlier middleware on the 204', async () => {
      // The preflight branch used to build a fresh headers object, so anything an earlier
      // middleware set was dropped from the 204 alone while surviving every other method.
      const corsMiddleware = new CorsMiddleware();
      const middlewares = [
        {
          handle: async (ctx: any, next: () => Promise<void>) => {
            ctx.setResponseHeader('X-Request-Id', 'req-42');

            return await next();
          },
        },
        corsMiddleware,
      ] as any;

      for (const method of [HttpMethod.GET, HttpMethod.OPTIONS]) {
        adapter.registerRoute({
          staticServe: undefined,
          validator: undefined,
          method,
          path: '/test',
          middlewares,
          handler: async (ctx: Context) => ctx.send({ message: 'ok' }),
        });
      }

      server = await adapter.start();

      const response = await fetch(`http://localhost:${server.port}/test`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('X-Request-Id')).toBe('req-42');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('should answer a refused preflight 204 without CORS headers', async () => {
      const corsMiddleware = new CorsMiddleware({ origin: ['https://example.com'] });

      for (const method of [HttpMethod.GET, HttpMethod.OPTIONS]) {
        adapter.registerRoute({
          staticServe: undefined,
          validator: undefined,
          method,
          path: '/test',
          middlewares: [corsMiddleware] as any,
          handler: async (ctx: Context) => ctx.send({ message: 'ok' }),
        });
      }

      server = await adapter.start();

      const response = await fetch(`http://localhost:${server.port}/test`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://malicious.com' },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(response.headers.get('Access-Control-Allow-Methods')).toBeNull();
    });
  });
});
