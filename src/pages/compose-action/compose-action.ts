/// <reference path="../../types/thunderbird.d.ts" />
export {};

const toggle = document.getElementById("toggle-encrypt") as HTMLInputElement;
const statusText = document.getElementById("status-text") as HTMLElement;
const btnManage = document.getElementById("btn-manage") as HTMLButtonElement;
const btnSign = document.getElementById("btn-sign") as HTMLButtonElement;

async function init() {
  const state = (await browser.runtime.sendMessage({
    type: "getComposeState",
  })) as { encrypt: boolean } | undefined;

  if (state) {
    toggle.checked = state.encrypt;
    updateUI(state.encrypt);
  }
}

function updateUI(enabled: boolean) {
  statusText.textContent = enabled
    ? browser.i18n.getMessage("encryptionEnabled")
    : browser.i18n.getMessage("encryptionDisabled");
  btnManage.disabled = !enabled;
  btnSign.disabled = !enabled;
}

toggle.addEventListener("change", async () => {
  const result = (await browser.runtime.sendMessage({
    type: "toggleEncryption",
  })) as { encrypt: boolean } | undefined;
  if (result) {
    updateUI(result.encrypt);
  }
});

btnManage.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "openPolicyEditor" });
  window.close();
});

btnSign.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "openSignEditor" });
  window.close();
});

init();
