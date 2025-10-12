import { describe, expect, it } from 'bun:test';
import { ErgenecoreContextWrapper } from '../lib';

describe('CoreContextWrapper - Cookie Management', () => {
  /**
   * Create a mock Request with cookies
   */
  const createRequestWithCookies = (cookies: string) => {
    return new Request('http://localhost:3000/test', {
      headers: {
        Cookie: cookies,
      },
    });
  };

  describe('getCookie() - Unsigned Cookies', () => {
    it('should get unsigned cookie by name', async () => {
      const request = createRequestWithCookies('session=abc123; theme=dark');
      const wrapper = new ErgenecoreContextWrapper(request);

      const sessionCookie = await wrapper.getCookie('session');
      const themeCookie = await wrapper.getCookie('theme');

      expect(sessionCookie).toBe('abc123');
      expect(themeCookie).toBe('dark');
    });

    it('should return false for non-existent cookie', async () => {
      const request = createRequestWithCookies('session=abc123');
      const wrapper = new ErgenecoreContextWrapper(request);

      const result = await wrapper.getCookie('nonexistent');

      expect(result).toBe(false);
    });

    it('should handle URL-encoded cookie values', async () => {
      const request = createRequestWithCookies('data=hello%20world; user=john%40example.com');
      const wrapper = new ErgenecoreContextWrapper(request);

      const dataCookie = await wrapper.getCookie('data');
      const userCookie = await wrapper.getCookie('user');

      expect(dataCookie).toBe('hello world');
      expect(userCookie).toBe('john@example.com');
    });

    it('should handle empty cookie header', async () => {
      const request = new Request('http://localhost:3000/test');
      const wrapper = new ErgenecoreContextWrapper(request);

      const result = await wrapper.getCookie('session');

      expect(result).toBe(false);
    });
  });

  describe('getCookie() - Signed Cookies', () => {
    it('should verify and return signed cookie with correct secret', async () => {
      const secret = 'my-secret-key';
      const wrapper = new ErgenecoreContextWrapper(new Request('http://localhost:3000/test'));

      // First, sign a value to get the signed format
      const signedValue = await (wrapper as any).signCookieValue('test-value', secret);
      const request = createRequestWithCookies(`session=${encodeURIComponent(signedValue)}`);
      const wrapperWithCookie = new ErgenecoreContextWrapper(request);

      const result = await wrapperWithCookie.getCookie('session', secret);

      expect(result).toBe('test-value');
    });

    it('should return false for tampered signed cookie', async () => {
      const secret = 'my-secret-key';
      const wrapper = new ErgenecoreContextWrapper(new Request('http://localhost:3000/test'));

      // Create a properly signed cookie
      const signedValue = await (wrapper as any).signCookieValue('original-value', secret);

      // Tamper with the value part
      const tamperedValue = signedValue.replace('original-value', 'tampered-value');
      const request = createRequestWithCookies(`session=${encodeURIComponent(tamperedValue)}`);
      const wrapperWithCookie = new ErgenecoreContextWrapper(request);

      const result = await wrapperWithCookie.getCookie('session', secret);

      expect(result).toBe(false);
    });

    it('should return false for signed cookie with wrong secret', async () => {
      const correctSecret = 'correct-secret';
      const wrongSecret = 'wrong-secret';
      const wrapper = new ErgenecoreContextWrapper(new Request('http://localhost:3000/test'));

      const signedValue = await (wrapper as any).signCookieValue('test-value', correctSecret);
      const request = createRequestWithCookies(`session=${encodeURIComponent(signedValue)}`);
      const wrapperWithCookie = new ErgenecoreContextWrapper(request);

      const result = await wrapperWithCookie.getCookie('session', wrongSecret);

      expect(result).toBe(false);
    });

    it('should return false for malformed signed cookie', async () => {
      const secret = 'my-secret-key';
      const request = createRequestWithCookies('session=malformed-no-signature');
      const wrapper = new ErgenecoreContextWrapper(request);

      const result = await wrapper.getCookie('session', secret);

      expect(result).toBe(false);
    });

    it('should work with BufferSource secret', async () => {
      const secretBuffer = new TextEncoder().encode('buffer-secret');
      const wrapper = new ErgenecoreContextWrapper(new Request('http://localhost:3000/test'));

      const signedValue = await (wrapper as any).signCookieValue('test-value', secretBuffer);
      const request = createRequestWithCookies(`session=${encodeURIComponent(signedValue)}`);
      const wrapperWithCookie = new ErgenecoreContextWrapper(request);

      const result = await wrapperWithCookie.getCookie('session', secretBuffer);

      expect(result).toBe('test-value');
    });
  });

  /**
   * NOTE: setCookie() and deleteCookie() unit tests removed.
   *
   * These methods now require Bun.serve() context (req.cookies API).
   * They are tested via integration tests with real HTTP server.
   *
   * See: test/CoreAdapter.integration.test.ts for cookie integration tests
   */

  describe('Cookie Signing/Verification - Web Crypto API', () => {
    it('should sign cookie value using HMAC-SHA256', async () => {
      const request = new Request('http://localhost:3000/test');
      const wrapper = new ErgenecoreContextWrapper(request);

      const value = 'test-value';
      const secret = 'my-secret';

      const signed = await (wrapper as any).signCookieValue(value, secret);

      expect(signed).toContain(value);
      expect(signed).toContain('.');
      expect(signed.split('.').length).toBe(2);
      expect(signed.split('.')[1]).toMatch(/^[a-f0-9]+$/); // Hex signature
    });

    it('should verify valid signed cookie', async () => {
      const request = new Request('http://localhost:3000/test');
      const wrapper = new ErgenecoreContextWrapper(request);

      const value = 'test-value';
      const secret = 'my-secret';

      const signed = await (wrapper as any).signCookieValue(value, secret);
      const verified = await (wrapper as any).verifySignedCookie(signed, secret);

      expect(verified).toBe(value);
    });

    it('should reject invalid signature', async () => {
      const request = new Request('http://localhost:3000/test');
      const wrapper = new ErgenecoreContextWrapper(request);

      const invalidSigned = 'value.invalidsignature';
      const secret = 'my-secret';

      const verified = await (wrapper as any).verifySignedCookie(invalidSigned, secret);

      expect(verified).toBe(false);
    });

    it('should produce consistent signatures for same value and secret', async () => {
      const request = new Request('http://localhost:3000/test');
      const wrapper = new ErgenecoreContextWrapper(request);

      const value = 'test-value';
      const secret = 'my-secret';

      const signed1 = await (wrapper as any).signCookieValue(value, secret);
      const signed2 = await (wrapper as any).signCookieValue(value, secret);

      expect(signed1).toBe(signed2);
    });

    it('should produce different signatures for different values', async () => {
      const request = new Request('http://localhost:3000/test');
      const wrapper = new ErgenecoreContextWrapper(request);

      const secret = 'my-secret';

      const signed1 = await (wrapper as any).signCookieValue('value1', secret);
      const signed2 = await (wrapper as any).signCookieValue('value2', secret);

      expect(signed1).not.toBe(signed2);
    });
  });
});
