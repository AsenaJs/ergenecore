---
'@asenajs/ergenecore': minor
---

Support `AsenaStartOptions` in `Ergenecore.start()`.

`start()` now accepts `number | AsenaStartOptions`. A bare port keeps the original signature working exactly as before; when Asena 0.8 passes start options with `unix` set, the server binds to a **unix domain socket** instead of a TCP port. Bun rejects `hostname` and `unix` together, so both `hostname` and `port` are dropped from the serve config in that mode, and the startup log reports `unix:<path>` rather than an unreachable `http://host:port` URL.

This is what makes `createTestApp({ dispatch: 'socket' })` from `@asenajs/asena/test` work: parallel test suites each get their own socket and can no longer collide on a random port.

Requires `@asenajs/asena` ≥ 0.8.0 (the `AsenaStartOptions` type).