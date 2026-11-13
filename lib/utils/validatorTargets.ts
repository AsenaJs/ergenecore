// Literal keys, because the core types VALIDATOR_METHODS as string[]. test/ValidatorTargets.test.ts pins both lists.
export const VALIDATOR_TARGETS = ['json', 'query', 'form', 'param', 'header'] as const;
