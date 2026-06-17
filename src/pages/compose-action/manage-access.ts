// Pulled out of compose-action.ts so the enable/disable + hint logic for the
// compose popup can be unit-tested without the WebExtension runtime.
//
// The "Manage Access" button is only usable once encryption is on AND the
// message has at least one recipient. When it is disabled purely because no
// recipients have been added yet, we surface that reason as visible helper
// text and keep the button focusable (via `aria-disabled` rather than the
// native `disabled` attribute) so keyboard and screen-reader users can reach
// the explanation — a hover-only tooltip would not. See WCAG 2.2 AA.

export interface ComposeUiState {
  encrypt: boolean;
  hasRecipients: boolean;
}

export interface ComposeActionElements {
  statusText: HTMLElement;
  btnManage: HTMLButtonElement;
  btnSign: HTMLButtonElement;
  manageHint: HTMLElement;
}

export type Translate = (key: string) => string;

/**
 * "Manage Access" can be opened only when encryption is enabled and at least
 * one recipient has been added.
 */
export function canManageAccess(state: ComposeUiState): boolean {
  return state.encrypt && state.hasRecipients;
}

/**
 * i18n key for the reason "Manage Access" is unavailable, or `null` when it is
 * usable. The only reason we spell out is "no recipients yet": when encryption
 * itself is off the status line already explains the situation, so adding a
 * recipient hint there would be misleading.
 */
export function manageAccessHintKey(state: ComposeUiState): string | null {
  if (state.encrypt && !state.hasRecipients) return "manageAccessNoRecipients";
  return null;
}

/**
 * Apply the current compose state to the popup UI: status line, button
 * availability, and the accessible reason the "Manage Access" button is
 * disabled.
 */
export function applyComposeActionUi(
  els: ComposeActionElements,
  state: ComposeUiState,
  t: Translate
): void {
  els.statusText.textContent = state.encrypt
    ? t("encryptionEnabled")
    : t("encryptionDisabled");

  setDisabled(els.btnManage, !canManageAccess(state));
  setDisabled(els.btnSign, !state.encrypt);

  const hintKey = manageAccessHintKey(state);
  if (hintKey) {
    els.manageHint.textContent = t(hintKey);
    els.manageHint.hidden = false;
    if (els.manageHint.id) {
      els.btnManage.setAttribute("aria-describedby", els.manageHint.id);
    }
  } else {
    els.manageHint.textContent = "";
    els.manageHint.hidden = true;
    els.btnManage.removeAttribute("aria-describedby");
  }
}

/**
 * Disable a button via `aria-disabled` instead of the native `disabled`
 * attribute. A natively-disabled button is removed from the tab order, so its
 * `aria-describedby` reason can never be reached by keyboard / screen-reader
 * users. `aria-disabled` keeps it focusable; callers must still guard the
 * click handler against acting while disabled.
 */
export function setDisabled(btn: HTMLButtonElement, disabled: boolean): void {
  if (disabled) {
    btn.setAttribute("aria-disabled", "true");
  } else {
    btn.removeAttribute("aria-disabled");
  }
}

/** Whether a button rendered with `aria-disabled` should ignore activation. */
export function isDisabled(btn: HTMLElement): boolean {
  return btn.getAttribute("aria-disabled") === "true";
}
