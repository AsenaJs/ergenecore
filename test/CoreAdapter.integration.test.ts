import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Ergenecore } from '../lib';
import { ErgenecoreWebsocketAdapter } from '../lib';
import type { ServerLogger } from '@asenajs/asena/logger';
import { HttpMethod } from '@asenajs/asena/web-types';
import type { Context } from '../lib';
import type { Server } from 'bun';

// Mock logger
const mockLogger: ServerLogger = {
  profile: mock(() => {}),
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
};

describe('CoreAdapter Integration Tests', () => {
  let adapter: Ergenecore;
  let server: Server;
  let baseUrl: string;

  beforeEach(() => {
    const wsAdapter = new ErgenecoreWebsocketAdapter(mockLogger);

    adapter = new Ergenecore(mockLogger, wsAdapter);
    // Use port 0 for random available port
    adapter.setPort(0);
  });

  afterEach(async () => {
    if (server) {
      await adapter.stop();
    }
  });

  describe('HTTP Requests', () => {
    it('should handle GET request end-to-end', async () => {
      // Register route
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/test',
        middlewares: [],
        handler: async (ctx: Context) => {
          return ctx.send({ message: 'Hello from GET' });
        },
      });

      // Start server
      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      // Make request
      const response = await fetch(`${baseUrl}/test`);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.message).toBe('Hello from GET');
    });

    it('should handle POST request with body', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.POST,
        path: '/users',
        middlewares: [],
        handler: async (ctx: Context) => {
          const body = await ctx.getBody<{ name: string }>();

          return ctx.send({ created: true, user: body });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'John Doe' }),
      });

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.created).toBe(true);
      expect(data.user.name).toBe('John Doe');
    });

    it('should handle PUT request', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.PUT,
        path: '/users/:id',
        middlewares: [],
        handler: async (ctx: Context) => {
          const id = ctx.getParam('id');
          const body = await ctx.getBody<{ name: string }>();

          return ctx.send({ updated: true, userId: id, data: body });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/users/123`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Jane Doe' }),
      });

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.updated).toBe(true);
      expect(data.userId).toBe('123');
      expect(data.data.name).toBe('Jane Doe');
    });

    it('should handle DELETE request', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.DELETE,
        path: '/users/:id',
        middlewares: [],
        handler: async (ctx: Context) => {
          const id = ctx.getParam('id');

          return ctx.send({ deleted: true, userId: id });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/users/456`, {
        method: 'DELETE',
      });

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.deleted).toBe(true);
      expect(data.userId).toBe('456');
    });
  });

  describe('Path Parameters', () => {
    it('should extract single path parameter', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/users/:id',
        middlewares: [],
        handler: async (ctx: Context) => {
          const id = ctx.getParam('id');

          return ctx.send({ userId: id });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/users/789`);
      const data = await response.json();

      expect(data.userId).toBe('789');
    });

    it('should extract multiple path parameters', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/orgs/:orgId/repos/:repoId',
        middlewares: [],
        handler: async (ctx: Context) => {
          const orgId = ctx.getParam('orgId');
          const repoId = ctx.getParam('repoId');

          return ctx.send({ orgId, repoId });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/orgs/asenajs/repos/ergenecore`);
      const data = await response.json();

      expect(data.orgId).toBe('asenajs');
      expect(data.repoId).toBe('ergenecore');
    });

    it('should handle parameters with special characters', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/items/:slug',
        middlewares: [],
        handler: async (ctx: Context) => {
          const slug = ctx.getParam('slug');

          return ctx.send({ slug });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/items/hello-world-123`);
      const data = await response.json();

      expect(data.slug).toBe('hello-world-123');
    });
  });

  describe('Query Parameters', () => {
    it('should extract query parameters', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/search',
        middlewares: [],
        handler: async (ctx: Context) => {
          const query = await ctx.getQuery('q');
          const page = await ctx.getQuery('page');

          return ctx.send({ query, page });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/search?q=test&page=2`);
      const data = await response.json();

      expect(data.query).toBe('test');
      expect(data.page).toBe('2');
    });
  });

  describe('Response Methods', () => {
    it('should send JSON response', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/json',
        middlewares: [],
        handler: async (ctx: Context) => {
          return ctx.send({ type: 'json', status: 'ok' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/json`);
      const data = await response.json();

      expect(response.headers.get('content-type')).toContain('application/json');
      expect(data.type).toBe('json');
    });

    it('should send HTML response', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/html',
        middlewares: [],
        handler: async (ctx: Context) => {
          return ctx.html('<h1>Hello World</h1>');
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/html`);
      const text = await response.text();

      expect(response.headers.get('content-type')).toContain('text/html');
      expect(text).toBe('<h1>Hello World</h1>');
    });

    it('should send redirect response', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/old',
        middlewares: [],
        handler: async (ctx: Context) => {
          return ctx.redirect('/new');
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/old`, {
        redirect: 'manual',
      });

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/new');
    });

    it('should send custom status code', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/created',
        middlewares: [],
        handler: async (ctx: Context) => {
          return ctx.send({ created: true }, 201);
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/created`);

      expect(response.status).toBe(201);
    });
  });

  describe('Multiple Routes', () => {
    it('should handle multiple routes on same path with different methods', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/items',
        middlewares: [],
        handler: async (ctx: Context) => {
          return ctx.send({ method: 'GET', items: [] });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.POST,
        path: '/items',
        middlewares: [],
        handler: async (ctx: Context) => {
          return ctx.send({ method: 'POST', created: true });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const getResponse = await fetch(`${baseUrl}/items`);
      const getData = await getResponse.json();

      const postResponse = await fetch(`${baseUrl}/items`, { method: 'POST' });
      const postData = await postResponse.json();

      expect(getData.method).toBe('GET');
      expect(postData.method).toBe('POST');
    });

    it('should handle multiple different routes', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/users',
        middlewares: [],
        handler: async (ctx: Context) => {
          return ctx.send({ resource: 'users' });
        },
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/posts',
        middlewares: [],
        handler: async (ctx: Context) => {
          return ctx.send({ resource: 'posts' });
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const usersResponse = await fetch(`${baseUrl}/users`);
      const usersData = await usersResponse.json();

      const postsResponse = await fetch(`${baseUrl}/posts`);
      const postsData = await postsResponse.json();

      expect(usersData.resource).toBe('users');
      expect(postsData.resource).toBe('posts');
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for unregistered routes', async () => {
      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/not-found`);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toBe('Not Found');
    });

    it('should handle errors in route handlers', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/error',
        middlewares: [],
        handler: async (_ctx: Context) => {
          throw new Error('Test error message');
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/error`);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe('Test error message');
    });

    it('should use custom error handler if provided', async () => {
      adapter.onError(async (error, ctx) => {
        return ctx.send({ customError: true, message: error.message }, 503);
      });

      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/custom-error',
        middlewares: [],
        handler: async (_ctx: Context) => {
          throw new Error('Custom test error');
        },
      });

      server = await adapter.start();
      baseUrl = `http://localhost:${server.port}`;

      const response = await fetch(`${baseUrl}/custom-error`);
      const data = await response.json();

      expect(response.status).toBe(503);
      expect(data.customError).toBe(true);
      expect(data.message).toBe('Custom test error');
    });
  });

  describe('Server Lifecycle', () => {
    it('should start and stop server cleanly', async () => {
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/lifecycle',
        middlewares: [],
        handler: async (ctx: Context) => {
          return ctx.send({ status: 'running' });
        },
      });

      // Start server
      server = await adapter.start();
      const port = server.port;

      baseUrl = `http://localhost:${port}`;

      // Server should respond
      const response1 = await fetch(`${baseUrl}/lifecycle`);

      expect(response1.status).toBe(200);

      // Stop server
      await adapter.stop();

      // Server should not respond
      try {
        await fetch(`${baseUrl}/lifecycle`);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  describe('Cookie Management (Integration)', () => {
    it('should set and get cookies using Bun native API', async () => {
      // Register route that sets cookie
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/set-cookie',
        middlewares: [],
        handler: async (ctx: Context) => {
          await ctx.setCookie('test-cookie', 'cookie-value', {
            extraOptions: {
              path: '/',
              httpOnly: true,
            },
          });

          return ctx.send({ success: true });
        },
      });

      // Register route that gets cookie
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/get-cookie',
        middlewares: [],
        handler: async (ctx: Context) => {
          const cookieValue = await ctx.getCookie('test-cookie');

          return ctx.send({ cookieValue });
        },
      });

      // Start server
      server = await adapter.start();
      baseUrl = `http://${adapter.hostname || 'localhost'}:${server.port}`;

      // Set cookie
      const setCookieResponse = await fetch(`${baseUrl}/set-cookie`);

      expect(setCookieResponse.status).toBe(200);

      const setCookieHeader = setCookieResponse.headers.get('Set-Cookie');

      expect(setCookieHeader).toBeDefined();
      expect(setCookieHeader).toContain('test-cookie=cookie-value');
      expect(setCookieHeader).toContain('Path=/');
      expect(setCookieHeader).toContain('HttpOnly');

      // Get cookie
      const getCookieResponse = await fetch(`${baseUrl}/get-cookie`, {
        headers: {
          Cookie: 'test-cookie=cookie-value',
        },
      });

      expect(getCookieResponse.status).toBe(200);

      const data = await getCookieResponse.json();

      expect(data.cookieValue).toBe('cookie-value');
    });

    it('should delete cookies using Bun native API', async () => {
      // Register route that deletes cookie
      adapter.registerRoute({
        staticServe: undefined,
        validator: undefined,
        method: HttpMethod.GET,
        path: '/delete-cookie',
        middlewares: [],
        handler: async (ctx: Context) => {
          await ctx.deleteCookie('test-cookie', {
            extraOptions: {
              path: '/',
            },
          });

          return ctx.send({ deleted: true });
        },
      });

      // Start server
      server = await adapter.start();
      baseUrl = `http://${adapter.hostname || 'localhost'}:${server.port}`;

      // Delete cookie
      const response = await fetch(`${baseUrl}/delete-cookie`);

      expect(response.status).toBe(200);

      const setCookieHeader = response.headers.get('Set-Cookie');

      expect(setCookieHeader).toBeDefined();
      expect(setCookieHeader).toContain('test-cookie=');
      expect(setCookieHeader).toContain('Expires=');
      expect(setCookieHeader).toContain('1970'); // Expired date
    });
  });
});
