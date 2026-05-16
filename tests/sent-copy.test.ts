import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleAfterSend, type SentInfo } from "../src/background/sent-copy";
import {
  composeTabs,
  decryptedMessages,
  inFlightUploads,
  pendingCryptoPopups,
  pendingPolicyEditors,
} from "../src/background/state";
import { installBrowserMock, type BrowserMock } from "./helpers/browser-mock";

let mock: BrowserMock;
let notifyError: ReturnType<typeof vi.fn>;
let isPGEncrypted: ReturnType<typeof vi.fn>;
let getOrCreateLocalFolder: ReturnType<typeof vi.fn>;
let importSpy: ReturnType<typeof vi.spyOn>;
let moveSpy: ReturnType<typeof vi.spyOn>;
let deleteSpy: ReturnType<typeof vi.spyOn>;

const SENT_FOLDER = { id: "sent://Sent" };
const LOCAL_FOLDER = { id: "local://PostGuard Sent" };

function deps() {
  return { notifyError, isPGEncrypted, getOrCreateLocalFolder };
}

function sentInfo(messageIds: number[] = [1]): SentInfo {
  return {
    messages: messageIds.map((id) => ({ id, folder: SENT_FOLDER })),
  };
}

beforeEach(() => {
  mock = installBrowserMock();
  composeTabs.clear();
  decryptedMessages.clear();
  pendingCryptoPopups.clear();
  pendingPolicyEditors.clear();
  inFlightUploads.clear();

  notifyError = vi.fn();
  isPGEncrypted = vi.fn(async () => true);
  getOrCreateLocalFolder = vi.fn(async () => LOCAL_FOLDER);

  importSpy = vi.spyOn(browser.messages, "import");
  moveSpy = vi.spyOn(browser.messages, "move");
  deleteSpy = vi.spyOn(browser.messages, "delete");
});

describe("onAfterSend — sent copy management", () => {
  it("should skip when no sentMimeData is stored", async () => {
    composeTabs.set(7, { encrypt: true });
    await handleAfterSend({ id: 7 }, sentInfo([1]), deps());

    expect(isPGEncrypted).not.toHaveBeenCalled();
    expect(importSpy).not.toHaveBeenCalled();
  });

  it("should skip non-PG-encrypted sent messages", async () => {
    composeTabs.set(7, { encrypt: true, sentMimeData: new Uint8Array([1, 2, 3]) });
    isPGEncrypted.mockResolvedValueOnce(false);

    await handleAfterSend({ id: 7 }, sentInfo([42]), deps());

    expect(isPGEncrypted).toHaveBeenCalledWith(42);
    expect(getOrCreateLocalFolder).not.toHaveBeenCalled();
    expect(importSpy).not.toHaveBeenCalled();
  });

  it("should import plaintext MIME into PostGuard Sent folder", async () => {
    composeTabs.set(7, { encrypt: true, sentMimeData: new Uint8Array([1, 2, 3]) });

    await handleAfterSend({ id: 7 }, sentInfo([42]), deps());

    expect(getOrCreateLocalFolder).toHaveBeenCalledWith("PostGuard Sent");
    expect(importSpy).toHaveBeenCalledTimes(1);
    const [file, folder] = importSpy.mock.calls[0] as [File, unknown];
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("sent.eml");
    expect(folder).toBe(LOCAL_FOLDER.id);
  });

  it("should move imported message to original sent folder", async () => {
    composeTabs.set(7, { encrypt: true, sentMimeData: new Uint8Array([1, 2, 3]) });

    await handleAfterSend({ id: 7 }, sentInfo([42]), deps());

    expect(moveSpy).toHaveBeenCalledWith([9999], SENT_FOLDER.id);
  });

  it("should delete the encrypted copy from sent folder", async () => {
    composeTabs.set(7, { encrypt: true, sentMimeData: new Uint8Array([1, 2, 3]) });

    await handleAfterSend({ id: 7 }, sentInfo([42]), deps());

    expect(deleteSpy).toHaveBeenCalledWith([42], true);
  });

  it("should notify user when sent copy management fails", async () => {
    composeTabs.set(7, { encrypt: true, sentMimeData: new Uint8Array([1, 2, 3]) });
    importSpy.mockRejectedValueOnce(new Error("import boom"));

    await handleAfterSend({ id: 7 }, sentInfo([42]), deps());

    expect(notifyError).toHaveBeenCalledWith("sentCopyError");
  });

  it("should clean up compose tab state after send", async () => {
    composeTabs.set(7, { encrypt: true, sentMimeData: new Uint8Array([1, 2, 3]) });
    inFlightUploads.set(7, { uuid: "u", recoveryToken: "r", startedAt: Date.now() });

    await handleAfterSend({ id: 7 }, sentInfo([42]), deps());

    expect(composeTabs.has(7)).toBe(false);
    expect(inFlightUploads.has(7)).toBe(false);
  });

  it("should clean up compose tab state even on failure", async () => {
    composeTabs.set(7, { encrypt: true, sentMimeData: new Uint8Array([1, 2, 3]) });
    inFlightUploads.set(7, { uuid: "u", recoveryToken: "r", startedAt: Date.now() });
    importSpy.mockRejectedValueOnce(new Error("nope"));

    await handleAfterSend({ id: 7 }, sentInfo([42]), deps());

    expect(composeTabs.has(7)).toBe(false);
    expect(inFlightUploads.has(7)).toBe(false);
  });

  it("should skip the swap when no local folder is available", async () => {
    composeTabs.set(7, { encrypt: true, sentMimeData: new Uint8Array([1, 2, 3]) });
    getOrCreateLocalFolder.mockResolvedValueOnce(undefined);

    await handleAfterSend({ id: 7 }, sentInfo([42]), deps());

    expect(importSpy).not.toHaveBeenCalled();
    expect(moveSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    // Cleanup still runs.
    expect(composeTabs.has(7)).toBe(false);
  });
});
