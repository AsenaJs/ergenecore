import type { WebsocketRouteParams } from '@asenajs/asena/adapter';
import {
  AsenaAdapter,
  type AsenaServeOptions,
  type AsenaStartOptions,
  type BaseMiddleware,
  type BaseStaticServeParams,
  type ErrorHandler,
  type NotFoundHandler,
  isHttpException,
  type RouteParams,
  VALIDATOR_METHODS,
  type ValidatorHandler,
  ASENA_CONTEXT_CONTRACT,
  assertContextAdapter,
  assertRouteContract,
  prepareContextValidation,
  type ContractContextClass,
} from '@asenajs/asena/adapter';
import { blue, green, red, type ServerLogger, yellow } from '@asenajs/asena/logger';
import type { GlobalMiddlewareConfig } from '@asenajs/asena/server/config';
import { ErgenecoreWebsocketAdapter } from './ErgenecoreWebsocketAdapter';
import { type Context, ErgenecoreContextWrapper } from './ErgenecoreContextWrapper';
import type { Server } from 'bun';
import * as Bun from 'bun';
import * as path from 'path';
import type { StaticServeExtras, ValidationSchema, ValidationSchemaWithHook } from './types';
import { HttpException, ValidationError } from './errors';
import { shouldApplyMiddleware } from '@asenajs/asena/utils';
import { regularFileStats, StaticFileReader, staticFileHeaders } from './utils/staticFileReader';
import type { Stats } from 'fs';

/**
 * Static response headers for performance
 *
 * Pre-allocated header objects to avoid creating new objects for each response.
 * This reduces garbage collection pressure and improves performance.
 */
const STATIC_JSON_HEADERS = Object.freeze({ 'Content-Type': 'application/json' });

/**
 * Pre-Serialise Body for 404/500
 */
const INTERNAL_SERVER_ERROR = JSON.stringify({ error: 'Internal Server Error' });
const NOT_FOUND = JSON.stringify({ error: 'Not Found' });

const JSON_HEADERS = new Headers(STATIC_JSON_HEADERS);

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value instanceof Promise ||
    (value !== null &&
      (typeof value === 'object' || typeof value === 'function') &&
      typeof (value as PromiseLike<unknown>).then === 'function')
  );
}

const JSON_INIT: ResponseInit = { headers: JSON_HEADERS };

function toHandlerResponse(response: unknown): Response {
  if (response instanceof Response) {
    return response;
  }

  return new Response(JSON.stringify(response), JSON_INIT);
}

function resolveStaticPath(root: string, rewrittenPath: string): string {
  // 3. Build absolute file path
  const filePath = path.join(root, rewrittenPath);

  // 4. Security: Resolve and validate path to prevent traversal attacks
  return path.sep !== '/' || filePath.charCodeAt(0) !== 47
    ? path.resolve(filePath)
    : filePath.length > 1 && filePath.endsWith('/')
      ? filePath.slice(0, -1)
      : filePath;
}

function isNormalizedRelativePath(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }

  let segmentStart = value.charCodeAt(0) === 47 ? 1 : 0;

  for (let i = segmentStart; i <= value.length; i++) {
    if (i < value.length && value.charCodeAt(i) !== 47) {
      continue;
    }

    const length = i - segmentStart;

    if (
      length === 0 ||
      (value.charCodeAt(segmentStart) === 46 && (length === 1 || (length === 2 && value.charCodeAt(i - 1) === 46)))
    ) {
      return false;
    }

    segmentStart = i + 1;
  }

  return true;
}

function requestPathname(url: string): string {
  const authority = url.indexOf('//');
  const start = authority === -1 ? -1 : url.indexOf('/', authority + 2);

  if (start === -1) {
    return new URL(url).pathname;
  }

  for (let i = start; i < url.length; i++) {
    const code = url.charCodeAt(i);

    if (code === 63 || code === 35) {
      return url.slice(start, i);
    }
  }

  return start === 0 ? url : url.slice(start);
}

interface ValidationStep {
  target: (typeof VALIDATOR_METHODS)[number];
  handle: () =>
    | ValidationSchemaWithHook
    | ValidationSchema
    | undefined
    | Promise<ValidationSchemaWithHook | ValidationSchema | undefined>;
  extract: (context: Context) => Promise<unknown> | unknown;
  prepared?: { schema: ValidationSchema; hook: ValidationSchemaWithHook['hook'] | null };
  cachedResolved: boolean;
}

/**
 * CoreAdapter - Native Bun adapter for Asenajs
 *
 * High-performance HTTP adapter using Bun's native APIs exclusively:
 * - SIMD-accelerated routing
 * - Native Request/Response
 * - Zero framework overhead
 * - Built-in parameter extraction
 */
export class Ergenecore extends AsenaAdapter<Context, ValidationSchemaWithHook | ValidationSchema> {
  /**
   * Adapter name
   */
  public name = 'Ergenecore';

  /**
   * Server port (inherited from AsenaAdapter but needs override for initialization)
   */
  protected port = 3000;

  /**
   * Server hostname
   */
  private _hostname;

  /**
   * Bun server instance
   */
  private server!: Server<any>;

  /**
   * Route queue for deferred registration
   * Routes are queued during initialization and built when server starts
   */
  private routeQueue: RouteParams<Context, ValidationSchemaWithHook>[] = [];

  /**
   * WebSocket route queue for deferred registration
   * WebSocket routes are queued during initialization and built when server starts
   */
  private wsRouteQueue: WebsocketRouteParams<Context>[] = [];

  /**
   * Flag to track if routes have been built
   */
  private routesBuilt = false;

  /**
   * Error handler function
   */
  private errorHandler?: ErrorHandler<Context>;

  /**
   * Handler for requests that matched no route
   */
  private notFoundHandler?: NotFoundHandler<Context>;

  private readonly staticFileReader = new StaticFileReader();

  /**
   * Whether the adapter logs errors before handing them to the application.
   * Set false when your own handler already logs with a correlation id.
   */
  private readonly logErrors: boolean = true;

  /**
   * Global middlewares with route configuration
   * Structure: Array<{ middleware, config }>
   * Config is optional - if not provided, middleware applies to all routes
   */
  private globalMiddlewares: {
    middleware: BaseMiddleware<Context>;
    config?: GlobalMiddlewareConfig['routes'];
  }[] = [];

  /**
   * HTML routes for FrontendController pages
   * Stored separately and merged into Bun.serve() routes at start time
   */
  private htmlRoutes = new Map<string, unknown>();

  /**
   * Queue of FrontendController route metadata for deferred logging at start time
   */
  private frontEndRouteQueue: { path: string; controllerName: string; controllerBasePath: string }[] = [];

  private options: AsenaServeOptions = {} satisfies AsenaServeOptions;

  /**
   * Creates a new CoreAdapter instance
   *
   * @param logger - Server logger instance
   * @param websocketAdapter - WebSocket adapter instance (optional)
   */
  public constructor(logger: ServerLogger, websocketAdapter?: ErgenecoreWebsocketAdapter, logErrors = true) {
    // Call parent constructor with logger and websocketAdapter
    super(logger, websocketAdapter || new ErgenecoreWebsocketAdapter(logger));

    this.logErrors = logErrors;
  }

  /**
   * Registers a WebSocket route (deferred registration)
   *
   * Routes are queued and will be built into Bun's native router format
   * when the server starts. Supports middleware chain execution before
   * WebSocket upgrade.
   *
   * @param params - WebSocket route parameters (path, middlewares, websocketService)
   *
   * @example
   * ```typescript
   * adapter.registerWebsocketRoute({
   *   path: '/chat',
   *   middlewares: [authMiddleware],
   *   websocketService: chatService
   * });
   * ```
   */
  public async registerWebsocketRoute(params: WebsocketRouteParams<Context>): Promise<void> {
    // Queue WebSocket route for building during start()
    this.wsRouteQueue.push(params);

    // Register WebSocket service with adapter using the route path (not namespace)
    if (this.websocketAdapter && params.websocketService) {
      await this.websocketAdapter.registerWebSocket(params.websocketService);
    }
  }

  /**
   * Sets the server port
   *
   * @param port - Port number
   */
  public setPort(port: number): void {
    this.port = port;
  }

