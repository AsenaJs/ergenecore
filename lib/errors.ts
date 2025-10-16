/**
 * HTTP Exception for Ergenecore
 *
 * Public API for throwing HTTP errors in handlers and middlewares.
 * Inspired by Hono's HTTPException pattern.
 *
 * @example
 * ```typescript
 * // In middleware
 * if (!user) {
 *   throw new HttpException(401, 'Unauthorized', {
 *     headers: { 'WWW-Authenticate': 'Bearer' }
 *   });
 * }
 *
 * // In handler
 * if (!isValid) {
 *   throw new HttpException(400, { error: 'Invalid data' });
 * }
 * ```
 */
export class HttpException extends Error {

  /**
   * HTTP status code
   */
  public readonly status: number;

  /**
   * Response body (can be string or object)
   */
  public readonly body: string | object;

  /**
   * Optional response init options (headers, statusText, etc.)
   */
  public readonly options?: ResponseInit;

  /**
   * Creates a new HttpException
   *
   * @param status - HTTP status code (e.g., 401, 403, 404)
   * @param body - Response body (string or object to be JSON stringified)
   * @param options - Optional ResponseInit options (headers, statusText, etc.)
   *
   * @example
   * ```typescript
   * // Simple message
   * throw new HttpException(404, 'Not Found');
   *
   * // JSON object
   * throw new HttpException(400, { error: 'Invalid input', field: 'email' });
   *
   * // With headers
   * throw new HttpException(429, 'Too Many Requests', {
   *   headers: { 'Retry-After': '60' }
   * });
   * ```
   */
  public constructor(status: number, body: string | object = '', options?: ResponseInit) {
    const message = typeof body === 'string' ? body : JSON.stringify(body);

    super(message);
    this.name = 'HttpException';
    this.status = status;
    this.body = body;
    this.options = options;
  }

  /**
   * Converts the exception to a Response object
   *
   * @returns Bun Response object ready to be returned
   */
  public getResponse(): Response {
    const body = typeof this.body === 'string' ? this.body : JSON.stringify(this.body);

    const headers = new Headers(this.options?.headers);

    // Set Content-Type to application/json if body is an object and not already set
    if (typeof this.body === 'object' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    return new Response(body, {
      status: this.status,
      statusText: this.options?.statusText,
      headers,
    });
  }

}

/**
 * Internal error class for middleware response propagation
 *
 * This error is thrown internally when a middleware returns a Response object,
 * allowing the response to be propagated through the middleware chain without
 * being lost in the recursive next() pattern.
 *
 * @internal
 */
export class MiddlewareResponseError extends Error {

  /**
   * The Response object returned by the middleware
   */
  public readonly response: Response;

  /**
   * Creates a new MiddlewareResponseError
   *
   * @param response - Response object to propagate
   */
  public constructor(response: Response) {
    super('MIDDLEWARE_RETURNED_RESPONSE');
    this.name = 'MiddlewareResponseError';
    this.response = response;
  }

}