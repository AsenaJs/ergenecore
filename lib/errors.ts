import type { HttpStatusCode } from '@asenajs/asena/web-types';
import {
  HTTP_EXCEPTION,
  type HttpExceptionLike,
  VALIDATION_ERROR,
  type ValidationErrorLike,
  type ValidationIssue,
} from '@asenajs/asena/adapter';
import { flattenError, type ZodError } from 'zod';

/**
 * Extended ResponseInit with cause support
 */
export interface HttpExceptionInit extends ResponseInit {
  /** The original error that caused this exception */
  cause?: Error;
}

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
 *
 * // With cause
 * try { await db.query(...) } catch (err) {
 *   throw new HttpException(500, 'Database Error', { cause: err });
 * }
 * ```
 */
export class HttpException extends Error implements HttpExceptionLike {
  /**
   * Registered-symbol brand so `isHttpException()` works even when a project resolves two
   * copies of this package - `instanceof` answers false across copies, silently.
   */
  public readonly [HTTP_EXCEPTION] = true as const;

  /**
   * HTTP status code
   */
  public readonly status: number;

  /**
   * Response body (can be string or object)
   */
  public readonly body: string | object;

  /**
   * Optional response init options (headers, statusText, cause, etc.)
   */
  public readonly options?: HttpExceptionInit;

  /**
   * Creates a new HttpException
   *
   * @param status - HTTP status code (e.g., 401, 403, 404) or HttpStatusCode enum value
   * @param body - Response body (string or object to be JSON stringified)
   * @param options - Optional HttpExceptionInit options (headers, statusText, cause, etc.)
   *
   * @example
   * ```typescript
   * // Simple message
   * throw new HttpException(404, 'Not Found');
   *
   * // With HttpStatusCode enum
   * throw new HttpException(ClientErrorStatusCode.NotFound, 'Not Found');
   *
   * // JSON object
   * throw new HttpException(400, { error: 'Invalid input', field: 'email' });
   *
   * // With headers
   * throw new HttpException(429, 'Too Many Requests', {
   *   headers: { 'Retry-After': '60' }
   * });
   *
   * // With cause
   * throw new HttpException(500, 'Internal Error', { cause: originalError });
   * ```
   */
  public constructor(status: HttpStatusCode | number, body: string | object = '', options?: HttpExceptionInit) {
    const message = typeof body === 'string' ? body : JSON.stringify(body);

    super(message, options?.cause ? { cause: options.cause } : undefined);
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
 * Thrown when request validation fails, so the failure reaches the application's
 * `ConfigService.onError` like every other error instead of being answered inside
 * the validation step.
 *
 * Extends `HttpException` with status 400 deliberately: an existing handler that
 * branches on `error instanceof HttpException` and replies with `error.status`
 * keeps answering 400, so adopting this does not silently turn validation failures
 * into 500s.
 *
 * @example
 * ```typescript
 * public onError(error: Error, context: Context) {
 *   if (isValidationError(error)) {
 *     return context.send({ success: false, errors: error.issues }, 400);
 *   }
 *
 *   return context.send({ error: 'Internal Server Error' }, 500);
 * }
 * ```
 */
export class ValidationError extends HttpException implements ValidationErrorLike {
  public readonly [VALIDATION_ERROR] = true as const;

  /** Which part of the request failed: `json`, `query`, `form`, `param` or `header` */
  public readonly target: string;

  /** Field-level failures, adapter-agnostic */
  public readonly issues: ValidationIssue[];

  /** The original Zod error, for anything `issues` does not carry */
  public readonly cause: ZodError;

  public constructor(cause: ZodError, target: string) {
    super(400, 'Validation failed');

    this.name = 'ValidationError';
    this.target = target;
    this.cause = cause;
    this.issues = cause.issues.map((issue) => ({
      path: issue.path.map((segment) => (typeof segment === 'symbol' ? segment.toString() : segment)),
      message: issue.message,
      code: issue.code,
    }));
  }

  /**
   * The envelope the caller sees when the application does not answer this failure itself.
   *
   * It lives here rather than in the adapter so a validation failure has exactly one response
   * shape - the adapter used to build a richer body inline for applications with no `onError`
   * and fall back to the bare `HttpException` text for everyone else, so the same failure
   * answered two different bodies depending on an unrelated hook.
   *
   * Built on each call rather than stored: a `Response` body can only be read once.
   */
  public getResponse(): Response {
    return new Response(
      JSON.stringify({
        error: 'Validation failed',
        details: flattenError(this.cause),
        target: this.target,
      }),
      {
        status: this.status,
        headers: { 'Content-Type': 'application/json' },
      },
    );
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