  /**
   * Registers a global middleware with optional pattern matching
   *
   * @param middleware - Middleware instance
   * @param config - Optional route configuration for pattern matching
   *
   * @example
   * ```typescript
   * // Old API (still supported) - applies to all routes
   * adapter.use(loggerMiddleware);
   *
   * // New API with pattern matching - applies only to matching routes
   * adapter.use(authMiddleware, {
   *   include: ['/api/*', '/admin/*'],
   *   exclude: ['/api/health']
   * });
   * ```
   */
  /**
   * Registers an HTML route for FrontendController pages.
   * HTML routes bypass the middleware chain and are served directly by Bun.serve().
   *
   * @param path - Full URL path (e.g., '/ui/home')
   * @param htmlBundle - The HTML bundle returned by importing an .html file
   */
  public registerHTMLRoute(
    path: string,
    htmlBundle: unknown,
    controllerName: string,
    controllerBasePath: string,
  ): void {
    if (this.htmlRoutes.has(path)) {
      throw new Error(`Duplicate HTML route: "${path}" is already registered.`);
    }

    this.htmlRoutes.set(path, htmlBundle);
    this.frontEndRouteQueue.push({ path, controllerName, controllerBasePath });

    // Register trailing slash variant for consistent routing
    // e.g., /ui → also register /ui/ (or vice versa)
    if (path !== '/' && !path.endsWith('/')) {
      this.htmlRoutes.set(`${path}/`, htmlBundle);
    } else if (path !== '/' && path.endsWith('/')) {
      this.htmlRoutes.set(path.slice(0, -1), htmlBundle);
    }
  }

  public use(middleware: BaseMiddleware<Context>, config?: GlobalMiddlewareConfig['routes']): void {
    this.globalMiddlewares.push({ middleware, config });
  }

  /**
   * Registers a route (deferred registration)
   *
   * Routes are queued and will be built into Bun's native router format
   * when the server starts.
   *
   * @param params - Route parameters
   *
   * @example
   * ```typescript
   * adapter.registerRoute({
   *   method: HttpMethod.GET,
   *   path: '/users/:id',
   *   middlewares: [],
   *   handler: async (ctx) => ctx.send({ id: ctx.getParam('id') })
   * });
   * ```
   */
  public registerRoute(params: RouteParams<Context, ValidationSchemaWithHook>): void {
    const label = `${params.method} ${params.path}`;
    if (params.validatorCache !== undefined && typeof params.validatorCache !== 'boolean') {
      throw new Error(`${label}: validatorCache must be a boolean`);
    }
    assertRouteContract(params, params.contextClass, label);
    assertContextAdapter(params.contextClass, 'ergenecore');
    this.routeQueue.push(params);
  }

  /**
   * Starts the Bun server
   *
   * Builds routes from queue (HTTP + WebSocket) and starts Bun.serve() with native router.
   *
   * Process:
   * 1. Build HTTP routes from route queue
   * 2. Build WebSocket routes from WebSocket route queue
   * 3. Check for path collisions (HTTP GET vs WebSocket GET)
   * 4. Merge HTTP and WebSocket routes
   * 5. Prepare WebSocket adapter
   * 6. Start Bun server with merged routes
   *
   * @param port - Optional port to override default
   * @returns Bun server instance
   */
  public async start(portOrOptions?: number | AsenaStartOptions): Promise<Server<any>> {
    // A bare port keeps the original signature working; AsenaServer passes start options
    const explicitPort = typeof portOrOptions === 'number' ? portOrOptions : undefined;
    const startOptions: AsenaStartOptions = typeof portOrOptions === 'object' ? portOrOptions : {};

    // Build routes if not built yet
    const serverHostname = this._hostname;

    if (!this.routesBuilt) {
      // 1. Build HTTP routes
      const httpRoutes = await this.buildBunRoutes();

      // 2. Build WebSocket routes
      const wsRoutes = this.buildWebSocketRoutes();

      // 3. Check for path collisions
      this.checkPathCollisions(httpRoutes, wsRoutes);

      // 4. Merge routes
      const finalRoutes = this.mergeRoutes(httpRoutes, wsRoutes);

      // 4.5. Merge HTML routes (FrontendController pages)
      for (const [htmlPath, htmlBundle] of this.htmlRoutes) {
        if (finalRoutes[htmlPath]) {
          throw new Error(
            `HTML route collision at "${htmlPath}": path already registered as an API or WebSocket route.`,
          );
        }

        finalRoutes[htmlPath] = htmlBundle;
      }

      // 5. Prepare WebSocket before starting server
      await this.websocketAdapter.prepareWebSocket(this.options.wsOptions);

      const serverPort = explicitPort ?? this.port;

      // 6. Start Bun server with merged routes
      const serveConfig: any = {
        ...this.options.serveOptions,
        routes: finalRoutes,
        websocket: this.websocketAdapter.websocket,
      };

      if (startOptions.unix) {
        // Bun throws "Cannot specify both hostname and unix", and a port means nothing here
        serveConfig.unix = startOptions.unix;
        delete serveConfig.hostname;
        delete serveConfig.port;
      } else {
        serveConfig.port = serverPort;
        serveConfig.hostname = serverHostname;
      }

      this.server = Bun.serve(serveConfig);

      // Start WebSocket server (initializes AsenaWebSocketServer for each namespace)
      await this.websocketAdapter.startWebsocket(this.server);

      this.routesBuilt = true;

      // Log controller summary first
      if (this.routeQueue.length > 0 || this.wsRouteQueue.length > 0 || this.frontEndRouteQueue.length > 0) {
        this.logControllerSummary();

        // Then log detailed route list
        this.logger.info(this.buildControllerBasedLog());
      } else {
        this.logger.info('No routes registered');
      }
    }

    const hostDisplay = serverHostname || 'localhost';

    this.logger.info(
      startOptions.unix
        ? `Server ready → unix:${startOptions.unix}`
        : `Server ready → http://${hostDisplay}:${this.server.port}`,
    );

    return this.server;
  }

  /**
   * Stops the server
   *
   * The HTTP socket closes first and the WebSocket layer second - the reverse of the order
   * start() brought them up, since the transport is initialised *after* Bun.serve(). A close
   * handler running during the drain may still broadcast, so the transport has to outlive the
   * sockets that use it.
   *
   * @param closeActiveConnections - Whether to close active connections
   */
  public async stop(closeActiveConnections = true): Promise<void> {
    try {
      if (this.server) {
        await this.server.stop(closeActiveConnections);
        this.logger.info('Server stopped');
      }
    } finally {
      this.staticFileReader.close();

      // In a `finally`, and swallowed: `AsenaServer.runStop()` awaits this call unguarded, so an
      // error escaping here would strand everything queued behind it - the components' @OnStop
      // hooks, the microservice transports, ulak. A WebSocket layer that cannot let go of a
      // broker connection is worth a log line, not a shutdown that stops halfway. And a socket
      // that refuses to close must not be able to keep the transport open either.
      try {
        // The cast is the constructor's guarantee: `websocketAdapter` is declared on the base as
        // `AsenaWebsocketAdapter`, which has no shutdown() of its own, but Ergenecore only ever
        // accepts - or defaults to - an ErgenecoreWebsocketAdapter.
        await (this.websocketAdapter as ErgenecoreWebsocketAdapter).shutdown();
      } catch (error) {
        this.logger.error('WebSocket shutdown failed, continuing with shutdown:', error);
      }
    }
  }

  /**
   * Sets the error handler
   *
   * @param errorHandler - Error handler function
   */
  public onError(errorHandler: ErrorHandler<Context>): void {
    this.errorHandler = errorHandler;
  }

  /**
   * Registers the handler for requests that match no route.
   *
   * Separate from {@link onError}: a missing route is a routing outcome, not a thrown error.
   */
  public onNotFound(notFoundHandler: NotFoundHandler<Context>): void {
    this.notFoundHandler = notFoundHandler;
  }

  /**
   * Sets serve options
   *
   * @param options - Serve options function
   */
  public async serveOptions(options: () => Promise<AsenaServeOptions> | AsenaServeOptions): Promise<void> {
    this.options = await options();
  }

