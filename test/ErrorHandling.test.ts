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

describe('Error Handling', () => {
  let adapter: Ergenecore;
  let wsAdapter: ErgenecoreWebsocketAdapter;

  beforeEach(() => {
    wsAdapter = new ErgenecoreWebsocketAdapter(mockLogger);
    adapter = new Ergenecore(mockLogger, wsAdapter);
    adapter.setPort(0); // Use random available port
  });

  afterEach(async () => {
    if (adapter['server']) {
      await adapter.stop();
    }
  });

  describe('Global Error Handler', () => {
    it('should register global error handler', () => {
      const errorHandler = mock((error: Error, _ctx: Context) => {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      adapter.onError(errorHandler);

      expect(adapter['errorHandler']).toBe(errorHandler);
    });

    it('should call global error handler when route handler throws', async () => {
      const errorMessage = 'Test error from handler';
      const errorHandler = mock((error: Error, _ctx: Context) => {
        return new Response(JSON.stringify({ customError: error.message }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      adapter.onError(errorHandler);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/error',
        middlewares: [],
        handler: async (_ctx: Context) => {
          throw new Error(errorMessage);
        },
      });

      adapter.start();

      const response = await fetch(`http://localhost:${adapter['server'].port}/error`);
      const data = await response.json();

      expect(response.status).toBe(503);
      expect(data.customError).toBe(errorMessage);
      expect(errorHandler).toHaveBeenCalled();

      // Check that error handler received correct arguments
      const calls = (errorHandler as any).mock.calls;

      expect(calls.length).toBe(1);
      expect(calls[0][0]).toBeInstanceOf(Error);
      expect(calls[0][0].message).toBe(errorMessage);
      expect(calls[0][1]).toBeDefined(); // Context should be passed
    });

    it('should provide request context to error handler', async () => {
      let receivedContext: Context | null = null;

      const errorHandler = (error: Error, ctx: Context) => {
        receivedContext = ctx;
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      adapter.onError(errorHandler);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test/:id',
        middlewares: [],
        handler: async (_ctx: Context) => {
          throw new Error('Test error');
        },
      });

      adapter.start();

      await fetch(`http://localhost:${adapter['server'].port}/test/123?foo=bar`);

      expect(receivedContext).not.toBeNull();
      expect(receivedContext!.req).toBeDefined();
      expect(receivedContext!.getParam('id')).toBe('123');
    });

    it('should return default 500 error when no custom handler registered', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/error',
        middlewares: [],
        handler: async (_ctx: Context) => {
          throw new Error('Unhandled error');
        },
      });

      adapter.start();

      const response = await fetch(`http://localhost:${adapter['server'].port}/error`);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe('Unhandled error');
    });

    it('should allow error handler to return custom status codes', async () => {
      const errorHandler = (_error: Error, _ctx: Context) => {
        return new Response(JSON.stringify({ error: 'Bad Request' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      adapter.onError(errorHandler);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.POST,
        path: '/submit',
        middlewares: [],
        handler: async (_ctx: Context) => {
          throw new Error('Invalid data');
        },
      });

      adapter.start();

      const response = await fetch(`http://localhost:${adapter['server'].port}/submit`, {
        method: 'POST',
      });

      expect(response.status).toBe(400);
    });

    it('should handle errors in middleware', async () => {
      const errorHandler = mock((error: Error, _ctx: Context) => {
        return new Response(JSON.stringify({ middlewareError: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      adapter.onError(errorHandler);

      const failingMiddleware = {
        handle: async (_ctx: Context, _next: () => Promise<void>) => {
          throw new Error('Middleware error');
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/middleware-error',
        // @ts-ignore
        middlewares: [failingMiddleware],
        handler: async (ctx: Context) => ctx.send({ success: true }),
      });

      adapter.start();

      const response = await fetch(`http://localhost:${adapter['server'].port}/middleware-error`);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.middlewareError).toBe('Middleware error');
      expect(errorHandler).toHaveBeenCalled();
    });

    it('should handle errors in global middleware', async () => {
      const errorHandler = mock((error: Error, _ctx: Context) => {
        return new Response(JSON.stringify({ globalMiddlewareError: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      adapter.onError(errorHandler);

      const failingGlobalMiddleware = {
        handle: async (_ctx: Context, _next: () => Promise<void>) => {
          throw new Error('Global middleware error');
        },
      };

      // @ts-ignore
      adapter.use(failingGlobalMiddleware);

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
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.globalMiddlewareError).toBe('Global middleware error');
      expect(errorHandler).toHaveBeenCalled();
    });

    it('should handle async errors in handler', async () => {
      const errorHandler = mock((error: Error, _ctx: Context) => {
        return new Response(JSON.stringify({ asyncError: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      adapter.onError(errorHandler);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/async-error',
        middlewares: [],
        handler: async (_ctx: Context) => {
          await new Promise((resolve) => {setTimeout(resolve, 10)});
          throw new Error('Async operation failed');
        },
      });

      adapter.start();

      const response = await fetch(`http://localhost:${adapter['server'].port}/async-error`);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.asyncError).toBe('Async operation failed');
      expect(errorHandler).toHaveBeenCalled();
    });

    it('should allow error handler to access request body', async () => {
      let receivedBody: any = null;

      const errorHandler = async (_error: Error, ctx: Context) => {
        try {
          receivedBody = await ctx.getBody();
        } catch (e) {
          // Body might have been consumed
        }

        return new Response(JSON.stringify({ error: 'Handled' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      adapter.onError(errorHandler);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.POST,
        path: '/error-with-body',
        middlewares: [],
        handler: async (_ctx: Context) => {
          throw new Error('Error after receiving body');
        },
      });

      adapter.start();

      await fetch(`http://localhost:${adapter['server'].port}/error-with-body`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: 'data' }),
      });

      // Body should be accessible due to caching in CoreContextWrapper
      expect(receivedBody).toEqual({ test: 'data' });
    });

    it('should handle non-Error objects thrown', async () => {
      const errorHandler = mock((error: Error, _ctx: Context) => {
        return new Response(JSON.stringify({ error: error.message || 'Unknown error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      adapter.onError(errorHandler);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/throw-string',
        middlewares: [],
        handler: async (_ctx: Context) => {
          throw 'String error'; // eslint-disable-line no-throw-literal
        },
      });

      adapter.start();

      const response = await fetch(`http://localhost:${adapter['server'].port}/throw-string`);

      expect(response.status).toBe(500);
      expect(errorHandler).toHaveBeenCalled();
    });
  });

  describe('Error Logging', () => {
    it('should log errors to logger when no custom handler', async () => {
      (mockLogger.error as any).mockClear();

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/error',
        middlewares: [],
        handler: async (_ctx: Context) => {
          throw new Error('Test error for logging');
        },
      });

      adapter.start();

      await fetch(`http://localhost:${adapter['server'].port}/error`);

      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should not log errors when custom handler handles them', async () => {
      (mockLogger.error as any).mockClear();

      const errorHandler = (_error: Error, _ctx: Context) => {
        return new Response(JSON.stringify({ handled: true }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      adapter.onError(errorHandler);

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/handled-error',
        middlewares: [],
        handler: async (_ctx: Context) => {
          throw new Error('Handled error');
        },
      });

      adapter.start();

      await fetch(`http://localhost:${adapter['server'].port}/handled-error`);

      // Custom handler should handle it, no logger.error call
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });
});
