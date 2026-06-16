// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { firstInvalidMobileInput } from "../src/pages/policy-editor/validate";

const EMAIL_TYPE = "pbdf.sidn-pbdf.email.email";
const MOBILE_TYPE = "pbdf.sidn-pbdf.mobilenumber.mobilenumber";

/**
 * Build a `.recipient-section` that mirrors what `renderRecipients` produces:
 * the checkbox is appended to the `.attr-item` BEFORE the `.attr-value` value
 * input and carries the same `data-attr-type`. This is the exact layout that
 * made an unscoped `input[data-attr-type=...]` selector match the checkbox
 * (value "on") first and permanently block Save.
 */
function buildSection(
  email: string,
  attrs: Array<{ type: string; value: string; checked: boolean; inputType?: string }>
): HTMLElement {
  const section = document.createElement("div");
  section.className = "recipient-section";
  section.dataset.email = email;

  const grid = document.createElement("div");
  grid.className = "attr-grid";

  for (const attr of attrs) {
    const item = document.createElement("label");
    item.className = "attr-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = attr.checked;
    checkbox.dataset.attrType = attr.type;

    const valueContainer = document.createElement("span");
    valueContainer.className = "attr-value";
    const valueInput = document.createElement("input");
    valueInput.type = attr.inputType ?? "text";
    valueInput.value = attr.value;
    valueInput.dataset.attrType = attr.type;
    valueContainer.appendChild(valueInput);

    const error = document.createElement("span");
    error.className = "attr-error";

    // Match production tree order: checkbox, then value, then error slot.
    item.appendChild(checkbox);
    item.appendChild(valueContainer);
    valueContainer.appendChild(error);
    grid.appendChild(item);
  }

  section.appendChild(grid);
  return section;
}

describe("firstInvalidMobileInput — Save gate for recipient mobile numbers", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.innerHTML = "";
    document.body.appendChild(container);
  });

  it("does not block Save when a checked mobile attribute has a valid number", () => {
    // Regression for PR #134 cycle 2: the unscoped selector matched the
    // checkbox (value "on") before the type='tel' input, so a perfectly valid
    // number could never be saved. The checkbox must never be returned.
    container.appendChild(
      buildSection("alice@example.com", [
        { type: EMAIL_TYPE, value: "alice@example.com", checked: true },
        {
          type: MOBILE_TYPE,
          value: "+31612345678",
          checked: true,
          inputType: "tel",
        },
      ])
    );

    expect(firstInvalidMobileInput(container)).toBeNull();
  });

  it("accepts a local-format Dutch number (normalised elsewhere to E.164)", () => {
    container.appendChild(
      buildSection("bob@example.com", [
        { type: MOBILE_TYPE, value: "0612345678", checked: true, inputType: "tel" },
      ])
    );

    expect(firstInvalidMobileInput(container)).toBeNull();
  });

  it("never returns the checkbox even though it shares data-attr-type", () => {
    container.appendChild(
      buildSection("carol@example.com", [
        { type: MOBILE_TYPE, value: "+31612345678", checked: true, inputType: "tel" },
      ])
    );

    const invalid = firstInvalidMobileInput(container);
    expect(invalid).toBeNull();
    // Belt-and-braces: if anything were ever returned it must be the tel input,
    // never a checkbox carrying value "on".
    expect(invalid?.type).not.toBe("checkbox");
  });

  it("blocks Save and returns the offending tel input for a malformed number", () => {
    container.appendChild(
      buildSection("dave@example.com", [
        { type: MOBILE_TYPE, value: "not-a-number", checked: true, inputType: "tel" },
      ])
    );

    const invalid = firstInvalidMobileInput(container);
    expect(invalid).not.toBeNull();
    expect(invalid?.type).toBe("tel");
    expect(invalid?.value).toBe("not-a-number");
  });

  it("rejects a landline (mobile-only validation)", () => {
    container.appendChild(
      buildSection("erin@example.com", [
        // Dutch landline (070...) — valid number but not a mobile.
        { type: MOBILE_TYPE, value: "0701234567", checked: true, inputType: "tel" },
      ])
    );

    expect(firstInvalidMobileInput(container)).not.toBeNull();
  });

  it("ignores an unchecked mobile attribute even if its value is malformed", () => {
    container.appendChild(
      buildSection("frank@example.com", [
        { type: MOBILE_TYPE, value: "garbage", checked: false, inputType: "tel" },
      ])
    );

    expect(firstInvalidMobileInput(container)).toBeNull();
  });

  it("ignores a checked mobile attribute with an empty value (optional field)", () => {
    container.appendChild(
      buildSection("grace@example.com", [
        { type: MOBILE_TYPE, value: "   ", checked: true, inputType: "tel" },
      ])
    );

    expect(firstInvalidMobileInput(container)).toBeNull();
  });

  it("returns the first offending input across multiple recipients", () => {
    container.appendChild(
      buildSection("alice@example.com", [
        { type: MOBILE_TYPE, value: "+31612345678", checked: true, inputType: "tel" },
      ])
    );
    container.appendChild(
      buildSection("bob@example.com", [
        { type: MOBILE_TYPE, value: "bogus", checked: true, inputType: "tel" },
      ])
    );

    const invalid = firstInvalidMobileInput(container);
    expect(invalid?.value).toBe("bogus");
  });
});
