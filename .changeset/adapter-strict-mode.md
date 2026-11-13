---
"@asenajs/ergenecore": minor
---

The package compiles under `strict: true`. What changes for an application:

- The parameter type of `registerRoute()` is exported as `ErgenecoreRouteParams`. It accepts a route without `staticServe` and `validator`, and validator schemas of type `ValidationSchema` as well as `ValidationSchemaWithHook`.
- The `hostname` accessor is typed `string | undefined` (was `any`). Code that uses the value as a `string` without a check, or assigns anything else to it, gets a compile error.
- `start()` rejects with `Validator target "<key>" is declared by @asenajs/asena but not handled by this adapter` when a route has a validator and the installed `@asenajs/asena` declares a validator target this adapter does not implement. No `@asenajs/asena` version in the peer range declares one.
