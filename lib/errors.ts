import {
  HttpException,
  VALIDATION_ERROR,
  type ValidationErrorLike,
  type ValidationIssue,
} from '@asenajs/asena/adapter';
import { flattenError, type ZodError } from 'zod';

/**
 * The exception applications throw, re-exported so `@asenajs/ergenecore` keeps offering it under
 * the name it always had.
 *
 * It used to be defined here. It now lives in `@asenajs/asena/adapter` so the hono adapter can
 * offer the *same class* rather than a look-alike - one `throw new HttpException(...)` that
 * compiles and behaves identically on both. This is a re-export, not a subclass: the class object
 * is the one core exports, so `instanceof` holds across the two import paths.
 */
export { HttpException, type HttpExceptionInit } from '@asenajs/asena/adapter';

/**
 * Thrown when request validation fails, so the failure reaches the application's
 * `ConfigService.onError` like every other error instead of being answered inside
 * the validation step.
 *
 * Extends `HttpException` with status 400 deliberately: a handler that matches with
 * `isHttpException()` and replies with `error.status` keeps answering 400, so adopting
 * this does not silently turn validation failures into 500s. Check `isValidationError()`
 * first if you want validation failures to get their own envelope - this is an
 * `HttpException`, so the generic branch would otherwise swallow it.
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
