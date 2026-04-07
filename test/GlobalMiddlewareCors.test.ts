import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Ergenecore } from '../lib';
import { ErgenecoreWebsocketAdapter } from '../lib';
import { CorsMiddleware } from '../lib/defaults';
import type { ServerLogger } from '@asenajs/asena/logger';
import type { BaseMiddleware } from '@asenajs/asena/adapter';
import { HttpMethod } from '@asenajs/asena/web-types';
import type { Context } from '../lib';
import type { Server } from 'bun';

const mockLogger: ServerLogger = {
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  profile: mock(() => {}),
};

function createTestMiddleware(name: string, shouldContinue = true): BaseMiddleware<Context> {
  return {
    // @ts-ignore
    name,
    handle: mock(async (ctx: Context, next: () => Promise<void>) => {
      const order = ctx.getValue('executionOrder') || [];

      order.push(name);
      ctx.setValue('executionOrder', order);

      if (shouldContinue) {
        await next();
      }

      return shouldContinue;
    }),
    override: false,
  };
}

describe('Global Middleware - CORS Preflight Integration (Ergenecore)', () => {
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

  describe('OPTIONS preflight without explicit OPTIONS route', () => {
    it('should handle OPTIONS preflight via global CORS middleware when only GET route exists', async () => {
      const corsMiddleware = new CorsMiddleware();

      // Register CORS as global middleware (not per-route)
      // @ts-ignore
      adapter.use(corsMiddleware);

      // Only register GET - no OPTIONS route
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ users: [] }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      // Browser sends OPTIONS preflight
      const response = await fetch(`${baseUrl}/api/users`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    });

    it('should handle OPTIONS preflight for routes with multiple methods registered', async () => {
      const corsMiddleware = new CorsMiddleware();

      // @ts-ignore
      adapter.use(corsMiddleware);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ users: [] }),
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.POST,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ created: true }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/api/users`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('should handle OPTIONS preflight for nested paths with params', async () => {
      const corsMiddleware = new CorsMiddleware();

      // @ts-ignore
      adapter.use(corsMiddleware);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users/:id',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ id: ctx.getParam('id') }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/api/users/123`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('should handle OPTIONS preflight for multiple different paths', async () => {
      const corsMiddleware = new CorsMiddleware();

      // @ts-ignore
      adapter.use(corsMiddleware);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ users: [] }),
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/posts',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ posts: [] }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const [usersRes, postsRes] = await Promise.all([
        fetch(`${baseUrl}/api/users`, { method: 'OPTIONS', headers: { Origin: 'https://example.com' } }),
        fetch(`${baseUrl}/api/posts`, { method: 'OPTIONS', headers: { Origin: 'https://example.com' } }),
      ]);

      expect(usersRes.status).toBe(204);
      expect(postsRes.status).toBe(204);
      expect(usersRes.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(postsRes.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  describe('OPTIONS preflight to completely unknown paths', () => {
    it('should handle OPTIONS to unknown path when CORS is global', async () => {
      const corsMiddleware = new CorsMiddleware();

      // @ts-ignore
      adapter.use(corsMiddleware);

      // Register a route but send OPTIONS to a different path
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ users: [] }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/completely/random/path`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      });

      // CORS middleware should still respond with 204
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
    });
  });

  describe('CORS with pattern-based global middleware', () => {
    it('should handle OPTIONS preflight when CORS has include pattern', async () => {
      const corsMiddleware = new CorsMiddleware();

      // @ts-ignore
      adapter.use(corsMiddleware, { include: ['/api/*'] });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ users: [] }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      // OPTIONS to included path should get CORS
      const response = await fetch(`${baseUrl}/api/users`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('should NOT apply CORS to excluded paths on OPTIONS', async () => {
      const corsMiddleware = new CorsMiddleware();

      // @ts-ignore
      adapter.use(corsMiddleware, { include: ['/api/*'] });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/public/page',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ page: 'public' }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      // OPTIONS to non-included path should NOT get CORS
      const response = await fetch(`${baseUrl}/public/page`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      });

      // Should be 404 (no CORS middleware applied, no OPTIONS handler)
      expect(response.status).toBe(404);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    it('should respect exclude patterns on OPTIONS preflight', async () => {
      const corsMiddleware = new CorsMiddleware();

      // @ts-ignore
      adapter.use(corsMiddleware, { exclude: ['/internal/*'] });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/internal/secret',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ secret: true }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/internal/secret`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      });

      expect(response.status).toBe(404);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });

  describe('Non-OPTIONS requests still work correctly (regression)', () => {
    it('should add CORS headers to normal GET requests', async () => {
      const corsMiddleware = new CorsMiddleware();

      // @ts-ignore
      adapter.use(corsMiddleware);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ users: [] }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/api/users`, {
        headers: { Origin: 'https://example.com' },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('should return 404 for unknown GET paths with global middleware', async () => {
      const corsMiddleware = new CorsMiddleware();

      // @ts-ignore
      adapter.use(corsMiddleware);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ users: [] }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      // GET to unknown path - middleware runs but handler returns 404
      const response = await fetch(`${baseUrl}/unknown`);

      expect(response.status).toBe(404);
    });
  });

  describe('Global middleware execution on catch-all', () => {
    it('should execute custom global middleware on unmatched routes', async () => {
      const trackingMiddleware = createTestMiddleware('tracker');

      adapter.use(trackingMiddleware);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ users: [] }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      // Request to unmatched path
      await fetch(`${baseUrl}/unknown`);

      // Middleware should have been called
      expect(trackingMiddleware.handle).toHaveBeenCalled();
    });

    it('should execute multiple global middlewares in order on catch-all', async () => {
      const mw1 = createTestMiddleware('first');
      const mw2 = createTestMiddleware('second');
      const mw3 = createTestMiddleware('third');

      adapter.use(mw1);
      adapter.use(mw2);
      adapter.use(mw3);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ users: [] }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      await fetch(`${baseUrl}/unknown`);

      expect(mw1.handle).toHaveBeenCalled();
      expect(mw2.handle).toHaveBeenCalled();
      expect(mw3.handle).toHaveBeenCalled();
    });

    it('should return 403 when global middleware returns false on catch-all', async () => {
      const blockingMiddleware = createTestMiddleware('blocker', false);

      adapter.use(blockingMiddleware);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ users: [] }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/unknown`);

      // Middleware returned false → should be forbidden
      expect(response.status).toBe(403);
    });

    it('should use Response returned by global middleware on catch-all', async () => {
      const responseMiddleware: BaseMiddleware<Context> = {
        handle: mock(async () => {
          return new Response(JSON.stringify({ custom: 'response' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }),
        override: false,
      };

      // @ts-ignore
      adapter.use(responseMiddleware);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ users: [] }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/unknown`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.custom).toBe('response');
    });

    it('should call error handler when no middleware handles on catch-all', async () => {
      const errorHandler = mock((error: Error, ctx: Context) => {
        return new Response(JSON.stringify({ error: error.message, custom: true }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      adapter.onError(errorHandler);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ users: [] }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/unknown`);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.custom).toBe(true);
      expect(errorHandler).toHaveBeenCalled();
    });
  });
});
