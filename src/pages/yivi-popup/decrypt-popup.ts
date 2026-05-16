import type {
  DecryptDataResult,
  DecryptFileResult,
  DecryptResult,
  PostGuard,
} from "@e4a/pg-js";
import type { DecryptPopupData } from "../../lib/types";
import { toBase64, fromBase64 } from "../../lib/encoding";
import { extractFromZip } from "./zip";
import { YIVI_ELEMENT_SELECTOR } from "./encrypt-popup";

export interface DecryptPopupDeps {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
  /** Defaults to the production `extractFromZip` from `./zip`. Tests can
   *  inject a stub to avoid building a real zip blob. */
  extractFromZip?: typeof extractFromZip;
}

/**
 * Body of the popup's decrypt flow, lifted out of `handleDecrypt`. Takes
 * either tier-1/2 ciphertext bytes (from the postguard.encrypted
 * attachment) or a tier-3 Cryptify uuid (no attachment exists; the
 * encrypted payload is on Cryptify). The SDK is injected as `pg` so the
 * uuid- vs data-mode branches are testable with mocks.
 */
export async function runDecryptInPopup(
  pg: PostGuard,
  data: DecryptPopupData,
  windowId: number,
  deps: DecryptPopupDeps,
): Promise<void> {
  const unzip = deps.extractFromZip ?? extractFromZip;
  let plaintext: Uint8Array;
  let sender: DecryptDataResult["sender"];

  if (data.uuid) {
    const opened = pg.open({ uuid: data.uuid });
    const result = await opened.decrypt({
      element: YIVI_ELEMENT_SELECTOR,
      recipient: data.recipientEmail,
    });
    if (!isDecryptFileResult(result)) {
      throw new Error("Expected file decrypt result for uploaded ciphertext");
    }
    // pg-js's upload pipeline wraps `data:`-mode payloads as a
    // single-file zip (`data.bin` = the raw MIME) before sealing, so the
    // uuid-mode decrypt yields a zip blob. Unwrap here. Tracked at
    // encryption4all/postguard-js#39.
    plaintext = await unzip(result.blob, "data.bin");
    sender = result.sender;
  } else if (data.ciphertextBase64) {
    const ciphertext = fromBase64(data.ciphertextBase64);
    const opened = pg.open({ data: ciphertext });
    const result = await opened.decrypt({
      element: YIVI_ELEMENT_SELECTOR,
      recipient: data.recipientEmail,
    });
    if (!isDecryptDataResult(result)) {
      throw new Error("Expected data decrypt result for attached ciphertext");
    }
    plaintext = result.plaintext;
    sender = result.sender;
  } else {
    throw new Error("Decrypt popup requires either ciphertextBase64 or uuid");
  }

  await deps.runtime.sendMessage({
    type: "cryptoPopupDone",
    windowId,
    result: {
      operation: "decrypt",
      plaintextBase64: toBase64(plaintext),
      sender,
    },
  });
}

function isDecryptFileResult(result: DecryptResult): result is DecryptFileResult {
  return "blob" in result;
}

function isDecryptDataResult(result: DecryptResult): result is DecryptDataResult {
  return "plaintext" in result;
}
