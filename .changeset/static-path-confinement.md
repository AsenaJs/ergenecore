---
'@asenajs/ergenecore': patch
---

Static serve: confine paths to the root directory properly, and answer 400 for an undecodable path

**A sibling directory whose name began with the root's was served.** The traversal guard was
`resolvedFilePath.startsWith(resolvedRoot)`, a string-prefix test on paths — so a root of
`/srv/assets` accepted `/srv/assets-private/credentials.txt`, and a request for
`/assets/..%2Fassets-private%2Fcredentials.txt` returned it with a 200. The existing traversal
tests could not see it: their fixtures were `static-secure` and `outside`, which share no prefix,
so every `../` they tried did land outside and was refused. The guard now compares against the
root *with its separator*, which makes it a containment test rather than a prefix one, and treats
a request that resolves to the root itself as inside it — `GET /assets/` rewrites to `/` and joins
back to the root, and still reaches the application's 404 rather than a 403. A file inside the
root whose own name starts with `..` is still served.

**A malformed percent-escape produced a 500.** `decodeURIComponent` throws a `URIError` on `%zz` or
a lone `%`, and that travelled to `respondToError` as an unbranded error: status 500, an
error-level log line with a stack, and the application's `onError` invoked for a request the
client had simply written wrong. It is now an `HttpException(400)`, which `onError` still sees and
which logs at the level 4xx uses.

Neither fix costs the request path anything measurable: the separator-aware comparison runs in
~7ns against the 674ns `Bun.file().exists()` syscall next to it, and the root prefix is computed
once at route-build time rather than per request.
