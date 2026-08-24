import type { Server } from 'bun';
import type {
  AsenaContext,
  AsenaSSEStreamWriter,
  AsenaStreamWriter,
  AsenaVariables,
  CookieExtra,
  SendOptions,
} from '@asenajs/asena/adapter';
import { HttpException } from './errors';
import { SSEStreamWriter } from './stream';
import { StreamWriter } from './stream';

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
  public routePattern?: string;

  private readonly request: Request;

  private _url?: URL;

  private _values?: Map<string, any>;

  private bodyCache: any = undefined;

  private bodyRead = false;

  private formDataCache?: FormData;

  private rawBodyCache?: Promise<ArrayBuffer>;

  private contentTypeCache?: string;

  private validatedForm: any = undefined;

  private formValidated = false;

  /**
   * Lazy-initialized mock Response object
   * Only created when context.res is accessed (e.g., by middlewares setting headers)
   */
  private _mockResponse?: {
    headers: Map<string, string>;
    status?: number;
  };

  private _server?: Server<never>;

  private _requestIp?: string | null;

  public constructor(request: Request, server?: Server<never>) {
    this.request = request;
    this._server = server;
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
   * The request body, read once and replayed to every representation below.
   *
   * The stream can only be consumed once, so a middleware reading the raw bytes, a `form`
   * validator, and a handler asking for JSON used to be mutually exclusive - whichever came
   * second failed, as a misleading 400 or a bare stream error. The promise (not the buffer)
   * is cached so concurrent readers share the single read.
   */
  private readRawBody(): Promise<ArrayBuffer> {
    if (this.rawBodyCache === undefined) {
      // Bun derives the content-type of an in-process Request from its FormData/Blob body and
      // drops it once that body is consumed, so it has to be read before the read below.
      this.contentTypeCache = this.request.headers.get('content-type') ?? '';
      this.rawBodyCache = this.request.arrayBuffer();
    }

    return this.rawBodyCache;
  }

  private get contentType(): string {
    return (this.contentTypeCache ??= this.request.headers.get('content-type') ?? '');
  }

  /**
   * Get request body as ArrayBuffer
   */
  public async getArrayBuffer(): Promise<ArrayBuffer> {
    return await this.readRawBody();
  }

  /**
   * Get parsed multipart/form-data body
   *
   * When the route declares a `form` validator this returns the schema's output, for the same
   * reason {@link getBody} returns `req.valid('json')`: the validator already collapsed repeated
   * keys into arrays and applied coercions, while the raw parse below is last-value-wins.
   * Routes without a form validator keep the raw shape.
   */
  public async getParseBody(): Promise<any> {
    if (this.formValidated) {
      return this.validatedForm;
    }

    const contentType = this.contentType;

    if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await this.getFormData();
      const result: Record<string, any> = {};

      formData.forEach((value, key) => {
        result[key] = value;
      });

      return result;
    }

    return await this.getBody();
  }

  /**
   * Get request body as Blob
   */
  public async getBlob(): Promise<Blob> {
    const type = this.contentType;

    return new Blob([await this.readRawBody()], { type });
  }

  /**
   * Get request body as FormData
   *
   * Cached after first read (Request body stream can only be read once), so a `form`
   * validator consuming the body does not break a handler that reads it again.
   *
   * @throws HttpException - 400 Bad Request if the form data is malformed
   */
  public async getFormData(): Promise<FormData> {
    if (this.formDataCache) {
      return this.formDataCache;
    }

    // The multipart boundary lives in the content-type, so the derived Response needs it
    const contentType = this.contentType;

    try {
      const buffer = await this.readRawBody();

      this.formDataCache = await new Response(buffer, { headers: { 'content-type': contentType } }).formData();

      return this.formDataCache;
    } catch (error) {
      throw new HttpException(400, {
        error: 'Malformed form data in request body',
        message: error instanceof Error ? error.message : 'Failed to parse form data',
      });
    }
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
   * When the route declares a `json` validator, this returns the schema's parsed output - with
   * unknown keys stripped and coercions/defaults applied - because the validator writes it back
   * via {@link setValidatedBody}. Without a validator it is the raw parsed body.
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
      const text = new TextDecoder().decode(await this.readRawBody());

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
   * Replaces the cached body with a validator's parsed output.
   *
   * Internal: called by `Ergenecore.validateRequest()` after a `json` schema passes. Zod's output
   * is what the schema actually describes - unknown keys stripped, coercions and defaults
   * applied - and discarding it meant `getBody()` handed the handler the raw payload, so a
   * strict validator sitting right next to `updateById({ ...body })` prevented nothing.
   *
   * The validator has necessarily read the body already, so the cache is warm and this only
   * swaps its contents; no second read of the request stream happens.
   *
   * @param data - Validated body produced by the schema
   */
  public setValidatedBody(data: unknown): void {
    this.bodyCache = data;
    this.bodyRead = true;
  }

  /**
   * Replaces the parsed form body with a validator's parsed output.
   *
   * Internal: the `form` counterpart of {@link setValidatedBody}, called by
   * `Ergenecore.validateRequest()` after a `form` schema passes. Kept separate from the body
   * cache because the two representations are independent - a form validator says nothing
   * about what `getBody()` should return.
   *
   * @param data - Validated form data produced by the schema
   */
  public setValidatedForm(data: unknown): void {
    this.validatedForm = data;
    this.formValidated = true;
  }

  /**
   * Get single query parameter by name
   *
   * Returns `undefined` when the parameter is absent, `''` when it is present but empty (`?name=`).
   */
  public async getQuery(name: string): Promise<string | undefined> {
    return this.url.searchParams.get(name) ?? undefined;
  }

  /**
   * Get all values for a query parameter (for array query params)
   */
  public async getQueryAll(name: string): Promise<string[]> {
    return this.url.searchParams.getAll(name);
  }

  /**
   * Get all query parameters as a key-value object
   */
  public getAllQueries(): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {};

    for (const [key, value] of this.url.searchParams.entries()) {
      if (key in result) {
        const existing = result[key];

        result[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Get the client IP address (lazy evaluated, cached)
   *
   * Uses Bun's server.requestIP() to resolve the actual TCP connection IP.
   * Only computed on first call - zero cost if never accessed.
   *
   * @returns The client IP address, or null if unavailable
   */
  public getRequestIp(): string | null {
    if (this._requestIp === undefined) {
      if (this._server) {
        const addr = this._server.requestIP(this.request);

        this._requestIp = addr?.address ?? null;
      } else {
        this._requestIp = null;
      }
    }

    return this._requestIp;
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
    this.res.headers.set(key.toLowerCase(), value);
  }

  /**
   * Append a value to a response header, keeping any value already set for it (comma-joined) -
   * the semantics multi-valued headers such as `Vary` and `Link` need.
   *
   * `Set-Cookie` cannot be comma-joined and is not supported here; cookies go through
   * `setCookie`.
   *
   * @param key - Header name
   * @param value - Header value to append
   */
  public appendResponseHeader(key: string, value: string): void {
    // Header names are case-insensitive on the wire but the staging Map is not
    const name = key.toLowerCase();
    const existing = this.res.headers.get(name);

    this.res.headers.set(name, existing ? `${existing}, ${value}` : value);
  }

  /**
   * Copies the headers middlewares staged with `setResponseHeader()` onto a Response that was
   * not built by `send()`/`html()`/`stream()` - a plain object, a raw `Response`, or an error
   * response. Those never call `mergeHeaders()`, so without this a middleware's CORS headers
   * reached only the routes that happened to answer through the wrapper.
   *
   * Headers already on the response win, matching `mergeHeaders()` where custom overrides
   * middleware.
   */
  public applyMiddlewareHeaders(response: Response): Response {
    if (!this._mockResponse || this._mockResponse.headers.size === 0) {
      return response;
    }

    this._mockResponse.headers.forEach((value, key) => {
      if (!response.headers.has(key)) {
        response.headers.set(key, value);
      }
    });

    return response;
  }

  /**
   * Send response (JSON or text based on data type)
   *
   * Automatically merges headers set by middlewares via setResponseHeader()
   */
  public send(data: string | any, statusOrOptions?: SendOptions | number): Response {
    const { headers = {}, status = 200 } =
      typeof statusOrOptions === 'number' ? { status: statusOrOptions } : statusOrOptions || {};

    this.res.status = status;

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
    this.res.status = 302;

    return new Response(null, {
      status: 302,
      headers: { Location: url },
    });
  }

  /**
   * Get value from context store.
   * Type-safe when AsenaVariables is augmented.
   */
  public getValue<K extends keyof AsenaVariables>(key: K): AsenaVariables[K];
  public getValue<T = any>(key: string): T;
  public getValue(key: string): any {
    return this.values.get(key);
  }

  /**
   * Set value in context store.
   * Type-safe when AsenaVariables is augmented.
   */
  public setValue<K extends keyof AsenaVariables>(key: K, value: AsenaVariables[K]): void;
  public setValue(key: string, value: any): void;
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

    this.res.status = status;

    const mergedHeaders = this.mergeHeaders({ 'Content-Type': 'text/html', ...headers });

    return new Response(data, {
      status,
      headers: mergedHeaders,
    });
  }

  /**
   * Start a generic binary/text stream
   */
  public stream(
    cb: (stream: AsenaStreamWriter) => Promise<void>,
    onError?: (error: Error, stream: AsenaStreamWriter) => Promise<void>,
  ): Response {
    const { readable, writable } = new TransformStream();
    const stream = new StreamWriter(writable, readable);

    this.wireAbort(stream);

    const headers = this.mergeHeaders();

    this.res.status = 200;

    this.runStreamCallback(stream, cb, onError);

    return new Response(stream.responseReadable, { status: 200, headers });
  }

  /**
   * Start a Server-Sent Events stream
   */
  public streamSSE(
    cb: (stream: AsenaSSEStreamWriter) => Promise<void>,
    onError?: (error: Error, stream: AsenaSSEStreamWriter) => Promise<void>,
  ): Response {
    const { readable, writable } = new TransformStream();
    const stream = new SSEStreamWriter(writable, readable);

    this.wireAbort(stream);

    const headers = this.mergeHeaders({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    this.res.status = 200;

    this.runStreamCallback(stream, cb, onError);

    return new Response(stream.responseReadable, { status: 200, headers });
  }

  /**
   * Start a text stream with text/plain content-type
   */
  public streamText(
    cb: (stream: AsenaStreamWriter) => Promise<void>,
    onError?: (error: Error, stream: AsenaStreamWriter) => Promise<void>,
  ): Response {
    const { readable, writable } = new TransformStream();
    const stream = new StreamWriter(writable, readable);

    this.wireAbort(stream);

    const headers = this.mergeHeaders({
      'Content-Type': 'text/plain',
      'X-Content-Type-Options': 'nosniff',
    });

    this.res.status = 200;

    this.runStreamCallback(stream, cb, onError);

    return new Response(stream.responseReadable, { status: 200, headers });
  }

  /**
   * Wire request abort signal to stream abort
   */
  private wireAbort(stream: StreamWriter): void {
    this.request.signal.addEventListener('abort', () => {
      if (!stream.closed) {
        stream.abort();
      }
    });
  }

  /**
   * Fire-and-forget the streaming callback with error handling
   */
  private runStreamCallback<T extends AsenaStreamWriter>(
    stream: T,
    cb: (stream: T) => Promise<void>,
    onError?: (error: Error, stream: T) => Promise<void>,
  ): void {
    // `void`: the promise is deliberately not awaited - this method returns as soon as the stream
    // is handed over, and every failure inside is handled below. Marking it explicit is what
    // separates fire-and-forget from a forgotten await.
    void (async () => {
      try {
        await cb(stream);
      } catch (e) {
        if (e instanceof Error && onError) {
          await onError(e, stream);
        } else {
          console.error(e);
        }
      } finally {
        if (!stream.closed) {
          await stream.close();
        }
      }
    })();
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
