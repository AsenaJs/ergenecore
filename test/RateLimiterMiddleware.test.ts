import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Ergenecore } from '../lib';
import { ErgenecoreWebsocketAdapter } from '../lib';
import { RateLimiterMiddleware } from '../lib/defaults';
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

// Helper to wait for specified milliseconds
const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('Rate Limiter Middleware', () => {
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

  describe('Basic Token Bucket Behavior', () => {
    it('should allow requests when tokens are available', async () => {
      const rateLimiter = new RateLimiterMiddleware({
        capacity: 10,
        refillRate: 10, // 10 tokens per second
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [rateLimiter],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Success' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      // First request should succeed
      const response = await fetch(`${baseUrl}/test`, {
        headers: {
          'X-Forwarded-For': '1.2.3.4',
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('X-RateLimit-Limit')).toBe('600'); // 10 * 60 = 600 req/min
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('9'); // 10 - 1 = 9
    });

    it('should block requests when tokens are exhausted', async () => {
      const rateLimiter = new RateLimiterMiddleware({
        capacity: 2,
        refillRate: 0.1, // Very slow refill
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [rateLimiter],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Success' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const ip = '1.2.3.4';

      // First two requests should succeed
      const response1 = await fetch(`${baseUrl}/test`, {
        headers: { 'X-Forwarded-For': ip },
      });

      expect(response1.status).toBe(200);

      const response2 = await fetch(`${baseUrl}/test`, {
        headers: { 'X-Forwarded-For': ip },
      });

      expect(response2.status).toBe(200);

      // Third request should be rate limited
      const response3 = await fetch(`${baseUrl}/test`, {
        headers: { 'X-Forwarded-For': ip },
      });

      expect(response3.status).toBe(429);
      expect(await response3.text()).toBe('Rate limit exceeded. Please try again later.');
      expect(response3.headers.get('Retry-After')).toBeTruthy();
    });

    it('should refill tokens over time', async () => {
      const rateLimiter = new RateLimiterMiddleware({
        capacity: 2,
        refillRate: 5, // 5 tokens per second
        cleanupInterval: 0, // Disable cleanup for test
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [rateLimiter],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Success' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const ip = '1.2.3.4';

      // Exhaust tokens (2 requests)
      await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip } });
      await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip } });

      // Next request should fail
      const response1 = await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip } });

      expect(response1.status).toBe(429);

      // Wait 1 second (refill 5 tokens, capped at capacity 2)
      await sleep(1000);

      // Should succeed now (tokens refilled)
      const response2 = await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip } });

      expect(response2.status).toBe(200);

      rateLimiter.destroy(); // Cleanup
    });

    it('should not exceed capacity when refilling', async () => {
      const rateLimiter = new RateLimiterMiddleware({
        capacity: 5,
        refillRate: 10, // Fast refill
        cleanupInterval: 0,
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [rateLimiter],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Success' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const ip = '1.2.3.4';

      // Wait 2 seconds (would refill 20 tokens, but capped at 5)
      await sleep(2000);

      // Make 5 requests (should all succeed)
      for (let i = 0; i < 5; i++) {
        const response = await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip } });

        expect(response.status).toBe(200);
      }

      // 6th request should fail (capacity was capped at 5)
      const response = await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip } });

      expect(response.status).toBe(429);

      rateLimiter.destroy();
    });
  });

  describe('Instance-based Storage', () => {
    it('should maintain separate buckets per middleware instance', async () => {
      const globalLimiter = new RateLimiterMiddleware({
        capacity: 10,
        refillRate: 1,
      });

      const strictLimiter = new RateLimiterMiddleware({
        capacity: 2,
        refillRate: 0.1,
      });

      // Route 1: Global limiter
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/users',
        // @ts-ignore
        middlewares: [globalLimiter],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Users' });
        },
      });

      // Route 2: Strict limiter
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.POST,
        path: '/api/login',
        // @ts-ignore
        middlewares: [strictLimiter],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Login' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const ip = '1.2.3.4';

      // Exhaust strict limiter (2 requests to /login)
      await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'X-Forwarded-For': ip },
      });
      await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'X-Forwarded-For': ip },
      });

      // Next login request should be blocked
      const loginResponse = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'X-Forwarded-For': ip },
      });

      expect(loginResponse.status).toBe(429);

      // But /users should still work (different bucket)
      const usersResponse = await fetch(`${baseUrl}/api/users`, {
        headers: { 'X-Forwarded-For': ip },
      });

      expect(usersResponse.status).toBe(200);
    });

    it('should track different clients independently', async () => {
      const rateLimiter = new RateLimiterMiddleware({
        capacity: 2,
        refillRate: 0.1,
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [rateLimiter],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Success' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const ip1 = '1.1.1.1';
      const ip2 = '2.2.2.2';

      // Exhaust IP1's tokens
      await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip1 } });
      await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip1 } });

      // IP1 should be blocked
      const response1 = await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip1 } });

      expect(response1.status).toBe(429);

      // But IP2 should still work (different bucket)
      const response2 = await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip2 } });

      expect(response2.status).toBe(200);
    });
  });

  describe('Custom Configuration', () => {
    it('should use custom key generator', async () => {
      const rateLimiter = new RateLimiterMiddleware({
        capacity: 2,
        refillRate: 0.1,
        keyGenerator: (ctx) => ctx.req.headers.get('x-api-key') || 'anonymous',
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [rateLimiter],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Success' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const apiKey = 'my-api-key-123';

      // Exhaust tokens for this API key
      await fetch(`${baseUrl}/test`, { headers: { 'X-API-Key': apiKey } });
      await fetch(`${baseUrl}/test`, { headers: { 'X-API-Key': apiKey } });

      // Should be blocked
      const response1 = await fetch(`${baseUrl}/test`, { headers: { 'X-API-Key': apiKey } });

      expect(response1.status).toBe(429);

      // Different API key should work
      const response2 = await fetch(`${baseUrl}/test`, {
        headers: { 'X-API-Key': 'different-key' },
      });

      expect(response2.status).toBe(200);
    });

    it('should use custom message and status code', async () => {
      const rateLimiter = new RateLimiterMiddleware({
        capacity: 1,
        refillRate: 0.1,
        message: 'Çok fazla istek gönderdiniz!',
        statusCode: 503,
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [rateLimiter],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Success' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const ip = '1.2.3.4';

      // Exhaust tokens
      await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip } });

      // Should return custom message and status
      const response = await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip } });

      expect(response.status).toBe(503);
      expect(await response.text()).toBe('Çok fazla istek gönderdiniz!');
    });

    it('should skip rate limiting when skip function returns true', async () => {
      const rateLimiter = new RateLimiterMiddleware({
        capacity: 1,
        refillRate: 0.1,
        skip: (ctx) => ctx.req.url.includes('admin=true'),
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [rateLimiter],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Success' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const ip = '1.2.3.4';

      // Exhaust tokens
      await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip } });

      // Normal request should be blocked
      const response1 = await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip } });

      expect(response1.status).toBe(429);

      // Admin request should be allowed (skipped)
      const response2 = await fetch(`${baseUrl}/test?admin=true`, {
        headers: { 'X-Forwarded-For': ip },
      });

      expect(response2.status).toBe(200);
    });

    it('should support custom cost per request', async () => {
      const rateLimiter = new RateLimiterMiddleware({
        capacity: 10,
        refillRate: 1,
        cost: 5, // Each request costs 5 tokens
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [rateLimiter],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Success' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const ip = '1.2.3.4';

      // First request costs 5 tokens (10 - 5 = 5 remaining)
      const response1 = await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip } });

      expect(response1.status).toBe(200);
      expect(response1.headers.get('X-RateLimit-Remaining')).toBe('5');

      // Second request costs 5 tokens (5 - 5 = 0 remaining)
      const response2 = await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip } });

      expect(response2.status).toBe(200);
      expect(response2.headers.get('X-RateLimit-Remaining')).toBe('0');

      // Third request should fail (not enough tokens)
      const response3 = await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip } });

      expect(response3.status).toBe(429);
    });

    it('should support dynamic cost function', async () => {
      const rateLimiter = new RateLimiterMiddleware({
        capacity: 10,
        refillRate: 1,
        cost: (ctx) => (ctx.req.url.includes('expensive') ? 5 : 1),
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [rateLimiter],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Success' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const ip = '1.2.3.4';

      // Normal request costs 1 token
      const response1 = await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip } });

      expect(response1.status).toBe(200);
      expect(response1.headers.get('X-RateLimit-Remaining')).toBe('9');

      // Expensive request costs 5 tokens
      const response2 = await fetch(`${baseUrl}/test?expensive=true`, {
        headers: { 'X-Forwarded-For': ip },
      });

      expect(response2.status).toBe(200);
      expect(response2.headers.get('X-RateLimit-Remaining')).toBe('4');
    });
  });

  describe('Rate Limit Headers', () => {
    it('should set correct rate limit headers', async () => {
      const rateLimiter = new RateLimiterMiddleware({
        capacity: 10,
        refillRate: 5, // 5 tokens/s = 300 tokens/min
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [rateLimiter],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Success' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/test`, {
        headers: { 'X-Forwarded-For': '1.2.3.4' },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('X-RateLimit-Limit')).toBe('300'); // 5 * 60
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('9');
      expect(response.headers.get('X-RateLimit-Reset')).toBeTruthy();
    });

    it('should set Retry-After header when rate limited', async () => {
      const rateLimiter = new RateLimiterMiddleware({
        capacity: 1,
        refillRate: 1, // 1 token per second
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [rateLimiter],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Success' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const ip = '1.2.3.4';

      // Exhaust tokens
      await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip } });

      // Next request should be rate limited
      const response = await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip } });

      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('1'); // 1 second
    });
  });

  describe('Bucket Cleanup', () => {
    it('should cleanup inactive buckets', async () => {
      const rateLimiter = new RateLimiterMiddleware({
        capacity: 10,
        refillRate: 1,
        cleanupInterval: 100, // Cleanup every 100ms
        bucketTTL: 200, // Remove buckets after 200ms of inactivity
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [rateLimiter],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Success' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const ip = '1.2.3.4';

      // Make a request to create bucket
      await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip } });

      // Bucket should exist
      expect(rateLimiter.getBucketState(ip)).toBeDefined();

      // Wait for cleanup (200ms TTL + 100ms cleanup interval)
      await sleep(400);

      // Bucket should be removed
      expect(rateLimiter.getBucketState(ip)).toBeUndefined();

      rateLimiter.destroy(); // Cleanup timer
    });
  });

  describe('Edge Cases', () => {
    it('should handle requests without X-Forwarded-For header', async () => {
      const rateLimiter = new RateLimiterMiddleware({
        capacity: 2,
        refillRate: 0.1,
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [rateLimiter],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Success' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      // Requests without IP header (grouped as 'unknown')
      await fetch(`${baseUrl}/test`);
      await fetch(`${baseUrl}/test`);

      // Should be rate limited (same bucket)
      const response = await fetch(`${baseUrl}/test`);

      expect(response.status).toBe(429);
    });

    it('should handle concurrent requests correctly', async () => {
      const rateLimiter = new RateLimiterMiddleware({
        capacity: 5,
        refillRate: 1,
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        // @ts-ignore
        middlewares: [rateLimiter],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Success' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const ip = '1.2.3.4';

      // Fire 10 concurrent requests
      const promises = Array.from({ length: 10 }, () =>
        fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip } }),
      );

      const responses = await Promise.all(promises);

      // Should have exactly 5 successes (capacity) and 5 failures
      const successes = responses.filter((r) => r.status === 200).length;
      const failures = responses.filter((r) => r.status === 429).length;

      expect(successes).toBe(5);
      expect(failures).toBe(5);
    });
  });
});
