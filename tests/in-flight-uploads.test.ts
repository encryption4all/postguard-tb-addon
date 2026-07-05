import { describe, it, expect, beforeEach, vi } from "vitest";

// Lightweight `browser.storage.local` mock — vitest doesn't ship a
// WebExtensions polyfill and the state module touches the global
// `browser` object directly. We stub just the surface the in-flight
// helpers exercise: `storage.local.get/set/remove`.
type LocalStore = Record<string, unknown>;

function installBrowserMock(): LocalStore {
  const store: LocalStore = {};
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: vi.fn(async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          const out: LocalStore = {};
          for (const k of keys) {
            if (k in store) out[k] = store[k];
          }
          return out;
        }),
        set: vi.fn(async (entries: LocalStore) => {
          Object.assign(store, entries);
        }),
        remove: vi.fn(async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          for (const k of keys) delete store[k];
        }),
      },
    },
  });
  return store;
}

async function loadModule() {
  // Dynamic import so the browser stub is in place before the module
  // captures any references at import time.
  return await import("../src/background/state");
}

describe("in-flight upload persistence", () => {
  let store: LocalStore;

  beforeEach(async () => {
    vi.resetModules();
    store = installBrowserMock();
    const mod = await loadModule();
    mod.inFlightUploads.clear();
  });

  it("recordInFlightUpload stores by tab id with a current timestamp", async () => {
    const mod = await loadModule();
    const before = Date.now();
    mod.recordInFlightUpload(42, "uuid-1", "tok-1");
    const after = Date.now();
    const rec = mod.inFlightUploads.get(42);
    expect(rec).toBeDefined();
    expect(rec!.uuid).toBe("uuid-1");
    expect(rec!.recoveryToken).toBe("tok-1");
    expect(rec!.startedAt).toBeGreaterThanOrEqual(before);
    expect(rec!.startedAt).toBeLessThanOrEqual(after);
  });

  it("persistInFlightUploads writes every record under inFlightUploads key", async () => {
    const mod = await loadModule();
    mod.recordInFlightUpload(1, "uuid-1", "tok-1");
    mod.recordInFlightUpload(2, "uuid-2", "tok-2");
    await mod.persistInFlightUploads();
    const saved = store.inFlightUploads as Record<
      string,
      { uuid: string; token: { iv: string; data: string }; startedAt: number }
    >;
    expect(Object.keys(saved)).toEqual(expect.arrayContaining(["1", "2"]));
    expect(saved["1"].uuid).toBe("uuid-1");
    expect(typeof saved["1"].startedAt).toBe("number");
  });

  it("persistInFlightUploads never writes the recovery token in cleartext", async () => {
    const mod = await loadModule();
    mod.recordInFlightUpload(1, "uuid-1", "super-secret-token");
    await mod.persistInFlightUploads();
    // The whole persisted payload must not contain the plaintext token,
    // and there must be no `recoveryToken` field on disk at all.
    const serialized = JSON.stringify(store.inFlightUploads);
    expect(serialized).not.toContain("super-secret-token");
    const saved = store.inFlightUploads as Record<string, Record<string, unknown>>;
    expect(saved["1"].recoveryToken).toBeUndefined();
    expect(saved["1"].token).toMatchObject({ iv: expect.any(String), data: expect.any(String) });
  });

  it("persist → load round-trips the encrypted token back to plaintext", async () => {
    const mod = await loadModule();
    mod.recordInFlightUpload(7, "uuid-7", "tok-7");
    await mod.persistInFlightUploads();
    const records = await mod.loadInFlightUploads();
    expect(records).toEqual([
      { tabId: 7, record: expect.objectContaining({ uuid: "uuid-7", recoveryToken: "tok-7" }) },
    ]);
  });

  it("persistInFlightUploads removes the storage key when the map is empty", async () => {
    const mod = await loadModule();
    mod.recordInFlightUpload(1, "uuid-1", "tok-1");
    await mod.persistInFlightUploads();
    expect(store.inFlightUploads).toBeDefined();
    mod.clearInFlightUpload(1);
    await mod.persistInFlightUploads();
    expect(store.inFlightUploads).toBeUndefined();
  });

  it("loadInFlightUploads reads legacy plaintext records written by pre-fix builds", async () => {
    // Records persisted before the credential was encrypted at rest have a
    // cleartext `recoveryToken` and no encrypted `token`. They must still load once so
    // an active session survives the upgrade (then get re-persisted encrypted).
    const mod = await loadModule();
    const now = Date.now();
    store.inFlightUploads = {
      "5": { uuid: "uuid-fresh", recoveryToken: "tok-fresh", startedAt: now - 60_000 },
    };
    const records = await mod.loadInFlightUploads();
    expect(records).toEqual([
      { tabId: 5, record: { uuid: "uuid-fresh", recoveryToken: "tok-fresh", startedAt: now - 60_000 } },
    ]);
  });

  it("loadInFlightUploads drops records older than MAX_IN_FLIGHT_AGE_MS without a network call", async () => {
    const mod = await loadModule();
    const stale = Date.now() - mod.MAX_IN_FLIGHT_AGE_MS - 1000;
    store.inFlightUploads = {
      "9": { uuid: "uuid-stale", recoveryToken: "tok-stale", startedAt: stale },
    };
    const records = await mod.loadInFlightUploads();
    expect(records).toEqual([]);
  });

  it("loadInFlightUploads drops a record whose encrypted token cannot be decrypted", async () => {
    // e.g. the keystore was cleared, or the blob was tampered with. Dropping
    // the (short-lived) record must not crash the startup probe.
    const mod = await loadModule();
    store.inFlightUploads = {
      "3": {
        uuid: "uuid-bad",
        token: { iv: "AAAAAAAAAAAAAAAA", data: "AAAAAAAAAAAAAAAAAAAAAA==" },
        startedAt: Date.now() - 1000,
      },
    };
    const records = await mod.loadInFlightUploads();
    expect(records).toEqual([]);
  });

  it("loadInFlightUploads returns [] when nothing is persisted", async () => {
    const mod = await loadModule();
    const records = await mod.loadInFlightUploads();
    expect(records).toEqual([]);
  });

  it("clearInFlightUpload removes a single tab without disturbing the rest", async () => {
    const mod = await loadModule();
    mod.recordInFlightUpload(1, "u1", "t1");
    mod.recordInFlightUpload(2, "u2", "t2");
    mod.clearInFlightUpload(1);
    expect(mod.inFlightUploads.has(1)).toBe(false);
    expect(mod.inFlightUploads.get(2)?.uuid).toBe("u2");
  });
});
