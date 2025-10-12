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

describe('Middleware System', () => {
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

  describe('Single Middleware', () => {
    it('should execute route middleware before handler', async () => {
      const middleware = createTestMiddleware('route-middleware');

      adapter.registerRoute({
        method: HttpMethod.GET,
        path: '/test',
        middlewares: [middleware],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      } as any);

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.executionOrder).toEqual(['route-middleware']);
      expect(middleware.handle).toHaveBeenCalledTimes(1);
    });

    it('should execute global middleware before route middleware', async () => {
      const globalMiddleware = createTestMiddleware('global-middleware');
      const routeMiddleware = createTestMiddleware('route-middleware');

      adapter.use(globalMiddleware);

      adapter.registerRoute({
        method: HttpMethod.GET,
        path: '/test',
        middlewares: [routeMiddleware],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      } as any);

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`);
      const data = await response.json();

      expect(data.executionOrder).toEqual(['global-middleware', 'route-middleware']);
    });
  });

  describe('Multiple Middlewares', () => {
    it('should execute middlewares in correct order', async () => {
      const middleware1 = createTestMiddleware('middleware-1');
      const middleware2 = createTestMiddleware('middleware-2');
      const middleware3 = createTestMiddleware('middleware-3');

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        middlewares: [middleware1, middleware2, middleware3],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`);
      const data = await response.json();

      expect(data.executionOrder).toEqual(['middleware-1', 'middleware-2', 'middleware-3']);
    });

    it('should execute multiple global middlewares in order', async () => {
      const global1 = createTestMiddleware('global-1');
      const global2 = createTestMiddleware('global-2');

      adapter.use(global1);
      adapter.use(global2);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`);
      const data = await response.json();

      expect(data.executionOrder).toEqual(['global-1', 'global-2']);
    });

    it('should execute global middlewares before route middlewares', async () => {
      const global1 = createTestMiddleware('global-1');
      const global2 = createTestMiddleware('global-2');
      const route1 = createTestMiddleware('route-1');
      const route2 = createTestMiddleware('route-2');

      adapter.use(global1);
      adapter.use(global2);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        middlewares: [route1, route2],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`);
      const data = await response.json();

      expect(data.executionOrder).toEqual(['global-1', 'global-2', 'route-1', 'route-2']);
    });
  });

  describe('Middleware Return False', () => {
    it('should stop execution when middleware returns false', async () => {
      const middleware1 = createTestMiddleware('middleware-1', true);
      const middleware2 = createTestMiddleware('middleware-2', false); // Returns false
      const middleware3 = createTestMiddleware('middleware-3', true);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        middlewares: [middleware1, middleware2, middleware3],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ executionOrder: order });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`);

      // Should return 403 Forbidden
      expect(response.status).toBe(403);
      expect(await response.text()).toBe('Forbidden');

      // Only first two middlewares should be executed
      expect(middleware1.handle).toHaveBeenCalledTimes(1);
      expect(middleware2.handle).toHaveBeenCalledTimes(1);
      expect(middleware3.handle).toHaveBeenCalledTimes(0); // Should NOT be called
    });

    it('should stop at global middleware when it returns false', async () => {
      const global1 = createTestMiddleware('global-1', true);
      const global2 = createTestMiddleware('global-2', false); // Returns false
      const route1 = createTestMiddleware('route-1', true);

      adapter.use(global1);
      adapter.use(global2);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        middlewares: [route1],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Should not reach here' });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`);

      expect(response.status).toBe(403);
      expect(global1.handle).toHaveBeenCalledTimes(1);
      expect(global2.handle).toHaveBeenCalledTimes(1);
      expect(route1.handle).toHaveBeenCalledTimes(0); // Should NOT be called
    });
  });

  describe('Middleware Context Access', () => {
    it('should allow middleware to modify context', async () => {
      const middleware: BaseMiddleware<Context> = {
        // @ts-ignore
        name: 'context-modifier',
        handle: async (ctx: Context) => {
          ctx.setValue('user', { id: 123, name: 'John' });
          ctx.setValue('timestamp', Date.now());
          return true;
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        middlewares: [middleware],
        handler: async (ctx: Context) => {
          const user = ctx.getValue('user');
          const timestamp = ctx.getValue('timestamp');

          return ctx.send({ user, hasTimestamp: !!timestamp });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`);
      const data = await response.json();

      expect(data.user).toEqual({ id: 123, name: 'John' });
      expect(data.hasTimestamp).toBe(true);
    });

    it('should allow middleware to access request data', async () => {
      const middleware: BaseMiddleware<Context> = {
        // @ts-ignore
        name: 'request-logger',
        handle: async (ctx: Context) => {
          const method = ctx.req.method;
          const url = ctx.req.url;

          ctx.setValue('requestInfo', { method, url });
          return true;
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        middlewares: [middleware],
        handler: async (ctx: Context) => {
          const requestInfo = ctx.getValue('requestInfo');

          return ctx.send({ requestInfo });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`);
      const data = await response.json();

      expect(data.requestInfo.method).toBe('GET');
      expect(data.requestInfo.url).toContain('/test');
    });
  });

  describe('Middleware Error Handling', () => {
    it('should catch errors in middleware', async () => {
      const errorMiddleware: BaseMiddleware<Context> = {
        // @ts-ignore
        name: 'error-middleware',
        handle: async (_ctx: Context) => {
          throw new Error('Middleware error');
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        middlewares: [errorMiddleware],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Should not reach here' });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`);

      expect(response.status).toBe(500);
      const data = await response.json();

      expect(data.error).toBe('Middleware error');
    });
  });

  describe('Middleware with Different Routes', () => {
    it('should apply global middleware to all routes', async () => {
      const globalMiddleware = createTestMiddleware('global');

      adapter.use(globalMiddleware);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/route1',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ route: 'route1', executionOrder: order });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/route2',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ route: 'route2', executionOrder: order });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response1 = await fetch(`${baseUrl}/route1`);
      const data1 = await response1.json();

      const response2 = await fetch(`${baseUrl}/route2`);
      const data2 = await response2.json();

      expect(data1.executionOrder).toEqual(['global']);
      expect(data2.executionOrder).toEqual(['global']);
      expect(globalMiddleware.handle).toHaveBeenCalledTimes(2);
    });

    it('should apply route-specific middlewares only to that route', async () => {
      const route1Middleware = createTestMiddleware('route1-only');

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/route1',
        middlewares: [route1Middleware],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ route: 'route1', executionOrder: order });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/route2',
        middlewares: [],
        handler: async (ctx: Context) => {
          const order = ctx.getValue('executionOrder') || [];

          return ctx.send({ route: 'route2', executionOrder: order });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response1 = await fetch(`${baseUrl}/route1`);
      const data1 = await response1.json();

      const response2 = await fetch(`${baseUrl}/route2`);
      const data2 = await response2.json();

      expect(data1.executionOrder).toEqual(['route1-only']);
      expect(data2.executionOrder).toEqual([]);
      expect(route1Middleware.handle).toHaveBeenCalledTimes(1);
    });
  });
});
