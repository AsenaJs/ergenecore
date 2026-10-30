import {
  ASENA_CONTEXT_CONTRACT,
  ASENA_CONTEXT_ADAPTER,
  defineRequestSchemas,
  type RequestSchemas,
  type ExactRequestSchemas,
  type InferInputs,
} from '@asenajs/asena/adapter';
import { ErgenecoreContextWrapper } from './ErgenecoreContextWrapper';

export interface DefinedContext<S extends RequestSchemas> {
  new (...args: ConstructorParameters<typeof ErgenecoreContextWrapper>): ErgenecoreContextWrapper<InferInputs<S>>;
  readonly [ASENA_CONTEXT_CONTRACT]: Readonly<S>;
  readonly [ASENA_CONTEXT_ADAPTER]: string;
}

export function defineContext<const S extends RequestSchemas>(schemas: ExactRequestSchemas<S>): DefinedContext<S> {
  const contract = defineRequestSchemas(schemas);
  return class RouteContext extends ErgenecoreContextWrapper<InferInputs<S>> {
    public static readonly [ASENA_CONTEXT_CONTRACT] = contract;
    public static readonly [ASENA_CONTEXT_ADAPTER] = 'ergenecore';
  };
}
