// Pure helper behind the compose-action popup's encryption-status panel.
//
// The panel is the compose-window counterpart of the message-display decrypt
// banner: it tells the user, before they hit send, that PostGuard encryption
// is active, who the mail will be encrypted for (with the Yivi attributes each
// recipient must disclose), and which identity the sender signs with.
//
// It lives in the compose-action popup rather than in the compose body because
// a WebExtension can only inject content into the compose editor itself, and
// anything injected there becomes part of the sent message. The popup is the
// supported, body-safe surface for compose chrome.
//
// This module is intentionally free of any `browser.*` access so it can be
// unit-tested without the WebExtension runtime — attribute-label translation
// is supplied by the caller as a plain function.

import type { Policy } from "../../lib/types";
import { EMAIL_ATTRIBUTE_TYPE } from "../../lib/utils";

/** Compose state needed to summarize what a send will do. Mirrors the payload
 *  returned by the background `getComposeState` handler. */
export interface ComposeStatusInput {
  encrypt: boolean;
  /** Normalized (lowercased, address-only) To + Cc recipients. */
  recipients: string[];
  /** Per-recipient attribute requirements set via "Manage Access". When a
   *  recipient has no custom policy they fall back to email-only. */
  policy?: Policy;
  /** Per-account signing attributes set via "Sign", keyed by from-address. */
  signId?: Policy;
  /** Normalized (lowercased, address-only) from-address. */
  from: string;
  /** Whether any Bcc recipient is set (PostGuard does not support Bcc). */
  hasBcc: boolean;
}

export interface RecipientSummary {
  /** The recipient's email address. */
  email: string;
  /** Localized labels of the attributes this recipient must disclose to
   *  decrypt. Always includes the email-address attribute. */
  attributes: string[];
}

export interface SigningSummary {
  /** The sender's from-address (always disclosed as part of the signature). */
  from: string;
  /** Localized labels of the attributes the sender signs with. Always
   *  includes the email-address attribute. */
  attributes: string[];
}

export interface ComposeStatusSummary {
  encrypt: boolean;
  recipients: RecipientSummary[];
  signing: SigningSummary;
  /** Pre-translated warning lines (e.g. the Bcc-unsupported notice). */
  warnings: string[];
}

export type Translate = (key: string) => string;

/** Resolve an attribute type to a human label, falling back to the raw type
 *  when no localized string exists (mirrors the policy editor). */
function attributeLabel(type: string, t: Translate): string {
  return t(type) || type;
}

/**
 * Map a list of attribute requests to localized labels. The email attribute
 * is mandatory for every PostGuard identity, so it is always present and
 * listed first even when an explicit policy omitted it.
 */
function attributeLabels(con: ReadonlyArray<{ t: string }> | undefined, t: Translate): string[] {
  const types: string[] = [EMAIL_ATTRIBUTE_TYPE];
  for (const attr of con ?? []) {
    if (!types.includes(attr.t)) types.push(attr.t);
  }
  return types.map((type) => attributeLabel(type, t));
}

/**
 * Build a structured, render-ready summary of what sending the current
 * compose tab will do. Pure: all i18n is delegated to `t`.
 */
export function buildComposeStatusSummary(
  input: ComposeStatusInput,
  t: Translate
): ComposeStatusSummary {
  const recipients: RecipientSummary[] = input.recipients.map((email) => ({
    email,
    attributes: attributeLabels(input.policy?.[email], t),
  }));

  const signing: SigningSummary = {
    from: input.from,
    // The sender always signs with their public email; `signId` adds extra
    // private attributes (the email entry is dropped before encryption, so
    // re-add it here via attributeLabels' guaranteed email label).
    attributes: attributeLabels(input.signId?.[input.from], t),
  };

  const warnings: string[] = [];
  if (input.hasBcc) warnings.push(t("composeBccWarning"));

  return { encrypt: input.encrypt, recipients, signing, warnings };
}

// --- Rendering ---
// DOM construction is split out from the data builder above so the summary
// can be asserted as plain data, while this renderer is exercised under jsdom
// (same split as manage-access.ts: pure logic + an `apply*` DOM step).

function makeSection(title: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "panel-section";
  const heading = document.createElement("h3");
  heading.className = "panel-section__title";
  heading.textContent = title;
  section.appendChild(heading);
  return section;
}

function makeIdentityRow(email: string, attributes: string[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "panel-row";

  const emailEl = document.createElement("span");
  emailEl.className = "panel-row__email";
  emailEl.textContent = email;
  row.appendChild(emailEl);

  const badges = document.createElement("span");
  badges.className = "panel-row__badges";
  for (const label of attributes) {
    const badge = document.createElement("span");
    badge.className = "panel-badge";
    badge.textContent = label;
    badges.appendChild(badge);
  }
  row.appendChild(badges);
  return row;
}

/**
 * Render `summary` into `container`. The panel is shown only while encryption
 * is enabled; when it is off the container is cleared and hidden so the popup
 * collapses back to the bare toggle. Idempotent — safe to call on every state
 * refresh.
 */
export function renderComposeStatusPanel(
  container: HTMLElement,
  summary: ComposeStatusSummary,
  t: Translate
): void {
  container.textContent = "";
  container.hidden = !summary.encrypt;
  if (!summary.encrypt) return;

  const recSection = makeSection(t("composeStatusRecipientsLabel"));
  if (summary.recipients.length === 0) {
    const empty = document.createElement("p");
    empty.className = "panel-empty";
    empty.textContent = t("composeStatusNoRecipients");
    recSection.appendChild(empty);
  } else {
    for (const r of summary.recipients) {
      recSection.appendChild(makeIdentityRow(r.email, r.attributes));
    }
  }
  container.appendChild(recSection);

  const signSection = makeSection(t("notificationComposeBadgesLabel"));
  signSection.appendChild(
    makeIdentityRow(summary.signing.from, summary.signing.attributes)
  );
  container.appendChild(signSection);

  for (const warning of summary.warnings) {
    const warn = document.createElement("p");
    warn.className = "panel-warning";
    warn.setAttribute("role", "alert");
    warn.textContent = warning;
    container.appendChild(warn);
  }
}