  /**
   * Builds Bun native router object from queued routes
   *
   * Optimizations applied:
   * 1. Base path extraction - Groups routes by static base path
   * 2. Common middleware detection - Identifies shared middlewares per group
   * 3. Middleware deduplication - Reduces redundant middleware execution
   *
   * Converts Asena route format to Bun's native router format:
   * ```typescript
   * {
   *   "/users": {
   *     GET: (req) => Response,
   *     POST: (req) => Response
   *   },
   *   "/users/:id": {
   *     GET: (req) => Response
   *   }
   * }
   * ```
   *
   * @returns Bun router object
   */
  private async buildBunRoutes(): Promise<Record<string, any>> {
    const routes: Record<string, any> = {};

    // Group routes by exact path. There used to be an outer grouping by *base* path too, but
    // its only product was a `commonMiddlewares` array that createRouteHandler ignored - and
    // the comparison behind it was broken anyway (see the removed extractCommonMiddlewares in
    // HonoAdapter, where the same code was live and swapped guards between sibling routes).
    const routesByPath = new Map<string, RouteParams<Context, ValidationSchemaWithHook>[]>();

    for (const route of this.routeQueue) {
      if (!routesByPath.has(route.path)) {
        routesByPath.set(route.path, []);
      }

      routesByPath.get(route.path).push(route);
    }

    // Build Bun router object for each path
    for (const [path, pathRoutes] of routesByPath) {
      // Normalize trailing slash to support both variants
      // This ensures /users and /users/ both work with query params
      const normalizedPath = path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path;
      const pathWithSlash = normalizedPath === '/' ? '/' : `${normalizedPath}/`;

      // Initialize both path variants (skip duplicate for root path)
      routes[normalizedPath] = routes[normalizedPath] || {};
      if (normalizedPath !== '/') {
        routes[pathWithSlash] = routes[pathWithSlash] || {};
      }

      for (const route of pathRoutes) {
        const method = route.method.toUpperCase();
        const contextClass = route.contextClass as ContractContextClass<Context> | undefined;
        const validateContract = contextClass
          ? prepareContextValidation(route.contextContract ?? contextClass[ASENA_CONTEXT_CONTRACT])
          : undefined;
        const validationSteps = route.validator ? await this.prepareValidationSteps(route) : [];

        const hasGlobalMiddlewares =
          normalizedPath === '/*'
            ? this.globalMiddlewares.length > 0
            : this.getGlobalMiddlewaresForPath(route.path).length > 0;

        // Check if route is simple (no middleware, validation, or static serve)
        const isSimpleRoute =
          !hasGlobalMiddlewares &&
          (!route.middlewares || route.middlewares.length === 0) &&
          !route.validator &&
          !validateContract &&
          !route.staticServe;

        // Create handler based on route complexity
        const handler = isSimpleRoute
          ? this.createFastPathHandler(route)
          : this.createRouteHandler(route, validateContract, validationSteps);

        // Register handler to both path variants for trailing slash support
        if (method === 'ALL') {
          // Bun native: direct handler function matches all HTTP methods
          routes[normalizedPath] = handler;
          if (normalizedPath !== '/') {
            routes[pathWithSlash] = handler;
          }
        } else {
          routes[normalizedPath][method] = handler;
          if (normalizedPath !== '/') {
            routes[pathWithSlash][method] = handler;
          }
        }
      }
    }

    // Catch-all handler for unmatched routes (including OPTIONS preflight)
    // Runs global middlewares so CORS and other cross-cutting concerns work for all requests
    const unmatched = async (req: Request): Promise<Response> => {
      const context = new ErgenecoreContextWrapper(req, this.server);
      const requestPath = new URL(req.url).pathname;

      // Wrapped like every other request path. Without this a global middleware throwing on an
      // unmatched route - an auth middleware raising HttpException(401), or getBody() rejecting a
      // malformed payload - escaped the handler entirely: onError never saw it, nothing was
      // logged, and the caller got Bun's own 500 page instead of the adapter's envelope.
      try {
        // Filter and run applicable global middlewares
        const applicableMiddlewares = this.globalMiddlewares
          .filter(({ config }) => shouldApplyMiddleware(requestPath, config))
          .map(({ middleware }) => middleware);

        if (applicableMiddlewares.length > 0) {
          // The 404 is produced as the chain's *terminal step*, the same way a matched route runs
          // its handler. Producing it after the chain had already unwound meant a global
          // middleware's post-`next()` code observed the request before any status existed -
          // `@asenajs/asena-otel` reads `context.res.status` there, so every unmatched route was
          // recorded with no `http.response.status_code`.
          const result = await this.executeMiddlewares(context, applicableMiddlewares, 0, () =>
            this.respondToUnmatched(context, requestPath, req.method),
          );

          if (result instanceof Response) return context.applyMiddlewareHeaders(result);

          if (result === false) {
            return context.applyMiddlewareHeaders(new Response('Forbidden', { status: 403 }));
          }
        }

        // Reached when no global middleware applies, or when one short-circuited without calling
        // next(). The application's onNotFound, or the default 404.
        return context.applyMiddlewareHeaders(await this.respondToUnmatched(context, requestPath, req.method));
      } catch (error) {
        return context.applyMiddlewareHeaders(await this.respondToError(error, context));
      }
    };

    const userCatchAll = routes['/*'];

    if (userCatchAll === undefined) {
      routes['/*'] = unmatched;
    } else if (typeof userCatchAll !== 'function') {
      const handlers: Record<string, ((req: Request) => Response | Promise<Response>) | undefined> = Object.assign(
        Object.create(null),
        { HEAD: userCatchAll.GET },
        userCatchAll,
      );

      routes['/*'] = (req: Request) => (handlers[req.method] ?? unmatched)(req);
    }

    return routes;
  }

  /**
   * Builds WebSocket routes from queued WebSocket route registrations
   *
   * Converts Asena WebSocket route format to Bun's native router format
   * with middleware chain support. Each WebSocket route creates a GET
   * handler that executes middlewares before attempting WebSocket upgrade.
   *
   * @returns Bun router object for WebSocket routes
   *
   * @example
   * ```typescript
   * // Returns:
   * {
   *   "/chat": {
   *     GET: (req) => Response | undefined // upgrade handler with middlewares
   *   }
   * }
   * ```
   */
  private buildWebSocketRoutes(): Record<string, any> {
    const routes: Record<string, any> = {};

    for (const wsRoute of this.wsRouteQueue) {
      // Normalize path - ensure it starts with /
      const path = wsRoute.path.startsWith('/') ? wsRoute.path : `/${wsRoute.path}`;

      // Initialize path object
      routes[path] = routes[path] || {};

      // Add GET handler for WebSocket upgrade (with middleware chain)
      routes[path].GET = this.createWebSocketUpgradeHandler(wsRoute);
    }

    return routes;
  }

  /**
   * Answers a request nothing served: an unmatched route, or a static file that does not exist.
   *
   * Both go through the application's `onNotFound` so an app has one place to shape its 404,
   * and both fall back to the same JSON envelope the hono adapter uses.
   *
   * Deliberately NOT routed to `onError` - that hook is for errors the application threw.
   */
  private async respondToUnmatched(context: Context, path: string, method: string): Promise<Response> {
    const response = await this.resolveUnmatchedResponse(context, path, method);

    // Record the status on the context before answering. An unmatched request never reaches a
    // route handler, so nothing else writes it - and `OtelTracingMiddleware` reads
    // `context.res.status` to attribute both the span and the request metrics. Without this every
    // 404 was recorded with no `http.response.status_code` at all, which is exactly the traffic
    // (bots, probes, typo'd paths) an operator most wants to count.
    context.res.status = response.status;

    return response;
  }

  private async resolveUnmatchedResponse(context: Context, path: string, method: string): Promise<Response> {
    if (this.notFoundHandler) {
      try {
        const response = await this.notFoundHandler(context, { path, method });

        if (response instanceof Response) {
          return response;
        }
      } catch (error) {
        // onNotFound must not be able to take the server down.
        this.logger.error('onNotFound threw an error, using the default response:', error);
      }
    }

    this.logUnmatched(path, method);

    return new Response(NOT_FOUND, {
      status: 404,
      headers: STATIC_JSON_HEADERS,
    });
  }

  /**
   * Records a request the framework itself answered with a 404.
   *
   * Only reached when the application has no `onNotFound`, or when its hook declined or threw -
   * an application that answered its own 404 already knows about the request. Without this an
   * unmatched route was the one outcome that produced no output at any level, which is exactly
   * the traffic (bots, probes, a typo in a deployed client) an operator needs to see.
   *
   * `info`, not `warn`: a scanner walking /wp-admin, /.env and /phpmyadmin must not be able to
   * fill the warning stream. Not `debug` either - a 404 nobody can see is how a mistyped route
   * survives to production.
   */
  private logUnmatched(path: string, method: string): void {
    if (this.logErrors === false) return;

    this.logger.info('Route not found:', { path, method, status: 404 });
  }

