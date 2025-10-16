import type { WebsocketRouteParams } from '@asenajs/asena/adapter';
import {
  AsenaAdapter,
  type AsenaServeOptions,
  type BaseMiddleware,
  type BaseStaticServeParams,
  type BaseValidator,
  type ErrorHandler,
  type RouteParams,
  VALIDATOR_METHODS,
  type ValidatorHandler,
} from '@asenajs/asena/adapter';
import { blue, green, red, type ServerLogger, yellow } from '@asenajs/asena/logger';
import type { GlobalMiddlewareConfig } from '@asenajs/asena/server/config';
import { shouldApplyMiddleware } from '@asenajs/asena/utils/patternMatcher';
import { ErgenecoreWebsocketAdapter } from './ErgenecoreWebsocketAdapter';
import { type Context, ErgenecoreContextWrapper } from './ErgenecoreContextWrapper';
import type { Server } from 'bun';
import * as Bun from 'bun';
import * as path from 'path';
import type { StaticServeExtras, ValidationSchema, ValidationSchemaWithHook } from './types';
import { HttpException, MiddlewareResponseError } from './errors';

/**
 * Static response headers for performance
 *
 * Pre-allocated header objects to avoid creating new objects for each response.
 * This reduces garbage collection pressure and improves performance.
 */
