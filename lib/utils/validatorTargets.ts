// Literal keys, because the core types VALIDATOR_METHODS as string[]. test/ValidatorTargets.test.ts pins both lists.
export const VALIDATOR_TARGETS = ['json', 'query', 'form', 'param', 'header'] as const;

export type ValidatorTarget = (typeof VALIDATOR_TARGETS)[number];

export function isValidatorTarget(target: string): target is ValidatorTarget {
  return VALIDATOR_TARGETS.some((known) => known === target);
}
