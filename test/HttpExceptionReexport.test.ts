import { describe, expect, test } from 'bun:test';
import { HttpException as Reexported, ValidationError } from '../lib';
import { HttpException as Core, isHttpException } from '@asenajs/asena/adapter';

/**
 * `HttpException` used to be declared in `lib/errors.ts`. It now lives in
 * `@asenajs/asena/adapter` and this package re-exports it, so the hono adapter can offer the same
 * class rather than a look-alike with a different constructor.
 *
 * The whole scheme rests on this being a re-export and not a subclass or a copy. If someone
 * "helpfully" reintroduces a local `class HttpException extends Core` here, every one of these
 * still passes except the first - and an application that catches with `instanceof` starts
 * disagreeing with one that catches with the guard. The full behavioural contract for the class
 * lives with the class, in `Asena/test/adapter/HttpException.test.ts`.
 */
describe('HttpException re-export', () => {
  test('is the same class object as the one core exports', () => {
    expect(Reexported).toBe(Core);
  });

  test('an instance built through this package is an instance of the core class', () => {
    expect(new Reexported(401, 'Unauthorized')).toBeInstanceOf(Core);
  });

  test('is branded, whichever import path built it', () => {
    expect(isHttpException(new Reexported(401, 'Unauthorized'))).toBe(true);
    expect(isHttpException(new Core(401, 'Unauthorized'))).toBe(true);
  });

  test('ValidationError still extends it, so a status-based handler keeps answering 400', () => {
    const error = new ValidationError({ issues: [] } as any, 'json');

    expect(error).toBeInstanceOf(Core);
    expect(error.status).toBe(400);
  });
});
