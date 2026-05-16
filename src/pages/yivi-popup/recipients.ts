import type { Recipient, PostGuard } from "@e4a/pg-js";
import type { SerializedRecipient } from "../../lib/types";
import { EMAIL_ATTRIBUTE_TYPE } from "../../lib/utils";

// Pulled out of yivi-popup.ts so the recipient-rebuild can be tested
// without depending on the DOM / popup runtime. The function is a pure
// translation of the wire format the background sends us into the
// typed Recipient builders pg-js exposes.

export type RecipientFactory = Pick<
  PostGuard["recipient"],
  "email" | "emailDomain"
>;

/**
 * Reconstitute the `Recipient[]` argument for `pg.encrypt()` from the
 * `SerializedRecipient[]` the background put on the wire. Custom
 * attribute disclosures are layered onto the base via `extraAttribute`;
 * the email attribute itself is the implicit identity and is not
 * re-added.
 */
export function buildRecipients(
  factory: RecipientFactory,
  serialized: readonly SerializedRecipient[],
): Recipient[] {
  return serialized.map((r) => {
    const base =
      r.type === "emailDomain"
        ? factory.emailDomain(r.email)
        : factory.email(r.email);
    if (r.policy) {
      for (const attr of r.policy) {
        if (attr.t !== EMAIL_ATTRIBUTE_TYPE) {
          base.extraAttribute(attr.t, attr.v);
        }
      }
    }
    return base;
  });
}
