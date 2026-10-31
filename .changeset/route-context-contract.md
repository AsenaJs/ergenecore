---
'@asenajs/ergenecore': major
---

Add Standard Schema route context subclasses with validated, typed request input. The adapter validates body, form, query, params, and headers after middleware and preserves transformed outputs in each request's context. Legacy validator schemas are prepared once per route by default; set `validatorCache: false` on a route that needs its schema factory to run for every request. Require `@asenajs/asena` ^0.12.0 for the shared route contract API.
