// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  buildComposeStatusSummary,
  renderComposeStatusPanel,
  type ComposeStatusInput,
} from "../src/pages/compose-action/status-summary";
import { EMAIL_ATTRIBUTE_TYPE } from "../src/lib/utils";

const SURNAME = "pbdf.gemeente.personalData.surname";

// Identity translator: returns the key so assertions read against raw keys /
// attribute types without a real _locales bundle.
const t = (key: string) => key;

function base(overrides: Partial<ComposeStatusInput> = {}): ComposeStatusInput {
  return {
    encrypt: true,
    recipients: [],
    from: "sender@example.com",
    hasBcc: false,
    ...overrides,
  };
}

describe("buildComposeStatusSummary", () => {
  it("defaults every recipient to email-only when no policy is set", () => {
    const summary = buildComposeStatusSummary(
      base({ recipients: ["alice@example.com", "bob@example.com"] }),
      t
    );
    expect(summary.recipients).toEqual([
      { email: "alice@example.com", attributes: [EMAIL_ATTRIBUTE_TYPE] },
      { email: "bob@example.com", attributes: [EMAIL_ATTRIBUTE_TYPE] },
    ]);
  });

  it("lists the per-recipient policy attributes alongside the email", () => {
    const summary = buildComposeStatusSummary(
      base({
        recipients: ["alice@example.com"],
        policy: {
          "alice@example.com": [
            { t: EMAIL_ATTRIBUTE_TYPE, v: "alice@example.com" },
            { t: SURNAME, v: "Jansen" },
          ],
        },
      }),
      t
    );
    expect(summary.recipients[0]).toEqual({
      email: "alice@example.com",
      attributes: [EMAIL_ATTRIBUTE_TYPE, SURNAME],
    });
  });

  it("always lists the email attribute first even if a policy omitted it", () => {
    const summary = buildComposeStatusSummary(
      base({
        recipients: ["alice@example.com"],
        policy: { "alice@example.com": [{ t: SURNAME, v: "Jansen" }] },
      }),
      t
    );
    expect(summary.recipients[0].attributes).toEqual([EMAIL_ATTRIBUTE_TYPE, SURNAME]);
  });

  it("signs with the sender email by default", () => {
    const summary = buildComposeStatusSummary(base(), t);
    expect(summary.signing).toEqual({
      from: "sender@example.com",
      attributes: [EMAIL_ATTRIBUTE_TYPE],
    });
  });

  it("adds extra signing attributes from signId, keyed by the from-address", () => {
    const summary = buildComposeStatusSummary(
      base({
        signId: {
          "sender@example.com": [
            { t: EMAIL_ATTRIBUTE_TYPE, v: "sender@example.com" },
            { t: SURNAME, v: "De Vries" },
          ],
        },
      }),
      t
    );
    expect(summary.signing.attributes).toEqual([EMAIL_ATTRIBUTE_TYPE, SURNAME]);
  });

  it("surfaces a Bcc warning when any Bcc recipient is set", () => {
    expect(buildComposeStatusSummary(base({ hasBcc: false }), t).warnings).toEqual([]);
    expect(buildComposeStatusSummary(base({ hasBcc: true }), t).warnings).toEqual([
      "composeBccWarning",
    ]);
  });

  it("carries the encrypt flag through", () => {
    expect(buildComposeStatusSummary(base({ encrypt: false }), t).encrypt).toBe(false);
    expect(buildComposeStatusSummary(base({ encrypt: true }), t).encrypt).toBe(true);
  });
});

describe("renderComposeStatusPanel", () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = `<div id="status-panel" hidden></div>`;
    container = document.getElementById("status-panel") as HTMLElement;
  });

  it("hides and clears the panel when encryption is off", () => {
    // First render something, then turn encryption off and confirm it collapses.
    renderComposeStatusPanel(
      container,
      buildComposeStatusSummary(base({ recipients: ["alice@example.com"] }), t),
      t
    );
    expect(container.hidden).toBe(false);

    renderComposeStatusPanel(
      container,
      buildComposeStatusSummary(base({ encrypt: false, recipients: ["alice@example.com"] }), t),
      t
    );
    expect(container.hidden).toBe(true);
    expect(container.children.length).toBe(0);
  });

  it("renders a recipient row with an attribute badge per disclosed attribute", () => {
    renderComposeStatusPanel(
      container,
      buildComposeStatusSummary(
        base({
          recipients: ["alice@example.com"],
          policy: {
            "alice@example.com": [
              { t: EMAIL_ATTRIBUTE_TYPE, v: "alice@example.com" },
              { t: SURNAME, v: "Jansen" },
            ],
          },
        }),
        t
      ),
      t
    );

    expect(container.hidden).toBe(false);
    const emails = [...container.querySelectorAll(".panel-row__email")].map(
      (el) => el.textContent
    );
    expect(emails).toContain("alice@example.com");
    expect(emails).toContain("sender@example.com"); // signing row

    const rcptRow = container.querySelector(".panel-row")!;
    const badges = [...rcptRow.querySelectorAll(".panel-badge")].map((el) => el.textContent);
    expect(badges).toEqual([EMAIL_ATTRIBUTE_TYPE, SURNAME]);
  });

  it("shows the empty hint when encryption is on with no recipients", () => {
    renderComposeStatusPanel(container, buildComposeStatusSummary(base(), t), t);
    const empty = container.querySelector(".panel-empty");
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toBe("composeStatusNoRecipients");
  });

  it("renders Bcc warnings as alerts", () => {
    renderComposeStatusPanel(
      container,
      buildComposeStatusSummary(base({ recipients: ["alice@example.com"], hasBcc: true }), t),
      t
    );
    const warning = container.querySelector(".panel-warning");
    expect(warning).not.toBeNull();
    expect(warning!.getAttribute("role")).toBe("alert");
    expect(warning!.textContent).toBe("composeBccWarning");
  });
});
