/// <reference path="../../types/thunderbird.d.ts" />
export {};

import { EMAIL_ATTRIBUTE_TYPE as EMAIL_ATTR_TYPE } from "../../lib/utils";
import { MOBILE_NUMBER_ATTR_TYPE, validateMobileNumber } from "./phone";
import { collectPolicy } from "./collect";

interface InitData {
  initialPolicy: Record<string, Array<{ t: string; v: string }>>;
  sign: boolean;
}

const ATTRIBUTE_TYPES = [
  { type: EMAIL_ATTR_TYPE, label: "Email address", hasValue: true },
  { type: "pbdf.sidn-pbdf.mobilenumber.mobilenumber", label: "Mobile number", hasValue: true },
  { type: "pbdf.gemeente.personalData.surname", label: "Surname", hasValue: true },
  { type: "pbdf.gemeente.personalData.dateofbirth", label: "Date of birth", hasValue: true },
  { type: "pbdf.nuts.agb.agbcode", label: "AGB code", hasValue: true },
  { type: "pbdf.pbdf.surfnet-2.id", label: "Surf EduID", hasValue: true },
];

const container = document.getElementById("recipients-container")!;
const btnSave = document.getElementById("btn-save") as HTMLButtonElement;
const btnCancel = document.getElementById("btn-cancel") as HTMLButtonElement;
const pageTitle = document.getElementById("page-title") as HTMLElement;

let initData: InitData | null = null;

async function init() {
  // Request initial data from background
  initData = (await browser.runtime.sendMessage({
    type: "policyEditorInit",
  })) as InitData | null;

  if (!initData) {
    container.innerHTML = '<div class="empty-state">No recipients found.</div>';
    return;
  }

  if (initData.sign) {
    pageTitle.textContent = "PostGuard — Sign";
  }

  renderRecipients(initData.initialPolicy);
}

function renderRecipients(
  policy: Record<string, Array<{ t: string; v: string }>>
) {
  container.innerHTML = "";

  for (const [email, attrs] of Object.entries(policy)) {
    const section = document.createElement("div");
    section.className = "recipient-section";
    section.dataset.email = email;

    const emailLabel = document.createElement("div");
    emailLabel.className = "recipient-email";
    emailLabel.textContent = email;
    section.appendChild(emailLabel);

    const grid = document.createElement("div");
    grid.className = "attr-grid";

    for (const attrType of ATTRIBUTE_TYPES) {
      const existing = attrs.find((a) => a.t === attrType.type);
      // Email attribute is always mandatory and locked to the recipient's/sender's address
      const isLockedEmail = attrType.type === EMAIL_ATTR_TYPE;
      const isChecked = isLockedEmail || !!existing;

      const item = document.createElement("label");
      item.className = "attr-item" + (isChecked ? " selected" : "") + (isLockedEmail ? " locked" : "");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = isChecked;
      checkbox.dataset.attrType = attrType.type;
      if (isLockedEmail) checkbox.disabled = true;

      // Use localized label if available
      const labelText = browser.i18n.getMessage(attrType.type) || attrType.label;
      const label = document.createElement("span");
      label.textContent = labelText;

      const valueContainer = document.createElement("span");
      valueContainer.className = "attr-value";
      const valueInput = document.createElement("input");
      valueInput.type = attrType.type === MOBILE_NUMBER_ATTR_TYPE ? "tel" : "text";
      valueInput.placeholder = labelText;
      valueInput.value = isLockedEmail ? email : (existing?.v ?? "");
      valueInput.dataset.attrType = attrType.type;
      if (isLockedEmail) valueInput.readOnly = true;

      valueContainer.appendChild(valueInput);

      // Mobile numbers must be valid E.164 (Yivi stores them that way and a
      // malformed value silently breaks decryption — cryptify#39). Show an
      // inline error as the user types and on blur, mirroring the website.
      if (attrType.type === MOBILE_NUMBER_ATTR_TYPE) {
        const error = document.createElement("span");
        error.className = "attr-error";
        error.setAttribute("role", "alert");
        valueContainer.appendChild(error);

        const validate = () => {
          // Only flag a non-empty value when the attribute is selected.
          if (checkbox.checked && valueInput.value.trim().length > 0) {
            return showPhoneValidity(valueInput, error);
          }
          clearPhoneError(valueInput, error);
          return true;
        };

        valueInput.addEventListener("input", validate);
        valueInput.addEventListener("blur", validate);
      }

      checkbox.addEventListener("change", () => {
        item.classList.toggle("selected", checkbox.checked);
        if (checkbox.checked && !valueInput.value) {
          valueInput.focus();
        }
        // Clear any stale error when the attribute is unchecked.
        if (!checkbox.checked && attrType.type === MOBILE_NUMBER_ATTR_TYPE) {
          const error = valueContainer.querySelector<HTMLElement>(".attr-error");
          if (error) clearPhoneError(valueInput, error);
        }
      });

      item.appendChild(checkbox);
      item.appendChild(label);
      item.appendChild(valueContainer);
      grid.appendChild(item);
    }

    section.appendChild(grid);
    container.appendChild(section);
  }
}

// Mark a mobile-number input as invalid and surface a clear inline message.
// Returns whether the current value is valid.
function showPhoneValidity(
  input: HTMLInputElement,
  error: HTMLElement
): boolean {
  const { valid } = validateMobileNumber(input.value);
  if (valid) {
    clearPhoneError(input, error);
    return true;
  }
  input.classList.add("invalid");
  input.setAttribute("aria-invalid", "true");
  error.textContent =
    browser.i18n.getMessage("policyEditorInvalidPhone") ||
    "Enter a valid mobile number, e.g. 0612345678 or +31612345678.";
  return false;
}

function clearPhoneError(input: HTMLInputElement, error: HTMLElement): void {
  input.classList.remove("invalid");
  input.removeAttribute("aria-invalid");
  error.textContent = "";
}

// Validate every selected mobile-number field, surfacing inline errors.
// Returns the first invalid input (for focusing) or null when all are valid.
function validateMobileInputs(): HTMLInputElement | null {
  let firstInvalid: HTMLInputElement | null = null;
  const inputs = container.querySelectorAll<HTMLInputElement>(
    `input[data-attr-type="${MOBILE_NUMBER_ATTR_TYPE}"]`
  );

  for (const input of inputs) {
    const item = input.closest(".attr-item");
    const checkbox = item?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]'
    );
    const error = item?.querySelector<HTMLElement>(".attr-error");
    if (!error) continue;

    if (!checkbox?.checked || input.value.trim().length === 0) {
      clearPhoneError(input, error);
      continue;
    }

    if (!showPhoneValidity(input, error) && !firstInvalid) {
      firstInvalid = input;
    }
  }

  return firstInvalid;
}

btnSave.addEventListener("click", async () => {
  // Reject wrongly-formatted mobile numbers before they reach the policy.
  const firstInvalid = validateMobileInputs();
  if (firstInvalid) {
    firstInvalid.focus();
    return;
  }

  const policy = collectPolicy(container);
  await browser.runtime.sendMessage({
    type: "policyEditorDone",
    policy,
  });
  window.close();
});

btnCancel.addEventListener("click", () => {
  window.close();
});

init();
