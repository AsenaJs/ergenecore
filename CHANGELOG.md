# @asenajs/ergenecore

## 3.0.0

### Major Changes

- `zod` is now a peer dependency - this package has no runtime dependencies at all

  `ValidationSchema` is `z.ZodType`, exported from this package's public types, and the schema you
  return from `json()` is constructed with _your_ `z`. That makes zod part of the contract rather than
  an implementation detail, and a contract type must not come from a copy the caller cannot see. The
  adapter defines how validation is wired; it does not get to pick which zod your application runs.

  It also removes the last entry from `dependencies`. Ergenecore is now genuinely zero-dependency,
  which is what its documentation has claimed all along.

  ## Migration

  ```bash
  bun add zod
  ```

  | Package manager      | What you need to do                                                                                 |
  | :------------------- | :-------------------------------------------------------------------------------------------------- |
  | bun, npm 7+, pnpm 8+ | Peers auto-install, but declare it anyway - an undeclared peer disappears on the next clean install |
  | yarn 1               | **Required.** yarn 1 does not install peers                                                         |

  Requires **zod ^4.3.6**. `flattenError`, used to build the validation-failure envelope, is a
  zod-v4 top-level export and is called at runtime, so zod 3 will not work.

  Also hardened in this release: `respondToError` called `getResponse()` on anything carrying the
  `HTTP_EXCEPTION` brand, but the brand only guarantees `status`. A foreign exception implementing the
  contract without that method threw a `TypeError` from inside the error path, where nothing can catch
  it - `Bun.serve` is configured with no `error` hook, so the request fell through to Bun's own 500
  page and the original failure was never logged.

### Minor Changes

- `HttpException` moves to core; this package re-exports it

  `HttpException` and `HttpExceptionInit` are now declared in `@asenajs/asena/adapter` so the hono
  adapter can offer the _same class_ rather than a look-alike with a different constructor. Requires
  `@asenajs/asena` `>=0.9.2`; the peer range moves to `^0.9.2`.

  `import { HttpException } from '@asenajs/ergenecore'` keeps working and is a re-export, not a
  subclass or a copy - the class object is the one core exports, so `instanceof` holds across both
  import paths and `ValidationError extends HttpException` is unchanged. Nothing an application
  wrote needs to change. Prefer `@asenajs/asena/adapter` in new code, since that is the import that
  is identical on both adapters.

  Also hardened: `respondToError` called `getResponse()` on anything carrying the brand. The brand
  only ever guaranteed `status` - `getResponse` is optional on `HttpExceptionLike` - so a foreign
  exception implementing the contract threw a `TypeError` from inside the error path. There is no
  handler above that point and `Bun.serve` is configured without an `error` hook, so the request
  fell through to Bun's own 500 page and the original failure was never logged. It now checks for
  the method and otherwise answers from `status` alone, withholding the body.

## 2.0.0

### Major Changes

