import { describe, expect, test } from 'bun:test';
import { isHttpException, HTTP_EXCEPTION } from '@asenajs/asena/adapter';
import { HttpException, ValidationError } from '../lib/errors';

/**
 * `isHttpException()` exists because `instanceof` answers false across two resolved copies of a
 * package - and when it does, every deliberate 401/403/404 in a user's `onError` falls through
 * to the generic 500 branch. Silently: the API still responds, just with the wrong status.
 *
 * The JSDoc on `isHttpException` tells users to branch on it, so if the exception this adapter's
 * users actually throw is not branded, the documented example ships a status downgrade.
 */
describe('HttpException brand (ergenecore)', () => {
  test('the exception users throw is branded', () => {
    expect(isHttpException(new HttpException(401, 'Unauthorized'))).toBe(true);
  });

  test('subclasses inherit the brand', () => {
    const error = new ValidationError({ issues: [] } as any, 'json');

    expect(isHttpException(error)).toBe(true);
  });

  test('status is readable through the branded shape', () => {
    const error: unknown = new HttpException(403, 'Forbidden');

    expect(isHttpException(error) && error.status).toBe(403);
  });

  test('a plain Error is not branded', () => {
    expect(isHttpException(new Error('nope'))).toBe(false);
    expect(isHttpException(null)).toBe(false);
    expect(isHttpException({ [HTTP_EXCEPTION]: false })).toBe(false);
  });
});
