import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Ergenecore } from '../lib';
import { ErgenecoreWebsocketAdapter } from '../lib';
import { RateLimiterMiddleware } from '../lib/defaults';
import type { ServerLogger } from '@asenajs/asena/logger';
import { HttpMethod } from '@asenajs/asena/web-types';
import { Container } from '@asenajs/asena/container';
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
      const response = await fetch(`${baseUrl}/test`);

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

      // First two requests should succeed
      const response1 = await fetch(`${baseUrl}/test`);

      expect(response1.status).toBe(200);

      const response2 = await fetch(`${baseUrl}/test`);

      expect(response2.status).toBe(200);

      // Third request should be rate limited
      const response3 = await fetch(`${baseUrl}/test`);

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

      // Exhaust tokens (2 requests)
      await fetch(`${baseUrl}/test`);
      await fetch(`${baseUrl}/test`);

      // Next request should fail
      const response1 = await fetch(`${baseUrl}/test`);

      expect(response1.status).toBe(429);

      // Wait 1 second (refill 5 tokens, capped at capacity 2)
      await sleep(1000);

      // Should succeed now (tokens refilled)
      const response2 = await fetch(`${baseUrl}/test`);

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

      // Wait 2 seconds (would refill 20 tokens, but capped at 5)
      await sleep(2000);

      // Make 5 requests (should all succeed)
      for (let i = 0; i < 5; i++) {
        const response = await fetch(`${baseUrl}/test`);

        expect(response.status).toBe(200);
      }

      // 6th request should fail (capacity was capped at 5)
      const response = await fetch(`${baseUrl}/test`);

      expect(response.status).toBe(429);

      rateLimiter.destroy();
    });
  });

  describe('Instance-based Storage', () => {
    it('should maintain separate buckets per middleware instance', async () => {
      const globalLimiter = new RateLimiterMiddleware({
        capacity: 10,
        refillRate: 1,
        trustProxy: true,
      });

      const strictLimiter = new RateLimiterMiddleware({
        capacity: 2,
        refillRate: 0.1,
        trustProxy: true,
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

    it('should track different forwarded clients independently behind a trusted proxy', async () => {
      const rateLimiter = new RateLimiterMiddleware({
        capacity: 2,
        refillRate: 0.1,
        trustProxy: true,
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
        // Trusted so the bucket key is the forwarded address this test can name
        trustProxy: true,
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
    it('should key on the connecting peer when no proxy is trusted', async () => {
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

  // Any client could set X-Forwarded-For or CF-Connecting-IP and get a fresh bucket per request,
  // which made the limiter a no-op against exactly the traffic it exists to stop. The peer
  // address is the one identifier the client cannot choose.
  describe('Client identity', () => {
    const registerLimited = (rateLimiter: RateLimiterMiddleware) => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/api/data',
        // @ts-ignore
        middlewares: [rateLimiter],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Success' });
        },
      });
    };

    const registerPeerProbe = () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/peer',
        middlewares: [],
        handler: async (ctx: Context) => {
          return ctx.send({ peer: ctx.getRequestIp() });
        },
      });
    };

    const statuses = async (headerSets: Record<string, string>[]): Promise<number[]> => {
      const collected: number[] = [];

      for (const headers of headerSets) {
        const response = await fetch(`${baseUrl}/api/data`, { headers });

        collected.push(response.status);
      }

      return collected;
    };

    it('should treat a varying X-Forwarded-For as one client', async () => {
      const rateLimiter = new RateLimiterMiddleware({ capacity: 2, refillRate: 0.1 });

      registerLimited(rateLimiter);

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const results = await statuses([
        { 'X-Forwarded-For': '1.1.1.1' },
        { 'X-Forwarded-For': '2.2.2.2' },
        { 'X-Forwarded-For': '3.3.3.3' },
      ]);

      expect(results).toEqual([200, 200, 429]);
      expect(rateLimiter.getBucketState('1.1.1.1')).toBeUndefined();
    });

    it('should ignore CF-Connecting-IP', async () => {
      const rateLimiter = new RateLimiterMiddleware({ capacity: 2, refillRate: 0.1 });

      registerLimited(rateLimiter);

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const results = await statuses([
        { 'CF-Connecting-IP': '8.8.8.8' },
        { 'CF-Connecting-IP': '8.8.4.4' },
        { 'CF-Connecting-IP': '1.0.0.1' },
      ]);

      expect(results).toEqual([200, 200, 429]);
      expect(rateLimiter.getBucketState('8.8.8.8')).toBeUndefined();
    });

    it('should key on the forwarded hop when the peer is a trusted proxy', async () => {
      const rateLimiter = new RateLimiterMiddleware({ capacity: 1, refillRate: 0.1, trustProxy: true });

      registerLimited(rateLimiter);

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const results = await statuses([
        { 'X-Forwarded-For': '1.1.1.1' },
        { 'X-Forwarded-For': '1.1.1.1' },
        { 'X-Forwarded-For': '2.2.2.2' },
      ]);

      expect(results).toEqual([200, 429, 200]);
      expect(rateLimiter.getBucketState('1.1.1.1')).toBeDefined();
    });

    it('should take the rightmost hop and ignore one the client forged on the left', async () => {
      const rateLimiter = new RateLimiterMiddleware({ capacity: 2, refillRate: 0.1, trustProxy: true });

      registerLimited(rateLimiter);

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const forged = ['4.4.4.4', '5.5.5.5', '6.6.6.6'];
      const results = await statuses(forged.map((hop) => ({ 'X-Forwarded-For': `${hop}, 9.9.9.9` })));

      expect(results).toEqual([200, 200, 429]);
      expect(rateLimiter.getBucketState('9.9.9.9')).toBeDefined();

      for (const hop of forged) {
        expect(rateLimiter.getBucketState(hop)).toBeUndefined();
      }
    });

    it('should ignore the header when the peer is not a listed proxy', async () => {
      const rateLimiter = new RateLimiterMiddleware({ capacity: 2, refillRate: 0.1, trustProxy: ['10.0.0.1'] });

      registerLimited(rateLimiter);

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const results = await statuses([
        { 'X-Forwarded-For': '1.1.1.1' },
        { 'X-Forwarded-For': '2.2.2.2' },
        { 'X-Forwarded-For': '3.3.3.3' },
      ]);

      expect(results).toEqual([200, 200, 429]);
      expect(rateLimiter.getBucketState('1.1.1.1')).toBeUndefined();
    });

    it('should walk past every trusted proxy and stop at the client hop', async () => {
      // The peer form varies by listener (`::1`, `::ffff:127.0.0.1`), so it is read back from the
      // server rather than hardcoded.
      let peer: string | null = null;

      const rateLimiter = new RateLimiterMiddleware({
        capacity: 2,
        refillRate: 0.1,
        trustProxy: (address) => address === '10.0.0.1' || address === peer,
      });

      registerLimited(rateLimiter);
      registerPeerProbe();

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      peer = ((await (await fetch(`${baseUrl}/peer`)).json()) as { peer: string | null }).peer;

      expect(peer).not.toBeNull();

      const results = await statuses(
        ['4.4.4.4', '5.5.5.6', '6.6.6.6'].map((forged) => ({
          'X-Forwarded-For': `${forged}, 5.5.5.5, 10.0.0.1`,
        })),
      );

      expect(results).toEqual([200, 200, 429]);
      expect(rateLimiter.getBucketState('5.5.5.5')).toBeDefined();
      expect(rateLimiter.getBucketState('10.0.0.1')).toBeUndefined();
    });

    // The limiter keeps the list by reference, so the peer read back after start() can join it
    const startWithTrustList = async (list: string[]) => {
      const rateLimiter = new RateLimiterMiddleware({ capacity: 2, refillRate: 0.1, trustProxy: list });

      registerLimited(rateLimiter);
      registerPeerProbe();

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const { peer } = (await (await fetch(`${baseUrl}/peer`)).json()) as { peer: string };

      return { rateLimiter, peer };
    };

    it('should match a plain IPv4 list entry against an IPv4-mapped hop and peer', async () => {
      const list = ['10.0.0.1'];
      const { rateLimiter, peer } = await startWithTrustList(list);

      list.push(peer.replace(/^::ffff:/i, ''));

      const results = await statuses(
        ['4.4.4.4', '5.5.5.6', '6.6.6.6'].map((forged) => ({
          'X-Forwarded-For': `${forged}, 5.5.5.5, ::ffff:10.0.0.1`,
        })),
      );

      expect(results).toEqual([200, 200, 429]);
      expect(rateLimiter.getBucketState('5.5.5.5')).toBeDefined();
    });

    it('should match an IPv4-mapped list entry against a plain IPv4 hop', async () => {
      // A proxy writes the hop it saw as plain IPv4 while the list follows Bun's dual-stack form
      const list = ['::ffff:10.0.0.1'];
      const { rateLimiter, peer } = await startWithTrustList(list);

      list.push(peer);

      const results = await statuses(
        ['4.4.4.4', '5.5.5.6', '6.6.6.6'].map((forged) => ({
          'X-Forwarded-For': `${forged}, 5.5.5.5, 10.0.0.1`,
        })),
      );

      expect(results).toEqual([200, 200, 429]);
      expect(rateLimiter.getBucketState('5.5.5.5')).toBeDefined();
      expect(rateLimiter.getBucketState('10.0.0.1')).toBeUndefined();
    });

    it('should fall back to the peer when the forwarded header is over-long', async () => {
      const rateLimiter = new RateLimiterMiddleware({ capacity: 2, refillRate: 0.1, trustProxy: true });

      registerLimited(rateLimiter);

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const longHeader = (seed: number) => `${seed}.0.0.1, ` + '9.9.9.9, '.repeat(130) + '8.8.8.8';

      expect(longHeader(1).length).toBeGreaterThan(1024);

      const results = await statuses([1, 2, 3].map((seed) => ({ 'X-Forwarded-For': longHeader(seed) })));

      expect(results).toEqual([200, 200, 429]);
      expect(rateLimiter.getBucketState('8.8.8.8')).toBeUndefined();
    });

    it('should see the peer from a route-level limiter with no global middlewares', async () => {
      const rateLimiter = new RateLimiterMiddleware({ capacity: 2, refillRate: 0.1 });

      registerLimited(rateLimiter);

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const results = await statuses([
        { 'X-Forwarded-For': '1.1.1.1' },
        { 'X-Forwarded-For': '2.2.2.2' },
        { 'X-Forwarded-For': '3.3.3.3' },
      ]);

      expect(results).toEqual([200, 200, 429]);
      // 'unknown' would mean the context never got the server and every client shares one bucket
      expect(rateLimiter.getBucketState('unknown')).toBeUndefined();
    });

    it('should evict the least recently seen client at maxBuckets and let it start over', async () => {
      const rateLimiter = new RateLimiterMiddleware({
        capacity: 1,
        refillRate: 0.1,
        maxBuckets: 2,
        keyGenerator: (ctx) => ctx.req.headers.get('x-client') || 'unknown',
      });

      registerLimited(rateLimiter);

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const results = await statuses([
        { 'x-client': 'c1' },
        { 'x-client': 'c1' },
        { 'x-client': 'c2' },
        { 'x-client': 'c3' },
      ]);

      // The cap trades strict enforcement for bounded memory: c1 was evicted, so its next request
      // starts with a full bucket instead of the 429 it had earned.
      expect(results).toEqual([200, 429, 200, 200]);
      expect(rateLimiter.getBucketState('c1')).toBeUndefined();
      expect(rateLimiter.getBucketState('c2')).toBeDefined();
      expect(rateLimiter.getBucketState('c3')).toBeDefined();

      const [readmitted] = await statuses([{ 'x-client': 'c1' }]);

      expect(readmitted).toBe(200);
      expect(rateLimiter.getBucketState('c2')).toBeUndefined();
    });

    it('should evict the idle client rather than the recently seen one', async () => {
      const rateLimiter = new RateLimiterMiddleware({
        capacity: 5,
        refillRate: 0.1,
        maxBuckets: 2,
        keyGenerator: (ctx) => ctx.req.headers.get('x-client') || 'unknown',
      });

      registerLimited(rateLimiter);

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      // c1 is touched again after c2, so insertion order alone (c1, c2) is not the eviction order
      await statuses([{ 'x-client': 'c1' }, { 'x-client': 'c2' }, { 'x-client': 'c1' }, { 'x-client': 'c3' }]);

      expect(rateLimiter.getBucketState('c2')).toBeUndefined();
      expect(rateLimiter.getBucketState('c1')).toBeDefined();
      expect(rateLimiter.getBucketState('c3')).toBeDefined();
    });
  });

  describe('Shutdown (@OnStop)', () => {
    it('should expose destroy() as an @OnStop hook the container can find', () => {
      // The metadata is what makes LifecycleService run destroy() during server.stop(). Reading
      // it through the real Container is the only assertion that proves the wiring, rather than
      // proving that a decorator was typed onto the class.
      expect(new Container().getStopHooks(RateLimiterMiddleware)).toContain('destroy');
    });

    it('should hand the hook down to subclasses', () => {
      // The documented way to use this middleware is to extend it, so a hook the subclass does
      // not inherit is a hook that never runs in a real application.
      class ApiRateLimiter extends RateLimiterMiddleware {}

      expect(new Container().getStopHooks(ApiRateLimiter)).toContain('destroy');
    });

    it('should stop the cleanup interval, not merely drop its buckets', async () => {
      const rateLimiter = new RateLimiterMiddleware({
        capacity: 10,
        refillRate: 10,
        cleanupInterval: 20,
        bucketTTL: 0, // Every bucket is stale the moment the sweep looks at it
        // Trusted so the bucket key is the forwarded address this test can name
        trustProxy: true,
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

      await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip } });

      // The sweep is running: the bucket the request created is gone
      await sleep(60);
      expect(rateLimiter.getBucketState(ip)).toBeUndefined();

      rateLimiter.destroy();

      // The timer is unref()'d, so nothing about the process exiting proves it stopped. A bucket
      // that survives a full cleanup period is what proves clearInterval actually ran - this is
      // the leak an in-process restart accumulates, one live interval per generation.
      await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': ip } });
      await sleep(60);

      expect(rateLimiter.getBucketState(ip)).toBeDefined();
    });

    it('should drop every bucket and stay callable a second time', async () => {
      const rateLimiter = new RateLimiterMiddleware({
        capacity: 10,
        refillRate: 10,
        cleanupInterval: 0,
        // Trusted so the bucket keys are the forwarded addresses this test can name
        trustProxy: true,
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

      await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': '1.2.3.4' } });
      await fetch(`${baseUrl}/test`, { headers: { 'X-Forwarded-For': '5.6.7.8' } });

      expect(rateLimiter.getBucketState('1.2.3.4')).toBeDefined();
      expect(rateLimiter.getBucketState('5.6.7.8')).toBeDefined();

      rateLimiter.destroy();

      // One Map entry per client that ever called, held for the lifetime of the process
      expect(rateLimiter.getBucketState('1.2.3.4')).toBeUndefined();
      expect(rateLimiter.getBucketState('5.6.7.8')).toBeUndefined();

      // A stop hook that throws is logged and skipped, so a second stop() must find nothing left
      // to do rather than fail on a handle that was already cleared.
      expect(() => rateLimiter.destroy()).not.toThrow();
    });
  });
});

describe('Rate Limiter Middleware — maxBuckets validation', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('should reject maxBuckets = %p', (maxBuckets) => {
    expect(() => new RateLimiterMiddleware({ maxBuckets, cleanupInterval: 0 })).toThrow(
      /maxBuckets must be a positive integer/,
    );
  });

  it('should accept maxBuckets = 1 and hold at most one bucket', async () => {
    const rateLimiter = new RateLimiterMiddleware({
      maxBuckets: 1,
      cleanupInterval: 0,
      keyGenerator: (ctx) => (ctx as any).client,
    });
    const context = (client: string) => ({ client, setResponseHeader: () => {} }) as any;

    await rateLimiter.handle(context('c1'), async () => {});
    await rateLimiter.handle(context('c2'), async () => {});

    expect(rateLimiter.getBucketState('c1')).toBeUndefined();
    expect(rateLimiter.getBucketState('c2')).toBeDefined();

    rateLimiter.destroy();
  });
});
