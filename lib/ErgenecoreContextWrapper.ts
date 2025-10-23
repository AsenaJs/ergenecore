import type { AsenaContext, CookieExtra, SendOptions } from '@asenajs/asena/adapter';
import { HttpException } from './errors';

/**
 * CoreContext type alias for CoreContextWrapper
 */
export type Context = ErgenecoreContextWrapper;

/**
 * CoreContextWrapper wraps Bun's native Request/Response to implement Asena's AsenaContext interface
 *
 * This wrapper provides a framework-agnostic API for handling HTTP requests and responses,
 * allowing Asena to work with different adapters without changing user code.
 */
export class ErgenecoreContextWrapper implements AsenaContext<Request, Response> {
  private readonly request: Request;

  private _url?: URL;

  private _values?: Map<string, any>;

  private bodyCache: any = undefined;

  private bodyRead = false;

  /**
   * Lazy-initialized mock Response object
   * Only created when context.res is accessed (e.g., by middlewares setting headers)
   */
  private _mockResponse?: {
    headers: Map<string, string>;
  };

  public constructor(request: Request) {
    this.request = request;
  }

  /**
   * Lazy-initialized URL getter
   *
   * URL object is only created when actually accessed, saving allocation
   * for routes that don't use query parameters.
   */
  private get url(): URL {
    if (!this._url) {
      this._url = new URL(this.request.url);
    }

    return this._url;
  }

  /**
   * Lazy-initialized values Map getter
   *
   * Map is only created when actually needed (setValue/getValue called),
   * saving allocation for simple routes that don't store context values.
   */
  private get values(): Map<string, any> {
    if (!this._values) {
      this._values = new Map<string, any>();
    }

    return this._values;
  }

  /**
   * Get the native Request object
   */
  public get req(): Request {
    return this.request;
  }

  /**
   * Get mock Response object (lazy-initialized)
   *
   * Provides a Response-like interface for middlewares to set headers.
   * Only created when accessed, maintaining zero overhead for simple handlers.
   */
  public get res(): any {
    if (!this._mockResponse) {
      this._mockResponse = {
        headers: new Map<string, string>(),
      };
    }

    return this._mockResponse;
  }

  /**
   * Get all request headers as an object
   */
  public get headers(): Record<string, string> {
    const headersObj: Record<string, string> = {};

    this.request.headers.forEach((value, key) => {
      headersObj[key.toLowerCase()] = value;
    });

    return headersObj;
  }

  /**
   * Get request body as ArrayBuffer
   */
  public async getArrayBuffer(): Promise<ArrayBuffer> {
    return await this.request.arrayBuffer();
  }

  /**
   * Get parsed multipart/form-data body
   */
  public async getParseBody(): Promise<any> {
    const contentType = this.request.headers.get('content-type');

    if (contentType?.includes('multipart/form-data') || contentType?.includes('application/x-www-form-urlencoded')) {
      const formData = await this.request.formData();
      const result: Record<string, any> = {};

      formData.forEach((value, key) => {
        result[key] = value;
      });

      return result;
    }

    return await this.request.json();
  }

  /**
   * Get request body as Blob
   */
  public async getBlob(): Promise<Blob> {
    return await this.request.blob();
  }

  /**
   * Get request body as FormData
   */
  public async getFormData(): Promise<FormData> {
    return await this.request.formData();
  }

  /**
   * Get URL parameter by name
   * Parameters are stored in the values map by the router
   */
  public getParam(name: string): string {
    return this.values.get(`param:${name}`) || '';
  }

