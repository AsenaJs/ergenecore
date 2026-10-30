---
'@asenajs/ergenecore': patch
---

Faster request handling: routes without middleware skip the middleware chain, synchronous handlers answer without an extra promise, query parsing is memoized, and static files are served through a bounded table of open file descriptors with a fresh stat on every request.
