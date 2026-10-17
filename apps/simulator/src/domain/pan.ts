import { luhnValid } from '@fraudstream/security';
import type { Random } from './random.js';

/**
 * Issuer prefixes of the card numbers that networks and processors publish for testing
 * (e.g. 4111 1111 1111 1111, 4012 8888 8888 1881, 5555 5555 5555 4444, 5105 1051 0510 5100).
 * The simulator only ever builds PANs inside these ranges (SPEC §6.9): never real cards.
 */
export const TEST_BINS = ['411111', '401288', '555555', '510510'] as const;

/** Check digit that makes `partial + digit` pass Luhn. */
export function luhnCheckDigit(partial: string): string {
  for (let digit = 0; digit <= 9; digit++) {
    if (luhnValid(`${partial}${digit}`)) return String(digit);
  }
  throw new RangeError('partial PAN must contain digits only');
}

/** A 16-digit, Luhn-valid PAN in one of the documented test ranges. */
export function testPan(random: Random): string {
  let body: string = random.pick(TEST_BINS);
  while (body.length < 15) body += String(random.int(0, 9));
  return `${body}${luhnCheckDigit(body)}`;
}

export function isTestPan(pan: string): boolean {
  return /^\d{16}$/.test(pan) && TEST_BINS.some((bin) => pan.startsWith(bin)) && luhnValid(pan);
}
