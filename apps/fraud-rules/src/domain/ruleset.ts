import { DecimalString, toCents } from '@fraudstream/contracts';
import { z } from 'zod';

const base = {
  name: z.string().min(1),
  points: z.number().int().min(0),
  hardDecline: z.boolean().default(false),
};

/** `rules.yaml` schema: every rule of SPEC §6.4 must be present with its parameters. */
export const RulesetFile = z.strictObject({
  version: z.string().min(1),
  defaultCreditLimit: DecimalString,
  rules: z.strictObject({
    R001: z.strictObject({
      ...base,
      windowSeconds: z.number().int().positive(),
      maxTransactions: z.number().int().positive(),
    }),
    R002: z.strictObject({
      ...base,
      windowSeconds: z.number().int().positive(),
      creditLimitShare: z.number().gt(0).lte(1),
    }),
    R003: z.strictObject({
      ...base,
      multiplier: z.number().positive(),
      minHistory: z.number().int().min(1),
      historyDays: z.number().int().positive(),
    }),
    R004: z.strictObject({ ...base, maxSpeedKmh: z.number().positive() }),
    R005: z.strictObject({ ...base }),
    R006: z.strictObject({
      ...base,
      smallAmount: DecimalString,
      windowSeconds: z.number().int().positive(),
      minTransactions: z.number().int().min(1),
    }),
    R007: z.strictObject({ ...base, amount: DecimalString }),
    R008: z.strictObject({ ...base }),
    R009: z.strictObject({
      ...base,
      fromHour: z.number().int().min(0).max(23),
      toHour: z.number().int().min(1).max(24),
      multiplier: z.number().positive(),
    }),
    R010: z.strictObject({ ...base }),
  }),
});
export type RulesetFile = z.infer<typeof RulesetFile>;

export interface Ruleset {
  version: string;
  defaultCreditLimitCents: bigint;
  rules: RulesetFile['rules'];
}

export function toRuleset(file: RulesetFile): Ruleset {
  return {
    version: file.version,
    defaultCreditLimitCents: toCents(file.defaultCreditLimit),
    rules: file.rules,
  };
}
