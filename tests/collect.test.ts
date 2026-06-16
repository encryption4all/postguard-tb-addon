// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { collectPolicy } from "../src/pages/policy-editor/collect";

const EMAIL_TYPE = "pbdf.sidn-pbdf.email.email";
const MOBILE_TYPE = "pbdf.sidn-pbdf.mobilenumber.mobilenumber";

/**
 * Build a `.recipient-section` that mirrors what `renderRecipients` produces:
 * each attribute is an `.attr-item` label containing a checkbox plus a
 * `.attr-value` span wrapping the value input. The checkbox is appended
 * before the value container and carries the same `data-attr-type`, which is
 * exactly the layout that made the unscoped selector pick up the checkbox.
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

    item.appendChild(checkbox);
    item.appendChild(valueContainer);
    grid.appendChild(item);
  }

  section.appendChild(grid);
  return section;
}

describe("collectPolicy — reads selected attribute values from the DOM", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.innerHTML = "";
    document.body.appendChild(container);
  });

  it("reads the type='tel' mobile input and normalises it to E.164", () => {
    // Regression for PR #134: the mobile field is type='tel', not 'text'. A
    // selector that filtered on type='text' silently dropped valid numbers.
    container.appendChild(
      buildSection("alice@example.com", [
        { type: EMAIL_TYPE, value: "alice@example.com", checked: true },
        {
          type: MOBILE_TYPE,
          value: "0612345678",
          checked: true,
          inputType: "tel",
        },
      ])
    );

    expect(collectPolicy(container)).toEqual({
      "alice@example.com": [
        { t: EMAIL_TYPE, v: "alice@example.com" },
        { t: MOBILE_TYPE, v: "+31612345678" },
      ],
    });
  });

  it("never reads the checkbox's value ('on') instead of the typed value", () => {
    // Regression: the checkbox shares data-attr-type and precedes the value
    // input in tree order, so an unscoped selector returned the checkbox
    // (value 'on'). Scoping to .attr-value prevents that.
    container.appendChild(
      buildSection("bob@example.com", [
        {
          type: MOBILE_TYPE,
          value: "+31612345678",
          checked: true,
          inputType: "tel",
        },
      ])
    );

    const policy = collectPolicy(container);
    expect(policy["bob@example.com"]).toEqual([
      { t: MOBILE_TYPE, v: "+31612345678" },
    ]);
    // Explicitly assert the checkbox default value never leaks through.
    expect(policy["bob@example.com"][0].v).not.toBe("on");
  });

  it("skips unchecked attributes and empty non-email values", () => {
    container.appendChild(
      buildSection("carol@example.com", [
        { type: EMAIL_TYPE, value: "carol@example.com", checked: true },
        { type: MOBILE_TYPE, value: "", checked: true, inputType: "tel" },
        {
          type: "pbdf.gemeente.personalData.surname",
          value: "Jansen",
          checked: false,
        },
      ])
    );

    expect(collectPolicy(container)).toEqual({
      "carol@example.com": [{ t: EMAIL_TYPE, v: "carol@example.com" }],
    });
  });

  it("collects multiple recipient sections independently", () => {
    container.appendChild(
      buildSection("a@example.com", [
        { type: EMAIL_TYPE, value: "a@example.com", checked: true },
      ])
    );
    container.appendChild(
      buildSection("b@example.com", [
        { type: EMAIL_TYPE, value: "b@example.com", checked: true },
        {
          type: MOBILE_TYPE,
          value: "06 12 34 56 78",
          checked: true,
          inputType: "tel",
        },
      ])
    );

    expect(collectPolicy(container)).toEqual({
      "a@example.com": [{ t: EMAIL_TYPE, v: "a@example.com" }],
      "b@example.com": [
        { t: EMAIL_TYPE, v: "b@example.com" },
        { t: MOBILE_TYPE, v: "+31612345678" },
      ],
    });
  });
});
