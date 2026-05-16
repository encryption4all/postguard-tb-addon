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
    const saved = store.inFlightUploads as Record<string, { uuid: string; recoveryToken: string; startedAt: number }>;
    expect(Object.keys(saved)).toEqual(expect.arrayContaining(["1", "2"]));
    expect(saved["1"].uuid).toBe("uuid-1");
    expect(saved["2"].recoveryToken).toBe("tok-2");
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

  it("loadInFlightUploads returns persisted records that are within the freshness window", async () => {
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
