import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ProblemException, type FieldError } from './problem.js';

/**
 * Validates a request part with a Zod schema. Errors list field paths and rule messages
 * only; the rejected values are never echoed, so a PAN cannot leak through a 400 (SPEC §6.1).
 */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(
    private readonly schema: S,
    private readonly title = 'Request validation failed',
  ) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw ProblemException.of(400, this.title, undefined, toFieldErrors(result.error));
  }
}

export function toFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => {
    const keys = issue.code === 'unrecognized_keys' ? issue.keys : [];
    const base = issue.path.map(String).join('.');
    const field = keys.length > 0 ? [base, keys.join(',')].filter(Boolean).join('.') : base;
    return {
      field: field === '' ? '(body)' : field,
      message: issue.code === 'unrecognized_keys' ? 'unknown field' : issue.message,
    };
  });
}
