/**
 * CORS Middleware for Ergenecore
 *
 * Handles Cross-Origin Resource Sharing (CORS) by:
 * - Setting appropriate CORS headers on responses
 * - Handling preflight OPTIONS requests
 * - Supporting origin validation
 * - Zero external dependencies (uses Bun's native APIs)
 *
 * @module defaults/CorsMiddleware
 *
 * @example
 * ```typescript
 * import { Middleware } from '@asenajs/asena/decorators';
 * import { CorsMiddleware } from '@asenajs/ergenecore';
 *
 * @Middleware()
 * export class MyCorsMiddleware extends CorsMiddleware {
 *   constructor() {
 *     super({
 *       origin: '*', // or ['https://example.com']
 *       methods: ['GET', 'POST', 'PUT', 'DELETE'],
 *       credentials: true
 *     });
 *   }
 * }
 * ```
 */

import type { Context } from '../ErgenecoreContextWrapper';
import { MiddlewareService } from '../defaults';

/**
 * CORS configuration options
 */
export interface CorsOptions {
  /**
   * Allowed origins
   * - Use '*' to allow all origins
   * - Use string[] to allow specific origins
   * - Use function for dynamic origin validation
   *
   * @default '*'
   */
  origin?: '*' | string[] | ((origin: string) => boolean);

  /**
   * Allowed HTTP methods
   *
   * @default ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
   */
  methods?: string[];

  /**
   * Allowed headers
   *
   * @default ['Content-Type', 'Authorization']
   */
  allowedHeaders?: string[];

  /**
   * Exposed headers (visible to client JavaScript)
   *
   * @default []
   */
  exposedHeaders?: string[];

  /**
   * Allow credentials (cookies, authorization headers, TLS client certificates)
   *
   * @default false
   */
  credentials?: boolean;

  /**
   * Preflight cache duration in seconds
   *
   * @default 86400 (24 hours)
   */
  maxAge?: number;
}

/**
 * CORS Middleware
 *
 * Implements CORS (Cross-Origin Resource Sharing) for Ergenecore adapter.
 * Extend this class and configure it via constructor to customize CORS behavior.
 *
 * **Performance Optimizations:**
 * - Lazy header allocation (only when needed)
 * - Pre-joined header strings for common cases
 * - Fast origin validation
 * - Minimal string allocations
 *
 * **CORS Flow:**
 * 1. Check if request has Origin header (if not, skip CORS)
 * 2. Advertise that the response varies by Origin (unless the config is the literal '*')
 * 3. Validate origin - when it is not allowed, emit no CORS headers and carry on
 * 4. Handle preflight OPTIONS request → return 204 immediately
 * 5. For other requests → set CORS headers and call next()
 */
export class CorsMiddleware extends MiddlewareService {
  private readonly origin: '*' | string[] | ((origin: string) => boolean);

  private readonly methods: string;

  private readonly allowedHeaders: string;

  private readonly exposedHeaders: string;

  private readonly credentials: boolean;

  private readonly maxAge: string;

  /**
   * Creates a new CORS middleware instance
   *
   * @param options - CORS configuration options
   *
   * @example
   * ```typescript
   * @Middleware()
   * export class CustomCors extends CorsMiddleware {
   *   constructor() {
   *     super({
   *       origin: ['https://example.com', 'https://app.example.com'],
   *       methods: ['GET', 'POST'],
   *       credentials: true,
   *       maxAge: 3600
   *     });
   *   }
   * }
   * ```
   */
  public constructor(options: CorsOptions = {}) {
    super();

    // Pre-process and store configuration (avoid runtime processing)
    this.origin = options.origin ?? '*';
    this.methods = (options.methods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).join(', ');
    this.allowedHeaders = (options.allowedHeaders ?? ['Content-Type', 'Authorization']).join(', ');
    this.exposedHeaders = (options.exposedHeaders ?? []).join(', ');
    this.credentials = options.credentials ?? false;
    this.maxAge = String(options.maxAge ?? 86400); // 24 hours default
  }

