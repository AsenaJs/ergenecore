---
"@asenajs/ergenecore": patch
---

The package now compiles under `strict: true`. `registerRoute` accepts routes without `staticServe` and `validator`, which the adapter already treated as optional, and the `hostname` accessor is typed `string | undefined`.
