import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Ergenecore } from '../lib';
import { ErgenecoreWebsocketAdapter } from '../lib';
import type { ServerLogger } from '@asenajs/asena/logger';
import { HttpMethod } from '@asenajs/asena/web-types';
import type { Context } from '../lib';

// Mock logger
const mockLogger: ServerLogger = {
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  profile: mock(() => {}),
};

describe('CoreAdapter', () => {
  let adapter: Ergenecore;
  let wsAdapter: ErgenecoreWebsocketAdapter;

  beforeEach(() => {
    wsAdapter = new ErgenecoreWebsocketAdapter(mockLogger);
    adapter = new Ergenecore(mockLogger, wsAdapter);
  });

  afterEach(async () => {
    // Cleanup if server is running
    if (adapter['server']) {
      await adapter.stop();
    }
  });

  describe('Initialization', () => {
    it('should initialize with correct name', () => {
      expect(adapter.name).toBe('Ergenecore');
    });

    it('should initialize with empty route queue', () => {
      expect(adapter['routeQueue']).toBeDefined();
      expect(adapter['routeQueue'].length).toBe(0);
    });

    it('should store logger reference', () => {
      expect(adapter['logger']).toBe(mockLogger);
    });

    it('should store websocket adapter reference', () => {
      expect(adapter['websocketAdapter']).toBe(wsAdapter);
    });
  });

  describe('Route Registration', () => {
    it('should queue route during registration', async () => {
      const handler = async (ctx: Context) => ctx.send({ success: true });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        middlewares: [],
        handler,
      });

      expect(adapter['routeQueue'].length).toBe(1);
      expect(adapter['routeQueue'][0].method).toBe(HttpMethod.GET);
      expect(adapter['routeQueue'][0].path).toBe('/test');
      expect(adapter['routeQueue'][0].handler).toBe(handler);
    });

    it('should queue multiple routes', async () => {
      const handler1 = async (ctx: Context) => ctx.send({ id: 1 });
      const handler2 = async (ctx: Context) => ctx.send({ id: 2 });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/users',
        middlewares: [],
        handler: handler1,
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.POST,
        path: '/users',
        middlewares: [],
        handler: handler2,
      });

      expect(adapter['routeQueue'].length).toBe(2);
    });

    it('should log routes on server start with controller-based format', async () => {
      const handler = async (ctx: Context) => ctx.send({ success: true });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        middlewares: [],
        handler,
        controllerName: 'TestController',
        controllerBasePath: '/test',
      });

      // Clear previous mock calls
      (mockLogger.info as any).mockClear();

      adapter.setPort(0); // Use random port
      adapter.start();

      // Should log server ready and controller-based routes
      expect(mockLogger.info).toHaveBeenCalled();

      // Check if controller-based log format was used
      const logCalls = (mockLogger.info as any).mock.calls;
      const routeLog = logCalls.find((call: any) =>
        call[0]?.includes?.('TestController') || call[0]?.includes?.('Registered routes')
      );

      expect(routeLog).toBeDefined();

      await adapter.stop();
    });
  });

  describe('buildBunRoutes', () => {
    it('should build routes object with 404 handler when no routes queued', () => {
      const bunRoutes = adapter['buildBunRoutes']();

      // Even with no routes, should have 404 handler
      expect(bunRoutes['/*']).toBeDefined();
      expect(typeof bunRoutes['/*']).toBe('function');
    });

    it('should build single route with single method', async () => {
      const handler = async (ctx: Context) => ctx.send({ success: true });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        middlewares: [],
        handler,
      });

      const bunRoutes = adapter['buildBunRoutes']();

      expect(bunRoutes['/test']).toBeDefined();
      expect(bunRoutes['/test'].GET).toBeDefined();
      expect(typeof bunRoutes['/test'].GET).toBe('function');
    });

    it('should build route with multiple methods for same path', async () => {
      const getHandler = async (ctx: Context) => ctx.send({ method: 'GET' });
      const postHandler = async (ctx: Context) => ctx.send({ method: 'POST' });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/users',
        middlewares: [],
        handler: getHandler,
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.POST,
        path: '/users',
        middlewares: [],
        handler: postHandler,
      });

      const bunRoutes = adapter['buildBunRoutes']();

      expect(bunRoutes['/users']).toBeDefined();
      expect(bunRoutes['/users'].GET).toBeDefined();
      expect(bunRoutes['/users'].POST).toBeDefined();
    });

    it('should build multiple routes with different paths', async () => {
      const handler1 = async (ctx: Context) => ctx.send({ route: 1 });
      const handler2 = async (ctx: Context) => ctx.send({ route: 2 });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/users',
        middlewares: [],
        handler: handler1,
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/posts',
        middlewares: [],
        handler: handler2,
      });

      const bunRoutes = adapter['buildBunRoutes']();

      expect(bunRoutes['/users']).toBeDefined();
      expect(bunRoutes['/posts']).toBeDefined();
    });

    it('should handle parameterized routes', async () => {
      const handler = async (ctx: Context) => ctx.send({ id: ctx.getParam('id') });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/users/:id',
        middlewares: [],
        handler,
      });

      const bunRoutes = adapter['buildBunRoutes']();

      expect(bunRoutes['/users/:id']).toBeDefined();
      expect(bunRoutes['/users/:id'].GET).toBeDefined();
    });

    it('should handle wildcard routes', async () => {
      const handler = async (ctx: Context) => ctx.send({ wildcard: true });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/static/*',
        middlewares: [],
        handler,
      });

      const bunRoutes = adapter['buildBunRoutes']();

      expect(bunRoutes['/static/*']).toBeDefined();
    });
  });

  describe('Server Lifecycle', () => {
    it('should start server with Bun.serve()', async () => {
      const handler = async (ctx: Context) => ctx.send({ success: true });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        middlewares: [],
        handler,
      });

      adapter.setPort(0); // Use random available port
      const server = adapter.start();

      expect(server).toBeDefined();
      expect(adapter['server']).toBe(server);
      expect(server.port).toBeGreaterThan(0);

      await adapter.stop();
    });

    it('should build routes before starting server', async () => {
      const handler = async (ctx: Context) => ctx.send({ success: true });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        middlewares: [],
        handler,
      });

      expect(adapter['routesBuilt']).toBe(false);

      adapter.start();

      expect(adapter['routesBuilt']).toBe(true);

      await adapter.stop();
    });

    it('should not rebuild routes on second start', async () => {
      const handler = async (ctx: Context) => ctx.send({ success: true });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        middlewares: [],
        handler,
      });

      const buildSpy = mock(adapter['buildBunRoutes']);

      adapter['buildBunRoutes'] = buildSpy;

      adapter.start();
      expect(buildSpy).toHaveBeenCalledTimes(1);

      await adapter.stop();
    });

    it('should stop server cleanly', async () => {
      const handler = async (ctx: Context) => ctx.send({ success: true });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        middlewares: [],
        handler,
      });

      adapter.start();
      const port = adapter['server'].port;

      await adapter.stop();

      // Try to connect - should fail
      try {
        await fetch(`http://localhost:${port}/test`);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  describe('Context Injection', () => {
    it('should create CoreContextWrapper for each request', async () => {
      const handler = async (ctx: Context) => {
        expect(ctx).toBeDefined();
        expect(ctx.req).toBeDefined();
        return ctx.send({ success: true });
      };

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        middlewares: [],
        handler,
      });

      adapter.setPort(0); // Use random available port
      adapter.start();

      const response = await fetch(`http://localhost:${adapter['server'].port}/test`);

      expect(response.status).toBe(200);

      await adapter.stop();
    });

    it('should inject route params from Bun parser into context', async () => {
      const handler = async (ctx: Context) => {
        const id = ctx.getParam('id');

        return ctx.send({ userId: id });
      };

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/users/:id',
        middlewares: [],
        handler,
      });

      adapter.setPort(0); // Use random available port
      adapter.start();

      const response = await fetch(`http://localhost:${adapter['server'].port}/users/123`);
      const data = await response.json();

      expect(data.userId).toBe('123');

      await adapter.stop();
    });
  });

  describe('Error Handling', () => {
    it('should handle handler errors gracefully', async () => {
      const handler = async (_ctx: Context) => {
        throw new Error('Test error');
      };

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/error',
        middlewares: [],
        handler,
      });

      adapter.setPort(0); // Use random available port
      adapter.start();

      const response = await fetch(`http://localhost:${adapter['server'].port}/error`);

      // Should return 500 error
      expect(response.status).toBe(500);

      await adapter.stop();
    });

    it('should handle 404 for unregistered routes', async () => {
      adapter.start();

      const response = await fetch(`http://localhost:${adapter['server'].port}/notfound`);

      expect(response.status).toBe(404);

      await adapter.stop();
    });
  });
});
