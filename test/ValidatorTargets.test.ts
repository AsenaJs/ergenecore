import { describe, expect, it } from 'bun:test';
import { VALIDATOR_METHODS } from '@asenajs/asena/adapter';
import { VALIDATOR_TARGETS } from '../lib/utils/validatorTargets';

describe('validator targets', () => {
  it('match the core VALIDATOR_METHODS in order', () => {
    const targets: string[] = [...VALIDATOR_TARGETS];

    expect(targets).toEqual(VALIDATOR_METHODS);
  });
});
