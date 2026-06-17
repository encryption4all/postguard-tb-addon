/// <reference path="../../types/thunderbird.d.ts" />
import {
  applyComposeActionUi,
  isDisabled,
  type ComposeActionElements,
  type ComposeUiState,
} from "./manage-access";
export {};

const toggle = document.getElementById("toggle-encrypt") as HTMLInputElement;
const els: ComposeActionElements = {
  statusText: document.getElementById("status-text") as HTMLElement,
  btnManage: document.getElementById("btn-manage") as HTMLButtonElement,
  btnSign: document.getElementById("btn-sign") as HTMLButtonElement,
  manageHint: document.getElementById("manage-hint") as HTMLElement,
};

const t = (key: string) => browser.i18n.getMessage(key);

async function init() {
  const state = (await browser.runtime.sendMessage({
    type: "getComposeState",
  })) as ComposeUiState | undefined;

  if (state) {
    toggle.checked = state.encrypt;
    applyComposeActionUi(els, state, t);
  }
}

toggle.addEventListener("change", async () => {
  const result = (await browser.runtime.sendMessage({
    type: "toggleEncryption",
  })) as ComposeUiState | undefined;
  if (result) {
    applyComposeActionUi(els, result, t);
  }
});

els.btnManage.addEventListener("click", async () => {
  if (isDisabled(els.btnManage)) return;
  await browser.runtime.sendMessage({ type: "openPolicyEditor" });
  window.close();
});

els.btnSign.addEventListener("click", async () => {
  if (isDisabled(els.btnSign)) return;
  await browser.runtime.sendMessage({ type: "openSignEditor" });
  window.close();
});

init();
