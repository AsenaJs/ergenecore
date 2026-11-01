---
'@asenajs/ergenecore': patch
---

`deleteCookie` now sends the cookie's attributes (`secure`, `httpOnly`, `sameSite`, `partitioned`, `path`, `domain`) with `Max-Age=0`, so browsers remove `__Host-`/`__Secure-` cookies. Calling it without options no longer throws.