  /**
   * Get request body as JSON
   *
   * Throws HttpException(400) if JSON is invalid (industry standard behavior).
   * Empty body is valid and returns empty object {}.
   *
   * @throws HttpException - 400 Bad Request if JSON parsing fails
   * @returns Parsed JSON body
   *
   * @example
   * ```typescript
   * // Valid JSON
   * const body = await context.getBody(); // { name: "test" }
   *
   * // Empty body
   * const body = await context.getBody(); // {}
   *
   * // Invalid JSON
   * const body = await context.getBody(); // throws HttpException(400)
   * ```
   */
  public async getBody<T>(): Promise<T> {
    // Cache body after first read to allow multiple accesses
    // (Request body stream can only be read once)
    if (this.bodyRead) {
      return this.bodyCache as T;
    }

    try {
      // Get raw text first to check if body is empty
      const text = await this.request.text();

      // Empty body is valid - return empty object
      if (!text || text.trim() === '') {
        this.bodyCache = {};
        this.bodyRead = true;
        return this.bodyCache as T;
      }

      // Parse JSON
      this.bodyCache = JSON.parse(text);
      this.bodyRead = true;
      return this.bodyCache as T;
    } catch (error) {
      // JSON parsing failed - throw HttpException (industry standard)
      throw new HttpException(400, {
        error: 'Invalid JSON in request body',
        message: error instanceof Error ? error.message : 'Failed to parse JSON',
      });
    }
  }

  /**
   * Get single query parameter by name
   */
  public async getQuery(name: string): Promise<string> {
    return this.url.searchParams.get(name) || '';
  }

  /**
   * Get all values for a query parameter (for array query params)
   */
  public async getQueryAll(name: string): Promise<string[]> {
    return this.url.searchParams.getAll(name);
  }

  /**
   * Set a response header that will be included in the final response
   *
   * Uses the mock Response object's headers Map.
   * This method is compatible with Asena's interface while delegating to res.headers.
   *
   * @param key - Header name
   * @param value - Header value
   */
  public setResponseHeader(key: string, value: string): void {
    this.res.headers.set(key, value);
  }

