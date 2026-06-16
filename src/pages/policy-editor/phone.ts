import {
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/mobile";

// Yivi stores mobile numbers in canonical E.164 (e.g. "+31612345678"). If the
// policy commits anything that isn't canonical E.164, the identity derived
// during encryption no longer matches the one Yivi discloses at decrypt time
// and decryption silently fails (tracked in cryptify#39). The PostGuard
// website validates this attribute the exact same way via
// `libphonenumber-js/mobile`; this helper mirrors that logic so the
// Thunderbird addon rejects wrongly-formatted numbers before they are used.
export const MOBILE_NUMBER_ATTR_TYPE =
  "pbdf.sidn-pbdf.mobilenumber.mobilenumber";

// Default region used to interpret local-format input (e.g. "0612345678").
export const DEFAULT_PHONE_COUNTRY: CountryCode = "NL";

export interface PhoneValidationResult {
  /**
   * Whether the input is acceptable. An empty input is considered valid: the
   * mobile-number attribute is optional, so a blank field simply means "no
   * mobile number" rather than a formatting error.
   */
  valid: boolean;
  /**
   * Canonical E.164 representation when the input parses to a valid mobile
   * number (e.g. "+31612345678"), otherwise `null`. Callers should persist
   * this value rather than the raw input so the encrypted policy matches what
   * Yivi discloses at decrypt time.
   */
  e164: string | null;
}

/**
 * Validate and normalise a recipient mobile number.
 *
 * Mirrors the PostGuard website's `MultiInput.svelte` validation: parse via
 * `libphonenumber-js/mobile` so local-format inputs are normalised to E.164,
 * and treat anything that does not parse to a valid mobile number as invalid.
 *
 * @param input   The raw value typed by the user.
 * @param country The region used to interpret local-format numbers without a
 *                country prefix. Defaults to the Netherlands.
 */
export function validateMobileNumber(
  input: string,
  country: CountryCode = DEFAULT_PHONE_COUNTRY
): PhoneValidationResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { valid: true, e164: null };
  }

  const parsed = parsePhoneNumberFromString(trimmed, country);
  if (parsed?.isValid()) {
    return { valid: true, e164: parsed.number };
  }

  return { valid: false, e164: null };
}
