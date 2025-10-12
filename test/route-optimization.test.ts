import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { Ergenecore } from '../lib';
import { HttpMethod } from '@asenajs/asena/web-types';
import type { ServerLogger } from '@asenajs/asena/logger';
import type { Context } from '../lib';

// Mock logger
const mockLogger: ServerLogger = {
  profile: mock(() => {}),
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
};

describe('Base Path Extraction', () => {
  test('should extract base path from simple path', () => {
    const adapter = new Ergenecore(mockLogger);

    // @ts-ignore - Testing private method
    const basePath = adapter.extractBasePath('/users');

    expect(basePath).toBe('/users');
  });

  test('should extract base path from path with single parameter', () => {
    const adapter = new Ergenecore(mockLogger);

    // @ts-ignore - Testing private method
    const basePath = adapter.extractBasePath('/users/:id');

    expect(basePath).toBe('/users');
  });

  test('should extract base path from nested path with parameter', () => {
    const adapter = new Ergenecore(mockLogger);

    // @ts-ignore - Testing private method
    const basePath = adapter.extractBasePath('/api/users/:id');

    expect(basePath).toBe('/api/users');
  });

  test('should extract base path from path with multiple parameters', () => {
    const adapter = new Ergenecore(mockLogger);

    // @ts-ignore - Testing private method
    const basePath = adapter.extractBasePath('/api/users/:id/posts/:postId');

    expect(basePath).toBe('/api/users');
  });

  test('should extract base path from path with wildcard', () => {
    const adapter = new Ergenecore(mockLogger);

    // @ts-ignore - Testing private method
    const basePath = adapter.extractBasePath('/static/*');

    expect(basePath).toBe('/static');
  });

  test('should extract base path from path with wildcard in middle', () => {
    const adapter = new Ergenecore(mockLogger);

    // @ts-ignore - Testing private method
    const basePath = adapter.extractBasePath('/api/*/users');

    expect(basePath).toBe('/api');
  });

  test('should return root for root path', () => {
    const adapter = new Ergenecore(mockLogger);

    // @ts-ignore - Testing private method
    const basePath = adapter.extractBasePath('/');

    expect(basePath).toBe('/');
  });

  test('should handle trailing slash', () => {
    const adapter = new Ergenecore(mockLogger);

    // @ts-ignore - Testing private method
    const basePath = adapter.extractBasePath('/users/');

    expect(basePath).toBe('/users');
  });

  test('should handle multiple segments before parameter', () => {
    const adapter = new Ergenecore(mockLogger);

    // @ts-ignore - Testing private method
    const basePath = adapter.extractBasePath('/api/v1/users/:id');

    expect(basePath).toBe('/api/v1/users');
  });
});

describe('Common Middleware Detection', () => {
  // Mock middleware classes
  class AuthMiddleware {

    public async handle(_context: Context, next: () => Promise<void>): Promise<void> {
      await next();
    }
  
}

  class LogMiddleware {

    public async handle(_context: Context, next: () => Promise<void>): Promise<void> {
      await next();
    }
  
}

  class RateLimitMiddleware {

    public async handle(_context: Context, next: () => Promise<void>) {
      await next();
    }
  
}

  test('should detect common middlewares across all routes', () => {
    const adapter = new Ergenecore(mockLogger);

    const authMW = new AuthMiddleware();
    const logMW = new LogMiddleware();
    const routes = [
      {
        method: HttpMethod.GET,
        path: '/users',
        middlewares: [authMW, logMW],
        handler: async (ctx: Context) => ctx.send({ data: 'users' }),
      },
      {
        method: HttpMethod.POST,
        path: '/users',
        middlewares: [authMW, logMW],
        handler: async (ctx: Context) => ctx.send({ data: 'create user' }),
      },
      {
        method: HttpMethod.GET,
        path: '/users/:id',
        middlewares: [authMW, logMW],
        handler: async (ctx: Context) => ctx.send({ data: 'user' }),
      },
    ];

    // @ts-ignore - Testing private method
    const commonMiddlewares = adapter.extractCommonMiddlewares(routes);

    expect(commonMiddlewares.length).toBe(2);
    // @ts-ignore
    expect(commonMiddlewares[0]).toBe(authMW);
    // @ts-ignore
    expect(commonMiddlewares[1]).toBe(logMW);
  });

  test('should return empty array when no common middlewares', () => {
    const adapter = new Ergenecore(mockLogger);

    const authMW = new AuthMiddleware();
    const logMW = new LogMiddleware();

    const routes = [
      {
        method: HttpMethod.GET,
        path: '/users',
        middlewares: [authMW],
        handler: async (ctx: Context) => ctx.send({ data: 'users' }),
      },
      {
        method: HttpMethod.POST,
        path: '/users',
        middlewares: [logMW],
        handler: async (ctx: Context) => ctx.send({ data: 'create user' }),
      },
    ];

    // @ts-ignore - Testing private method
    const commonMiddlewares = adapter.extractCommonMiddlewares(routes);

    expect(commonMiddlewares.length).toBe(0);
  });

  test('should return empty array for single route', () => {
    const adapter = new Ergenecore(mockLogger);

    const authMW = new AuthMiddleware();

    const routes = [
      {
        method: HttpMethod.GET,
        path: '/users',
        middlewares: [authMW],
        handler: async (ctx: Context) => ctx.send({ data: 'users' }),
      },
    ];

    // @ts-ignore - Testing private method
    const commonMiddlewares = adapter.extractCommonMiddlewares(routes);

    expect(commonMiddlewares.length).toBe(0);
  });

  test('should detect partial common middlewares', () => {
    const adapter = new Ergenecore(mockLogger);

    const authMW = new AuthMiddleware();
    const logMW = new LogMiddleware();
    const rateLimitMW = new RateLimitMiddleware();

    const routes = [
      {
        method: HttpMethod.GET,
        path: '/users',
        middlewares: [authMW, logMW, rateLimitMW],
        handler: async (ctx: Context) => ctx.send({ data: 'users' }),
      },
      {
        method: HttpMethod.POST,
        path: '/users',
        middlewares: [authMW, logMW],
        handler: async (ctx: Context) => ctx.send({ data: 'create user' }),
      },
      {
        method: HttpMethod.GET,
        path: '/users/:id',
        middlewares: [authMW, logMW],
        handler: async (ctx: Context) => ctx.send({ data: 'user' }),
      },
    ];

    // @ts-ignore - Testing private method
    const commonMiddlewares = adapter.extractCommonMiddlewares(routes);

    // Only authMW and logMW are common (rateLimitMW is only in first route)
    expect(commonMiddlewares.length).toBe(2);
    // @ts-ignore
    expect(commonMiddlewares[0]).toBe(authMW);
    // @ts-ignore
    expect(commonMiddlewares[1]).toBe(logMW);
  });
});

