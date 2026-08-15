---
'@asenajs/ergenecore': minor
---

`getBody()` returns validated data; CORS sets `Vary: Origin` and stops answering 403

Three independent fixes, mirroring the Hono adapter — the CORS middleware was the same code in both
packages, and the body problem was worse here.

**`getBody()` now returns the validator's output.** `validateRequest()` ran `schema.safeParse()`,
threw on failure, and discarded `result.data` on success, so `getBody()` kept returning the raw
`JSON.parse` output from its body cache. Since `z.object()` strips unknown keys rather than
rejecting them, a route could declare a strict schema, pass validation, and still hand the handler
every extra key the client attached — making

```ts
await this.repository.updateById(id, await context.getBody());
```

a mass-assignment sink on every validated route. Unlike the Hono adapter there was not even a raw
accessor to reach the parsed value; it was computed and thrown away.

The validator now writes its output back through `setValidatedBody()`, which swaps the already-warm
body cache — no second read of the request stream. Routes without a validator are unaffected. Only
the body is swapped; `query`, `param` and `header` schemas still validate but their coerced output
is not written back, since those accessors read the request directly and have no cache to swap.

**`CorsMiddleware` sets `Vary: Origin`.** For any `origin` config other than the literal `'*'` the
allowed-origin header is computed from the request's own `Origin`, and nothing said so. A CDN or
shared proxy in front of the API could hand one origin's `Access-Control-Allow-Origin` to a request
from a different origin. Because `setResponseHeader` writes into a Map here, an existing `Vary` is
merged rather than overwritten — a plain set would have dropped an upstream `Vary: Accept-Encoding`.

**A disallowed origin is served without CORS headers instead of `403`.** CORS is a policy the
browser enforces on the user's behalf; the denial the spec describes is a response the browser
refuses to expose, not a server-side rejection. The 403 additionally turned away non-browser callers
that merely send an `Origin` header. If you relied on it as access control, it was never one.

**Preflight responses keep headers set upstream.** The 204 was built from a fresh headers object, so
anything an earlier middleware wrote through `setResponseHeader` was dropped from preflights alone.

**The default `BunLocalTransport` is written back to the adapter's field.** It was assigned to a
local variable, so sockets — which are built from the field — got `undefined` while
`AsenaWebSocketServer` got the default, and the framework's two broadcast paths disagreed about the
sender in the default configuration. The shutdown path reads the same field, so the default was also
never torn down.

This half pairs with `@asenajs/asena` 0.10.1, which adds `publishRemote()` and makes
`socket.publish()` exclude the sender whatever transport is configured. The peer range stays
`^0.10.0`, so an application can still resolve core `0.10.0` here; on that combination
`socket.publish()` takes core's legacy branch (sender included) and this adapter logs one warning at
startup naming `publishRemote`. Upgrading core to 0.10.1 is the fix.
