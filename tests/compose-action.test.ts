// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  applyComposeActionUi,
  canManageAccess,
  manageAccessHintKey,
  isDisabled,
  type ComposeActionElements,
} from "../src/pages/compose-action/manage-access";

// Mirror the real popup markup (public/pages/compose-action/compose-action.html)
// so the test exercises the exact element ids and structure shipped to users.
function buildPopup(): ComposeActionElements {
  document.body.innerHTML = `
    <div class="status" id="status-text" role="status" aria-live="polite"></div>
    <div class="actions">
      <button class="btn" id="btn-manage" aria-disabled="true">Manage Access</button>
      <p class="hint" id="manage-hint" role="status" aria-live="polite" hidden></p>
      <button class="btn" id="btn-sign" aria-disabled="true">Sign</button>
    </div>`;
  return {
    statusText: document.getElementById("status-text") as HTMLElement,
    btnManage: document.getElementById("btn-manage") as HTMLButtonElement,
    btnSign: document.getElementById("btn-sign") as HTMLButtonElement,
    manageHint: document.getElementById("manage-hint") as HTMLElement,
  };
}

// Identity translator: returns the key so assertions can match without a real
// _locales bundle.
const t = (key: string) => key;

describe("canManageAccess / manageAccessHintKey", () => {
  it("is usable only when encryption is on and there is a recipient", () => {
    expect(canManageAccess({ encrypt: true, hasRecipients: true })).toBe(true);
    expect(canManageAccess({ encrypt: true, hasRecipients: false })).toBe(false);
    expect(canManageAccess({ encrypt: false, hasRecipients: true })).toBe(false);
  });

  it("surfaces the no-recipients reason only while encryption is enabled", () => {
    expect(manageAccessHintKey({ encrypt: true, hasRecipients: false })).toBe(
      "manageAccessNoRecipients"
    );
    // Encryption off: the status line already explains it — no recipient hint.
    expect(manageAccessHintKey({ encrypt: false, hasRecipients: false })).toBeNull();
    expect(manageAccessHintKey({ encrypt: true, hasRecipients: true })).toBeNull();
  });
});

describe("applyComposeActionUi", () => {
  let els: ComposeActionElements;

  beforeEach(() => {
    els = buildPopup();
  });

  it("enables Manage Access and hides the hint when encryption is on with a recipient", () => {
    applyComposeActionUi(els, { encrypt: true, hasRecipients: true }, t);

    expect(isDisabled(els.btnManage)).toBe(false);
    expect(isDisabled(els.btnSign)).toBe(false);
    expect(els.manageHint.hidden).toBe(true);
    expect(els.manageHint.textContent).toBe("");
    expect(els.btnManage.hasAttribute("aria-describedby")).toBe(false);
    expect(els.statusText.textContent).toBe("encryptionEnabled");
  });

  it("disables Manage Access and shows a reachable hint when there are no recipients", () => {
    applyComposeActionUi(els, { encrypt: true, hasRecipients: false }, t);

    // Still focusable for keyboard / screen-reader users: aria-disabled, not
    // the native disabled attribute (which removes it from the tab order).
    expect(isDisabled(els.btnManage)).toBe(true);
    expect(els.btnManage.hasAttribute("disabled")).toBe(false);

    // The reason is visible (not hover-only) and announced.
    expect(els.manageHint.hidden).toBe(false);
    expect(els.manageHint.textContent).toBe("manageAccessNoRecipients");

    // And programmatically tied to the button so it is announced on focus.
    expect(els.btnManage.getAttribute("aria-describedby")).toBe("manage-hint");
    expect(document.getElementById("manage-hint")).not.toBeNull();
  });

  it("does not show the recipient hint when encryption is off", () => {
    applyComposeActionUi(els, { encrypt: false, hasRecipients: false }, t);

    expect(isDisabled(els.btnManage)).toBe(true);
    expect(isDisabled(els.btnSign)).toBe(true);
    expect(els.manageHint.hidden).toBe(true);
    expect(els.btnManage.hasAttribute("aria-describedby")).toBe(false);
    expect(els.statusText.textContent).toBe("encryptionDisabled");
  });

  it("clears the hint when recipients are added after it was shown", () => {
    applyComposeActionUi(els, { encrypt: true, hasRecipients: false }, t);
    expect(els.manageHint.hidden).toBe(false);
    expect(els.btnManage.getAttribute("aria-describedby")).toBe("manage-hint");

    applyComposeActionUi(els, { encrypt: true, hasRecipients: true }, t);
    expect(els.manageHint.hidden).toBe(true);
    expect(els.manageHint.textContent).toBe("");
    expect(els.btnManage.hasAttribute("aria-describedby")).toBe(false);
    expect(isDisabled(els.btnManage)).toBe(false);
  });
});
