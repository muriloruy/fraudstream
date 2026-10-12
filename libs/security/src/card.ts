/** Luhn (mod 10) check over a string of digits (SPEC §6.1). */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** PAN length accepted by the platform: 13 to 19 digits (SPEC §6.1). */
export const PAN_PATTERN = /^\d{13,19}$/;

export function isValidPan(pan: string): boolean {
  return PAN_PATTERN.test(pan) && luhnValid(pan);
}

/**
 * Masks a PAN as first 6 / last 4 with six asterisks in between, always 16 characters
 * (`payments.transactions.masked_pan char(16)`, SPEC §5.1).
 */
export function maskPan(pan: string): string {
  if (!PAN_PATTERN.test(pan)) {
    throw new RangeError('PAN must be 13 to 19 digits');
  }
  return `${pan.slice(0, 6)}******${pan.slice(-4)}`;
}
