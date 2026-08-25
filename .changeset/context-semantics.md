---
"@asenajs/ergenecore": major
---

Breaking: `getQuery` returns `undefined` (not `''`) for an absent parameter, aligning the adapter with the core `AsenaContext` contract; a parameter that is present but empty (`?name=`) still returns `''`. Code that relied on the old `''` fallback should use `?? default` instead of `|| default` where the empty string is meaningful. New `appendResponseHeader` appends to a response header, keeping existing values (comma-joined) - the semantics multi-valued headers such as `Vary` and `Link` need; `setResponseHeader` still replaces, and `Set-Cookie` is not supported by `appendResponseHeader` (cookies go through `setCookie`). `writeSSE` now accepts a `comment` field, emitted as `: <line>` lines before any `event:`/`data:` lines, for keep-alive pings that must not look like an event; a message with neither `data` nor `comment` throws.

Requires `@asenajs/asena` `^0.11.0` as the peer dependency and Bun 1.4. Core 0.10.x is outside the peer range.
