/// <reference path="../types/thunderbird.d.ts" />
export {};

interface MessageState {
  messageId?: number;
  isEncrypted: boolean;
  wasEncrypted: boolean;
  badges?: Array<{ type: string; value: string }>;
}

async function showBanner() {
  console.log("[PostGuard] Message display script running");

  try {
    // Ask the background script to check the message displayed in our tab.
    // Content scripts don't have access to messageDisplay or tabs APIs,
    // so the background uses sender.tab.id to look up the message.
    const state: MessageState | null = await browser.runtime.sendMessage({
      type: "queryMessageState",
    }) as MessageState | null;

    console.log("[PostGuard] Message state:", JSON.stringify(state));

    if (!state) return;

    if (state.isEncrypted) {
      createBanner(
        browser.i18n.getMessage("displayScriptDecryptBar"),
        browser.i18n.getMessage("decryptButton"),
        state.messageId!
      );
    } else if (state.badges && state.badges.length > 0) {
      createBadgeBanner(
        browser.i18n.getMessage("notificationHeaderBadgesLabel"),
        state.badges
      );
    } else if (state.wasEncrypted) {
      createInfoBanner(
        browser.i18n.getMessage("displayScriptWasEncryptedBar")
      );
    }
  } catch (e) {
    console.error("[PostGuard] showBanner error:", e);
  }
}

function createBanner(text: string, buttonLabel: string, messageId: number) {
  const banner = document.createElement("div");
  banner.className = "postguard-banner";

  const icon = createIcon();
  const textEl = document.createElement("span");
  textEl.className = "postguard-banner__text";
  textEl.textContent = text;

  const btn = document.createElement("button");
  btn.className = "postguard-banner__btn";
  btn.textContent = buttonLabel;
  btn.addEventListener("click", () => {
    btn.disabled = true;
    btn.textContent = "Decrypting...";
    browser.runtime.sendMessage({
      type: "decryptMessage",
      messageId,
    });
  });

  banner.appendChild(icon);
  banner.appendChild(textEl);
  banner.appendChild(btn);
  document.body.insertBefore(banner, document.body.firstChild);
}

function createInfoBanner(text: string) {
  const banner = document.createElement("div");
  banner.className = "postguard-banner postguard-banner--was-encrypted";

  const icon = createIcon();
  const textEl = document.createElement("span");
  textEl.className = "postguard-banner__text";
  textEl.textContent = text;

  banner.appendChild(icon);
  banner.appendChild(textEl);
  document.body.insertBefore(banner, document.body.firstChild);
}

function createBadgeBanner(
  text: string,
  badges: Array<{ type: string; value: string }>
) {
  const banner = document.createElement("div");
  banner.className = "postguard-banner";

  const icon = createIcon();
  const textEl = document.createElement("span");
  textEl.className = "postguard-banner__text";
  textEl.textContent = text;

  const badgesEl = document.createElement("span");
  badgesEl.className = "postguard-banner__badges";
  for (const badge of badges) {
    const badgeEl = document.createElement("span");
    badgeEl.className = "postguard-banner__badge";
    badgeEl.textContent = badge.value;
    badgesEl.appendChild(badgeEl);
  }

  banner.appendChild(icon);
  banner.appendChild(textEl);
  banner.appendChild(badgesEl);
  document.body.insertBefore(banner, document.body.firstChild);
}

function createIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.classList.add("postguard-banner__icon");

  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("width", "64");
  rect.setAttribute("height", "64");
  rect.setAttribute("rx", "12");
  rect.setAttribute("fill", "#006EF4");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    "M32 14c-5.5 0-10 4.5-10 10v6h-2c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h24c1.1 0 2-.9 2-2V32c0-1.1-.9-2-2-2h-2v-6c0-5.5-4.5-10-10-10zm6 16H26v-6c0-3.3 2.7-6 6-6s6 2.7 6 6v6z"
  );
  path.setAttribute("fill", "#fff");

  svg.appendChild(rect);
  svg.appendChild(path);
  return svg;
}

showBanner().catch((e) => console.error("[PostGuard] Message display script error:", e));