  /**
   * CORS middleware handler
   *
   * Execution flow:
   * 1. Check if Origin header present (if not, skip CORS)
   * 2. Advertise that the response varies by Origin (unless the config is the literal '*')
   * 3. Validate origin - when it is not allowed, emit no CORS headers and carry on
   * 4. Handle preflight OPTIONS → return 204 No Content
   * 5. Set CORS headers for actual request → call next()
   *
   * A disallowed origin is *not* answered with 403. CORS is a policy the browser enforces on
   * behalf of the user, not an access-control decision the server makes: the correct denial is a
   * normal response with no `Access-Control-Allow-Origin`, which the browser then refuses to
   * expose. Rejecting outright also turned away every non-browser caller that happens to send an
   * Origin header - server-to-server clients, proxies, webviews - and forced applications to
   * register this middleware conditionally when CORS was already terminated at the ingress.
   *
   * @param context - Ergenecore context wrapper
   * @param next - Function to call next middleware or handler
   * @returns Response for preflight, or result of next() for actual requests
   */
  public async handle(context: Context, next: () => Promise<void>): Promise<any> {
    const origin = context.req.headers.get('Origin');

    // If no Origin header, this is not a CORS request → skip
    if (!origin) {
      return await next();
    }

    const allowedOrigin = this.getAllowedOrigin(origin);

    // Any config but the literal '*' makes the response depend on the request's Origin, so a
    // shared cache must key on it or it hands one origin's response to another. Refusals too.
    if (this.origin !== '*') {
      this.appendVaryOrigin(context);
    }

    if (allowedOrigin) {
      context.setResponseHeader('Access-Control-Allow-Origin', allowedOrigin);

      if (this.credentials) {
        context.setResponseHeader('Access-Control-Allow-Credentials', 'true');
      }

      if (this.exposedHeaders) {
        context.setResponseHeader('Access-Control-Expose-Headers', this.exposedHeaders);
      }
    }

    // Handle preflight OPTIONS request
    if (context.req.method === 'OPTIONS') {
      if (allowedOrigin) {
        context.setResponseHeader('Access-Control-Allow-Methods', this.methods);
        context.setResponseHeader('Access-Control-Allow-Headers', this.allowedHeaders);
        context.setResponseHeader('Access-Control-Max-Age', this.maxAge);
      }

      // Accumulated headers, not a fresh object, so what an earlier middleware set survives the 204.
      const headers: Record<string, string> = {};

      (context.res.headers as Map<string, string>).forEach((value, key) => {
        headers[key] = value;
      });

      return new Response(null, { status: 204, headers });
    }

    // For actual requests, continue to handler
    return await next();
  }

  /**
   * Adds `Origin` to the response's `Vary` header, keeping whatever is already listed.
   *
   * Appends rather than sets so an upstream `Vary: Accept-Encoding` survives, and skips the
   * append when `Origin` is already listed - a duplicate entry would only confuse caches.
   */
  private appendVaryOrigin(context: Context): void {
    const existing = (context.res.headers as Map<string, string>).get('Vary');

    const alreadyListed = existing
      ?.split(',')
      .map((value) => value.trim().toLowerCase())
      .includes('origin');

    if (!alreadyListed) {
      context.appendResponseHeader('Vary', 'Origin');
    }
  }

  /**
   * Determines the allowed origin value for the response
   *
   * Performance:
   * - Fast path for '*' (most common case)
   * - Array.includes() for string array (O(n) but n is typically small)
   * - Function call for dynamic validation
   *
   * @param requestOrigin - Origin from request header
   * @returns Allowed origin string or null if not allowed
   */
  private getAllowedOrigin(requestOrigin: string): string | null {
    // Fast path: Allow all origins
    if (this.origin === '*') {
      return '*';
    }

    // Array of specific origins
    if (Array.isArray(this.origin)) {
      return this.origin.includes(requestOrigin) ? requestOrigin : null;
    }

    // Function-based validation
    if (typeof this.origin === 'function') {
      return this.origin(requestOrigin) ? requestOrigin : null;
    }

    return null;
  }
}
