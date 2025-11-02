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

    it('should block requests from non-whitelisted origins', async () => {
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
          return ctx.send({ message: 'Should not reach here' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`, {
        headers: {
          Origin: 'https://malicious.com',
        },
      });

      expect(response.status).toBe(403);
      expect(await response.text()).toBe('CORS: Origin not allowed');
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

      // Should block other domains
      const response3 = await fetch(`${baseUrl}/test`, {
        headers: {
          Origin: 'https://malicious.com',
        },
      });

      expect(response3.status).toBe(403);
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
});
