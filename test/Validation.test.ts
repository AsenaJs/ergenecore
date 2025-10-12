import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Ergenecore, ErgenecoreWebsocketAdapter } from '../lib';
import type { ServerLogger } from '@asenajs/asena/logger';
import type { BaseValidator } from '@asenajs/asena/adapter';
import { HttpMethod } from '@asenajs/asena/web-types';
import type { Context } from '../lib';
import type { Server } from 'bun';
import { z } from 'zod';
import type { ValidationSchemaWithHook } from '../lib';

// Mock logger
const mockLogger: ServerLogger = {
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  profile: mock(() => {}),
};

describe('Validation System', () => {
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

  describe('Body Validation', () => {
    it('should validate request body with Zod schema', async () => {
      const bodyValidator: BaseValidator<ValidationSchemaWithHook> = {
        json: {
          handle: () => ({
            schema: z.object({
              name: z.string().min(2),
              age: z.number().min(18),
            }),
          }),
          override: false,
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.POST,
        path: '/users',
        middlewares: [],
        validator: bodyValidator,
        handler: async (ctx: Context) => {
          const body = await ctx.getBody<{ name: string; age: number }>();

          return ctx.send({ created: true, user: body });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      // Valid request
      const response = await fetch(`${baseUrl}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'John Doe', age: 25 }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.created).toBe(true);
    });

    it('should reject invalid body data', async () => {
      const bodyValidator: BaseValidator<ValidationSchemaWithHook> = {
        json: {
          handle: async () => ({
            schema: z.object({
              email: z.string().email(),
              password: z.string().min(8),
            }),
            hook: (result, ctx) => {
              if (!result.success) {
                return ctx.send({ error: 'Validation failed', details: result.error }, 400);
              }
            },
          }),
          override: false,
        },
      };

      adapter.registerRoute({
        method: HttpMethod.POST,
        path: '/auth/register',
        middlewares: [],
        validator: bodyValidator,
        handler: async (ctx: Context) => {
          return ctx.send({ success: true });
        },
      } as any);

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      // Invalid email
      const response = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'invalid-email', password: 'short' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();

      expect(data.error).toBe('Validation failed');
      expect(data.details).toBeDefined();
    });
  });

  describe('Query Validation', () => {
    it('should validate query parameters', async () => {
      const queryValidator: BaseValidator<ValidationSchemaWithHook> = {
        query: {
          handle: async () => ({
            schema: z.object({
              page: z.string().transform(Number).pipe(z.number().min(1)),
              limit: z.string().transform(Number).pipe(z.number().min(1).max(100)),
            }),
          }),
          override: false,
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.GET,
        path: '/posts',
        middlewares: [],
        validator: queryValidator,
        handler: async (ctx: Context) => {
          const page = await ctx.getQuery('page');
          const limit = await ctx.getQuery('limit');

          return ctx.send({ page: Number(page), limit: Number(limit) });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/posts?page=2&limit=20`);

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.page).toBe(2);
      expect(data.limit).toBe(20);
    });

    it('should reject invalid query parameters', async () => {
      const queryValidator: BaseValidator<ValidationSchemaWithHook> = {
        query: {
          handle: async () => ({
            schema: z.object({
              search: z.string().min(3),
            }),
            hook: (result, ctx) => {
              if (!result.success) {
                return ctx.send({ error: 'Query validation failed' }, 400);
              }
            },
          }),
          override: false,
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.GET,
        path: '/search',
        middlewares: [],
        validator: queryValidator,
        handler: async (ctx: Context) => {
          return ctx.send({ results: [] });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      // Query too short
      const response = await fetch(`${baseUrl}/search?search=ab`);

      expect(response.status).toBe(400);
      const data = await response.json();

      expect(data.error).toBe('Query validation failed');
    });
  });

  describe('Param Validation', () => {
    it('should validate path parameters', async () => {
      const paramValidator: BaseValidator<ValidationSchemaWithHook> = {
        param: {
          handle: async () => ({
            schema: z.object({
              id: z.string().uuid(),
            }),
          }),
          override: false,
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.GET,
        path: '/items/:id',
        middlewares: [],
        validator: paramValidator,
        handler: async (ctx: Context) => {
          const id = ctx.getParam('id');

          return ctx.send({ itemId: id });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const validUuid = '123e4567-e89b-12d3-a456-426614174000';
      const response = await fetch(`${baseUrl}/items/${validUuid}`);

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.itemId).toBe(validUuid);
    });

    it('should reject invalid path parameters', async () => {
      const paramValidator: BaseValidator<ValidationSchemaWithHook> = {
        param: {
          handle: async () => ({
            schema: z.object({
              id: z.string().regex(/^\d+$/).transform(Number),
            }),
            hook: (result, ctx) => {
              if (!result.success) {
                return ctx.send({ error: 'Invalid ID format' }, 400);
              }
            },
          }),
          override: false,
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.GET,
        path: '/products/:id',
        middlewares: [],
        validator: paramValidator,
        handler: async (ctx: Context) => {
          return ctx.send({ product: {} });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      // Invalid ID (not numeric)
      const response = await fetch(`${baseUrl}/products/abc`);

      expect(response.status).toBe(400);
      const data = await response.json();

      expect(data.error).toBe('Invalid ID format');
    });
  });

  describe('Header Validation', () => {
    it('should validate request headers', async () => {
      const headerValidator: BaseValidator<ValidationSchemaWithHook> = {
        header: {
          handle: async () => ({
            schema: z.object({
              'x-api-key': z.string().min(10),
              'x-client-version': z.string().regex(/^\d+\.\d+\.\d+$/),
            }),
          }),
          override: false,
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.GET,
        path: '/api/data',
        middlewares: [],
        validator: headerValidator,
        handler: async (ctx: Context) => {
          return ctx.send({ data: 'secured data' });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/api/data`, {
        headers: {
          'x-api-key': 'secret-api-key-12345',
          'x-client-version': '1.2.3',
        },
      });

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.data).toBe('secured data');
    });

    it('should reject invalid headers', async () => {
      const headerValidator: BaseValidator<ValidationSchemaWithHook> = {
        header: {
          handle: async () => ({
            schema: z.object({
              authorization: z.string().startsWith('Bearer '),
            }),
            hook: (result, ctx) => {
              if (!result.success) {
                return ctx.send({ error: 'Unauthorized' }, 401);
              }
            },
          }),
          override: false,
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.GET,
        path: '/protected',
        middlewares: [],
        validator: headerValidator,
        handler: async (ctx: Context) => {
          return ctx.send({ protected: true });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      // Missing Bearer prefix
      const response = await fetch(`${baseUrl}/protected`, {
        headers: {
          authorization: 'token123',
        },
      });

      expect(response.status).toBe(401);
      const data = await response.json();

      expect(data.error).toBe('Unauthorized');
    });
  });

  describe('Multiple Validators', () => {
    it('should validate multiple targets (body + query)', async () => {
      const multiValidator: BaseValidator<ValidationSchemaWithHook> = {
        json: {
          handle: async () => ({
            schema: z.object({
              content: z.string().min(1),
            }),
          }),
          override: false,
        },
        query: {
          handle: async () => ({
            schema: z.object({
              publish: z.enum(['true', 'false']),
            }),
          }),
          override: false,
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.POST,
        path: '/articles',
        middlewares: [],
        validator: multiValidator,
        handler: async (ctx: Context) => {
          const body = await ctx.getBody<{ content: string }>();
          const publish = await ctx.getQuery('publish');

          return ctx.send({ article: body, willPublish: publish === 'true' });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/articles?publish=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Article content' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.article.content).toBe('Article content');
      expect(data.willPublish).toBe(true);
    });

    it('should validate param + header', async () => {
      const multiValidator: BaseValidator<ValidationSchemaWithHook> = {
        param: {
          handle: async () => ({
            schema: z.object({
              userId: z.string().min(1),
            }),
          }),
          override: false,
        },
        header: {
          handle: async () => ({
            schema: z.object({
              'content-type': z.literal('application/json'),
            }),
            hook: (result, ctx) => {
              if (!result.success) {
                return ctx.send({ error: 'Content-Type must be application/json' }, 415);
              }
            },
          }),
          override: false,
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.GET,
        path: '/users/:userId/profile',
        middlewares: [],
        validator: multiValidator,
        handler: async (ctx: Context) => {
          const userId = ctx.getParam('userId');

          return ctx.send({ userId, profile: {} });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/users/123/profile`, {
        headers: {
          'content-type': 'application/json',
        },
      });

      expect(response.status).toBe(200);
    });
  });

  describe('Custom Validation Hooks', () => {
    it('should use custom hook for error handling', async () => {
      const validator: BaseValidator<ValidationSchemaWithHook> = {
        json: {
          handle: async () => ({
            schema: z.object({
              age: z.number().min(18).max(120),
            }),
            hook: (result, ctx) => {
              if (!result.success) {
                const errors = result.error.errors.map((err: any) => ({
                  field: err.path.join('.'),
                  message: err.message,
                }));

                return ctx.send({ validationErrors: errors }, 422);
              }
            },
          }),
          override: false,
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.POST,
        path: '/verify-age',
        middlewares: [],
        validator: validator,
        handler: async (ctx: Context) => {
          return ctx.send({ verified: true });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/verify-age`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ age: 15 }),
      });

      expect(response.status).toBe(422);
      const data = await response.json();

      expect(data.validationErrors).toBeDefined();
      expect(Array.isArray(data.validationErrors)).toBe(true);
    });
  });

  describe('Validation without Hook', () => {
    it('should use default error response when hook not provided', async () => {
      const validator: BaseValidator<ValidationSchemaWithHook> = {
        json: {
          handle: () => ({
            schema: z.object({
              name: z.string().min(2),
              age: z.number().min(18),
            }),
          }),
          override: false,
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.POST,
        path: '/signup',
        middlewares: [],
        validator: validator,
        handler: async (ctx: Context) => {
          return ctx.send({ success: true });
        },
      });

      server = adapter.start();
      baseUrl = `http://localhost:${server.port}`;
      console.log('registered');

      const response = await fetch(`${baseUrl}/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'ab' }),
      });

      // Should return 400 with default error message
      expect(response.status).toBe(400);
      const data = await response.json();

      expect(data.error).toBeDefined();
    });
  });
});