  /**
   * Logs an error before the application's handler sees it, at a level that matches the
   * response the caller will get.
   *
   * This adapter used to log only when NO error handler was registered - which is to say,
   * never in a real application, since every app configures `onError`. A 500 answered
   * nothing to stdout and the stack was gone. The level split mirrors the hono adapter:
   * 5xx is ours to fix and gets a stack, 4xx is the caller's and would otherwise let a bot
   * scanning for /wp-admin flood the error stream.
   */
  private logHandledError(error: unknown, context: Context): void {
    if (this.logErrors === false) return;

    // Brand check, not `instanceof` - it must agree with the `isHttpException` respondToError
    // uses, or a correctly answered 401 is still logged here as a 500 with a full stack.
    const status = isHttpException(error) ? error.status : 500;
    const isServerError = status >= 500;

    const meta = {
      // A thrown non-Error is rare but legal, and `String(value)` on a plain object yields
      // "[object Object]" - which tells an operator nothing. Serialise it instead.
      message: error instanceof Error ? error.message : JSON.stringify(error),
      path: new URL(context.req.url).pathname,
      method: context.req.method,
      status,
      ...(isServerError && error instanceof Error ? { stack: error.stack } : {}),
    };

    if (isServerError) {
      this.logger.error('Application error occurred:', meta);

      return;
    }

    // `debug` is optional on ServerLogger - read it structurally and fall back to info.
    const debug = (this.logger as { debug?: (message: string, meta?: unknown) => void }).debug;

    (debug ?? this.logger.info).call(this.logger, 'Request rejected:', meta);
  }

  /**
   * Produces the response for a thrown error, in the same order the hono adapter uses.
   *
   * The application's handler gets first refusal on *every* error, `HttpException` included.
   * Previously each catch block answered an `HttpException` straight from `getResponse()` and
   * only consulted `errorHandler` for everything else, so an app could not reshape its own
   * 401/403/404 envelopes. Worse, only one of the five catch blocks carried the
   * `!isValidationError` exemption, so a `ValidationError` thrown on the fast path never
   * reached `onError` at all - the exact opposite of why ValidationError exists.
   *
   * Falls back to the exception's own response (or a 500) when there is no handler, when the
   * handler returns nothing, or when the handler itself throws.
   */
  private async respondToError(error: unknown, context: Context): Promise<Response> {
    if (this.errorHandler) {
      try {
        const response = await this.errorHandler(error as Error, context);

        if (response instanceof Response) {
          // The application answered. Its handler is where this error gets recorded, with
          // whatever correlation id the application carries - a second line from here would
          // only duplicate it.
          return response;
        }
      } catch (handlerError) {
        this.logger.error('Error handler threw an error, using the default response:', handlerError);
      }
    }

    // Reached when there is no handler, when it declined, or when it threw - in every one of
    // those the framework is answering, so it is the framework's job to say what happened.
    // Without this, an `onError` that returns nothing swallows a 500 with no trace anywhere.
    this.logHandledError(error, context);

    // Branded check, not `instanceof`: with two resolved copies of this package `instanceof`
    // answers false and every deliberate 401/403/404 silently becomes the generic 500 below.
    if (isHttpException(error)) {
      // `getResponse` is optional on the contract - the brand guarantees `status` and nothing
      // more, so a foreign exception type that carries only the brand is legal. Calling it
      // unconditionally turned such an exception into a TypeError thrown from inside the error
      // path, which is the one place an application cannot recover from.
      if (typeof error.getResponse === 'function') {
        return error.getResponse();
      }

      // Answer from what the contract does guarantee, and nothing more. An exception that reaches
      // here is by definition one this adapter does not understand, so its message is not known to
      // be safe to echo - the same reasoning as the generic 500 below. The status is honoured
      // because that part *is* in the contract, and collapsing a deliberate 429 to a 500 is the
      // failure the brand exists to prevent.
      return new Response(INTERNAL_SERVER_ERROR, {
        status: error.status,
        headers: STATIC_JSON_HEADERS,
      });
    }

    // Never echo the thrown message. An unhandled 500 is by definition something the application
    // did not anticipate, and its message routinely carries a connection string, a file path or a
    // driver's raw complaint. The message is not lost - `logHandledError` above wrote it with a
    // stack. An application that wants to say more declares `onError`.
    return new Response(INTERNAL_SERVER_ERROR, {
      status: 500,
      headers: STATIC_JSON_HEADERS,
    });
  }

  /**
   * Executes middleware chain with recursive next() pattern
   *
   * Middlewares can control execution flow by:
   * - Calling await next() to proceed to next middleware
   * - Returning false to stop pipeline (403 response)
   * - Returning Response to send custom response and stop pipeline
   * - Throwing HttpException to send custom HTTP error response
   * - Throwing error to trigger error handler
   *
   * @param context - Request context
   * @param middlewares - Array of middlewares to execute
   * @param index - Current middleware index (internal)
   * @returns Promise<boolean | Response> - true to continue, false to stop with 403, Response to send custom response
   *
   * @example
   * ```typescript
   * const result = await this.executeMiddlewares(context, globalMiddlewares);
   * if (result === false) {
   *   return new Response('Forbidden', { status: 403 });
   * }
   * if (result instanceof Response) {
   *   return result;
   * }
   * ```
   */
  private async executeMiddlewares(
    context: Context,
    middlewares: BaseMiddleware<Context>[],
    index = 0,
    onComplete?: () => Response | boolean | void | Promise<Response | boolean | void>,
  ): Promise<boolean | Response> {
    // Base case: all middlewares executed successfully
    if (index >= middlewares.length) {
      if (onComplete) {
        const result = await onComplete();

        if (result instanceof Response) return result;

        if (result === false) return false;
      }

      return true;
    }

    const middleware = middlewares[index];

    let downstream: Promise<boolean | Response> | undefined;

    const next = async (): Promise<void> => {
      downstream ??= this.executeMiddlewares(context, middlewares, index + 1, onComplete);

      const result = await downstream;

      if (result instanceof Response) {
        context.res.status = result.status;
      }
    };

    const result = await middleware.handle(context, next);

    if (result instanceof Response) {
      return result;
    }

    if (result === false) {
      return false;
    }

    if (downstream !== undefined) {
      return await downstream;
    }

    return await this.executeMiddlewares(context, middlewares, index + 1, onComplete);
  }