const STATIC_JSON_HEADERS = Object.freeze({ 'Content-Type': 'application/json' });

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
   * Global middlewares with route configuration
   * Structure: Array<{ middleware, config }>
   * Config is optional - if not provided, middleware applies to all routes
   */
  private globalMiddlewares: Array<{
    middleware: BaseMiddleware<Context>;
    config?: GlobalMiddlewareConfig['routes'];
  }> = [];

  private options: AsenaServeOptions = {} satisfies AsenaServeOptions;

  /**
   * Creates a new CoreAdapter instance
   *
   * @param logger - Server logger instance
   * @param websocketAdapter - WebSocket adapter instance (optional)
   */
  public constructor(logger: ServerLogger, websocketAdapter?: ErgenecoreWebsocketAdapter) {
    // Call parent constructor with logger and websocketAdapter
    super(logger, websocketAdapter || new ErgenecoreWebsocketAdapter(logger));
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
  public registerWebsocketRoute(params: WebsocketRouteParams<Context>): void {
    // Queue WebSocket route for building during start()
    this.wsRouteQueue.push(params);

    // Register WebSocket service with adapter using the route path (not namespace)
    if (this.websocketAdapter && params.websocketService) {
      this.websocketAdapter.registerWebSocket(params.websocketService);
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
  public start(port?: number): Server<any> {
    // Build routes if not built yet
    const serverHostname = this._hostname;

    if (!this.routesBuilt) {
      // 1. Build HTTP routes
      const httpRoutes = this.buildBunRoutes();

      // 2. Build WebSocket routes
      const wsRoutes = this.buildWebSocketRoutes();

      // 3. Check for path collisions
      this.checkPathCollisions(httpRoutes, wsRoutes);

      // 4. Merge routes
      const finalRoutes = this.mergeRoutes(httpRoutes, wsRoutes);

      // 5. Prepare WebSocket before starting server
      this.websocketAdapter.prepareWebSocket(this.options.wsOptions);

      const serverPort = port ?? this.port;

      // 6. Start Bun server with merged routes
      this.server = Bun.serve({
        ...this.options.serveOptions,
        port: serverPort,
        hostname: serverHostname,
        routes: finalRoutes,
        websocket: this.websocketAdapter.websocket,
      } as any);

      // Start WebSocket server (initializes AsenaWebSocketServer for each namespace)
      this.websocketAdapter.startWebsocket(this.server);

      this.routesBuilt = true;

      // Log controller summary first
      if (this.routeQueue.length > 0 || this.wsRouteQueue.length > 0) {
        this.logControllerSummary();

        // Then log detailed route list
        this.logger.info(this.buildControllerBasedLog());
      } else {
        this.logger.info('No routes registered');
      }
    }

    const hostDisplay = serverHostname || 'localhost';

    this.logger.info(`Server ready → http://${hostDisplay}:${this.server.port}`);

    return this.server;
  }

  /**
   * Stops the server
   *
   * @param closeActiveConnections - Whether to close active connections
   */
  public async stop(closeActiveConnections = true): Promise<void> {
    if (this.server) {
      await this.server.stop(closeActiveConnections);
      this.logger.info('Server stopped');
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
  private buildBunRoutes(): Record<string, any> {
    const routes: Record<string, any> = {};

    // Group routes by base path for optimization
    const routeGroups = this.groupRoutesByBasePath(this.routeQueue);

    // Process each base path group
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const [_, groupRoutes] of routeGroups) {
      // Extract common middlewares for this group
      const commonMiddlewares = this.extractCommonMiddlewares(groupRoutes);

      // Group routes by exact path (same as before)
      const routesByPath = new Map<string, RouteParams<Context, ValidationSchemaWithHook>[]>();

      for (const route of groupRoutes) {
        if (!routesByPath.has(route.path)) {
          routesByPath.set(route.path, []);
        }

        routesByPath.get(route.path)!.push(route);
      }

      // Build Bun router object for each path
      for (const [path, pathRoutes] of routesByPath) {
        routes[path] = {};

        for (const route of pathRoutes) {
          const method = route.method.toUpperCase();

          // Fast Path Optimization with Pattern Matching
          // ✅ Check if this route has any applicable global middlewares
          const applicableGlobalMiddlewares = this.getGlobalMiddlewaresForPath(route.path);

          // Check if route is simple (no middleware, validation, or static serve)
          const isSimpleRoute =
            applicableGlobalMiddlewares.length === 0 &&
            (!route.middlewares || route.middlewares.length === 0) &&
            !route.validator &&
            !route.staticServe;

          if (isSimpleRoute) {
            // Use fast path handler for simple routes (minimal overhead)
            routes[path][method] = this.createFastPathHandler(route);
          } else {
            // Use full-featured handler for complex routes
            routes[path][method] = this.createRouteHandler(route, commonMiddlewares);
          }
        }
      }
    }

    // Add 404 handler with static headers
    routes['/*'] = () => {
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: STATIC_JSON_HEADERS,
      });
    };

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
      routes[path]['GET'] = this.createWebSocketUpgradeHandler(wsRoute);
    }

    return routes;
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
  ): Promise<boolean | Response> {
    // Base case: all middlewares executed successfully
    if (index >= middlewares.length) {
      return true;
    }

    const middleware = middlewares[index];

    // Create next() function that executes the next middleware in chain
    const next = async (): Promise<void> => {
      const result = await this.executeMiddlewares(context, middlewares, index + 1);

      // If next middleware returned Response, throw MiddlewareResponseError to propagate it
      if (result instanceof Response) {
        throw new MiddlewareResponseError(result);
      }

      // If next middleware returned false, throw to stop current middleware
      if (result === false) {
        throw new Error('MIDDLEWARE_CHAIN_STOPPED');
      }
    };

    try {
      // Execute middleware with real next() function
      const result = await middleware.handle(context, next);

      // If middleware returns Response, stop pipeline and return response
      if (result instanceof Response) {
        return result;
      }

      // If middleware returns false, stop pipeline
      if (result === false) {
        return false;
      }

      // Middleware executed successfully
      return true;
    } catch (error) {
      // If middleware threw HttpException, convert to Response
      if (error instanceof HttpException) {
        return error.getResponse();
      }

      // If a downstream middleware returned a Response, propagate it
      if (error instanceof MiddlewareResponseError) {
        return error.response;
      }

      // If a downstream middleware stopped the chain with false, propagate the stop
      if (error instanceof Error && error.message === 'MIDDLEWARE_CHAIN_STOPPED') {
        return false;
      }

      // Other errors should be thrown (will be caught by route handler)
      throw error;
    }
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
      try {
        // Create context wrapper
        const context = new ErgenecoreContextWrapper(req);

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
        // If HttpException was thrown, convert to Response
        if (error instanceof HttpException) {
          return error.getResponse();
        }

        // Log and handle other errors
        this.logger.error('WebSocket upgrade handler error:', error);

        return new Response(
          JSON.stringify({
            error: error instanceof Error ? error.message : 'WebSocket upgrade failed',
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          },
        );
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
        if (httpRoutes[wsPath]['GET']) {
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
    // If no error handler is set, use ultra-minimal version with default error handling
    if (!this.errorHandler) {
      return async (req: Request): Promise<Response> => {
        const context = new ErgenecoreContextWrapper(req);

        try {
          // Inject Bun's native route params if present
          // @ts-ignore - Bun adds params to Request
          if (req.params) {
            // @ts-ignore - Bun adds params to Request
            const params = req.params;

            // eslint-disable-next-line guard-for-in
            for (const key in params) {
              context.setValue(`param:${key}`, params[key]);
            }
          }

          // Execute handler directly
          const response = await route.handler(context);

          // Return response (check if already a Response object)
          if (response instanceof Response) {
            return response;
          }

          // Wrap in Response with static headers
          return new Response(JSON.stringify(response), {
            status: 200,
            headers: STATIC_JSON_HEADERS,
          });
        } catch (error) {
          // If handler threw HttpException, convert to Response
          if (error instanceof HttpException) {
            return error.getResponse();
          }

          // Default error handling when no custom error handler is registered
          this.logger.error('Route handler error:', error);

          return new Response(
            JSON.stringify({
              error: error instanceof Error ? error.message : 'Internal Server Error',
            }),
            {
              status: 500,
              headers: STATIC_JSON_HEADERS,
            },
          );
        }
      };
    }

    // With error handler (minimal try-catch)
    return async (req: Request): Promise<Response> => {
      const context = new ErgenecoreContextWrapper(req);

      try {
        // Inject Bun's native route params if present
        // @ts-ignore - Bun adds params to Request
        if (req.params) {
          // @ts-ignore - Bun adds params to Request
          const params = req.params;

          // eslint-disable-next-line guard-for-in
          for (const key in params) {
            context.setValue(`param:${key}`, params[key]);
          }
        }

        // Execute handler directly
        const response = await route.handler(context);

        // Return response (check if already a Response object)
        if (response instanceof Response) {
          return response;
        }

        // Wrap in Response with static headers
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: STATIC_JSON_HEADERS,
        });
      } catch (error) {
        // If handler threw HttpException, convert to Response
        if (error instanceof HttpException) {
          return error.getResponse();
        }

        // Handle other errors with custom error handler
        return this.errorHandler!(error as Error, context);
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
   * @param _commonMiddlewares - Common middlewares for this route group (for future optimization)
   * @returns Bun-compatible route handler
   */
  private createRouteHandler(
    route: RouteParams<Context, ValidationSchemaWithHook>,
    _commonMiddlewares: BaseMiddleware<Context>[] = [],
  ) {
    // ✅ Filter global middlewares by path pattern (ONCE during route building)
    // This happens at server startup, NOT on every request → zero runtime overhead
    const applicableGlobalMiddlewares = this.getGlobalMiddlewaresForPath(route.path);

    return async (req: Request): Promise<Response> => {
      // Create context wrapper outside try block so it's accessible in catch
      const context = new ErgenecoreContextWrapper(req);

      // Inject Bun's native route params
      // @ts-ignore - Bun adds params to Request
      if (req.params) {
        // @ts-ignore - Bun adds params to Request
        const params = req.params;

        // eslint-disable-next-line guard-for-in
        for (const key in params) {
          context.setValue(`param:${key}`, params[key]);
        }
      }

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

        // Execute route middlewares with real next() chain
        if (route.middlewares && route.middlewares.length > 0) {
          const result = await this.executeMiddlewares(context, route.middlewares);

          // If middleware returned a custom response, return it
          if (result instanceof Response) {
            return result;
          }

          // If middleware returned false, return 403
          if (result === false) {
            return new Response('Forbidden', { status: 403 });
          }
        }

        // Execute validation
        if (route.validator) {
          const validationResult = await this.validateRequest(context, route.validator);

          if (validationResult) return validationResult;
        }

        // Handle static file serving
        if (route.staticServe) {
          const staticResponse = await this.serveStaticFile(req, context, route.staticServe);

          if (staticResponse) return staticResponse;
        }

        // Execute route handler
        const response = await route.handler(context);

        // If handler returns Response, return it directly
        if (response instanceof Response) {
          return response;
        }

        // Otherwise, wrap in Response
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        // If handler or middleware threw HttpException, convert to Response
        if (error instanceof HttpException) {
          return error.getResponse();
        }

        // Handle other errors with custom error handler if available
        if (this.errorHandler) {
          // Pass the original context with params already injected
          return await this.errorHandler(error as Error, context);
        }

        // Default error response
        this.logger.error('Route handler error:', error);

        return new Response(
          JSON.stringify({
            error: error instanceof Error ? error.message : 'Internal Server Error',
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
    };
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
  private async validateRequest(
    context: Context,
    validator: BaseValidator<ValidationSchemaWithHook | ValidationSchema>,
  ): Promise<Response | null> {
    // Iterate through all validator methods (body, query, param, header)
    for (const key of VALIDATOR_METHODS) {
      const validatorHandler: ValidatorHandler<ValidationSchemaWithHook | ValidationSchema> = validator[key];

      // Skip if validator not defined for this target
      if (!validatorHandler || typeof validatorHandler.handle !== 'function') {
        continue;
      }

      // Get validation schema
      const validationSchema = await validatorHandler.handle();

      // Skip if no validation schema provided
      if (!validationSchema) {
        continue;
      }

      // Use type guard to discriminate between formats
      const schema: ValidationSchema = this.isValidationSchemaWithHook(validationSchema)
        ? validationSchema.schema
        : validationSchema;

      const hook = this.isValidationSchemaWithHook(validationSchema) ? (validationSchema.hook ?? null) : null;

      // Extract data to validate
      const data = await this.extractValidationData(context, key);
      // Run Zod validation
      const result = schema.safeParse(data);

      // If validation fails
      if (!result.success) {
        // Use custom hook if provided
        if (hook) {
          const hookResponse = await hook(result, context);

          if (hookResponse) return hookResponse;
        }

        // Default error response
        return new Response(
          JSON.stringify({
            error: 'Validation failed',
            details: result.error.flatten(),
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
    }

    // All validations passed
    return null;
  }

  /**
   * Extracts data from request based on validation target
   *
   * @param context - Request context
   * @param target - Validation target (body, query, param, header)
   * @returns Data to be validated
   */
  private async extractValidationData(context: Context, target: string): Promise<any> {
    switch (target) {
      case 'json':
        return await context.getBody();

      case 'body': {
        // 'json' is the correct Asena validator method name
        // 'body' is kept for backwards compatibility
        return await context.getBody();
      }

      case 'query': {
        const url = new URL(context.req.url);
        const queryObj: Record<string, string> = {};

        url.searchParams.forEach((value, key) => {
          queryObj[key] = value;
        });
        return queryObj;
      }

      case 'param': {
        // Extract all params from context
        const params: Record<string, string> = {};

        // We stored params with 'param:' prefix in context
        for (const [key, value] of (context as any).values.entries()) {
          if (key.startsWith('param:')) {
            params[key.replace('param:', '')] = value;
          }
        }

        return params;
      }

      case 'header': {
        const headers: Record<string, string> = {};

        context.req.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
        return headers;
      }

      default:
        return {};
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
  private async serveStaticFile(
    req: Request,
    context: Context,
    staticServe: BaseStaticServeParams<Context, StaticServeExtras>,
  ): Promise<Response | null> {
    try {
      // 1. Extract request path from URL
      const url = new URL(req.url);
      const requestPath = decodeURIComponent(url.pathname); // Decode URL encoding

      // 2. Apply path rewriting if provided
      const rewrittenPath = staticServe.rewriteRequestPath ? staticServe.rewriteRequestPath(requestPath) : requestPath;

      // 3. Build absolute file path
      const filePath = path.join(staticServe.root, rewrittenPath);

      // 4. Security: Resolve and validate path to prevent traversal attacks
      // Resolve both paths to absolute canonical paths
      const resolvedFilePath = path.resolve(filePath);
      const resolvedRoot = path.resolve(staticServe.root);

      // Check if resolved file path is within root directory
      if (!resolvedFilePath.startsWith(resolvedRoot)) {
        this.logger.warn(`Path traversal attempt detected: ${requestPath} -> ${resolvedFilePath}`);
        return new Response('Forbidden', { status: 403 });
      }

      // 5. Create Bun.file() instance
      const file = Bun.file(resolvedFilePath);

      // 5. Check if file exists
      const fileExists = await file.exists();

      // 6. File not found → trigger onNotFound hook
      if (!fileExists) {
        if (staticServe.onNotFound) {
          await staticServe.onNotFound.handler(rewrittenPath, context);

          // If hook overrides, return null (let handler continue)
          if (staticServe.onNotFound.override) {
            return null;
          }
        }

        // Default 404 response
        return new Response('Not Found', { status: 404 });
      }

      // 7. File found → trigger onFound hook
      if (staticServe.onFound) {
        await staticServe.onFound.handler(rewrittenPath, context);

        // If hook overrides, return null (let handler continue)
        if (staticServe.onFound.override) {
          return null;
        }
      }

      // 8. Create Bun file response with automatic Content-Type detection
      const fileResponse = new Response(file);

      // 9. Build response headers starting with Bun's Content-Type
      const finalHeaders = new Headers(fileResponse.headers);

      // 10. Add cache validation headers (ETag and Last-Modified)
      // ETag format: W/"<size>-<lastModified>" (weak validator)
      const etag = `W/"${file.size}-${file.lastModified}"`;

      finalHeaders.set('ETag', etag);

      // Last-Modified: HTTP date format (RFC 7231)
      const lastModified = new Date(file.lastModified).toUTCString();

      finalHeaders.set('Last-Modified', lastModified);

      // 11. Add custom headers (can override defaults)
      const customHeaders = this.buildStaticFileHeaders(resolvedFilePath, staticServe.extra);

      for (const [key, value] of Object.entries(customHeaders)) {
        finalHeaders.set(key, value);
      }

      // 12. Add default Cache-Control if not provided
      // Using 'public, max-age=0' allows caching but requires revalidation
      if (!finalHeaders.has('Cache-Control')) {
        finalHeaders.set('Cache-Control', 'public, max-age=0');
      }

      // 13. Return response with all headers
      // This preserves Bun's zero-copy file serving while adding cache headers
      return new Response(fileResponse.body, {
        status: fileResponse.status,
        headers: finalHeaders,
      });
    } catch (error) {
      this.logger.error('Static file serving error:', error);

      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'Static file serving failed',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
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

  /**
   * Extracts base path from a route path
   *
   * Removes dynamic segments (parameters and wildcards) from the path
   * to find the static base path for grouping routes.
   *
   * @param path - Route path (e.g., "/api/users/:id")
   * @returns Base path without dynamic segments (e.g., "/api/users")
   *
   * @example
   * ```typescript
   * extractBasePath('/api/users/:id') // => '/api/users'
   * extractBasePath('/api/users/:id/posts/:postId') // => '/api/users'
   * extractBasePath('/static/*') // => '/static'
   * extractBasePath('/') // => '/'
   * ```
   */
  private extractBasePath(path: string): string {
    // Remove trailing slash (except for root)
    let normalized = path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path;

    // Split path into segments
    const segments = normalized.split('/');
    const baseSegments = [];

    // Keep segments until we hit a parameter or wildcard
    for (const segment of segments) {
      // Stop if segment is a parameter (:param) or wildcard (*)
      if (segment.startsWith(':') || segment.includes('*')) {
        break;
      }

      baseSegments.push(segment);
    }

    // Join back into path, handle root case
    return baseSegments.join('/') || '/';
  }

  /**
   * Extracts common middlewares across multiple routes
   *
   * Identifies middlewares that are present in ALL routes and can be
   * moved to group level for optimization.
   *
   * @param routes - Array of routes to analyze
   * @returns Array of common middleware instances
   *
   * @example
   * ```typescript
   * extractCommonMiddlewares([
   *   { middlewares: [auth, log, rate] },
   *   { middlewares: [auth, log] },
   *   { middlewares: [auth, log] }
   * ]) // => [auth, log]
   * ```
   */
  private extractCommonMiddlewares(
    routes: RouteParams<Context, ValidationSchemaWithHook>[],
  ): BaseMiddleware<Context>[] {
    // Need at least 2 routes to have common middlewares
    if (routes.length === 0 || routes.length === 1) {
      return [];
    }

    // Get middlewares from first route as baseline
    const firstRouteMiddlewares = routes[0].middlewares || [];

    // Filter to only middlewares present in ALL routes
    return firstRouteMiddlewares.filter((middleware) => {
      return routes.every((route) => {
        return (route.middlewares || []).some((mw) => {
          // Compare by constructor name (class identity)
          return mw.constructor.name === middleware.constructor.name;
        });
      });
    });
  }

  /**
   * Groups routes by their base path
   *
   * Creates a map of base paths to routes for optimization.
   * Routes with the same base path will share common middlewares.
   *
   * @param routes - Array of routes to group
   * @returns Map of base paths to route arrays
   *
   * @example
   * ```typescript
   * groupRoutesByBasePath([
   *   { path: '/api/users' },
   *   { path: '/api/users/:id' },
   *   { path: '/api/posts' }
   * ])
   * // => Map {
   * //   '/api/users' => [route1, route2],
   * //   '/api/posts' => [route3]
   * // }
   * ```
   */
  private groupRoutesByBasePath(
    routes: RouteParams<Context, ValidationSchemaWithHook>[],
  ): Map<string, RouteParams<Context, ValidationSchemaWithHook>[]> {
    const groups = new Map<string, RouteParams<Context, ValidationSchemaWithHook>[]>();

    for (const route of routes) {
      const basePath = this.extractBasePath(route.path);

      if (!groups.has(basePath)) {
        groups.set(basePath, []);
      }

      groups.get(basePath)!.push(route);
    }

    return groups;
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
  private groupRoutesByController(): Map<
    string,
    { basePath: string; routes: Array<{ method: string; path: string }> }
  > {
    const groups = new Map<string, { basePath: string; routes: Array<{ method: string; path: string }> }>();

    for (const route of this.routeQueue) {
      const controllerName = route.controllerName || 'Unknown';
      const controllerBasePath = route.controllerBasePath || '/';

      if (!groups.has(controllerName)) {
        groups.set(controllerName, {
          basePath: controllerBasePath,
          routes: [],
        });
      }

      groups.get(controllerName)!.routes.push({
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
  private groupWebSocketRoutesByController(): Map<string, { basePath: string; routes: Array<{ path: string }> }> {
    const groups = new Map<string, { basePath: string; routes: Array<{ path: string }> }>();

    for (const wsRoute of this.wsRouteQueue) {
      const controllerName = wsRoute.controllerName || 'Unknown';
      const controllerBasePath = wsRoute.path; // WebSocket uses path as base path

      if (!groups.has(controllerName)) {
        groups.set(controllerName, {
          basePath: controllerBasePath,
          routes: [],
        });
      }

      groups.get(controllerName)!.routes.push({
        path: wsRoute.path,
      });
    }

    return groups;
  }

  /**
   * Filters global middlewares for a specific route path
   *
   * Uses pattern matching to determine which middlewares should apply to this path.
   * Pattern matching happens ONCE during route building (deferred registration),
   * not on every request, ensuring zero runtime overhead.
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
      const wsGroup = wsGroups.get(controllerName)!;
      const allRoutes = [
        ...group.routes,
        ...wsGroup.routes.map((r) => ({ method: 'WS', path: r.path })),
      ];

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

    return lines.join('\n');
  }

}
