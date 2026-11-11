/**
 * The devtools bus `asena console` hands the adapter through `attachDevtools()`.
 *
 * Declared here rather than imported: the adapter builds against published cores, which do not
 * export the bus type, and a core that never attaches devtools must keep working.
 *
 * @module types/Devtools
 */

export type DevtoolsStepKind =
  | 'global-middleware'
  | 'middleware'
  | 'validator'
  | 'controller'
  | 'catch'
  | 'config-onError'
  | 'adapter-default'
  | 'not-found';

export interface DevtoolsStep {
  kind: DevtoolsStepKind;
  name: string;
}

/** A record between `open()` and `close()`; opaque to the adapter. */
export type DevtoolsRecord = object;

export interface DevtoolsBus {
  /** True for as long as records are collected; it can turn false under a running server. */
  readonly enabled: boolean;
  open(method: string, path: string): DevtoolsRecord;
  run<T>(record: DevtoolsRecord, fn: () => T): T;
  step(kind: DevtoolsStepKind, name: string): void;
  close(record: DevtoolsRecord, status: number, answeredBy?: DevtoolsStep): void;
}