- A dedicated `onNotFound` hook, and every thrown error now reaches `onError` first

  **Breaking: `onError` no longer sees unmatched routes.** They used to arrive as a synthetic
  error, so an application handler had to ask "was this actually an error?" on every call. Routing
  has its own hook now:

  ```typescript
  @Config()
  export class AppConfig extends ConfigService {
    public onNotFound(context: Context, request: NotFoundRequest) {
      return context.send({ title: 'Not Found', status: 404, instance: request.path }, 404);
    }
  }
  ```

  `request.path` is the path only — no origin, no query string — and matches what the hono adapter
  reports for the same request, so the same handler body works on either adapter. With no hook
  declared the adapter answers `{"error":"Not Found"}` with a 404, unchanged. `NotFoundError` is
  removed.

  **Breaking: `HttpException` is now offered to `onError` before it answers itself.** Five catch
  sites answered an `HttpException` straight from `getResponse()` and only consulted the
  application handler for everything else, so an app could reshape its own 4xx envelopes on the
  hono adapter but not here. All five now go through the handler first, falling back to
  `getResponse()` (or a 500) when there is no handler, when it returns nothing, or when it throws.

  Only one of those five carried the `!isValidationError` exemption, so a `ValidationError` thrown
  on the fast path never reached `onError` at all — the exact opposite of why `ValidationError`
  exists. The same change fixes that.

  **Breaking: a validation failure now travels one path, whoever answers it.** The validator used to
  answer its own `{"error":"Validation failed","details":…}` when the application had no `onError`,
  and throw a `ValidationError` otherwise. So the same failing request was a logged 400 or an
  invisible one depending on an unrelated hook, and the body differed too — an `onError` that
  declined got `HttpException`'s bare `Validation failed` text instead of the envelope. The branch is
  gone: the error is always thrown, and the envelope moved onto `ValidationError.getResponse()`, so
  every route that does not answer it itself gets the same body. That body now also carries `target`
  (`json`, `query`, `param`, `header`), which the hono adapter has always reported.

  **A global middleware that throws on an unmatched path no longer escapes.** The catch-all was the
  one request path with no `try`/`catch` around it, so an auth middleware raising `HttpException(401)`
  on `/missing` — or `getBody()` rejecting a malformed payload — bypassed `onError`, wrote nothing,
  and let Bun answer its own 500 page.

  **A failed static file read no longer leaks its message.** `serveStaticFile` answered its own catch
  with `{"error": error.message}`, and a message thrown out of `path.resolve` or `Bun.file` is
  specifically a deployment path. It also never reached `onError`. It now goes through the same
  handler as everything else.

  **Breaking: the framework's default log now fires exactly when its default response fires.**

  One rule, both adapters:

  |          | the hook answered | no hook, or it declined or threw                         |
  | -------- | ----------------- | -------------------------------------------------------- |
  | response | yours             | the framework's                                          |
  | log      | none              | 5xx `error` + stack · 4xx `debug` (→`info`) · 404 `info` |

  Three things change. An application with **no** `onError` used to get a 500 that answered the
  client and wrote nothing to stdout, stack included — it is logged now. An `onError` that returns
  nothing, or throws, used to lose the original error entirely while the framework answered its
  default — it is logged now. And an `onError` that **does** answer no longer produces a framework
  line: your handler owns the response, so it owns the record, with whatever correlation id you
  attach. There is no switch to force that line back on; `createErgenecoreAdapter({ logErrors: false })`
  only silences further.

  **An unmatched route is logged too**, at `info` — `Route not found:` with `{ path, method, status }`.
  It produced no output at any level before, which is the one class of traffic (bots, probes, a typo
  in a deployed client) an operator most needs to count. `info` rather than `warn` so a scanner
  walking `/wp-admin`, `/.env` and `/phpmyadmin` cannot fill the warning stream, and rather than
  `debug` because a 404 nobody can see is how a mistyped route survives to production. An
  application that declared `onNotFound` and answered from it gets no line, same rule. `logErrors:
false` silences this as well.

  **A missing static file now reaches `onNotFound` too.** `@StaticServe` answered a hard-coded
  `text/plain` 404 and never consulted the config hook, while the hono adapter's `serveStatic`
  falls through to it — so the same application produced a different 404 body per adapter. Both
  now answer the same envelope. The per-route `StaticServeService.onNotFound` still runs first.

  **Breaking: the default 500 no longer echoes the thrown message.** With no `onError` registered
  the body was `{"error": "<error.message>"}`, so an unhandled exception returned its internal text
  to the caller — routinely a connection string, a file path or a driver's raw complaint — while the
  hono adapter answered a generic body for the same application. It is now
  `{"error": "Internal Server Error"}`. Nothing is lost: the message and stack are written to the log
  by the change above, and an application that wants to say more declares `onError`.

  **An unmatched route now records its status on the context.** `respondToUnmatched` returned a
  `Response` without writing the status back, and an unmatched request never reaches a route handler,
  so nothing else wrote it either. `@asenajs/asena-otel` reads `context.res.status` to attribute both
  the span and the request metrics, so **every 404 was recorded with no `http.response.status_code`** —
  precisely the traffic (bots, probes, mistyped paths) an operator most wants to count. The hono
  adapter was already correct here.

  **`HttpException` carries the `HTTP_EXCEPTION` brand** and is detectable with
  `isHttpException()` from `@asenajs/asena/adapter`. `instanceof` answers false across two resolved
  copies of a package, which turns every deliberate 401/403/404 into a generic 500 without a trace.
  The brand is an instance field under a registered symbol, so unlike the hono adapter's
  prototype-level brand it does survive across two copies of this package. Error _logging_ now uses
  the same check: `logHandledError` still used `instanceof` while `respondToError` used the brand, so
  a cross-copy 401 answered the client correctly while being logged at `error` level with a full
  stack — the exact log flooding the 5xx/4xx split exists to prevent.

  **Removed dead route-grouping code.** `extractCommonMiddlewares`, `groupRoutesByBasePath` and
  `extractBasePath` computed a "common middleware" set that `createRouteHandler` discarded. The
  comparison behind it was broken in the same way as the hono adapter's live copy — it compared
  `mw.constructor.name`, and by the time a middleware reaches an adapter it is a plain object
  literal, so every name was `"Object"`. Removed rather than repaired.

  `MiddlewareService.handle` was typed to return `Promise<any>`. The adapter awaits the result and
  stops the chain on a literal `false`, so a synchronous guard (`if (!token) return false;`) is a
  supported shape that did not type-check. The return type now mirrors Asena's
  `AsenaMiddlewareService`.

  `ConfigService` declares its hooks (`onError`, `onNotFound`, `serveOptions`, `globalMiddlewares`,
  `transport`) through declaration merging. They stay optional, but an override with the wrong
  signature is now a compile error instead of a hook the framework silently never calls.

  Requires `@asenajs/asena` 0.9.0 or later.

