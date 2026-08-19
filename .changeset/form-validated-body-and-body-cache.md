---
'@asenajs/ergenecore': minor
---

Fix the body representations fighting over a single-shot request stream, and hand handlers the validated form data.

The request body is now read once and replayed to every representation, so a middleware reading raw bytes, a `form` validator, and a handler asking for JSON no longer exclude each other. Previously whichever ran second failed - a middleware touching the body made a valid multipart request answer 400 "Malformed form data", and a handler calling `getBody()` after form validation got a misleading 400 "Invalid JSON". A failed form parse no longer consumes the body either, so a second read reports the same 400 instead of a stream error.

`getParseBody()` now returns the schema's output when the route declares a `form` validator, matching what `getBody()` already does for `json`. The form validator collapses repeated keys into arrays and applies coercions, while the raw parse is last-value-wins, so the handler used to read a shape the schema had already replaced. Routes without a form validator keep the raw shape.

Two smaller consequences of routing `getParseBody()`'s non-form branch through `getBody()`: an empty body now yields `{}` instead of throwing, and invalid JSON now throws `HttpException(400)` instead of a bare `SyntaxError`.

Also fixes `getBlob()` and `getFormData()` losing the content-type of an in-process `Request` whose body Bun derived it from - the header is now read before the body is consumed.
