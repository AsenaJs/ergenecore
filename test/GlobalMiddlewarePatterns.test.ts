import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Ergenecore } from '../lib';
import { ErgenecoreWebsocketAdapter } from '../lib';
import type { ServerLogger } from '@asenajs/asena/logger';
import type { BaseMiddleware } from '@asenajs/asena/adapter';
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

// Helper to create test middleware
function createTestMiddleware(name: string, shouldContinue = true): BaseMiddleware<Context> {
  return {
    // @ts-ignore
    name,
    handle: mock(async (ctx: Context, next: () => Promise<void>) => {
      // Store execution order
      const order = ctx.getValue('executionOrder') || [];

      order.push(name);
      ctx.setValue('executionOrder', order);

      // Only call next() if we want to continue
      if (shouldContinue) {
        await next();
      }

      return shouldContinue;
    }),
    override: false,
  };
}

describe('Global Middleware Pattern-Based Filtering', () => {
  let adapter: Ergenecore;
  let server: Server;
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

  describe('Include Patterns', () => {
    it('should apply middleware only to included paths', async () => {
      const middleware = createTestMiddleware('api-middleware');

      // Apply middleware only to /api/* paths
      adapter.use(middleware, { include: ['/api/*'] });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ path: '/api/users', executionOrder: order });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/health',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ path: '/health', executionOrder: order });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const apiResponse = await fetch(`${baseUrl}/api/users`);
      const apiData = await apiResponse.json();

      const healthResponse = await fetch(`${baseUrl}/health`);
      const healthData = await healthResponse.json();

      // Middleware should be applied to /api/users
      expect(apiData.executionOrder).toEqual(['api-middleware']);

      // Middleware should NOT be applied to /health
      expect(healthData.executionOrder).toEqual([]);

      // Middleware should only be called once (for /api/users)
      expect(middleware.handle).toHaveBeenCalledTimes(1);
    });

    it('should support multiple include patterns', async () => {
      const middleware = createTestMiddleware('multi-include');

      // Apply middleware to both /api/* and /admin/* paths
      adapter.use(middleware, { include: ['/api/*', '/admin/*'] });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/admin/dashboard',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/public',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const apiResponse = await fetch(`${baseUrl}/api/users`);
      const apiData = await apiResponse.json();

      const adminResponse = await fetch(`${baseUrl}/admin/dashboard`);
      const adminData = await adminResponse.json();

      const publicResponse = await fetch(`${baseUrl}/public`);
      const publicData = await publicResponse.json();

      // Middleware should be applied to both /api/* and /admin/*
      expect(apiData.executionOrder).toEqual(['multi-include']);
      expect(adminData.executionOrder).toEqual(['multi-include']);

      // Middleware should NOT be applied to /public
      expect(publicData.executionOrder).toEqual([]);
    });

    it('should support exact path matching', async () => {
      const middleware = createTestMiddleware('exact-match');

      // Apply middleware only to exact path /api/users
      adapter.use(middleware, { include: ['/api/users'] });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/posts',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const usersResponse = await fetch(`${baseUrl}/api/users`);
      const usersData = await usersResponse.json();

      const postsResponse = await fetch(`${baseUrl}/api/posts`);
      const postsData = await postsResponse.json();

      // Middleware should only be applied to exact path /api/users
      expect(usersData.executionOrder).toEqual(['exact-match']);
      expect(postsData.executionOrder).toEqual([]);
    });
  });

  describe('Exclude Patterns', () => {
    it('should exclude middleware from specific paths', async () => {
      const middleware = createTestMiddleware('auth-middleware');

      // Apply middleware to all routes EXCEPT /public/*
      adapter.use(middleware, { exclude: ['/public/*'] });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/public/about',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const apiResponse = await fetch(`${baseUrl}/api/users`);
      const apiData = await apiResponse.json();

      const publicResponse = await fetch(`${baseUrl}/public/about`);
      const publicData = await publicResponse.json();

      // Middleware should be applied to /api/users
      expect(apiData.executionOrder).toEqual(['auth-middleware']);

      // Middleware should NOT be applied to /public/about
      expect(publicData.executionOrder).toEqual([]);
    });

    it('should support multiple exclude patterns', async () => {
      const middleware = createTestMiddleware('logging-middleware');

      // Exclude middleware from /health and /metrics paths
      adapter.use(middleware, { exclude: ['/health', '/metrics'] });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/health',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/metrics',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const apiResponse = await fetch(`${baseUrl}/api/users`);
      const apiData = await apiResponse.json();

      const healthResponse = await fetch(`${baseUrl}/health`);
      const healthData = await healthResponse.json();

      const metricsResponse = await fetch(`${baseUrl}/metrics`);
      const metricsData = await metricsResponse.json();

      // Middleware should be applied to /api/users
      expect(apiData.executionOrder).toEqual(['logging-middleware']);

      // Middleware should NOT be applied to /health or /metrics
      expect(healthData.executionOrder).toEqual([]);
      expect(metricsData.executionOrder).toEqual([]);
    });
  });

  describe('Include + Exclude Combination', () => {
    it('should exclude take precedence over include', async () => {
      const middleware = createTestMiddleware('complex-pattern');

      // Include /api/* but exclude /api/public/*
      adapter.use(middleware, {
        include: ['/api/*'],
        exclude: ['/api/public/*'],
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/public/info',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/health',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const apiResponse = await fetch(`${baseUrl}/api/users`);
      const apiData = await apiResponse.json();

      const publicResponse = await fetch(`${baseUrl}/api/public/info`);
      const publicData = await publicResponse.json();

      const healthResponse = await fetch(`${baseUrl}/health`);
      const healthData = await healthResponse.json();

      // Middleware should be applied to /api/users (matches include, not excluded)
      expect(apiData.executionOrder).toEqual(['complex-pattern']);

      // Middleware should NOT be applied to /api/public/info (excluded takes precedence)
      expect(publicData.executionOrder).toEqual([]);

      // Middleware should NOT be applied to /health (doesn't match include)
      expect(healthData.executionOrder).toEqual([]);
    });
  });

  describe('Wildcard Patterns', () => {
    it('should support nested wildcard patterns', async () => {
      const middleware = createTestMiddleware('nested-wildcard');

      // Apply to all /api/v1/* paths
      adapter.use(middleware, { include: ['/api/v1/*'] });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/v1/users',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/v2/users',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const v1Response = await fetch(`${baseUrl}/api/v1/users`);
      const v1Data = await v1Response.json();

      const v2Response = await fetch(`${baseUrl}/api/v2/users`);
      const v2Data = await v2Response.json();

      // Middleware should only be applied to v1 routes
      expect(v1Data.executionOrder).toEqual(['nested-wildcard']);
      expect(v2Data.executionOrder).toEqual([]);
    });
  });

  describe('Multiple Global Middlewares with Different Patterns', () => {
    it('should apply multiple middlewares with different patterns correctly', async () => {
      const authMiddleware = createTestMiddleware('auth');
      const loggingMiddleware = createTestMiddleware('logging');
      const analyticsMiddleware = createTestMiddleware('analytics');

      // Auth: only /api/*
      adapter.use(authMiddleware, { include: ['/api/*'] });

      // Logging: all except /health
      adapter.use(loggingMiddleware, { exclude: ['/health'] });

      // Analytics: only /api/* but exclude /api/internal/*
      adapter.use(analyticsMiddleware, {
        include: ['/api/*'],
        exclude: ['/api/internal/*'],
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/internal/config',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/health',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/about',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const apiUsersResponse = await fetch(`${baseUrl}/api/users`);
      const apiUsersData = await apiUsersResponse.json();

      const internalResponse = await fetch(`${baseUrl}/api/internal/config`);
      const internalData = await internalResponse.json();

      const healthResponse = await fetch(`${baseUrl}/health`);
      const healthData = await healthResponse.json();

      const aboutResponse = await fetch(`${baseUrl}/about`);
      const aboutData = await aboutResponse.json();

      // /api/users: should have auth, logging, analytics
      expect(apiUsersData.executionOrder).toEqual(['auth', 'logging', 'analytics']);

      // /api/internal/config: should have auth, logging (analytics excluded)
      expect(internalData.executionOrder).toEqual(['auth', 'logging']);

      // /health: no middlewares (logging excluded)
      expect(healthData.executionOrder).toEqual([]);

      // /about: only logging (auth/analytics don't match)
      expect(aboutData.executionOrder).toEqual(['logging']);
    });
  });

  describe('Backward Compatibility', () => {
    it('should apply middleware to all routes when no config provided', async () => {
      const middleware = createTestMiddleware('no-config');

      // Use middleware without config (backward compatible)
      adapter.use(middleware);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/health',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const apiResponse = await fetch(`${baseUrl}/api/users`);
      const apiData = await apiResponse.json();

      const healthResponse = await fetch(`${baseUrl}/health`);
      const healthData = await healthResponse.json();

      // Middleware should be applied to ALL routes
      expect(apiData.executionOrder).toEqual(['no-config']);
      expect(healthData.executionOrder).toEqual(['no-config']);
      expect(middleware.handle).toHaveBeenCalledTimes(2);
    });
  });

  describe('Pattern-Based Middleware with Route Middlewares', () => {
    it('should execute filtered global middlewares before route middlewares', async () => {
      const globalMiddleware = createTestMiddleware('global-filtered');
      const routeMiddleware = createTestMiddleware('route-specific');

      // Global middleware only for /api/*
      adapter.use(globalMiddleware, { include: ['/api/*'] });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [routeMiddleware],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/health',
        middlewares: [routeMiddleware],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const apiResponse = await fetch(`${baseUrl}/api/users`);
      const apiData = await apiResponse.json();

      const healthResponse = await fetch(`${baseUrl}/health`);
      const healthData = await healthResponse.json();

      // /api/users: global middleware + route middleware
      expect(apiData.executionOrder).toEqual(['global-filtered', 'route-specific']);

      // /health: only route middleware (global excluded)
      expect(healthData.executionOrder).toEqual(['route-specific']);
    });
  });
});
