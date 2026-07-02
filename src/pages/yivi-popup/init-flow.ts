import type { PostGuard } from "@e4a/pg-js";
import { UploadSessionExpiredError } from "@e4a/pg-js";
import type {
  CryptoPopupInitData,
  EncryptPopupData,
  DecryptPopupData,
} from "../../lib/types";

export interface CryptoPopupUi {
  setOperation(op: "encrypt" | "decrypt"): void;
  setLoadingDone(): void;
  showError(msg: string): void;
}

export interface CryptoPopupI18n {
  getMessage(key: string): string;
}

export interface InitCryptoPopupDeps {
  resolveWindowId: () => Promise<number>;
  /** Sends the init request to background and returns the pending entry
   *  (or null if none — the popup was opened orphaned). */
  requestInitData: (windowId: number) => Promise<CryptoPopupInitData | null>;
  createPg: (config: CryptoPopupInitData["config"]) => PostGuard;
  runEncrypt: (
    pg: PostGuard,
    data: EncryptPopupData,
    windowId: number,
  ) => Promise<void>;
  runDecrypt: (
    pg: PostGuard,
    data: DecryptPopupData,
    windowId: number,
  ) => Promise<void>;
  sendError: (windowId: number, message: string) => Promise<unknown>;
  closeWindow: (windowId: number) => Promise<void>;
  ui: CryptoPopupUi;
  i18n: CryptoPopupI18n;
  autoCloseDelayMs?: number;
  /** Defaults to `setTimeout`. Tests inject a controllable scheduler. */
  scheduleAutoClose?: (fn: () => void, delayMs: number) => void;
}

const DEFAULT_AUTO_CLOSE_MS = 750;

/**
 * Orchestrates the popup's init → encrypt-or-decrypt → close flow.
 * Behaviour matches the previous in-file `init()` exactly, but every
 * Thunderbird and SDK surface is injected through `deps` so the four
 * init paths (windowId failure, no pending entry, encrypt route, decrypt
 * route) and the error-handling tail can be pinned without spinning up
 * the live popup.
 */
export async function initCryptoPopup(deps: InitCryptoPopupDeps): Promise<void> {
  let windowId: number;
  try {
    windowId = await deps.resolveWindowId();
  } catch {
    deps.ui.showError("Failed to get window ID.");
    return;
  }

  let data: CryptoPopupInitData | null;
  try {
    data = await deps.requestInitData(windowId);
  } catch {
    deps.ui.showError("Failed to initialize session.");
    return;
  }

  if (!data) {
    deps.ui.showError("Failed to initialize session.");
    return;
  }

  deps.ui.setOperation(data.operation);
  deps.ui.setLoadingDone();

  const pg = deps.createPg(data.config);

  try {
    if (data.operation === "encrypt") {
      await deps.runEncrypt(pg, data, windowId);
    } else {
      await deps.runDecrypt(pg, data, windowId);
    }
    const schedule = deps.scheduleAutoClose ?? setTimeout;
    schedule(() => {
      deps.closeWindow(windowId).catch(() => {
        // ignore — the user may have already closed it.
      });
    }, deps.autoCloseDelayMs ?? DEFAULT_AUTO_CLOSE_MS);
  } catch (e) {
    console.error("[PostGuard] Crypto popup error:", e);
    // Raw SDK error text can contain internal server URLs or subsystem
    // names, so it is only ever logged above (via console.error) — it is
    // never surfaced in the popup UI or forwarded to the background.
    // Only explicitly safe error types map to a specific (localized)
    // message; everything else falls back to a generic notice.
    const message =
      e instanceof UploadSessionExpiredError
        ? deps.i18n.getMessage("uploadSessionExpired")
        : deps.i18n.getMessage("operationFailed");
    await deps.sendError(windowId, message).catch(() => undefined);
    deps.ui.showError(message);
  }
}
