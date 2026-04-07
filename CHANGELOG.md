# @asenajs/ergenecore

## 1.3.0

### Minor Changes

- ### Streaming Support
  - Add `StreamWriter` and `SSEStreamWriter` for generic binary/text and Server-Sent Events streaming
  - Add `stream()`, `streamSSE()`, and `streamText()` methods to `ErgenecoreContextWrapper`
  - Automatic abort handling when client disconnects

  ### FrontendController & HTML Routes
  - Add `registerHTMLRoute()` for serving Bun HTML imports directly via `Bun.serve()` routes
  - HTML routes bypass middleware chain for maximum performance
  - Trailing slash normalization for consistent routing

  ### Middleware Chain Improvements
  - Unify global + route middlewares into a single execution chain with `onComplete` callback
  - Auto-continue middleware chain when `next()` is not explicitly called
  - Catch-all `/*` handler now runs global middlewares (CORS, rate limiting work on unmatched routes)

  ### Context Enhancements
  - Add `getRequestIp()` using Bun's native `server.requestIP()` (lazy evaluated, cached)
  - Add `getAllQueries()` for retrieving all query parameters as key-value object
  - Type-safe `getValue()`/`setValue()` with `AsenaVariables` augmentation support

  ### WebSocket Transport Layer
  - Integrate `BunLocalTransport` for WebSocket server communication
  - Add `SendPingStrategy` support (`'adapter'` vs `'native'`) for heartbeat control
  - Remove local heartbeat management in favor of base class implementation

  ### Trailing Slash Normalization
  - Both `/path` and `/path/` now resolve to the same handler
  - Applied to HTTP routes, HTML routes, and catch-all handler

  ### Error Handling
  - `HttpException` now accepts `HttpStatusCode` enum values
  - Add `HttpExceptionInit` with `cause` support for error chaining
  - Export `HttpExceptionInit` type

  ### Validation
  - `ValidationSchemaWithHook` is now generic with proper Zod type inference
  - Hook callback receives typed `ZodSafeParseResult`

  ### Exports & API Surface
  - Export `CorsMiddleware`, `RateLimiterMiddleware` and their option types from main index
  - Export `StreamWriter`, `SSEStreamWriter` from main index
  - Add `globalMiddlewares()` and `serveOptions()` abstract methods to `ConfigService`

  ### Miscellaneous
  - Fix import path: `@asenajs/asena/utlis` -> `@asenajs/asena/utils`
  - Update decorator import paths in JSDoc examples (`/server` -> `/decorators`)
  - Update `@asenajs/asena` peer dependency to `^0.7.0`
  - Update `zod` to `^4.3.6`
  - RateLimiterMiddleware now uses `context.getRequestIp()` as fallback key

## 1.2.0

### Minor Changes

- Refactored WebSocket adapter to use a single shared AsenaWebSocketServer instance instead of creating separate instances per namespace. Removed namespace parameter from AsenaWebSocketServer constructor for improved efficiency and alignment with @asenajs/asena v0.6.0 architecture.

## 1.1.0

### Minor Changes

- fix(lib): New AsenaWebSocketServer implemented
