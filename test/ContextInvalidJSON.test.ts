import { describe, expect, it } from 'bun:test';
import { ErgenecoreContextWrapper, HttpException } from '../lib';

describe('ErgenecoreContextWrapper - Invalid JSON Handling', () => {
  describe('getBody() with invalid JSON', () => {
    it('should throw HttpException(400) for invalid JSON', async () => {
      const invalidJson = '{ invalid json }';
      const req = new Request('http://localhost/test', {
        method: 'POST',
        body: invalidJson,
        headers: { 'Content-Type': 'application/json' },
      });

      const context = new ErgenecoreContextWrapper(req);

      try {
        await context.getBody();
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).status).toBe(400);

        const response = (error as HttpException).getResponse();

        expect(response.status).toBe(400);

        const body = await response.json();

        expect(body.error).toBe('Invalid JSON in request body');
        expect(body.message).toBeDefined();
      }
    });

    it('should throw HttpException(400) for malformed JSON', async () => {
      const malformedJson = '{"name": "test",}'; // Trailing comma
      const req = new Request('http://localhost/test', {
        method: 'POST',
        body: malformedJson,
        headers: { 'Content-Type': 'application/json' },
      });

      const context = new ErgenecoreContextWrapper(req);

      try {
        await context.getBody();
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).status).toBe(400);

        const body = await (error as HttpException).getResponse().json();

        expect(body.error).toBe('Invalid JSON in request body');
      }
    });

    it('should throw HttpException(400) for unclosed JSON', async () => {
      const unclosedJson = '{"name": "test"';
      const req = new Request('http://localhost/test', {
        method: 'POST',
        body: unclosedJson,
        headers: { 'Content-Type': 'application/json' },
      });

      const context = new ErgenecoreContextWrapper(req);

      try {
        await context.getBody();
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).status).toBe(400);
      }
    });

    it('should throw HttpException(400) for non-JSON text', async () => {
      const plainText = 'This is not JSON';
      const req = new Request('http://localhost/test', {
        method: 'POST',
        body: plainText,
        headers: { 'Content-Type': 'application/json' },
      });

      const context = new ErgenecoreContextWrapper(req);

      try {
        await context.getBody();
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).status).toBe(400);
      }
    });

    it('should throw HttpException(400) for JSON with syntax error', async () => {
      const syntaxErrorJson = '{"name": undefined}'; // undefined is not valid JSON
      const req = new Request('http://localhost/test', {
        method: 'POST',
        body: syntaxErrorJson,
        headers: { 'Content-Type': 'application/json' },
      });

      const context = new ErgenecoreContextWrapper(req);

      try {
        await context.getBody();
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).status).toBe(400);
      }
    });
  });

  describe('getBody() with empty body', () => {
    it('should return empty object {} for empty string body', async () => {
      const req = new Request('http://localhost/test', {
        method: 'POST',
        body: '',
        headers: { 'Content-Type': 'application/json' },
      });

      const context = new ErgenecoreContextWrapper(req);
      const body = await context.getBody();

      expect(body).toEqual({});
    });

    it('should return empty object {} for whitespace-only body', async () => {
      const req = new Request('http://localhost/test', {
        method: 'POST',
        body: '   \n  \t  ',
        headers: { 'Content-Type': 'application/json' },
      });

      const context = new ErgenecoreContextWrapper(req);
      const body = await context.getBody();

      expect(body).toEqual({});
    });

    it('should return empty object {} for null body', async () => {
      const req = new Request('http://localhost/test', {
        method: 'GET',
      });

      const context = new ErgenecoreContextWrapper(req);
      const body = await context.getBody();

      expect(body).toEqual({});
    });
  });

  describe('getBody() with valid JSON', () => {
    it('should parse valid JSON correctly', async () => {
      const validJson = JSON.stringify({ name: 'test', age: 25 });
      const req = new Request('http://localhost/test', {
        method: 'POST',
        body: validJson,
        headers: { 'Content-Type': 'application/json' },
      });

      const context = new ErgenecoreContextWrapper(req);
      const body = await context.getBody();

      expect(body).toEqual({ name: 'test', age: 25 });
    });

    it('should cache parsed body on subsequent calls', async () => {
      const validJson = JSON.stringify({ name: 'cached' });
      const req = new Request('http://localhost/test', {
        method: 'POST',
        body: validJson,
        headers: { 'Content-Type': 'application/json' },
      });

      const context = new ErgenecoreContextWrapper(req);

      // First call
      const body1 = await context.getBody();

      expect(body1).toEqual({ name: 'cached' });

      // Second call - should return cached value
      const body2 = await context.getBody();

      expect(body2).toEqual({ name: 'cached' });
      expect(body1).toBe(body2); // Same reference
    });

    it('should handle nested JSON objects', async () => {
      const nestedJson = JSON.stringify({
        user: {
          name: 'test',
          address: {
            city: 'Istanbul',
            country: 'Turkey',
          },
        },
      });
      const req = new Request('http://localhost/test', {
        method: 'POST',
        body: nestedJson,
        headers: { 'Content-Type': 'application/json' },
      });

      const context = new ErgenecoreContextWrapper(req);
      const body = await context.getBody();

      expect(body).toEqual({
        user: {
          name: 'test',
          address: {
            city: 'Istanbul',
            country: 'Turkey',
          },
        },
      });
    });

    it('should handle JSON arrays', async () => {
      const arrayJson = JSON.stringify([1, 2, 3, 4, 5]);
      const req = new Request('http://localhost/test', {
        method: 'POST',
        body: arrayJson,
        headers: { 'Content-Type': 'application/json' },
      });

      const context = new ErgenecoreContextWrapper(req);
      const body = await context.getBody();

      expect(body).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('getBody() error caching', () => {
    it('should not cache error state - should throw on every call', async () => {
      const invalidJson = '{ invalid }';
      const req = new Request('http://localhost/test', {
        method: 'POST',
        body: invalidJson,
        headers: { 'Content-Type': 'application/json' },
      });

      const context = new ErgenecoreContextWrapper(req);

      // First call should throw
      try {
        await context.getBody();
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
      }

      // Second call should also throw (not cached)
      try {
        await context.getBody();
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
      }
    });
  });
});
