import { EMAIL_ATTRIBUTE_TYPE as EMAIL_ATTR_TYPE } from "../../lib/utils";
import { MOBILE_NUMBER_ATTR_TYPE, validateMobileNumber } from "./phone";

/**
 * Read the selected attributes out of the rendered recipient sections.
 *
 * Each `.recipient-section` holds a grid of `.attr-item` labels; an attribute
 * is included when its checkbox is checked. The value comes from the matching
 * `.attr-value input`.
 *
 * The selector is deliberately scoped to `.attr-value` and does NOT filter on
 * input type: the value input is a text field for most attributes but
 * `type="tel"` for the mobile number, and the checkbox carries the same
 * `data-attr-type` while appearing earlier in tree order — an unscoped
 * `input[data-attr-type=...]` would return the checkbox (value "on") instead of
 * the typed value (cryptify#39, PR #134 review).
 */
export function collectPolicy(
  container: ParentNode
): Record<string, Array<{ t: string; v: string }>> {
  const policy: Record<string, Array<{ t: string; v: string }>> = {};
  const sections = container.querySelectorAll(".recipient-section");

  for (const section of sections) {
    const email = (section as HTMLElement).dataset.email!;
    const attrs: Array<{ t: string; v: string }> = [];

    const checkboxes = section.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]:checked'
    );

    for (const cb of checkboxes) {
      const type = cb.dataset.attrType!;
      const valueInput = section.querySelector<HTMLInputElement>(
        `.attr-value input[data-attr-type="${type}"]`
      );
      let value = valueInput?.value?.trim() ?? "";
      // Skip non-email attributes with empty values
      if (!value && type !== EMAIL_ATTR_TYPE) continue;
      // Persist the canonical E.164 form so the encrypted policy matches what
      // Yivi discloses at decrypt time (cryptify#39).
      if (type === MOBILE_NUMBER_ATTR_TYPE) {
        const { e164 } = validateMobileNumber(value);
        if (e164) value = e164;
      }
      attrs.push({ t: type, v: value });
    }

    policy[email] = attrs;
  }

  return policy;
}
