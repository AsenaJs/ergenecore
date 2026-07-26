---
'@asenajs/ergenecore': minor
---

Validation failures now reach `ConfigService.onError`

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