  /**
   * Send response (JSON or text based on data type)
   *
   * Automatically merges headers set by middlewares via setResponseHeader()
   */
  public send(data: string | any, statusOrOptions?: SendOptions | number): Response {
    const { headers = {}, status = 200 } =
      typeof statusOrOptions === 'number' ? { status: statusOrOptions } : statusOrOptions || {};

    const mergedHeaders = this.mergeHeaders(headers);

    if (typeof data === 'string') {
      return new Response(data, { status, headers: mergedHeaders });
    }

    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', ...mergedHeaders },
    });
  }

  /**
   * Get cookie value (optionally signed with secret)
   *
   * Uses Bun's native cookie API when available (for performance),
   * falls back to manual parsing for test environments.
   *
   * @param name - Cookie name
   * @param secret - Optional secret for signed cookies (uses HMAC-SHA256)
   */
  public async getCookie(name: string, secret?: string | BufferSource): Promise<string | false> {
    let value: string | undefined;

    // Try Bun native API first (available in Bun.serve() context)
    if ('cookies' in this.request && (this.request as any).cookies) {
      value = (this.request as any).cookies.get(name);
    } else {
      // Fallback: Manual parsing (for test environments or non-Bun contexts)
      const cookieHeader = this.request.headers.get('Cookie') || '';
      const cookies = Object.fromEntries(cookieHeader.split('; ').map((c) => c.split('=').map(decodeURIComponent)));

      value = cookies[name];
    }

    if (!value) return false;

    if (secret) {
      // Verify signed cookie using Web Crypto API (HMAC-SHA256)
      return await this.verifySignedCookie(value, secret);
    }

    return value;
  }

  /**
   * Set cookie (optionally signed with secret)
   *
   * Uses Bun's native cookie API which automatically handles Set-Cookie headers.
   *
   * @param name - Cookie name
   * @param value - Cookie value
   * @param options - Cookie options including secret for signing (HMAC-SHA256)
   */
  public async setCookie(name: string, value: string, options?: CookieExtra<any>): Promise<void> {
    const { secret, extraOptions } = options ?? {
      secret: undefined,
      extraOptions: undefined,
    };

    let cookieValue = value;

    if (secret) {
      // Sign cookie using Web Crypto API (HMAC-SHA256)
      cookieValue = await this.signCookieValue(value, secret);
    }

    // Use Bun native API (available in Bun.serve() context)
    if ('cookies' in this.request && (this.request as any).cookies) {
      (this.request as any).cookies.set(name, cookieValue, extraOptions);
    } else {
      throw new Error(
        'setCookie() requires Bun native cookie API. ' +
          'This method should only be called within Bun.serve() context.',
      );
    }
  }

  /**
   * Delete cookie
   *
   * Uses Bun's native cookie API which automatically handles Set-Cookie headers.
   *
   * @param name - Cookie name
   * @param options - Cookie options (path, domain)
   */
  public async deleteCookie(name: string, options?: CookieExtra<any>): Promise<void> {
    const { extraOptions } = options ?? {
      secret: undefined,
      extraOptions: undefined,
    };

    // Use Bun native API (available in Bun.serve() context)
    if ('cookies' in this.request && (this.request as any).cookies) {
      const deleteOptions = extraOptions
        ? {
            path: extraOptions.path,
            domain: extraOptions.domain,
          }
        : undefined;

      (this.request as any).cookies.delete(name, deleteOptions);
    } else {
      throw new Error(
        'deleteCookie() requires Bun native cookie API. ' +
          'This method should only be called within Bun.serve() context.',
      );
    }
  }

  /**
   * Redirect to a URL
   */
  public redirect(url: string): Response {
    return new Response(null, {
      status: 302,
      headers: { Location: url },
    });
  }

  /**
   * Get value from context store
   */
  public getValue<T = any>(key: string): T {
    return this.values.get(key) as T;
  }

  /**
   * Set value in context store
   */
  public setValue(key: string, value: any): void {
    this.values.set(key, value);
  }

  /**
   * Set WebSocket data that will be available during upgrade
   */
  public setWebSocketValue(value: any): void {
    this.values.set('_websocketData', value);
  }

  /**
   * Get WebSocket data
   */
  public getWebSocketValue<T>(): T {
    return this.values.get('_websocketData') as T;
  }

  /**
   * Send HTML response
   *
   * Automatically merges headers set by middlewares via setResponseHeader()
   */
  public html(data: string, statusOrOptions?: SendOptions | number): Response {
    const { headers = {}, status = 200 } =
      typeof statusOrOptions === 'number' ? { status: statusOrOptions } : statusOrOptions || {};

    const mergedHeaders = this.mergeHeaders({ 'Content-Type': 'text/html', ...headers });

    return new Response(data, {
      status,
      headers: mergedHeaders,
    });
  }

  /**
   * Merge middleware headers with custom headers (lazy - no allocation if no headers set)
   *
   * @param customHeaders - Headers provided directly to send()/html()
   * @returns Merged headers object (custom headers override middleware headers)
   */
  private mergeHeaders(customHeaders: Record<string, string> = {}): Record<string, string> {
    // Fast path: If mock response not created or no headers set, return custom headers directly
    if (!this._mockResponse || this._mockResponse.headers.size === 0) {
      return customHeaders;
    }

    // Merge: middleware headers first, then custom headers (custom takes precedence)
    const merged: Record<string, string> = {};

    this._mockResponse.headers.forEach((value, key) => {
      merged[key] = value;
    });

    // Custom headers override middleware headers
    Object.assign(merged, customHeaders);

    return merged;
  }

  /**
   * Sign cookie value using Web Crypto API (HMAC-SHA256)
   */
  private async signCookieValue(value: string, secret: string | BufferSource): Promise<string> {
    const encoder = new TextEncoder();
    const secretKey = typeof secret === 'string' ? encoder.encode(secret) : secret;
    const data = encoder.encode(value);

    const key = await crypto.subtle.importKey('raw', secretKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

    const signature = await crypto.subtle.sign('HMAC', key, data);
    const signatureHex = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    return `${value}.${signatureHex}`;
  }

  /**
   * Verify signed cookie using Web Crypto API (HMAC-SHA256)
   */
  private async verifySignedCookie(signedValue: string, secret: string | BufferSource): Promise<string | false> {
    const parts = signedValue.split('.');

    if (parts.length !== 2) return false;

    const [value, signature] = parts;
    const encoder = new TextEncoder();
    const secretKey = typeof secret === 'string' ? encoder.encode(secret) : secret;
    const data = encoder.encode(value);

    const key = await crypto.subtle.importKey('raw', secretKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);

    const signatureBytes = new Uint8Array(signature.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []);

    const isValid = await crypto.subtle.verify('HMAC', key, signatureBytes, data);

    return isValid ? value : false;
  }
}
