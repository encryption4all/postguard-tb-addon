/// <reference path="../../types/thunderbird.d.ts" />
export {};

import { PostGuard } from "@e4a/pg-js";
import type { CryptoPopupInitData } from "../../lib/types";
import { runEncryptInPopup } from "./encrypt-popup";
import { runDecryptInPopup } from "./decrypt-popup";
import { initCryptoPopup } from "./init-flow";

const titleEl = document.getElementById("title") as HTMLElement;
const subtitleEl = document.getElementById("subtitle") as HTMLElement;
const errorEl = document.getElementById("error") as HTMLElement;
const loadingEl = document.getElementById("loading") as HTMLElement;

initCryptoPopup({
  async resolveWindowId() {
    const win = await browser.windows.getCurrent();
    return win.id;
  },
  async requestInitData(windowId) {
    return (await browser.runtime.sendMessage({
      type: "cryptoPopupInit",
      windowId,
    })) as CryptoPopupInitData | null;
  },
  createPg: (config) => new PostGuard(config),
  runEncrypt: (pg, data, windowId) =>
    runEncryptInPopup(pg, data, windowId, { runtime: browser.runtime }),
  runDecrypt: (pg, data, windowId) =>
    runDecryptInPopup(pg, data, windowId, { runtime: browser.runtime }),
  sendError: (windowId, error) =>
    browser.runtime.sendMessage({
      type: "cryptoPopupError",
      windowId,
      error,
    }),
  closeWindow: (windowId) => browser.windows.remove(windowId),
  ui: {
    setOperation(op) {
      if (op === "decrypt") {
        titleEl.textContent = browser.i18n.getMessage("displayMessageTitle");
        subtitleEl.textContent = browser.i18n.getMessage("displayMessageHeading");
      } else {
        titleEl.textContent = browser.i18n.getMessage("displayMessageTitleSign");
        subtitleEl.textContent = browser.i18n.getMessage("displayMessageQrPrefix");
      }
    },
    setLoadingDone() {
      loadingEl.hidden = true;
    },
    showError(msg) {
      loadingEl.hidden = true;
      errorEl.textContent = msg;
      errorEl.hidden = false;
    },
  },
  i18n: {
    getMessage: (key) => browser.i18n.getMessage(key),
  },
});
