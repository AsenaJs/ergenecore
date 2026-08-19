import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Ergenecore, ErgenecoreWebsocketAdapter, HttpException, ValidationError } from '../lib';
import type { ServerLogger } from '@asenajs/asena/logger';
import { type BaseValidator, isValidationError } from '@asenajs/asena/adapter';
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

      server = await adapter.start();
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

      server = await adapter.start();
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

      server = await adapter.start();
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

      server = await adapter.start();
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

      server = await adapter.start();
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

      server = await adapter.start();
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

      server = await adapter.start();
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

      server = await adapter.start();
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

      server = await adapter.start();
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

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/users/123/profile`, {
        headers: {
          'content-type': 'application/json',
        },
      });

      expect(response.status).toBe(200);
    });
  });

  describe('Form Validation', () => {
    it('should validate multipart form data with file field', async () => {
      // Before the `form` case existed in extractValidationData, every form() validator
      // validated `{}` - a required z.file() field rejected every request with 400
      const validator: BaseValidator<ValidationSchemaWithHook> = {
        form: {
          handle: () => ({
            schema: z.object({
              image: z.file(),
              title: z.string(),
            }),
          }),
          override: false,
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.POST,
        path: '/upload',
        middlewares: [],
        validator: validator,
        handler: async (ctx: Context) => ctx.send({ uploaded: true }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const formData = new FormData();

      formData.append('image', new File(['x'], 'a.png', { type: 'image/png' }));
      formData.append('title', 'My image');

      const response = await fetch(`${baseUrl}/upload`, { method: 'POST', body: formData });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ uploaded: true });
    });

    it('should reject a missing required form field with target form', async () => {
      const validator: BaseValidator<ValidationSchemaWithHook> = {
        form: {
          handle: () => ({ schema: z.object({ name: z.string().min(1) }) }),
          override: false,
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.POST,
        path: '/form-required',
        middlewares: [],
        validator: validator,
        handler: async (ctx: Context) => ctx.send({ ok: true }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const missing = new FormData();

      missing.append('other', 'value');

      const response = await fetch(`${baseUrl}/form-required`, { method: 'POST', body: missing });

      expect(response.status).toBe(400);

      const data = await response.json();

      expect(data.error).toBe('Validation failed');
      expect(data.target).toBe('form');

      // hono parity: non-form content-type validates `{}`, so the required field still
      // fails instead of the JSON body being fed into the form schema
      const jsonResponse = await fetch(`${baseUrl}/form-required`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'John' }),
      });

      expect(jsonResponse.status).toBe(400);
    });

    it('should let the handler re-read form data after validation', async () => {
      const validator: BaseValidator<ValidationSchemaWithHook> = {
        form: {
          handle: () => ({ schema: z.object({ title: z.string() }) }),
          override: false,
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.POST,
        path: '/form-reread',
        middlewares: [],
        validator: validator,
        handler: async (ctx: Context) => {
          // The validator already consumed the body; without the FormData cache this
          // second read of the single-shot stream throws
          const formData = await ctx.getFormData();

          return ctx.send({ title: formData.get('title') });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const formData = new FormData();

      formData.append('title', 'cached');

      const response = await fetch(`${baseUrl}/form-reread`, { method: 'POST', body: formData });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ title: 'cached' });
    });

    it('should collapse repeated form keys into an array', async () => {
      const validator: BaseValidator<ValidationSchemaWithHook> = {
        form: {
          handle: () => ({ schema: z.object({ tags: z.array(z.string()), name: z.string() }) }),
          override: false,
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.POST,
        path: '/form-repeat',
        middlewares: [],
        validator: validator,
        handler: async (ctx: Context) => ctx.send({ ok: true }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const formData = new FormData();

      formData.append('tags', 'a');
      formData.append('tags', 'b');
      formData.append('name', 'John');

      const response = await fetch(`${baseUrl}/form-repeat`, { method: 'POST', body: formData });

      expect(response.status).toBe(200);
    });

    it('should validate a form request a middleware already read the body of', async () => {
      // Middlewares run before validation, so a middleware touching the raw body used to consume
      // the single-shot stream and leave the form validator parsing nothing.
      const validator: BaseValidator<ValidationSchemaWithHook> = {
        form: {
          handle: () => ({ schema: z.object({ name: z.string() }) }),
          override: false,
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.POST,
        path: '/form-after-middleware',
        middlewares: [
          {
            handle: async (ctx: Context, next: () => Promise<void>) => {
              await ctx.getArrayBuffer();

              return next();
            },
          } as any,
        ],
        validator: validator,
        handler: async (ctx: Context) => ctx.send({ ok: true }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const formData = new FormData();

      formData.append('name', 'John');

      const response = await fetch(`${baseUrl}/form-after-middleware`, { method: 'POST', body: formData });

      expect(response.status).toBe(200);
    });

    it('should let the handler read the raw body after form validation', async () => {
      const validator: BaseValidator<ValidationSchemaWithHook> = {
        form: {
          handle: () => ({ schema: z.object({ name: z.string() }) }),
          override: false,
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.POST,
        path: '/form-raw-reread',
        middlewares: [],
        validator: validator,
        handler: async (ctx: Context) => {
          const buffer = await ctx.getArrayBuffer();

          return ctx.send({ bytes: buffer.byteLength });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const formData = new FormData();

      formData.append('name', 'John');

      const response = await fetch(`${baseUrl}/form-raw-reread`, { method: 'POST', body: formData });

      expect(response.status).toBe(200);
      expect((await response.json()).bytes).toBeGreaterThan(0);
    });

    it('should answer a malformed multipart body with 400', async () => {
      const validator: BaseValidator<ValidationSchemaWithHook> = {
        form: {
          handle: () => ({ schema: z.object({ name: z.string() }) }),
          override: false,
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.POST,
        path: '/form-malformed',
        middlewares: [],
        validator: validator,
        handler: async (ctx: Context) => ctx.send({ ok: true }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/form-malformed`, {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=x' },
        body: 'not a multipart payload',
      });

      expect(response.status).toBe(400);
    });

    it('should keep the file shape a repeated key produces', async () => {
      // Hono parity, and the reason a schema cannot be written without knowing it: one file under
      // a plain key stays a File, a second occurrence widens it to File[], and a `key[]` name is
      // always an array - under the literal bracketed key.
      const validator: BaseValidator<ValidationSchemaWithHook> = {
        form: {
          handle: () => ({
            schema: z.object({
              single: z.file(),
              pair: z.array(z.file()).length(2),
              'bracketed[]': z.array(z.file()).length(1),
            }),
          }),
          override: false,
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.POST,
        path: '/form-files',
        middlewares: [],
        validator: validator,
        handler: async (ctx: Context) => ctx.send({ ok: true }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const formData = new FormData();

      formData.append('single', new File(['a'], 'a.png', { type: 'image/png' }));
      formData.append('pair', new File(['b'], 'b.png', { type: 'image/png' }));
      formData.append('pair', new File(['c'], 'c.png', { type: 'image/png' }));
      formData.append('bracketed[]', new File(['d'], 'd.png', { type: 'image/png' }));

      const response = await fetch(`${baseUrl}/form-files`, { method: 'POST', body: formData });

      expect(response.status).toBe(200);
    });

    it('should validate urlencoded form data', async () => {
      const validator: BaseValidator<ValidationSchemaWithHook> = {
        form: {
          handle: () => ({ schema: z.object({ name: z.string(), age: z.coerce.number() }) }),
          override: false,
        },
      };

      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.POST,
        path: '/form-urlencoded',
        middlewares: [],
        validator: validator,
        handler: async (ctx: Context) => ctx.send({ ok: true }),
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/form-urlencoded`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'name=John&age=25',
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
                const errors = result.error.issues.map((err: any) => ({
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

      server = await adapter.start();
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

      server = await adapter.start();
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

  describe('Plain Zod Schema Validation (No Hook Format)', () => {
    it('should accept plain Zod schema for body validation', async () => {
      const validator: BaseValidator<any> = {
        json: {
          handle: () =>
            z.object({
              username: z.string().min(3),
              email: z.string().email(),
            }),
          override: false,
        },
      };

      adapter.registerRoute({
        method: HttpMethod.POST,
        path: '/register-plain',
        middlewares: [],
        validator: validator,
        handler: async (ctx: Context) => {
          const body = await ctx.getBody<{ username: string; email: string }>();

          return ctx.send({ registered: true, user: body });
        },
      } as any);

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      // Valid request
      const response = await fetch(`${baseUrl}/register-plain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'john', email: 'john@example.com' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.registered).toBe(true);
      expect(data.user.username).toBe('john');
    });

    it('should reject invalid data with plain Zod schema', async () => {
      const validator: BaseValidator<any> = {
        json: {
          handle: async () =>
            z.object({
              age: z.number().min(18),
              country: z.string().length(2),
            }),
          override: false,
        },
      };

      adapter.registerRoute({
        method: HttpMethod.POST,
        path: '/verify-plain',
        middlewares: [],
        validator: validator,
        handler: async (ctx: Context) => {
          return ctx.send({ verified: true });
        },
      } as any);

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      // Invalid data (age < 18, country not 2 chars)
      const response = await fetch(`${baseUrl}/verify-plain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ age: 16, country: 'USA' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();

      expect(data.error).toBe('Validation failed');
      expect(data.details).toBeDefined();
    });

    it('should support plain Zod schema for query validation', async () => {
      const validator: BaseValidator<any> = {
        query: {
          handle: () =>
            z.object({
              sort: z.enum(['asc', 'desc']),
              limit: z.string().regex(/^\d+$/),
            }),
          override: false,
        },
      };

      adapter.registerRoute({
        method: HttpMethod.GET,
        path: '/items-plain',
        middlewares: [],
        validator: validator,
        handler: async (ctx: Context) => {
          const sort = await ctx.getQuery('sort');
          const limit = await ctx.getQuery('limit');

          return ctx.send({ sort, limit });
        },
      } as any);

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/items-plain?sort=asc&limit=10`);

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.sort).toBe('asc');
      expect(data.limit).toBe('10');
    });

    it('should work with mixed formats (plain schema + hook schema)', async () => {
      const validator: BaseValidator<any> = {
        json: {
          // Plain Zod schema
          handle: () =>
            z.object({
              title: z.string().min(5),
            }),
          override: false,
        },
        query: {
          // Hook format
          handle: () => ({
            schema: z.object({
              draft: z.enum(['true', 'false']),
            }),
            hook: (result: any, ctx: Context) => {
              if (!result.success) {
                return ctx.send({ error: 'Invalid query params' }, 422);
              }
            },
          }),
          override: false,
        },
      };

      adapter.registerRoute({
        method: HttpMethod.POST,
        path: '/create-post-mixed',
        middlewares: [],
        validator: validator,
        handler: async (ctx: Context) => {
          const body = await ctx.getBody<{ title: string }>();
          const draft = await ctx.getQuery('draft');

          return ctx.send({ post: body, isDraft: draft === 'true' });
        },
      } as any);

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      // Valid request
      const response = await fetch(`${baseUrl}/create-post-mixed?draft=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'My Blog Post' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.post.title).toBe('My Blog Post');
      expect(data.isDraft).toBe(true);
    });
  });

  describe('Validation errors and the global error handler', () => {
    const emailValidator: BaseValidator<ValidationSchemaWithHook> = {
      json: {
        handle: () => ({ schema: z.object({ email: z.string().min(3) }) }),
        override: false,
      },
    };

    const postInvalid = async () =>
      fetch(`${baseUrl}/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'x' }),
      });

    const registerSignup = () => {
      adapter.registerRoute({
        staticServe: undefined,
        method: HttpMethod.POST,
        path: '/signup',
        middlewares: [],
        validator: emailValidator,
        handler: async (ctx: Context) => ctx.send({ ok: true }),
      });
    };

    it('should route validation failures to the error handler as a ValidationError', async () => {
      let seen: Error | undefined;

      adapter.onError((error, ctx) => {
        seen = error;

        if (isValidationError(error)) {
          return ctx.send({ success: false, errors: error.issues }, 400);
        }

        return ctx.send({ success: false }, 500);
      });

      registerSignup();

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await postInvalid();

      expect(response.status).toBe(400);

      const data = await response.json();

      expect(data.success).toBe(false);
      expect(data.errors[0].path).toEqual(['email']);

      // Subclassing HttpException is what keeps an existing `instanceof HttpException`
      // branch answering 400 instead of 500
      expect(seen).toBeInstanceOf(ValidationError);
      expect(seen).toBeInstanceOf(HttpException);
      expect((seen as ValidationError).status).toBe(400);
      expect((seen as ValidationError).target).toBe('json');
    });

    it('should keep the default envelope when no error handler is configured', async () => {
      registerSignup();

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await postInvalid();

      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');

      const data = await response.json();

      expect(data.error).toBe('Validation failed');
      expect(data.details.fieldErrors.email).toBeDefined();
      // Matches what the hono adapter has always reported, so the same client can read either
      expect(data.target).toBe('json');
    });

    it('should log the failure when no error handler is configured', async () => {
      (mockLogger.info as any).mockClear();

      registerSignup();

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      await postInvalid();

      // The adapter used to answer this 400 from inside the validator, so it reached neither
      // `onError` nor the log - the one 4xx an application could not see at any level. It now
      // travels the same path as every other error. (`mockLogger` has no `debug`, so the 4xx
      // level falls back to `info`; assert on the message, not the method.)
      const logged = (mockLogger.info as any).mock.calls.find((call: unknown[]) =>
        String(call[0]).includes('Request rejected'),
      );

      expect(logged).toBeDefined();
      expect(logged[1].status).toBe(400);
      expect(logged[1].path).toBe('/signup');
    });

    it('should answer the same envelope when the error handler declines', async () => {
      // Before the envelope moved onto `ValidationError.getResponse()`, this fell back to
      // `HttpException`'s bare `Validation failed` text - so the body depended on whether an
      // unrelated hook existed, which is exactly what the single path removed.
      adapter.onError((() => undefined) as any);

      registerSignup();

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await postInvalid();

      expect(response.status).toBe(400);

      const data = await response.json();

      expect(data.error).toBe('Validation failed');
      expect(data.details.fieldErrors.email).toBeDefined();
      expect(data.target).toBe('json');
    });

    // The regression the changeset names but nothing covered: of the five catch sites, only the
    // one behind `createRouteHandler` carried the `!isValidationError` exemption. Every test
    // above registers a `validator`, which makes `isSimpleRoute` false and routes through that
    // one - so a ValidationError thrown on the *fast* path (no validator, no middlewares, no
    // static serve) never reached `onError` and no test could see it.
    it('should route a ValidationError thrown on the fast path to the error handler', async () => {
      let seen: Error | undefined;

      adapter.onError((error, ctx) => {
        seen = error;

        if (isValidationError(error)) {
          return ctx.send({ success: false, target: error.target }, 400);
        }

        return ctx.send({ success: false }, 500);
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.POST,
        path: '/fast-path-signup',
        // Empty on purpose: this is what puts the route on the fast path.
        middlewares: [],
        handler: async () => {
          throw new ValidationError(
            z.object({ email: z.string().email() }).safeParse({ email: 'nope' }).error!,
            'json',
          );
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/fast-path-signup`, { method: 'POST' });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ success: false, target: 'json' });
      expect(seen).toBeInstanceOf(ValidationError);
    });

    // The other half of the same change: the app handler now gets first refusal on an
    // HttpException too, rather than each catch site answering straight from getResponse().
    it('should offer an HttpException thrown on the fast path to the error handler first', async () => {
      adapter.onError((error, ctx) => ctx.send({ reshaped: true, status: (error as HttpException).status }, 418));

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/fast-path-denied',
        middlewares: [],
        handler: async () => {
          throw new HttpException(401, 'Unauthorized');
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/fast-path-denied`);

      // Not 401: the point is that the application got to reshape its own 4xx envelope.
      expect(response.status).toBe(418);
      expect(await response.json()).toEqual({ reshaped: true, status: 401 });
    });
  });
});
