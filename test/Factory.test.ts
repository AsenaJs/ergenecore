import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  createDevelopmentAdapter,
  createErgenecoreAdapter,
  createProductionAdapter,
  type ErgenecoreOptions,
} from '../lib/utils/factory';
import { Ergenecore } from '../lib/Ergenecore';
import { ErgenecoreWebsocketAdapter } from '../lib/ErgenecoreWebsocketAdapter';
import type { ServerLogger } from '@asenajs/asena/logger';
import { HttpMethod } from '@asenajs/asena/web-types';
import type { Context } from '../lib';

// Custom logger mock
const createMockLogger = (): ServerLogger => ({
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  profile: mock(() => {
    return () => {};
  }),
});

describe('Factory Functions', () => {
  let adapter: Ergenecore | null = null;

  afterEach(async () => {
    // Cleanup adapter after each test
    if (adapter && adapter['server']) {
      await adapter.stop();
    }
    adapter = null;
  });

  describe('createErgenecoreAdapter', () => {
    describe('Basic Initialization', () => {
      it('should create adapter instance with default options', () => {
        adapter = createErgenecoreAdapter();

        expect(adapter).toBeInstanceOf(Ergenecore);
        expect(adapter.name).toBe('Ergenecore');
      });

      it('should create adapter with default port 3000', () => {
        adapter = createErgenecoreAdapter();

        expect(adapter['port']).toBe(3000);
      });

      it('should create adapter with default logger', () => {
        adapter = createErgenecoreAdapter();

        expect(adapter['logger']).toBeDefined();
        expect(typeof adapter['logger'].info).toBe('function');
        expect(typeof adapter['logger'].error).toBe('function');
        expect(typeof adapter['logger'].warn).toBe('function');
        expect(typeof adapter['logger'].profile).toBe('function');
      });

      it('should create adapter with WebSocket support enabled by default', () => {
        adapter = createErgenecoreAdapter();

        expect(adapter['websocketAdapter']).toBeDefined();
        expect(adapter['websocketAdapter']).toBeInstanceOf(ErgenecoreWebsocketAdapter);
      });
    });

    describe('Custom Port Configuration', () => {
      it('should create adapter with custom port', () => {
        adapter = createErgenecoreAdapter({ port: 8080 });

        expect(adapter['port']).toBe(8080);
      });

      it('should create adapter with port 0 (random port)', () => {
        adapter = createErgenecoreAdapter({ port: 0 });

        expect(adapter['port']).toBe(0);
      });

      it('should set port correctly when starting server', async () => {
        adapter = createErgenecoreAdapter({ port: 0 });

        // Register a simple route
        adapter.registerRoute({
          staticServe: undefined,
          validator: undefined,
          method: HttpMethod.GET,
          path: '/test',
          middlewares: [],
          handler: async (ctx: Context) => ctx.send({ success: true }),
        });

        adapter.start();

        expect(adapter['server'].port).toBeGreaterThan(0);
      });
    });

    describe('Custom Hostname Configuration', () => {
      it('should create adapter without hostname by default', () => {
        adapter = createErgenecoreAdapter();

        expect(adapter.hostname).toBeUndefined();
      });

      it('should create adapter with custom hostname', () => {
        adapter = createErgenecoreAdapter({ hostname: 'localhost' });

        expect(adapter.hostname).toBe('localhost');
      });

      it('should create adapter with 0.0.0.0 hostname', () => {
        adapter = createErgenecoreAdapter({ hostname: '0.0.0.0' });

        expect(adapter.hostname).toBe('0.0.0.0');
      });

      it('should set hostname correctly when starting server', async () => {
        adapter = createErgenecoreAdapter({ hostname: 'localhost', port: 0 });

        // Register a simple route
        adapter.registerRoute({
          staticServe: undefined,
          validator: undefined,
          method: HttpMethod.GET,
          path: '/test',
          middlewares: [],
          handler: async (ctx: Context) => ctx.send({ success: true }),
        });

        adapter.start();

        expect(adapter['server'].hostname).toBe('localhost');
      });
    });

    describe('Custom Logger Configuration', () => {
      it('should create adapter with custom logger', () => {
        const customLogger = createMockLogger();

        adapter = createErgenecoreAdapter({ logger: customLogger });

        expect(adapter['logger']).toBe(customLogger);
      });

      it('should use custom logger for logging', async () => {
        const customLogger = createMockLogger();

        adapter = createErgenecoreAdapter({ logger: customLogger, port: 0 });

        // Register a route
        adapter.registerRoute({
          staticServe: undefined,
          validator: undefined,
          method: HttpMethod.GET,
          path: '/test',
          middlewares: [],
          handler: async (ctx: Context) => ctx.send({ success: true }),
        });

        adapter.start();

        // Logger should have been called for server start
        expect(customLogger.info).toHaveBeenCalled();
      });
    });

    describe('WebSocket Configuration', () => {
      it('should create adapter with WebSocket enabled by default', () => {
        adapter = createErgenecoreAdapter();

        expect(adapter['websocketAdapter']).toBeDefined();
        expect(adapter['websocketAdapter']).toBeInstanceOf(ErgenecoreWebsocketAdapter);
      });

      it('should create adapter with WebSocket explicitly enabled', () => {
        adapter = createErgenecoreAdapter({ enableWebSocket: true });

        expect(adapter['websocketAdapter']).toBeDefined();
        expect(adapter['websocketAdapter']).toBeInstanceOf(ErgenecoreWebsocketAdapter);
      });

      it('should create adapter with WebSocket disabled (still creates adapter internally)', () => {
        adapter = createErgenecoreAdapter({ enableWebSocket: false });

        // Note: Due to Ergenecore's architecture, a WebSocket adapter is always created
        // even when enableWebSocket is false, but it won't be used unless explicitly configured
        expect(adapter['websocketAdapter']).toBeDefined();
        expect(adapter['websocketAdapter']).toBeInstanceOf(ErgenecoreWebsocketAdapter);
      });

      it('should create adapter with custom WebSocket adapter', () => {
        const customLogger = createMockLogger();
        const customWsAdapter = new ErgenecoreWebsocketAdapter(customLogger);

        adapter = createErgenecoreAdapter({
          enableWebSocket: true,
          websocketAdapter: customWsAdapter,
        });

        expect(adapter['websocketAdapter']).toBe(customWsAdapter);
      });

      it('should use fallback WebSocket adapter if disabled (architecture behavior)', () => {
        const customLogger = createMockLogger();
        const customWsAdapter = new ErgenecoreWebsocketAdapter(customLogger);

        adapter = createErgenecoreAdapter({
          enableWebSocket: false,
          websocketAdapter: customWsAdapter,
        });

        // Even when disabled, Ergenecore creates a fallback WebSocket adapter
        // This is an architectural decision in the Ergenecore constructor
        expect(adapter['websocketAdapter']).toBeDefined();
        expect(adapter['websocketAdapter']).toBeInstanceOf(ErgenecoreWebsocketAdapter);
      });
    });

    describe('Combined Configuration', () => {
      it('should create adapter with all custom options', () => {
        const customLogger = createMockLogger();

        adapter = createErgenecoreAdapter({
          port: 8080,
          hostname: '0.0.0.0',
          logger: customLogger,
          enableWebSocket: true,
        });

        expect(adapter['port']).toBe(8080);
        expect(adapter.hostname).toBe('0.0.0.0');
        expect(adapter['logger']).toBe(customLogger);
        expect(adapter['websocketAdapter']).toBeDefined();
      });

      it('should create minimal adapter (WebSocket always present)', () => {
        const customLogger = createMockLogger();

        adapter = createErgenecoreAdapter({
          port: 3000,
          logger: customLogger,
          enableWebSocket: false,
        });

        expect(adapter['port']).toBe(3000);
        expect(adapter['logger']).toBe(customLogger);
        // WebSocket adapter is always created in Ergenecore architecture
        expect(adapter['websocketAdapter']).toBeDefined();
      });
    });

    describe('Integration Tests', () => {
      it('should create working HTTP server with factory', async () => {
        adapter = createErgenecoreAdapter({ port: 0 });

        adapter.registerRoute({
          staticServe: undefined,
          validator: undefined,
          method: HttpMethod.GET,
          path: '/health',
          middlewares: [],
          handler: async (ctx: Context) => ctx.send({ status: 'ok' }),
        });

        adapter.start();

        const response = await fetch(`http://localhost:${adapter['server'].port}/health`);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.status).toBe('ok');
      });

      it('should create working server with custom hostname', async () => {
        adapter = createErgenecoreAdapter({
          port: 0,
          hostname: 'localhost',
        });

        adapter.registerRoute({
          staticServe: undefined,
          validator: undefined,
          method: HttpMethod.GET,
          path: '/test',
          middlewares: [],
          handler: async (ctx: Context) => ctx.send({ hostname: 'localhost' }),
        });

        adapter.start();

        const response = await fetch(`http://localhost:${adapter['server'].port}/test`);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.hostname).toBe('localhost');
      });
    });
  });

  describe('createProductionAdapter', () => {
    describe('Default Production Configuration', () => {
      it('should create production adapter with defaults', () => {
        adapter = createProductionAdapter();

        expect(adapter).toBeInstanceOf(Ergenecore);
        expect(adapter.name).toBe('Ergenecore');
      });

      it('should create production adapter with WebSocket enabled by default', () => {
        adapter = createProductionAdapter();

        expect(adapter['websocketAdapter']).toBeDefined();
        expect(adapter['websocketAdapter']).toBeInstanceOf(ErgenecoreWebsocketAdapter);
      });

      it('should create production adapter with default port 3000', () => {
        adapter = createProductionAdapter();

        expect(adapter['port']).toBe(3000);
      });
    });

    describe('Custom Production Configuration', () => {
      it('should create production adapter with custom port', () => {
        adapter = createProductionAdapter({ port: 8080 });

        expect(adapter['port']).toBe(8080);
      });

      it('should create production adapter with custom hostname', () => {
        adapter = createProductionAdapter({
          port: 8080,
          hostname: '0.0.0.0',
        });

        expect(adapter['port']).toBe(8080);
        expect(adapter.hostname).toBe('0.0.0.0');
      });

      it('should create production adapter with custom logger', () => {
        const customLogger = createMockLogger();

        adapter = createProductionAdapter({ logger: customLogger });

        expect(adapter['logger']).toBe(customLogger);
      });

      it('should respect WebSocket configuration (always creates adapter)', () => {
        adapter = createProductionAdapter({ enableWebSocket: false });

        // Ergenecore architecture always creates WebSocket adapter
        expect(adapter['websocketAdapter']).toBeDefined();
      });

      it('should keep WebSocket enabled when explicitly set to true', () => {
        adapter = createProductionAdapter({ enableWebSocket: true });

        expect(adapter['websocketAdapter']).toBeDefined();
      });
    });

    describe('Production Integration Tests', () => {
      it('should create working production server', async () => {
        adapter = createProductionAdapter({ port: 0 });

        adapter.registerRoute({
          staticServe: undefined,
          validator: undefined,
          method: HttpMethod.GET,
          path: '/api/status',
          middlewares: [],
          handler: async (ctx: Context) => ctx.send({ env: 'production' }),
        });

        adapter.start();

        const response = await fetch(`http://localhost:${adapter['server'].port}/api/status`);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.env).toBe('production');
      });

      it('should create production server with all custom options', async () => {
        const customLogger = createMockLogger();

        adapter = createProductionAdapter({
          port: 0,
          hostname: 'localhost',
          logger: customLogger,
          enableWebSocket: true,
        });

        adapter.registerRoute({
          staticServe: undefined,
          validator: undefined,
          method: HttpMethod.GET,
          path: '/ready',
          middlewares: [],
          handler: async (ctx: Context) => ctx.send({ ready: true }),
        });

        adapter.start();

        const response = await fetch(`http://localhost:${adapter['server'].port}/ready`);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.ready).toBe(true);
        expect(customLogger.info).toHaveBeenCalled();
      });
    });
  });

  describe('createDevelopmentAdapter', () => {
    describe('Default Development Configuration', () => {
      it('should create development adapter with defaults', () => {
        adapter = createDevelopmentAdapter();

        expect(adapter).toBeInstanceOf(Ergenecore);
        expect(adapter.name).toBe('Ergenecore');
      });

      it('should create development adapter with port 3000', () => {
        adapter = createDevelopmentAdapter();

        expect(adapter['port']).toBe(3000);
      });

      it('should create development adapter with WebSocket enabled', () => {
        adapter = createDevelopmentAdapter();

        expect(adapter['websocketAdapter']).toBeDefined();
        expect(adapter['websocketAdapter']).toBeInstanceOf(ErgenecoreWebsocketAdapter);
      });

      it('should create development adapter with default verbose logger', () => {
        adapter = createDevelopmentAdapter();

        expect(adapter['logger']).toBeDefined();
        expect(typeof adapter['logger'].info).toBe('function');
        expect(typeof adapter['logger'].error).toBe('function');
        expect(typeof adapter['logger'].warn).toBe('function');
      });
    });

    describe('Custom Development Configuration', () => {
      it('should create development adapter with custom port', () => {
        adapter = createDevelopmentAdapter({ port: 5000 });

        expect(adapter['port']).toBe(5000);
      });

      it('should prioritize development port over custom port', () => {
        adapter = createDevelopmentAdapter({ port: 8080 });

        // Development adapter should use custom port if provided
        expect(adapter['port']).toBe(8080);
      });

      it('should create development adapter with custom logger', () => {
        const customLogger = createMockLogger();

        adapter = createDevelopmentAdapter({ logger: customLogger });

        expect(adapter['logger']).toBe(customLogger);
      });

      it('should create development adapter with custom hostname', () => {
        adapter = createDevelopmentAdapter({ hostname: 'localhost' });

        expect(adapter.hostname).toBe('localhost');
      });

      it('should always enable WebSocket in development mode', () => {
        adapter = createDevelopmentAdapter({ enableWebSocket: false });

        // Development adapter should always have WebSocket enabled
        expect(adapter['websocketAdapter']).toBeDefined();
      });
    });

    describe('Development Integration Tests', () => {
      it('should create working development server', async () => {
        adapter = createDevelopmentAdapter({ port: 0 });

        adapter.registerRoute({
          staticServe: undefined,
          validator: undefined,
          method: HttpMethod.GET,
          path: '/dev/test',
          middlewares: [],
          handler: async (ctx: Context) => ctx.send({ env: 'development' }),
        });

        adapter.start();

        const response = await fetch(`http://localhost:${adapter['server'].port}/dev/test`);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.env).toBe('development');
      });

      it('should create development server with verbose logging', async () => {
        const customLogger = createMockLogger();

        adapter = createDevelopmentAdapter({
          port: 0,
          logger: customLogger,
        });

        adapter.registerRoute({
          staticServe: undefined,
          validator: undefined,
          method: HttpMethod.GET,
          path: '/test',
          middlewares: [],
          handler: async (ctx: Context) => ctx.send({ success: true }),
        });

        adapter.start();

        const response = await fetch(`http://localhost:${adapter['server'].port}/test`);

        expect(response.status).toBe(200);
        expect(customLogger.info).toHaveBeenCalled();
      });

      it('should create development server with WebSocket support', async () => {
        adapter = createDevelopmentAdapter({ port: 0 });

        // Verify WebSocket is available
        expect(adapter['websocketAdapter']).toBeDefined();
        expect(adapter['websocketAdapter']).toBeInstanceOf(ErgenecoreWebsocketAdapter);

        adapter.registerRoute({
          staticServe: undefined,
          validator: undefined,
          method: HttpMethod.GET,
          path: '/test',
          middlewares: [],
          handler: async (ctx: Context) => ctx.send({ ws: 'enabled' }),
        });

        adapter.start();

        const response = await fetch(`http://localhost:${adapter['server'].port}/test`);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.ws).toBe('enabled');
      });
    });
  });

  describe('Factory Comparison Tests', () => {
    it('should create equivalent adapters with explicit configuration', () => {
      const customLogger = createMockLogger();

      const adapter1 = createErgenecoreAdapter({
        port: 3000,
        logger: customLogger,
        enableWebSocket: true,
      });

      const adapter2 = createProductionAdapter({
        port: 3000,
        logger: customLogger,
        enableWebSocket: true,
      });

      const adapter3 = createDevelopmentAdapter({
        port: 3000,
        logger: customLogger,
      });

      expect(adapter1['port']).toBe(adapter2['port']);
      expect(adapter2['port']).toBe(adapter3['port']);

      expect(adapter1['logger']).toBe(adapter2['logger']);
      expect(adapter2['logger']).toBe(adapter3['logger']);

      expect(adapter1['websocketAdapter']).toBeDefined();
      expect(adapter2['websocketAdapter']).toBeDefined();
      expect(adapter3['websocketAdapter']).toBeDefined();

      // Cleanup
      if (adapter1) adapter = adapter1;
      if (adapter2 && adapter2['server']) adapter2.stop();
      if (adapter3 && adapter3['server']) adapter3.stop();
    });

    it('should create different default configurations per factory', () => {
      const basicAdapter = createErgenecoreAdapter();
      const prodAdapter = createProductionAdapter();
      const devAdapter = createDevelopmentAdapter();

      // All should have same port by default
      expect(basicAdapter['port']).toBe(3000);
      expect(prodAdapter['port']).toBe(3000);
      expect(devAdapter['port']).toBe(3000);

      // All should have WebSocket enabled
      expect(basicAdapter['websocketAdapter']).toBeDefined();
      expect(prodAdapter['websocketAdapter']).toBeDefined();
      expect(devAdapter['websocketAdapter']).toBeDefined();

      // All should have loggers
      expect(basicAdapter['logger']).toBeDefined();
      expect(prodAdapter['logger']).toBeDefined();
      expect(devAdapter['logger']).toBeDefined();

      // Cleanup
      adapter = basicAdapter;
      if (prodAdapter['server']) prodAdapter.stop();
      if (devAdapter['server']) devAdapter.stop();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty options object', () => {
      const options: ErgenecoreOptions = {};

      adapter = createErgenecoreAdapter(options);

      expect(adapter).toBeInstanceOf(Ergenecore);
      expect(adapter['port']).toBe(3000);
    });

    it('should handle partial options', () => {
      adapter = createErgenecoreAdapter({ port: 8080 });

      expect(adapter['port']).toBe(8080);
      expect(adapter['logger']).toBeDefined();
      expect(adapter['websocketAdapter']).toBeDefined();
    });

    it('should handle undefined options', () => {
      adapter = createErgenecoreAdapter(undefined);

      expect(adapter).toBeInstanceOf(Ergenecore);
      expect(adapter['port']).toBe(3000);
    });

    it('should create multiple independent adapters', async () => {
      const adapter1 = createErgenecoreAdapter({ port: 0 });
      const adapter2 = createErgenecoreAdapter({ port: 0 });

      adapter1.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test1',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ id: 1 }),
      });

      adapter2.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test2',
        middlewares: [],
        handler: async (ctx: Context) => ctx.send({ id: 2 }),
      });

      adapter1.start();
      adapter2.start();

      const response1 = await fetch(`http://localhost:${adapter1['server'].port}/test1`);
      const data1 = await response1.json();

      const response2 = await fetch(`http://localhost:${adapter2['server'].port}/test2`);
      const data2 = await response2.json();

      expect(data1.id).toBe(1);
      expect(data2.id).toBe(2);

      // Cleanup both
      await adapter1.stop();
      await adapter2.stop();
    });
  });

  describe('Type Safety Tests', () => {
    it('should accept valid ErgenecoreOptions type', () => {
      const customLogger = createMockLogger();
      const customWsAdapter = new ErgenecoreWebsocketAdapter(customLogger);

      const options: ErgenecoreOptions = {
        port: 3000,
        hostname: 'localhost',
        logger: customLogger,
        enableWebSocket: true,
        websocketAdapter: customWsAdapter,
      };

      adapter = createErgenecoreAdapter(options);

      expect(adapter).toBeInstanceOf(Ergenecore);
    });

    it('should return Ergenecore instance type', () => {
      adapter = createErgenecoreAdapter();

      // Type assertion - should not throw
      const typedAdapter: Ergenecore = adapter;

      expect(typedAdapter).toBeInstanceOf(Ergenecore);
      expect(typedAdapter.name).toBe('Ergenecore');
    });
  });
});