  /**
   * Creates a WebSocket upgrade handler with middleware chain support
   *
   * The handler executes in the following order:
   * 1. Create context wrapper
   * 2. Execute global middlewares (pattern-filtered, if any return false, reject with 403)
   * 3. Execute route-specific middlewares (if any return false, reject with 403)
   * 4. Attempt WebSocket upgrade via server.upgrade()
   * 5. Return undefined if upgrade successful, error response otherwise
   *
   * @param wsRoute - WebSocket route parameters
   * @returns Bun-compatible WebSocket upgrade handler
   *
   * @example
   * ```typescript
   * const handler = createWebSocketUpgradeHandler({
   *   path: '/chat',
   *   middlewares: [authMiddleware],
   *   websocketService: chatService
   * });
   * // handler(req) => Response | undefined
   * ```
   */
  private createWebSocketUpgradeHandler(wsRoute: WebsocketRouteParams<Context>) {
    // ✅ Filter global middlewares by path pattern (ONCE during route building)
    // This happens at server startup, NOT on every request → zero runtime overhead
    const applicableGlobalMiddlewares = this.getGlobalMiddlewaresForPath(wsRoute.path);

    return async (req: Request): Promise<Response | undefined> => {
      // Built outside the try so the catch can hand it to the application's error handler,
      // the same way createRouteHandler does.
      const context = new ErgenecoreContextWrapper(req, this.server);

      try {
        // Execute filtered global middlewares with real next() chain
        if (applicableGlobalMiddlewares.length > 0) {
          const result = await this.executeMiddlewares(context, applicableGlobalMiddlewares);

          // If middleware returned a custom response, return it
          if (result instanceof Response) {
            return result;
          }

          // If middleware returned false, return 403
          if (result === false) {
            return new Response('Forbidden', { status: 403 });
          }
        }

        // Execute route-specific middlewares with real next() chain
        if (wsRoute.middlewares && wsRoute.middlewares.length > 0) {
          const result = await this.executeMiddlewares(context, wsRoute.middlewares);

          // If middleware returned a custom response, return it
          if (result instanceof Response) {
            return result;
          }

          // If middleware returned false, return 403
          if (result === false) {
            return new Response('Forbidden', { status: 403 });
          }
        }

        // Attempt WebSocket upgrade
        // Use wsRoute.path (actual route path) instead of namespace (which might be the service name)
        const upgraded = this.server.upgrade(req, {
          data: {
            path: wsRoute.path,
            id: `conn-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            values: context.getWebSocketValue(),
          } as any,
        });

        if (upgraded) {
          return undefined; // Upgrade successful
        }

        // Upgrade failed
        return new Response('WebSocket upgrade failed', { status: 500 });
      } catch (error) {
        return await this.respondToError(error, context);
      }
    };
  }

  /**
   * Checks for path collisions between HTTP and WebSocket routes
   *
   * Validates that no HTTP GET route conflicts with a WebSocket route
   * on the same path, as both use GET method for their handlers.
   *
   * @param httpRoutes - HTTP routes object from buildBunRoutes()
   * @param wsRoutes - WebSocket routes object from buildWebSocketRoutes()
   * @throws Error if collision detected
   *
   * @example
   * ```typescript
   * checkPathCollisions(
   *   { "/api/data": { GET: handler1 } },
   *   { "/api/data": { GET: wsHandler } }
   * );
   * // Throws: Route collision detected at path "/api/data": Both HTTP and WebSocket routes define GET method
   * ```
   */
  private checkPathCollisions(httpRoutes: Record<string, any>, wsRoutes: Record<string, any>): void {
    for (const wsPath of Object.keys(wsRoutes)) {
      // Check if HTTP routes have the same path
      if (httpRoutes[wsPath]) {
        // Check if HTTP route has GET method (collision with WebSocket GET)
        if (httpRoutes[wsPath].GET) {
          throw new Error(
            `Route collision detected at path "${wsPath}": Both HTTP and WebSocket routes define GET method. ` +
              `WebSocket routes use GET for upgrade handshake, so HTTP GET cannot be registered on the same path.`,
          );
        }
      }
    }
  }

  /**
   * Merges HTTP and WebSocket routes into a single router object
   *
   * Combines routes from buildBunRoutes() and buildWebSocketRoutes(),
   * ensuring that methods on the same path are properly merged.
   *
   * @param httpRoutes - HTTP routes object
   * @param wsRoutes - WebSocket routes object
   * @returns Merged routes object
   *
   * @example
   * ```typescript
   * mergeRoutes(
   *   { "/api": { POST: handler1, PUT: handler2 } },
   *   { "/api": { GET: wsHandler } }
   * );
   * // Returns: { "/api": { POST: handler1, PUT: handler2, GET: wsHandler } }
   * ```
   */
  private mergeRoutes(httpRoutes: Record<string, any>, wsRoutes: Record<string, any>): Record<string, any> {
    const merged = { ...httpRoutes };

    for (const [path, methods] of Object.entries(wsRoutes)) {
      if (merged[path]) {
        // Merge methods for existing path
        merged[path] = { ...merged[path], ...methods };
      } else {
        // Add new path
        merged[path] = methods;
      }
    }

    return merged;
  }

  /**
   * Creates a fast path handler for simple routes
   *
   * This handler is optimized for routes without:
   * - Middlewares (global or route-level)
   * - Validators
   * - Static file serving
   *
   * Benefits:
   * - Minimal object allocation
   * - No conditional checks
   * - Direct handler execution
   * - Reduced try-catch overhead
   *
   * @param route - Route parameters
   * @returns Bun-compatible fast path handler
   */
  private createFastPathHandler(route: RouteParams<Context, ValidationSchemaWithHook>) {
    // Deliberately one closure. There used to be a second, picked here by `if (!this.errorHandler)`
    // - and once both were routed through `respondToError` the two bodies were identical. It was
    // also the only place the adapter read `errorHandler` at *build* time rather than per request,
    // so a handler registered after start() would have selected the wrong closure.
    const settle = (pending: PromiseLike<unknown>, context: Context): Promise<Response> =>
      Promise.resolve(pending).then(toHandlerResponse, (error: unknown) => this.respondToError(error, context));

    const hasParams = route.path.includes(':');
    const ContextClass = (route.contextClass ?? ErgenecoreContextWrapper) as typeof ErgenecoreContextWrapper;

    // Not `async`: a synchronous handler's Response goes back to Bun without a promise.
    return (req: Request): Response | Promise<Response> => {
      let context: Context;

      try {
        context = new ContextClass(req, this.server, route.path);
      } catch (error) {
        return this.respondToError(error, new ErgenecoreContextWrapper(req, this.server, route.path));
      }

      try {
        // @ts-expect-error - Bun adds params to Request
        if (hasParams && req.params) {
          // @ts-expect-error - Bun adds params to Request
          context.setRouteParams(req.params);
        }

        const result: unknown = route.handler(context);

        if (isThenable(result)) {
          return settle(result, context);
        }

        return toHandlerResponse(result);
      } catch (error) {
        return this.respondToError(error, context);
      }
    };
  }

  /**
   * Creates a route handler function for Bun's router
   *
   * Wraps the Asena handler with:
   * - CoreContextWrapper for context abstraction
   * - Parameter injection from Bun's native parser
   * - Global and route middlewares (pattern-filtered)
   * - Error handling
   *
   * @param route - Route parameters
   * @returns Bun-compatible route handler
   */
  private createRouteHandler(
    route: RouteParams<Context, ValidationSchemaWithHook>,
    validateContract?: (context: Context) => Promise<void>,
    validationSteps: ValidationStep[] = [],
  ) {
    // A top-level `/*` answers every path, so include/exclude patterns must see the request path.
    const globalsByRequestPath = (route.path === '/*' || route.path === '/*/') && this.globalMiddlewares.length > 0;
    const middlewares = globalsByRequestPath
      ? route.middlewares || []
      : [...this.getGlobalMiddlewaresForPath(route.path), ...(route.middlewares || [])];
    // Resolved root for static file serving, computed once at startup instead of per request
    const resolvedStaticRoot = route.staticServe ? path.resolve(route.staticServe.root) : '';
    // The containment test below is a prefix comparison, so it needs the separator baked in.
    // `path.resolve` only ever leaves a trailing separator when the root *is* the filesystem
    // root, where appending another would produce `//` and reject every path.
    const resolvedStaticRootPrefix = resolvedStaticRoot.endsWith(path.sep)
      ? resolvedStaticRoot
      : `${resolvedStaticRoot}${path.sep}`;
    const joinsVerbatim =
      path.sep === '/' && typeof route.staticServe?.root === 'string' && path.isAbsolute(route.staticServe.root);
    const hasParams = route.path.includes(':');
    const ContextClass = (route.contextClass ?? ErgenecoreContextWrapper) as typeof ErgenecoreContextWrapper;

    const serveRoute = (req: Request, context: Context): Response | Promise<Response> => {
      if (route.staticServe) {
        const staticResponse = this.serveStaticFile(
          req,
          context,
          route.staticServe,
          resolvedStaticRoot,
          resolvedStaticRootPrefix,
          joinsVerbatim,
        );

        if (isThenable(staticResponse)) {
          return staticResponse.then((response) => response ?? this.runRouteHandler(route, context));
        }

        return staticResponse;
      }

      return this.runRouteHandler(route, context);
    };

    const runRoute =
      validateContract || validationSteps.length > 0
        ? async (req: Request, context: Context): Promise<Response> => {
            if (validateContract) await validateContract(context);
            if (validationSteps.length > 0) {
              const validationResult = await this.validateRequest(context, validationSteps);

              if (validationResult) return validationResult;
            }

            return serveRoute(req, context);
          }
        : serveRoute;

    return (req: Request): Response | Promise<Response> => {
      let context: Context;

      try {
        context = new ContextClass(req, this.server, route.path);
      } catch (error) {
        return this.respondToError(error, new ErgenecoreContextWrapper(req, this.server, route.path));
      }

      // Inject Bun's native route params
      // @ts-expect-error - Bun adds params to Request
      if (hasParams && req.params) {
        // @ts-expect-error - Bun adds params to Request
        context.setRouteParams(req.params);
      }

      try {
        const chain = globalsByRequestPath
          ? [...this.getGlobalMiddlewaresForPath(new URL(req.url).pathname), ...middlewares]
          : middlewares;
        const result =
          chain.length > 0
            ? this.executeMiddlewares(context, chain, 0, () => this.runRouteInChain(runRoute, req, context))
            : runRoute(req, context);

        if (isThenable(result)) {
          return this.settleRoute(context, result);
        }

        return this.finishRoute(context, result);
      } catch (error) {
        return this.failRoute(context, error);
      }
    };
  }

  private async runRouteInChain(
    runRoute: (req: Request, context: Context) => Response | Promise<Response>,
    req: Request,
    context: Context,
  ): Promise<Response> {
    try {
      return await runRoute(req, context);
    } catch (error) {
      return await this.respondToError(error, context);
    }
  }

  private runRouteHandler(
    route: RouteParams<Context, ValidationSchemaWithHook>,
    context: Context,
  ): Response | Promise<Response> {
    const response: unknown = route.handler(context);

    if (isThenable(response)) {
      return Promise.resolve(response).then(toHandlerResponse);
    }

    return toHandlerResponse(response);
  }

  private async settleRoute(context: Context, pending: PromiseLike<Response | boolean>): Promise<Response> {
    try {
      return this.finishRoute(context, await pending);
    } catch (error) {
      return await this.failRoute(context, error);
    }
  }

  private finishRoute(context: Context, result: Response | boolean): Response {
    // Single choke point so middleware headers reach handlers that answer without the
    // wrapper. Idempotent for `ctx.send()`, which merged them already.
    if (result instanceof Response) {
      return context.applyMiddlewareHeaders(result);
    }

    // If middleware chain returned false (stopped), return 403
    if (result === false) {
      return context.applyMiddlewareHeaders(new Response('Forbidden', { status: 403 }));
    }

    // Default: result is true (should not happen with onComplete, but just in case)
    return context.applyMiddlewareHeaders(new Response(null, { status: 204 }));
  }

  private async failRoute(context: Context, error: unknown): Promise<Response> {
    // The context here already has params injected, so pass it through unchanged.
    return context.applyMiddlewareHeaders(await this.respondToError(error, context));
  }

  /**
   * Type guard to check if validation schema has hook format
   *
   * Discriminates between ValidationSchemaWithHook and plain ValidationSchema.
   * Uses runtime check for 'schema' property to determine type.
   *
   * @param schema - Validation schema to check
   * @returns true if schema is ValidationSchemaWithHook format
   *
   * @example
   * ```typescript
   * if (isValidationSchemaWithHook(schema)) {
   *   // schema.schema and schema.hook are available
   * } else {
   *   // schema is a plain Zod schema
   * }
   * ```
   */
  private isValidationSchemaWithHook(
    schema: ValidationSchemaWithHook | ValidationSchema,
  ): schema is ValidationSchemaWithHook {
    return typeof schema === 'object' && schema !== null && 'schema' in schema;
  }

  /** Prepare each legacy validator target once for this route, preserving method order. */
  private async prepareValidationSteps(
    route: RouteParams<Context, ValidationSchemaWithHook>,
  ): Promise<ValidationStep[]> {
    const steps: ValidationStep[] = [];
    for (const target of VALIDATOR_METHODS) {
      const handler: ValidatorHandler<ValidationSchemaWithHook | ValidationSchema> = route.validator[target];
      if (!handler || typeof handler.handle !== 'function') continue;
      const step: ValidationStep = {
        target,
        handle: () => handler.handle(),
        extract: this.createValidationExtractor(target),
        cachedResolved: route.validatorCache !== false,
      };
      if (route.validatorCache !== false) {
        try {
          const value = await step.handle();
          if (value) step.prepared = this.unwrapValidationSchema(value);
        } catch (error) {
          throw new Error(`Failed to prepare validator for ${route.method.toUpperCase()} ${route.path} (${target})`, {
            cause: error,
          });
        }
      }
      steps.push(step);
    }
    return steps;
  }

  private unwrapValidationSchema(value: ValidationSchemaWithHook | ValidationSchema): {
    schema: ValidationSchema;
    hook: ValidationSchemaWithHook['hook'] | null;
  } {
    const schema = this.isValidationSchemaWithHook(value) ? value.schema : value;
    const hook = this.isValidationSchemaWithHook(value) ? (value.hook ?? null) : null;
    if (!schema || typeof schema.safeParseAsync !== 'function') {
      throw new TypeError('Validator factory must return a Zod schema with safeParseAsync()');
    }
    if (hook !== null && typeof hook !== 'function') {
      throw new TypeError('Validator hook must be a function');
    }
    return { schema, hook };
  }

  /**
   * Validates request data using Zod schemas
   *
   * Checks each validation target (body, query, param, header) and runs
   * the Zod schema validation. If validation fails and a hook is provided,
   * the hook is called to generate a custom error response.
   *
   * Supports two validation formats:
   * 1. Plain Zod schema: z.object({...})
   * 2. Schema with hook: { schema: z.object({...}), hook?: (...) => {...} }
   *
   * @param context - Request context
   * @param validator - Validator instance with schema definitions
   * @returns Response if validation fails, null if passes
   */
  private async validateRequest(context: Context, steps: ValidationStep[]): Promise<Response | null> {
    for (const { target: key, handle, extract, prepared, cachedResolved } of steps) {
      const handled = cachedResolved ? undefined : handle();
      const validationSchema = isThenable(handled) ? await handled : handled;

      // Skip if no validation schema provided
      if ((!cachedResolved && !validationSchema) || (cachedResolved && !prepared)) {
        continue;
      }

      // Use type guard to discriminate between formats
      const { schema, hook } = prepared ?? this.unwrapValidationSchema(validationSchema);

      // Extract data to validate
      const extracted = extract(context);
      const data = isThenable(extracted) ? await extracted : extracted;
      const result = await schema.safeParseAsync(data);

      if (result.success) {
        // Body targets only: z.object() strips unknown keys and the raw form parse is
        // last-value-wins, so without the write-back the handler reads a shape the schema
        // already replaced. query/param/header read the request and have no cache.
        if (key === 'json' || key === 'body') {
          context.setValidatedBody(result.data);
        } else if (key === 'form') {
          context.setValidatedForm(result.data);
        }

        continue;
      }

      if (hook) {
        const hookResponse = await hook(result, context);

        if (hookResponse) return hookResponse;
      }

      // Thrown, not answered here, so validation shares the same response envelope and the same
      // log line as every other error. The 400 moved onto `ValidationError.getResponse()`.
      throw new ValidationError(result.error, key);
    }

    return null;
  }

  /**
   * Extracts data from request based on validation target
   *
   * @param context - Request context
   * @param target - Validation target (body, query, param, header, form)
   * @returns Data to be validated
   */
  private createValidationExtractor(target: string): (context: Context) => Promise<any> | any {
    switch (target) {
      case 'json':
      case 'body':
        return (context) => context.getBody();

      case 'query': {
        return (context) => {
          const url = new URL(context.req.url);
          const queryObj: Record<string, string> = {};
          url.searchParams.forEach((value, key) => {
            queryObj[key] = value;
          });
          return queryObj;
        };
      }

      case 'param': {
        return (context) => {
          const params: Record<string, string> = {};
          for (const [key, value] of (context as any).values.entries()) {
            if (key.startsWith('param:')) params[key.replace('param:', '')] = value;
          }
          return params;
        };
      }

      case 'header': {
        return (context) => {
          const headers: Record<string, string> = {};
          context.req.headers.forEach((value, key) => {
            headers[key.toLowerCase()] = value;
          });
          return headers;
        };
      }

      case 'form': {
        return async (context) => {
          const contentType = context.req.headers.get('content-type') ?? '';
          if (
            !contentType.includes('multipart/form-data') &&
            !contentType.includes('application/x-www-form-urlencoded')
          ) {
            return {};
          }
          const formData = await context.getFormData();
          const form: Record<string, any> = Object.create(null);
          formData.forEach((value, key) => {
            if (key.endsWith('[]')) (form[key] ??= []).push(value);
            else if (Array.isArray(form[key])) form[key].push(value);
            else if (Object.hasOwn(form, key)) form[key] = [form[key], value];
            else form[key] = value;
          });
          return form;
        };
      }

      default:
        return () => ({});
    }
  }

  /**
   * Serves static files using Bun.file() API
   *
   * This method handles static file serving with the following features:
   * - Path rewriting via rewriteRequestPath
   * - Root directory resolution
   * - File existence checking
   * - onFound/onNotFound hooks
   * - Automatic MIME type detection (via Bun.file())
   *
   * @param req - Native Bun Request object
   * @param context - ErgenecoreContextWrapper instance
   * @param staticServe - Static serve configuration from route
   * @returns Response object if file found/not found, null if hooks override
   *
   * @example
   * ```typescript
   * const response = await this.serveStaticFile(req, context, {
   *   root: '/public',
   *   rewriteRequestPath: (path) => path.replace('/static', ''),
   *   onFound: { handler: async () => {}, override: false },
   *   onNotFound: { handler: async () => {}, override: false }
   * });
   * ```
   */
  private serveStaticFile(
    req: Request,
    context: Context,
    staticServe: BaseStaticServeParams<Context, StaticServeExtras>,
    resolvedRoot: string,
    resolvedRootPrefix: string,
    joinsVerbatim: boolean,
  ): Response | Promise<Response | null> {
    // Deliberately no try/catch. Anything thrown here - a rewriteRequestPath that raises, a
    // path.resolve or Bun.file failure - travels up to createRouteHandler's catch and through
    // `respondToError`, like every other failure. Answering it here meant the body was
    // `{"error": error.message}`, and a message thrown out of the filesystem layer is
    // specifically a deployment path; and the application's `onError` never saw it at all.

    // 1. Extract request path from URL
    const pathname = requestPathname(req.url);

    // A malformed escape - `%zz`, a lone `%` - makes decodeURIComponent throw a URIError, which
    // reached respondToError as an unbranded error: a 500, an error-level log with a stack, and
    // the application's onError handed a request the client had simply written wrong.
    let requestPath: string;

    try {
      requestPath = pathname.includes('%') ? decodeURIComponent(pathname) : pathname;
    } catch {
      throw new HttpException(400, { error: 'Bad Request' });
    }

    // 2. Apply path rewriting if provided
    const rewrittenPath = staticServe.rewriteRequestPath ? staticServe.rewriteRequestPath(requestPath) : requestPath;

    const resolvedFilePath =
      joinsVerbatim && isNormalizedRelativePath(rewrittenPath)
        ? resolvedRootPrefix + (rewrittenPath.charCodeAt(0) === 47 ? rewrittenPath.slice(1) : rewrittenPath)
        : resolveStaticPath(staticServe.root, rewrittenPath);

    // Check if resolved file path is within root directory. The separator is what makes this a
    // containment test rather than a string-prefix one: without it a root of `/srv/assets`
    // accepted `/srv/assets-private/…`, reachable through `..%2F` in the request path. The
    // equality arm keeps a request for the root itself - `GET /assets/` rewrites to `/` and
    // joins back to the root - falling through to the application's 404 rather than a 403.
    if (resolvedFilePath !== resolvedRoot && !resolvedFilePath.startsWith(resolvedRootPrefix)) {
      this.logger.warn(`Path traversal attempt detected: ${requestPath} -> ${resolvedFilePath}`);
      return new Response('Forbidden', { status: 403 });
    }

    const stats = regularFileStats(resolvedFilePath);

    if (stats !== undefined && !staticServe.onFound) {
      return this.statFileResponse(resolvedFilePath, stats, staticServe.extra, req);
    }

    return this.serveResolvedStaticFile(req, context, staticServe, pathname, rewrittenPath, resolvedFilePath, stats);
  }

  private statFileResponse(filePath: string, stats: Stats, extra: StaticServeExtras, req: Request): Response {
    if (!extra) {
      return this.staticFileReader.respond(filePath, stats, !req.headers.has('range'));
    }

    const read = this.staticFileReader.read(filePath, stats, !req.headers.has('range'));
    const headers = this.withStaticExtras(staticFileHeaders(read.type, read.etag, read.lastModified), filePath, extra);

    return new Response(read.bytes ?? Bun.file(filePath), { status: 200, headers });
  }

  private async serveResolvedStaticFile(
    req: Request,
    context: Context,
    staticServe: BaseStaticServeParams<Context, StaticServeExtras>,
    pathname: string,
    rewrittenPath: string,
    resolvedFilePath: string,
    stats: Stats | undefined,
  ): Promise<Response | null> {
    if (stats !== undefined) {
      await staticServe.onFound.handler(rewrittenPath, context);

      if (staticServe.onFound.override) {
        return null;
      }

      return this.statFileResponse(resolvedFilePath, stats, staticServe.extra, req);
    }

    this.staticFileReader.release(resolvedFilePath);

    // A path holding a NUL byte makes Bun.file() throw: a miss, not a 500.
    let file: ReturnType<typeof Bun.file> | undefined;

    try {
      file = Bun.file(resolvedFilePath);

      if (!(await file.exists())) file = undefined;
    } catch {
      file = undefined;
    }

    // 6. File not found → trigger onNotFound hook
    if (file === undefined) {
      if (staticServe.onNotFound) {
        await staticServe.onNotFound.handler(rewrittenPath, context);

        // If hook overrides, return null (let handler continue)
        if (staticServe.onNotFound.override) {
          return null;
        }
      }

      // No hook, or a hook that did not take over: fall through to the application's
      // onNotFound, exactly as an unmatched route does. This used to answer a hard-coded
      // `text/plain` 404 and never consult the config hook - so the same app produced a
      // different 404 body here than on the hono adapter, where serveStatic calls next()
      // and the request lands in app.notFound.
      return await this.respondToUnmatched(context, pathname, req.method);
    }

    // 7. File found → trigger onFound hook
    if (staticServe.onFound) {
      await staticServe.onFound.handler(rewrittenPath, context);

      // If hook overrides, return null (let handler continue)
      if (staticServe.onFound.override) {
        return null;
      }
    }

    const lastModifiedMs = file.lastModified;
    const finalHeaders = staticFileHeaders(
      file.type,
      `W/"${file.size}-${lastModifiedMs}"`,
      new Date(lastModifiedMs).toUTCString(),
    );

    return new Response(file, {
      status: 200,
      headers: this.withStaticExtras(finalHeaders, resolvedFilePath, staticServe.extra),
    });
  }

  private withStaticExtras(headers: Headers, filePath: string, extras: StaticServeExtras): Headers {
    if (extras) {
      const customHeaders = this.buildStaticFileHeaders(filePath, extras);

      for (const key in customHeaders) {
        headers.set(key, customHeaders[key]);
      }
    }

    if (!headers.has('Cache-Control')) {
      headers.set('Cache-Control', 'public, max-age=0');
    }

    return headers;
  }

  /**
   * Builds response headers for static file serving
   *
   * Constructs headers with:
   * - Content-Type (custom MIME or Bun default)
   * - Cache-Control (if specified)
   * - Custom headers (if specified)
   *
   * @param filePath - Resolved absolute file path
   * @param extras - StaticServeExtras configuration
   * @returns Headers object for Response
   *
   * @example
   * ```typescript
   * const headers = this.buildStaticFileHeaders('/app/public/style.css', {
   *   cacheControl: 'public, max-age=86400',
   *   headers: { 'X-Custom': 'value' },
   *   mimes: { '.css': 'text/css; charset=utf-8' }
   * });
   * // Returns: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': '...', 'X-Custom': 'value' }
   * ```
   */
  private buildStaticFileHeaders(filePath: string, extras: StaticServeExtras): Record<string, string> {
    const headers: Record<string, string> = {};

    if (!extras) {
      return headers;
    }

    // 1. Content-Type: Check custom MIME types first
    if (extras.mimes) {
      const ext = path.extname(filePath);
      const customMime = extras.mimes[ext];

      if (customMime) {
        headers['Content-Type'] = customMime;
      }
    }

    // Note: If no custom MIME, Bun.file() will set Content-Type automatically

    // 2. Cache-Control header
    if (extras.cacheControl) {
      headers['Cache-Control'] = extras.cacheControl;
    }

    // 3. Custom headers
    if (extras.headers) {
      for (const [key, value] of Object.entries(extras.headers)) {
        headers[key] = value;
      }
    }

    return headers;
  }

  public get hostname() {
    return this._hostname;
  }

  public set hostname(value) {
    this._hostname = value;
  }

  /**
   * Groups HTTP routes by controller name
   *
   * Creates a map of controller names to their routes for organized logging.
   * Each group contains the controller's base path and all its routes.
   *
   * @returns Map of controller names to route groups
   *
   * @example
   * ```typescript
   * groupRoutesByController()
   * // => Map {
   * //   'UserController' => {
   * //     basePath: '/users',
   * //     routes: [{ method: 'GET', path: '/users' }, { method: 'POST', path: '/users' }]
   * //   }
   * // }
   * ```
   */
  private groupRoutesByController(): Map<string, { basePath: string; routes: { method: string; path: string }[] }> {
    const groups = new Map<string, { basePath: string; routes: { method: string; path: string }[] }>();

    for (const route of this.routeQueue) {
      const controllerName = route.controllerName || 'Unknown';
      const controllerBasePath = route.controllerBasePath || '/';

      if (!groups.has(controllerName)) {
        groups.set(controllerName, {
          basePath: controllerBasePath,
          routes: [],
        });
      }

      groups.get(controllerName).routes.push({
        method: route.method.toUpperCase(),
        path: route.path,
      });
    }

    return groups;
  }

  /**
   * Groups WebSocket routes by controller name
   *
   * Creates a map of controller names to their WebSocket routes for organized logging.
   *
   * @returns Map of controller names to WebSocket route groups
   *
   * @example
   * ```typescript
   * groupWebSocketRoutesByController()
   * // => Map {
   * //   'ChatController' => {
   * //     basePath: '/chat',
   * //     routes: [{ path: '/chat' }]
   * //   }
   * // }
   * ```
   */
  private groupWebSocketRoutesByController(): Map<string, { basePath: string; routes: { path: string }[] }> {
    const groups = new Map<string, { basePath: string; routes: { path: string }[] }>();

    for (const wsRoute of this.wsRouteQueue) {
      const controllerName = wsRoute.controllerName || 'Unknown';
      const controllerBasePath = wsRoute.path; // WebSocket uses path as base path

      if (!groups.has(controllerName)) {
        groups.set(controllerName, {
          basePath: controllerBasePath,
          routes: [],
        });
      }

      groups.get(controllerName).routes.push({
        path: wsRoute.path,
      });
    }

    return groups;
  }

  /**
   * Filters global middlewares for a specific route path
   *
   * Uses pattern matching to determine which middlewares should apply to this path.
   *
   * @param path - Route path (e.g., '/api/users', '/users/:id')
   * @returns Array of middlewares that should apply to this path
   *
   * @example
   * ```typescript
   * // Given:
   * // - LoggerMiddleware (no config → applies to all routes)
   * // - AuthMiddleware (include: ['/api/*'])
   * // - RateLimitMiddleware (exclude: ['/health'])
   *
   * getGlobalMiddlewaresForPath('/api/users')
   * // => [LoggerMiddleware, AuthMiddleware, RateLimitMiddleware]
   *
   * getGlobalMiddlewaresForPath('/health')
   * // => [LoggerMiddleware, AuthMiddleware] (RateLimit excluded)
   *
   * getGlobalMiddlewaresForPath('/public/page')
   * // => [LoggerMiddleware, RateLimitMiddleware] (Auth not included)
   * ```
   */
  private getGlobalMiddlewaresForPath(path: string): BaseMiddleware<Context>[] {
    return this.globalMiddlewares
      .filter(({ config }) => shouldApplyMiddleware(path, config))
      .map(({ middleware }) => middleware);
  }

  /**
   * Logs a summary of registered controllers
   *
   * Displays colored success messages for each controller with route counts.
   * HTTP controllers show total HTTP routes, WebSocket-only controllers are
   * displayed separately.
   *
   * @example
   * Output format:
   * ```
   * ✓ Successfully registered CONTROLLER UserController (2 routes)
   * ✓ Successfully registered WEBSOCKET ChatController (1 route)
   * ```
   */
  private logControllerSummary(): void {
    const httpGroups = this.groupRoutesByController();
    const wsGroups = this.groupWebSocketRoutesByController();

    // Log HTTP controllers
    for (const [controllerName, group] of httpGroups) {
      const routeCount = group.routes.length;
      const routeText = routeCount === 1 ? 'route' : 'routes';

      this.logger.info(
        `${green('✓')} Successfully registered ${yellow('CONTROLLER')} ${blue(controllerName)} ${yellow(`(${routeCount} ${routeText})`)}`,
      );
    }

    // Log WebSocket controllers (only those that don't have HTTP routes)
    for (const [controllerName, group] of wsGroups) {
      if (!httpGroups.has(controllerName)) {
        const routeCount = group.routes.length;
        const routeText = routeCount === 1 ? 'route' : 'routes';

        this.logger.info(
          `${green('✓')} Successfully registered ${yellow('WEBSOCKET')} ${blue(controllerName)} ${yellow(`(${routeCount} ${routeText})`)}`,
        );
      }
    }

    // Log FrontendControllers
    const frontEndGroups = this.groupFrontEndRoutesByController();

    for (const [controllerName, group] of frontEndGroups) {
      const routeCount = group.routes.length;
      const routeText = routeCount === 1 ? 'route' : 'routes';

      this.logger.info(
        `${green('✓')} Successfully registered ${yellow('FRONTEND')} ${blue(controllerName)} ${yellow(`(${routeCount} ${routeText})`)}`,
      );
    }
  }

  /**
   * Builds controller-based log output with colors
   *
   * Creates a formatted string showing all routes grouped by controller,
   * with HTTP controllers listed first, then WebSocket namespaces separately.
   *
   * Color scheme:
   * - Controller name: blue
   * - Base path: yellow
   * - GET method: green
   * - POST method: blue
   * - PUT method: yellow
   * - DELETE method: red
   * - WS method: blue
   *
   * @returns Formatted log string with color codes
   *
   * @example
   * Output format:
   * ```
   *   UserController (/users):
   *     GET /users
   *     GET /users/:id
   *     POST /users
   *
   *   ChatNamespace (chat):
   *     WS /chat
   * ```
   */
  private buildControllerBasedLog(): string {
    const httpGroups = this.groupRoutesByController();
    const wsGroups = this.groupWebSocketRoutesByController();

    // Build log output with colors
    const lines: string[] = ['']; // Start with empty line for better spacing

    // 1. First, log HTTP-only controllers (sorted alphabetically)
    const httpOnlyControllers = Array.from(httpGroups.entries())
      .filter(([controllerName]) => !wsGroups.has(controllerName))
      .sort(([a], [b]) => a.localeCompare(b));

    for (const [controllerName, group] of httpOnlyControllers) {
      lines.push(`  ${blue(controllerName)} ${yellow(`(${group.basePath})`)}`);

      // Sort routes: GET first, then POST, PUT, PATCH, DELETE
      const methodOrder = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
      const sortedRoutes = group.routes.sort((a, b) => {
        const orderA = methodOrder.indexOf(a.method);
        const orderB = methodOrder.indexOf(b.method);

        return orderA - orderB;
      });

      for (const route of sortedRoutes) {
        // Colorize method based on type
        let coloredMethod = route.method;

        if (route.method === 'GET') {
          coloredMethod = green(route.method);
        } else if (route.method === 'POST') {
          coloredMethod = blue(route.method);
        } else if (route.method === 'PUT') {
          coloredMethod = yellow(route.method);
        } else if (route.method === 'DELETE') {
          coloredMethod = red(route.method);
        }

        lines.push(`    ${coloredMethod} ${route.path}`);
      }

      lines.push(''); // Empty line between controllers
    }

    // 2. Then, log mixed controllers (HTTP + WebSocket)
    const mixedControllers = Array.from(httpGroups.entries())
      .filter(([controllerName]) => wsGroups.has(controllerName))
      .sort(([a], [b]) => a.localeCompare(b));

    for (const [controllerName, group] of mixedControllers) {
      // Merge WebSocket routes into this controller
      const wsGroup = wsGroups.get(controllerName);
      const allRoutes = [...group.routes, ...wsGroup.routes.map((r) => ({ method: 'WS', path: r.path }))];

      lines.push(`  ${blue(controllerName)} ${yellow(`(${group.basePath})`)}`);

      // Sort routes: GET first, then POST, PUT, PATCH, DELETE, WS
      const methodOrder = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'WS'];
      const sortedRoutes = allRoutes.sort((a, b) => {
        const orderA = methodOrder.indexOf(a.method);
        const orderB = methodOrder.indexOf(b.method);

        return orderA - orderB;
      });

      for (const route of sortedRoutes) {
        // Colorize method based on type
        let coloredMethod = route.method;

        if (route.method === 'GET') {
          coloredMethod = green(route.method);
        } else if (route.method === 'POST') {
          coloredMethod = blue(route.method);
        } else if (route.method === 'PUT') {
          coloredMethod = yellow(route.method);
        } else if (route.method === 'DELETE') {
          coloredMethod = red(route.method);
        } else if (route.method === 'WS') {
          coloredMethod = blue(route.method);
        }

        lines.push(`    ${coloredMethod} ${route.path}`);
      }

      lines.push(''); // Empty line between controllers
    }

    // 3. Finally, log WebSocket-only namespaces
    const wsOnlyNamespaces = Array.from(wsGroups.entries())
      .filter(([controllerName]) => !httpGroups.has(controllerName))
      .sort(([a], [b]) => a.localeCompare(b));

    for (const [namespaceName, group] of wsOnlyNamespaces) {
      lines.push(`  ${blue(namespaceName)} ${yellow(`(${group.basePath})`)}`);

      for (const route of group.routes) {
        lines.push(`    ${blue('WS')} ${route.path}`);
      }

      lines.push(''); // Empty line between namespaces
    }

    // 4. Frontend controllers (HTML routes)
    const frontEndGroups = this.groupFrontEndRoutesByController();
    const sortedFrontEnd = Array.from(frontEndGroups.entries()).sort(([a], [b]) => a.localeCompare(b));

    for (const [controllerName, group] of sortedFrontEnd) {
      lines.push(`  ${blue(controllerName)} ${yellow(`(${group.basePath})`)}`);

      for (const route of group.routes) {
        lines.push(`    ${green('HTML')} ${route.path}`);
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Groups FrontendController routes by controller name for logging
   */
  private groupFrontEndRoutesByController(): Map<string, { basePath: string; routes: { path: string }[] }> {
    const groups = new Map<string, { basePath: string; routes: { path: string }[] }>();

    for (const route of this.frontEndRouteQueue) {
      if (!groups.has(route.controllerName)) {
        groups.set(route.controllerName, {
          basePath: route.controllerBasePath,
          routes: [],
        });
      }

      groups.get(route.controllerName).routes.push({ path: route.path });
    }

    return groups;
  }
}
