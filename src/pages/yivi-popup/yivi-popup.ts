/// <reference path="../../types/thunderbird.d.ts" />
export {};

import { runYiviSession } from "@e4a/pg-js";

interface YiviPopupData {
  hostname: string;
  header: Record<string, string>;
  con: Array<{ t: string; v?: string }>;
  sort: string;
  hints?: Array<{ t: string; v: string }>;
  senderId?: string;
}

const titleEl = document.getElementById("title") as HTMLElement;
const subtitleEl = document.getElementById("subtitle") as HTMLElement;
const senderEl = document.getElementById("sender-info") as HTMLElement;
const hintsEl = document.getElementById("hints") as HTMLElement;
const errorEl = document.getElementById("error") as HTMLElement;
const loadingEl = document.getElementById("loading") as HTMLElement;

async function init() {
  const data = (await browser.runtime.sendMessage({
    type: "yiviPopupInit",
  })) as YiviPopupData | null;

  if (!data) {
    showError("Failed to initialize session.");
    return;
  }

  // Update UI
  if (data.sort === "Decryption") {
    titleEl.textContent = browser.i18n.getMessage("displayMessageTitle");
    subtitleEl.textContent = browser.i18n.getMessage("displayMessageHeading");
  } else {
    titleEl.textContent = "PostGuard — Sign";
    subtitleEl.textContent = browser.i18n.getMessage("displayMessageQrPrefix");
  }

  if (data.senderId) {
    senderEl.innerHTML = `From: <strong>${escapeHtml(data.senderId)}</strong>`;
    senderEl.style.display = "block";
  }

  if (data.hints) {
    for (const hint of data.hints) {
      const badge = document.createElement("span");
      badge.className = "hint-badge";
      const label =
        browser.i18n.getMessage(hint.t) || hint.t.split(".").pop() || hint.t;
      badge.textContent = hint.v ? `${label}: ${hint.v}` : label;
      hintsEl.appendChild(badge);
    }
  }

  try {
    loadingEl.style.display = "none";

    // Use the SDK to run the full Yivi session (QR code + polling + JWT)
    const jwt = await runYiviSession({
      pkgUrl: data.hostname,
      element: "#yivi-web-form",
      con: data.con,
      sort: data.sort as "Signing" | "Decryption",
      headers: data.header,
    });

    console.log("[PostGuard] JWT received, sending to background");
    await browser.runtime.sendMessage({ type: "yiviPopupDone", jwt });

    // Auto-close after a short delay
    setTimeout(async () => {
      const win = await browser.windows.getCurrent();
      browser.windows.remove(win.id);
    }, 750);
  } catch (e) {
    console.error("[PostGuard] Yivi session error:", e);
    showError(e instanceof Error ? e.message : "Yivi session failed.");
  }
}

function showError(msg: string) {
  loadingEl.style.display = "none";
  errorEl.textContent = msg;
  errorEl.style.display = "block";
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

init();
