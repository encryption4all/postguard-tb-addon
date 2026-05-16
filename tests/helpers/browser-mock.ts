// Minimal in-memory mock of the subset of the Thunderbird `browser.*`
// WebExtension API that the addon uses. Installed onto `globalThis.browser`
// so the production source code can run unmodified under vitest.
//
// Tests should call `installBrowserMock()` in `beforeEach` to get a fresh
// state. Each mock module exposes hooks (e.g. `setMessages`) for arranging
// test data, and the returned `mock` object exposes the call-tracking state
// (`calls`, `listeners`) for assertions.

import { vi } from "vitest";

export interface MockAttachment {
  name: string;
  partName?: string;
}

export interface MockMessage {
  id: number;
  headers?: Record<string, string[] | string>;
  attachments?: MockAttachment[];
  /** Parsed MIME-ish structure returned by getFull(). */
  full?: {
    headers: Record<string, string[] | string>;
    parts?: Array<{ contentType: string; body?: string; parts?: any[] }>;
  };
}

export interface BrowserMock {
  storage: { local: Record<string, unknown> };
  tabs: Array<{ id: number; windowId: number; type?: string }>;
  windows: Array<{ id: number; type?: string }>;
  composeDetails: Map<number, any>;
  setComposeDetailsCalls: Array<{ tabId: number; details: any }>;
  iconCalls: Array<{ tabId: number; path: string }>;
  titleCalls: Array<{ tabId: number; title: string }>;
  notifications: Array<{ title: string; message: string }>;
  windowListeners: {
    onRemoved: Set<(id: number) => void>;
    onCreated: Set<(w: { id: number; type: string }) => void>;
  };
  tabListeners: {
    onRemoved: Set<(tabId: number, info: { windowId: number }) => void>;
  };
  messageListeners: {
    onDeleted: Set<(deleted: { messages: Array<{ id: number }> }) => void>;
  };
  runtimeMessageListeners: Set<(message: unknown, sender: any) => unknown>;
  messages: Map<number, MockMessage>;
  /** Emit a fake window-closed event to all `windows.onRemoved` listeners. */
  emitWindowRemoved: (windowId: number) => void;
  emitTabRemoved: (tabId: number, windowId: number) => void;
  emitMessagesDeleted: (ids: number[]) => void;
}

declare global {
  // eslint-disable-next-line no-var
  var browser: any;
}

