---
'@asenajs/ergenecore': patch
---

Fix form() validators validating an empty object: extractValidationData now parses multipart/urlencoded bodies with hono-parity semantics (content-type gate, repeated keys collapse to arrays), and FormData is cached so handlers can re-read it after validation.
