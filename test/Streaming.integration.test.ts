import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Ergenecore, ErgenecoreWebsocketAdapter } from '../lib';
import type { Context } from '../lib';
import type { ServerLogger } from '@asenajs/asena/logger';
import { HttpMethod } from '@asenajs/asena/web-types';
import type { Server } from 'bun';

const mockLogger: ServerLogger = {
  profile: mock(() => {}),
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
};

describe('Streaming Integration Tests', () => {
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

  describe('SSE Streaming', () => {
    it('should stream SSE events with correct headers', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/events',
        middlewares: [],
        handler: async (ctx: Context) => {
          return ctx.streamSSE(async (stream) => {
            await stream.writeSSE({ data: 'event1', event: 'update', id: '1' });
            await stream.writeSSE({ data: 'event2', event: 'update', id: '2' });
          });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/events`);

      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(response.headers.get('cache-control')).toBe('no-cache');

      const text = await response.text();

      expect(text).toContain('event: update');
      expect(text).toContain('data: event1');
      expect(text).toContain('id: 1');
      expect(text).toContain('data: event2');
      expect(text).toContain('id: 2');
    });

    it('should stream SSE events progressively', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/progressive',
        middlewares: [],
        handler: async (ctx: Context) => {
          return ctx.streamSSE(async (stream) => {
            for (let i = 0; i < 3; i++) {
              await stream.writeSSE({
                data: JSON.stringify({ count: i }),
                event: 'tick',
                id: String(i),
              });
            }
          });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/progressive`);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
      }

      const fullText = chunks.join('');

      expect(fullText).toContain('data: {"count":0}');
      expect(fullText).toContain('data: {"count":1}');
      expect(fullText).toContain('data: {"count":2}');
    });

    it('should handle SSE with multi-line data', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/multiline',
        middlewares: [],
        handler: async (ctx: Context) => {
          return ctx.streamSSE(async (stream) => {
            await stream.writeSSE({ data: 'line1\nline2\nline3' });
          });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/multiline`);
      const text = await response.text();

      expect(text).toContain('data: line1');
      expect(text).toContain('data: line2');
      expect(text).toContain('data: line3');
    });

    it('should stream comment-only keep-alive frames invisibly to EventSource', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/keepalive',
        middlewares: [],
        handler: async (ctx: Context) => {
          return ctx.streamSSE(async (stream) => {
            await stream.writeSSE({ comment: 'ping' });
            await stream.writeSSE({ data: 'payload', event: 'update' });
          });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/keepalive`);
      const text = await response.text();

      expect(text).toContain(': ping\n\n');
      expect(text).toContain('event: update');
      expect(text).toContain('data: payload');
    });
  });

  describe('Text Streaming', () => {
    it('should stream text with correct headers', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/logs',
        middlewares: [],
        handler: async (ctx: Context) => {
          return ctx.streamText(async (stream) => {
            await stream.writeln('Starting...');
            await stream.writeln('Processing...');
            await stream.writeln('Done.');
          });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/logs`);

      expect(response.headers.get('content-type')).toBe('text/plain');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');

      const text = await response.text();

      expect(text).toBe('Starting...\nProcessing...\nDone.\n');
    });
  });

  describe('Generic Streaming', () => {
    it('should stream binary data', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/binary',
        middlewares: [],
        handler: async (ctx: Context) => {
          return ctx.stream(async (stream) => {
            await stream.write(new Uint8Array([72, 101, 108, 108, 111])); // "Hello"
            await stream.write(new Uint8Array([32, 87, 111, 114, 108, 100])); // " World"
          });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/binary`);
      const text = await response.text();

      expect(text).toBe('Hello World');
    });

    it('should pipe a ReadableStream', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/pipe',
        middlewares: [],
        handler: async (ctx: Context) => {
          return ctx.stream(async (stream) => {
            const source = new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('piped content'));
                controller.close();
              },
            });

            await stream.pipe(source);
          });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/pipe`);
      const text = await response.text();

      expect(text).toBe('piped content');
    });
  });

  describe('Error Handling', () => {
    it('should invoke onError when stream callback throws', async () => {
      let errorHandled = false;

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/error-stream',
        middlewares: [],
        handler: async (ctx: Context) => {
          return ctx.streamSSE(
            async () => {
              throw new Error('intentional error');
            },
            async (error, stream) => {
              errorHandled = true;
              await stream.writeSSE({ data: error.message, event: 'error' });
            },
          );
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/error-stream`);
      const text = await response.text();

      expect(text).toContain('event: error');
      expect(text).toContain('data: intentional error');

      // Give async handler time to set flag
      await new Promise((r) => setTimeout(r, 10));
      expect(errorHandled).toBe(true);
    });
  });

  describe('Middleware Header Integration', () => {
    it('should include middleware-set headers in streaming response', async () => {
      const corsMiddleware = {
        handle: async (ctx: Context, next: () => Promise<void>) => {
          ctx.setResponseHeader!('Access-Control-Allow-Origin', '*');
          await next();
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/sse-cors',
        middlewares: [corsMiddleware as any],
        handler: async (ctx: Context) => {
          return ctx.streamSSE(async (stream) => {
            await stream.writeSSE({ data: 'test' });
          });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/sse-cors`);

      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('content-type')).toBe('text/event-stream');
    });
  });

  describe('onAbort', () => {
    it('should trigger onAbort when client disconnects', async () => {
      let abortTriggered = false;

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/abort-test',
        middlewares: [],
        handler: async (ctx: Context) => {
          return ctx.streamSSE(async (stream) => {
            stream.onAbort(() => {
              abortTriggered = true;
            });

            // Keep stream open until aborted
            await new Promise<void>((resolve) => {
              stream.onAbort(() => resolve());
              // Safety timeout
              setTimeout(resolve, 2000);
            });
          });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const controller = new AbortController();
      const fetchPromise = fetch(`${baseUrl}/abort-test`, {
        signal: controller.signal,
      });

      // Wait a bit then abort
      await new Promise((r) => setTimeout(r, 50));
      controller.abort();

      try {
        await fetchPromise;
      } catch {
        // AbortError expected
      }

      // Give server time to process abort
      await new Promise((r) => setTimeout(r, 100));

      expect(abortTriggered).toBe(true);
    });
  });
});
