---
"@asenajs/ergenecore": patch
---

A route registered with a `contextContract` that has no `contextClass`, or that does not match its `contextClass`, is now
rejected by core's shared route-contract check, so the error reads `<METHOD> <path>: contextContract must match contextClass`,
the same message the Hono adapter gives. Registration is still rejected in both cases; only the message text changed.