export function installBrowserMock(): BrowserMock {
  const m: BrowserMock = {
    storage: { local: {} },
    tabs: [],
    windows: [],
    composeDetails: new Map(),
    setComposeDetailsCalls: [],
    iconCalls: [],
    titleCalls: [],
    notifications: [],
    windowListeners: {
      onRemoved: new Set(),
      onCreated: new Set(),
    },
    tabListeners: { onRemoved: new Set() },
    messageListeners: { onDeleted: new Set() },
    runtimeMessageListeners: new Set(),
    messages: new Map(),
    emitWindowRemoved(id) {
      for (const l of [...m.windowListeners.onRemoved]) l(id);
    },
    emitTabRemoved(tabId, windowId) {
      for (const l of [...m.tabListeners.onRemoved]) l(tabId, { windowId });
    },
    emitMessagesDeleted(ids) {
      const deleted = { messages: ids.map((id) => ({ id })) };
      for (const l of [...m.messageListeners.onDeleted]) l(deleted);
    },
  };

  const storage = {
    local: {
      async get(key?: string | string[]) {
        if (key == null) return { ...m.storage.local };
        if (typeof key === "string") {
          return key in m.storage.local ? { [key]: m.storage.local[key] } : {};
        }
        const out: Record<string, unknown> = {};
        for (const k of key) if (k in m.storage.local) out[k] = m.storage.local[k];
        return out;
      },
      async set(items: Record<string, unknown>) {
        Object.assign(m.storage.local, items);
      },
      async remove(key: string | string[]) {
        const keys = Array.isArray(key) ? key : [key];
        for (const k of keys) delete m.storage.local[k];
      },
      async clear() {
        m.storage.local = {};
      },
    },
  };

  const tabs = {
    async query(q: Record<string, any>) {
      return m.tabs.filter((t) => {
        if (q.type != null && t.type !== q.type) return false;
        if (q.windowId != null && t.windowId !== q.windowId) return false;
        return true;
      });
    },
  };

  const windows = {
    async create(_: any) {
      const id = (m.windows.at(-1)?.id ?? 0) + 100;
      const w = { id, type: "popup" };
      m.windows.push(w);
      return w;
    },
    async update(_id: number, _info: any) {},
    async get(id: number) {
      return m.windows.find((w) => w.id === id) ?? { id };
    },
    async getCurrent() {
      return { id: m.windows.at(-1)?.id ?? 1 };
    },
    async remove(id: number) {
      m.windows = m.windows.filter((w) => w.id !== id);
      m.emitWindowRemoved(id);
    },
    onRemoved: {
      addListener: (cb: (id: number) => void) => m.windowListeners.onRemoved.add(cb),
      removeListener: (cb: (id: number) => void) => m.windowListeners.onRemoved.delete(cb),
    },
    onCreated: {
      addListener: (cb: (w: { id: number; type: string }) => void) =>
        m.windowListeners.onCreated.add(cb),
      removeListener: (cb: any) => m.windowListeners.onCreated.delete(cb),
    },
  };

  const compose = {
    async getComposeDetails(tabId: number) {
      return (
        m.composeDetails.get(tabId) ?? {
          type: "new",
          to: [],
          cc: [],
          bcc: [],
          deliveryFormat: "auto",
        }
      );
    },
    async setComposeDetails(tabId: number, details: any) {
      m.setComposeDetailsCalls.push({ tabId, details });
      const cur = m.composeDetails.get(tabId) ?? {};
      m.composeDetails.set(tabId, { ...cur, ...details });
    },
    async listAttachments(_tabId: number) {
      return [];
    },
    async addAttachment(_t: number, _d: any) {},
    async getAttachmentFile(_id: number) {
      return new File([], "x");
    },
    async removeAttachment(_t: number, _id: number) {},
    onBeforeSend: { addListener: vi.fn() },
    onAfterSend: { addListener: vi.fn() },
  };

  const composeAction = {
    setIcon: vi.fn(async (info: { tabId: number; path: string }) => {
      m.iconCalls.push({ tabId: info.tabId, path: info.path });
    }),
    setTitle: vi.fn(async (info: { tabId: number; title: string }) => {
      m.titleCalls.push({ tabId: info.tabId, title: info.title });
    }),
  };

  const messages = {
    async getFull(msgId: number) {
      const msg = m.messages.get(msgId);
      if (!msg) throw new Error(`no message ${msgId}`);
      return msg.full ?? { headers: msg.headers ?? {} };
    },
    async listAttachments(msgId: number) {
      return m.messages.get(msgId)?.attachments ?? [];
    },
    async get(msgId: number) {
      return m.messages.get(msgId);
    },
    async delete(_ids: number[], _skip: boolean) {},
    async move(_ids: number[], _folder: any) {},
    async import(_file: File, _folder: any) {
      return { id: 9999 };
    },
    onDeleted: {
      addListener: (cb: any) => m.messageListeners.onDeleted.add(cb),
      removeListener: (cb: any) => m.messageListeners.onDeleted.delete(cb),
    },
  };

  const notifications = {
    create: vi.fn(async (opts: { title: string; message: string }) => {
      m.notifications.push({ title: opts.title, message: opts.message });
      return "id";
    }),
  };

  const i18n = {
    getMessage: (key: string) => `i18n:${key}`,
  };

  const runtime = {
    async getBrowserInfo() {
      return { name: "Thunderbird", vendor: "Mozilla", version: "128.0", buildID: "x" };
    },
    getManifest() {
      return { version: "test-version" };
    },
    async sendMessage(_m: unknown) {},
    onMessage: {
      addListener: (cb: any) => m.runtimeMessageListeners.add(cb),
      removeListener: (cb: any) => m.runtimeMessageListeners.delete(cb),
    },
    onSuspend: { addListener: vi.fn() },
  };

  const alarms = {
    create: vi.fn(),
    clear: vi.fn(),
    onAlarm: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  };

  const scripting = {
    messageDisplay: { registerScripts: vi.fn(async () => undefined) },
  };

  const tabsListeners = {
    onRemoved: {
      addListener: (cb: any) => m.tabListeners.onRemoved.add(cb),
      removeListener: (cb: any) => m.tabListeners.onRemoved.delete(cb),
    },
  };

  (globalThis as any).browser = {
    storage,
    tabs: { ...tabs, ...tabsListeners },
    windows,
    compose,
    composeAction,
    messages,
    notifications,
    i18n,
    runtime,
    alarms,
    scripting,
    messageDisplayAction: { setIcon: vi.fn(), setTitle: vi.fn() },
  };

  return m;
}

export function uninstallBrowserMock() {
  delete (globalThis as any).browser;
}
