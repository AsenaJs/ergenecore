// Compile this file against dist declarations with `tsc -p tsconfig.contract-types.json`.
import { z } from 'zod';
import { Context } from '../dist/index';

class TypedContext extends Context.define({
  body: z.object({ name: z.string() }).transform(async (body) => ({ displayName: body.name.toUpperCase() })),
  query: z.object({ page: z.coerce.number().default(1), tag: z.string().optional() }),
}) {}

declare const typed: TypedContext;
const displayName: string = typed.input.body.displayName;
const page: number = typed.input.query.page;
const tag: string | undefined = typed.input.query.tag;
const bodyPromise: Promise<{ displayName: string }> = typed.getBody();
const explicitGeneric: Promise<{ legacy: true }> = typed.getBody<{ legacy: true }>();
void [displayName, page, tag, bodyPromise, explicitGeneric];

// @ts-expect-error No params schema was declared.
typed.input.params;
// @ts-expect-error Output is transformed; the source name is absent.
typed.input.body.name;
// @ts-expect-error Validated inputs are readonly.
typed.input.query = { page: 2 };
// @ts-expect-error Only known request targets are accepted.
Context.define({ cookies: z.object({ session: z.string() }) });

declare const legacy: Context;
const legacyBody: Promise<{ custom: string }> = legacy.getBody<{ custom: string }>();
void legacyBody;
