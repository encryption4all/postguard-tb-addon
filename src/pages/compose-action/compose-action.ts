/// <reference path="../../types/thunderbird.d.ts" />
import {
  applyComposeActionUi,
  isDisabled,
  type ComposeActionElements,
  type ComposeUiState,
} from "./manage-access";
import {
  buildComposeStatusSummary,
  renderComposeStatusPanel,
  type ComposeStatusInput,
} from "./status-summary";
export {};

// The background `getComposeState` handler returns the manage-access flags
// plus everything the status panel needs (recipients, policy, signId, …).
type ComposeState = ComposeUiState & ComposeStatusInput;

const toggle = document.getElementById("toggle-encrypt") as HTMLInputElement;
const statusPanel = document.getElementById("status-panel") as HTMLElement;
const els: ComposeActionElements = {
  statusText: document.getElementById("status-text") as HTMLElement,
  btnManage: document.getElementById("btn-manage") as HTMLButtonElement,
  btnSign: document.getElementById("btn-sign") as HTMLButtonElement,
  manageHint: document.getElementById("manage-hint") as HTMLElement,
};

const t = (key: string) => browser.i18n.getMessage(key);

function applyState(state: ComposeState) {
  toggle.checked = state.encrypt;
  applyComposeActionUi(els, state, t);
  renderComposeStatusPanel(statusPanel, buildComposeStatusSummary(state, t), t);
}

// Pull the full compose state and repaint the popup. Used on open and after
// every toggle so the status panel always reflects the live recipients/policy.
async function refresh() {
  const state = (await browser.runtime.sendMessage({
    type: "getComposeState",
  })) as ComposeState | undefined;
  if (state) applyState(state);
}

toggle.addEventListener("change", async () => {
  await browser.runtime.sendMessage({ type: "toggleEncryption" });
  await refresh();
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

refresh();
