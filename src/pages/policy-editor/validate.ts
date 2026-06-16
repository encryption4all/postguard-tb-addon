import { MOBILE_NUMBER_ATTR_TYPE, validateMobileNumber } from "./phone";

/** A mobile-number value input together with its row's checkbox and error slot. */
export interface MobileField {
  input: HTMLInputElement;
  checkbox: HTMLInputElement | null;
  error: HTMLElement | null;
}

/**
 * Collect every mobile-number value input in the editor.
 *
 * The selector is deliberately scoped to `.attr-value`: the checkbox carries
 * the same `data-attr-type` and is appended to the `.attr-item` BEFORE the
 * value input, so an unscoped `input[data-attr-type=...]` returns the checkbox
 * (whose `.value` is the non-empty `"on"`) first. The Save gate would then
 * validate `"on"` as a phone number, fail, and permanently block saving any
 * policy that includes a mobile number (PR #134 review). This mirrors the
 * scoping `collectPolicy` already uses for the same reason.
 */
export function mobileFields(container: ParentNode): MobileField[] {
  const inputs = container.querySelectorAll<HTMLInputElement>(
    `.attr-value input[data-attr-type="${MOBILE_NUMBER_ATTR_TYPE}"]`
  );
  return Array.from(inputs, (input) => {
    const item = input.closest(".attr-item");
    return {
      input,
      checkbox:
        item?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null,
      error: item?.querySelector<HTMLElement>(".attr-error") ?? null,
    };
  });
}

/** A field needs validating only when it is selected and has a non-empty value. */
export function isActiveMobileField(field: MobileField): boolean {
  return !!field.checkbox?.checked && field.input.value.trim().length > 0;
}

/**
 * Returns the first selected, non-empty mobile field whose value is not a valid
 * E.164 mobile number, or `null` when every selected number is valid (or none
 * are present). Pure — does not touch the DOM — so the Save gate it backs can
 * be unit-tested directly.
 */
export function firstInvalidMobileInput(
  container: ParentNode
): HTMLInputElement | null {
  for (const field of mobileFields(container)) {
    if (
      isActiveMobileField(field) &&
      !validateMobileNumber(field.input.value).valid
    ) {
      return field.input;
    }
  }
  return null;
}
