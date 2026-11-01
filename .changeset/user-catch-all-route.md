---
"@asenajs/ergenecore": patch
---

A route registered at top-level `/*` (for example `@Controller('/')` with `@Get('/*')`, or the single-page-app static route
from the static files guide) now answers its requests. Previously the adapter's own unmatched handler replaced it and every
such request ended in a 404. Methods the `/*` route does not register still go through the usual not-found handling - global
middlewares, CORS preflight and `onNotFound` - and a `HEAD` request is answered by the route's `GET`. Global middlewares
scoped with `include` / `exclude` are matched against the request path on a top-level `/*` route, so a middleware included
for `/api/*` runs for `GET /api/private` served by that route.