## 1.5.0

### Minor Changes

- 8641bea: Validation failures now reach `ConfigService.onError`

  `validateRequest` answered a failed validation by returning a 400 `Response` directly, so
  the surrounding `catch` that dispatches to the configured error handler was never entered.
  An application could not give validation errors the same response envelope as the rest of
  its API - the same defect the Hono adapter had.

  The adapter now throws `ValidationError` (exported from `@asenajs/ergenecore`), which
  extends `HttpException` with status **400** and carries `issues`, `target` and the original
  `ZodError` as `cause`. Match it with `isValidationError()` from `@asenajs/asena/adapter`.

  Because it extends `HttpException`, an existing handler that branches on
  `instanceof HttpException` and replies with `error.status` keeps answering 400 - adopting
  this does not turn validation failures into 500s. Note that validation errors are
  deliberately routed to the error handler rather than answered from `getResponse()`, which
  is what the generic `HttpException` branch does.

  Applications that define no error handler are unaffected: the previous
  `{ error, details }` envelope remains as the fallback.

  Deprecated `ZodError.flatten()` replaced with `z.flattenError()`.

## 1.4.0

### Minor Changes

- eba8d40: Support `AsenaStartOptions` in `Ergenecore.start()`.

  `start()` now accepts `number | AsenaStartOptions`. A bare port keeps the original signature working exactly as before; when Asena 0.8 passes start options with `unix` set, the server binds to a **unix domain socket** instead of a TCP port. Bun rejects `hostname` and `unix` together, so both `hostname` and `port` are dropped from the serve config in that mode, and the startup log reports `unix:<path>` rather than an unreachable `http://host:port` URL.

  This is what makes `createTestApp({ dispatch: 'socket' })` from `@asenajs/asena/test` work: parallel test suites each get their own socket and can no longer collide on a random port.

  Requires `@asenajs/asena` ≥ 0.8.0 (the `AsenaStartOptions` type).

## 1.3.1

### Patch Changes

- ### Features
  - **FrontendController Logging**: FrontendController routes are now logged in the controller summary with route counts, grouped by controller name and base path.
  - **Route Pattern**: `routePattern` is now set on the context object for all route types (GET, POST, PUT, DELETE, WebSocket), providing matched route patterns for OpenTelemetry and middleware.
  - **Status Code Tracking**: Response methods (send, redirect, html, stream, sse, file) now track the HTTP status code on the response object.

  ### Tests
  - Added HTML route registration tests (duplicate detection, trailing slash variant).
  - Added FrontendController summary logging tests.

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
