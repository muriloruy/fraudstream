import { z } from 'zod';

/**
 * Money is always a decimal string with at most 2 decimal places, never a JS number
 * (SPEC §4.9, ADR-009). Up to 16 integer digits fits numeric(18,2).
 */
// Bounded quantifiers only, no nested repetition: not vulnerable to ReDoS.
// eslint-disable-next-line security/detect-unsafe-regex
const DECIMAL_STRING = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;

export const DecimalString = z
  .string()
  .regex(DECIMAL_STRING, 'must be a decimal string with at most 2 decimal places');
export type DecimalString = z.infer<typeof DecimalString>;

// Zod runs refinements even after the regex check failed, so guard before converting.
export const PositiveDecimalString = DecimalString.refine(
  (value) => isDecimalString(value) && toCents(value) > 0n,
  { message: 'must be greater than zero' },
);

export function isDecimalString(value: string): boolean {
  return DECIMAL_STRING.test(value);
}

/** Exact conversion of a validated decimal string to integer cents. */
export function toCents(value: string): bigint {
  if (!isDecimalString(value)) {
    throw new RangeError('not a valid decimal string');
  }
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

/** ISO 4217 currencies accepted by the platform (SPEC §6.1 allow-list). */
export const CURRENCIES = [
  'BRL',
  'USD',
  'EUR',
  'GBP',
  'ARS',
  'CLP',
  'COP',
  'MXN',
  'PEN',
  'UYU',
  'CAD',
  'CHF',
  'JPY',
  'AUD',
  'CNY',
] as const;
export const CurrencyCode = z.enum(CURRENCIES);
export type CurrencyCode = z.infer<typeof CurrencyCode>;

export const Money = z.object({
  value: PositiveDecimalString,
  currency: CurrencyCode,
});
export type Money = z.infer<typeof Money>;

/** ISO 3166-1 alpha-2 officially assigned codes. */
export const COUNTRIES = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
  'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
  'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
  'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
  'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
  'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC',
  'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
  'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
  'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG',
  'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
  'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
  'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
  'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
] as const; // prettier-ignore
export const CountryCode = z.enum(COUNTRIES);
export type CountryCode = z.infer<typeof CountryCode>;

/** Merchant category code: exactly 4 digits. */
export const Mcc = z.string().regex(/^\d{4}$/, 'must be 4 digits');

/**
 * Masked PAN, first 6 and last 4 digits visible (SPEC §5.1 `char(16)`).
 * A full PAN never matches this pattern, so it cannot slip into an event.
 */
export const MaskedPan = z
  .string()
  .regex(/^\d{6}\*{6}\d{4}$/, 'must be masked as first 6 / last 4 digits');

/** Vault token: `tok_` followed by base62 characters (SPEC §5.2). */
export const CardToken = z.string().regex(/^tok_[0-9A-Za-z]{16,64}$/, 'must be a vault token');

/** SHA-256 digest with prefix, used for hashed IPs and device ids (SPEC §4.9). */
export const Sha256Hash = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be sha256:<hex>');

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Time-ordered UUID (RFC 9562 version 7). */
export const UuidV7 = z.string().regex(UUID_V7, 'must be a UUIDv7');

/** Any RFC 9562 UUID. */
export const Uuid = z.uuid();

/** ISO 8601 timestamp in UTC (`Z` suffix). */
export const UtcDateTime = z.iso.datetime({ offset: false });

export const AccountId = z.string().min(1).max(64);
export const MerchantId = z.string().min(1).max(64);

/** A score normalized to [0, 1]. */
export const UnitScore = z.number().min(0).max(1);
