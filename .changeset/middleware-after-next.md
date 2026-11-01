---
"@asenajs/ergenecore": patch
---

Code a middleware runs after `await next()` now runs. `next()` resolves once the rest of the chain has answered instead of
throwing the downstream `Response` past the caller, so a header set on `context.res` after `next()` reaches the response, an
error thrown after `next()` goes to `onError`, and `context.res.status` read after `next()` is the status that was produced,
on matched and unmatched routes alike.

Behaviour that changes with it: when a route has middlewares, an error thrown by the handler or by request validation is
answered through `onError` before `next()` resolves, so a middleware's `try/catch` around `next()` no longer sees it and reads
the error response's status instead. A middleware that returns a `Response` or `false` without calling `next()` still ends the
chain as before.