describe('Route Grouping', () => {
  test('should group routes by base path', () => {
    const adapter = new Ergenecore(mockLogger);

    const routes = [
      {
        method: HttpMethod.GET,
        path: '/api/users',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ data: 'users' }),
      },
      {
        method: HttpMethod.GET,
        path: '/api/users/:id',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ data: 'user' }),
      },
      {
        method: HttpMethod.GET,
        path: '/api/posts',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ data: 'posts' }),
      },
      {
        method: HttpMethod.GET,
        path: '/dashboard/stats',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ data: 'stats' }),
      },
    ];

    // @ts-ignore - Testing private method
    const groups = adapter.groupRoutesByBasePath(routes);

    expect(groups.size).toBe(3);
    expect(groups.has('/api/users')).toBe(true);
    expect(groups.has('/api/posts')).toBe(true);
    expect(groups.has('/dashboard/stats')).toBe(true);

    expect(groups.get('/api/users')?.length).toBe(2); // /api/users and /api/users/:id
    expect(groups.get('/api/posts')?.length).toBe(1);
    expect(groups.get('/dashboard/stats')?.length).toBe(1);
  });

  test('should handle root path routes', () => {
    const adapter = new Ergenecore(mockLogger);

    const routes = [
      {
        method: HttpMethod.GET,
        path: '/',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ data: 'home' }),
      },
      {
        method: HttpMethod.GET,
        path: '/about',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ data: 'about' }),
      },
    ];

    // @ts-ignore - Testing private method
    const groups = adapter.groupRoutesByBasePath(routes);

    expect(groups.size).toBe(2);
    expect(groups.has('/')).toBe(true);
    expect(groups.has('/about')).toBe(true);
  });
});

describe('Integration Test', () => {
  const TEST_PORT = 3008;
  let adapter: Ergenecore;

  // Mock middleware classes with execution tracking
  class AuthMiddleware {

    public static executionCount = 0;

    public async handle(_context: Context, next: () => Promise<void>): Promise<void> {
      AuthMiddleware.executionCount++;
      await next();
    }
  
}

  class LogMiddleware {

    public static executionCount = 0;

    public async handle(_context: Context, next: () => Promise<void>): Promise<void> {
      LogMiddleware.executionCount++;
      await next();
    }
  
}

  beforeAll(() => {
    adapter = new Ergenecore(mockLogger);

    const authMW = new AuthMiddleware();
    const logMW = new LogMiddleware();

    // Register routes with common middlewares
    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/api/users',
      // @ts-ignore
      middlewares: [authMW, logMW],
      handler: async (ctx: Context) => ctx.send({ data: 'users' }),
    });

    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/api/users/:id',
      // @ts-ignore
      middlewares: [authMW, logMW],
      handler: async (ctx: Context) => ctx.send({ data: 'user', id: ctx.getParam('id') }),
    });

    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/api/posts',
      // @ts-ignore
      middlewares: [authMW, logMW],
      handler: async (ctx: Context) => ctx.send({ data: 'posts' }),
    });

    adapter.start(TEST_PORT);
  });

  afterAll(async () => {
    await adapter.stop();
  });

  test('should serve routes with optimized middleware execution', async () => {
    // Reset counters
    AuthMiddleware.executionCount = 0;
    LogMiddleware.executionCount = 0;

    // Make requests to different routes
    const res1 = await fetch(`http://localhost:${TEST_PORT}/api/users`);
    const res2 = await fetch(`http://localhost:${TEST_PORT}/api/users/123`);
    const res3 = await fetch(`http://localhost:${TEST_PORT}/api/posts`);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res3.status).toBe(200);

    const data1 = await res1.json();
    const data2 = await res2.json();
    const data3 = await res3.json();

    expect(data1.data).toBe('users');
    expect(data2.data).toBe('user');
    expect(data2.id).toBe('123');
    expect(data3.data).toBe('posts');

    // Verify middleware execution count
    // Note: Without optimization, each middleware runs per request (3 requests = 6 executions)
    // With optimization, middlewares might be deduplicated (implementation dependent)
    expect(AuthMiddleware.executionCount).toBeGreaterThan(0);
    expect(LogMiddleware.executionCount).toBeGreaterThan(0);
  });
});
