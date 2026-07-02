import type { Policy, CryptoPopupResult } from "../lib/types";

// Extracted from `background.ts` so the dispatch logic can be unit-tested
// without spinning up the whole background script. The set of handlers is
// passed in (rather than imported) so tests can inject spies / stubs.

export interface RuntimeHandlers {
  handleQueryMessageState: (tabId: number | undefined) => unknown;
  handleToggleEncryption: (tabId: number | undefined) => unknown;
  handleGetComposeState: (tabId: number | undefined) => unknown;
  handleOpenPolicyEditor: (windowId: number | undefined, sign: boolean) => unknown;
  handlePolicyEditorInit: (windowId: number | undefined) => unknown;
  handlePolicyEditorDone: (windowId: number | undefined, policy: Policy) => unknown;
  handleCryptoPopupInit: (windowId: number | undefined) => unknown;
  handleCryptoPopupDone: (
    windowId: number | undefined,
    result: CryptoPopupResult,
  ) => unknown;
  handleCryptoPopupError: (windowId: number | undefined, error: string) => unknown;
  handleCryptoPopupUploadInit: (
    windowId: number | undefined,
    uuid: string,
    recoveryToken: string,
  ) => unknown;
  handleDecryptMessage: (messageId: number) => unknown;
  resolveComposeTabId: (windowId: number | undefined) => Promise<number | undefined>;
}

export interface RuntimeSender {
  tab?: { id?: number; windowId?: number };
}

/**
 * Pure dispatch function — returns whatever the matched handler returns, or
 * `false` for non-object messages, unknown types, and messages that fail
 * minimal payload validation. Validation is intentionally light: only the
 * shape the routes themselves rely on. The handlers do their own deeper
 * checks.
 */
export function dispatchRuntimeMessage(
  message: unknown,
  sender: RuntimeSender,
  handlers: RuntimeHandlers,
): unknown {
  if (!message || typeof message !== "object") return false;
  const msg = message as Record<string, unknown>;

  switch (msg.type) {
    case "queryMessageState":
      return handlers.handleQueryMessageState(sender.tab?.id);

    case "toggleEncryption":
      return handlers
        .resolveComposeTabId(sender.tab?.windowId)
        .then((id) => handlers.handleToggleEncryption(id));

    case "getComposeState":
      return handlers
        .resolveComposeTabId(sender.tab?.windowId)
        .then((id) => handlers.handleGetComposeState(id));

    case "openPolicyEditor":
      return handlers.handleOpenPolicyEditor(sender.tab?.windowId, false);

    case "openSignEditor":
      return handlers.handleOpenPolicyEditor(sender.tab?.windowId, true);

    case "policyEditorInit":
      return Promise.resolve(handlers.handlePolicyEditorInit(sender.tab?.windowId));

    case "policyEditorDone": {
      const policy = msg.policy;
      if (!policy || typeof policy !== "object") return false;
      return handlers.handlePolicyEditorDone(
        sender.tab?.windowId,
        policy as Policy,
      );
    }

    case "cryptoPopupInit":
      return Promise.resolve(
        handlers.handleCryptoPopupInit(sender.tab?.windowId),
      );

    case "cryptoPopupDone": {
      const result = msg.result;
      if (!result || typeof result !== "object") return false;
      const op = (result as Record<string, unknown>).operation;
      if (op !== "encrypt" && op !== "decrypt") return false;
      return Promise.resolve(
        handlers.handleCryptoPopupDone(
          sender.tab?.windowId,
          result as CryptoPopupResult,
        ),
      );
    }

    case "cryptoPopupError":
      return Promise.resolve(
        handlers.handleCryptoPopupError(
          sender.tab?.windowId,
          msg.error as string,
        ),
      );

    case "cryptoPopupUploadInit":
      return Promise.resolve(
        handlers.handleCryptoPopupUploadInit(
          sender.tab?.windowId,
          msg.uuid as string,
          msg.recoveryToken as string,
        ),
      );

    case "decryptMessage": {
      const messageId = msg.messageId;
      if (typeof messageId !== "number" || !Number.isFinite(messageId)) {
        return false;
      }
      return handlers.handleDecryptMessage(messageId);
    }

    default:
      return false;
  }
}
