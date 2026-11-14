// Literal keys, because the core types VALIDATOR_METHODS as string[]. test/ValidatorTargets.test.ts pins both lists.
export const VALIDATOR_TARGETS = ['json', 'query', 'form', 'param', 'header'] as const;

export type ValidatorTarget = (typeof VALIDATOR_TARGETS)[number];

export function isValidatorTarget(key: string): key is ValidatorTarget {
  return (VALIDATOR_TARGETS as readonly string[]).includes(key);
}

// Throws on a core target this adapter does not handle, so a newer core fails at start instead of skipping validation.
export function validatorTargetsOf(methods: readonly string[]): ValidatorTarget[] {
  return methods.map((key) => {
    if (!isValidatorTarget(key)) {
      throw new Error(`Validator target "${key}" is declared by @asenajs/asena but not handled by this adapter`);
    }
    return key;
  });
}
