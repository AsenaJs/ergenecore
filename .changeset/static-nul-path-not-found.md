---
"@asenajs/ergenecore": patch
---

A static request whose path decodes to a NUL byte (for example `/static/a%00.txt`) now ends as a static miss - the route's
`onNotFound` hook, then the application's `onNotFound` or the default 404 - instead of a 500 from `onError`.
