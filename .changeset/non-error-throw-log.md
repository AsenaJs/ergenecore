---
"@asenajs/ergenecore": patch
---

A thrown value the error log cannot serialise as JSON - a `bigint`, an object with a cycle - is answered with the 500 envelope and logged like any other failure. `throw undefined` is logged with the message `undefined`.
