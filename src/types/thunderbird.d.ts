// Thunderbird WebExtension API type declarations for MV3
// These supplement the built-in browser.* types

declare namespace browser {
  namespace runtime {
    function getBrowserInfo(): Promise<{ name: string; vendor: string; version: string; buildID: string }>;
    function getManifest(): { version: string; [key: string]: unknown };
    function sendMessage(message: unknown): Promise<unknown>;
    const onMessage: {
      addListener(callback: (message: unknown, sender: MessageSender) => unknown): void;
      removeListener(callback: (message: unknown, sender: MessageSender) => unknown): void;
    };
    const onSuspend: {
      addListener(callback: () => void): void;
    };
  }

  interface MessageSender {
    tab?: { id: number; windowId: number };
  }

  namespace tabs {
    function query(queryInfo: Record<string, unknown>): Promise<Tab[]>;
  }

  interface Tab {
    id: number;
    windowId: number;
    type?: string;
  }

  namespace windows {
    function create(createData: Record<string, unknown>): Promise<{ id: number }>;
    function update(windowId: number, updateInfo: Record<string, unknown>): Promise<void>;
    function get(windowId: number): Promise<Record<string, unknown>>;
    function getCurrent(): Promise<{ id: number }>;
    function remove(windowId: number): Promise<void>;
    const onRemoved: {
      addListener(callback: (windowId: number) => void): void;
      removeListener(callback: (windowId: number) => void): void;
    };
    const onCreated: {
      addListener(callback: (window: { id: number; type: string }) => void): void;
    };
  }

  namespace compose {
    function getComposeDetails(tabId: number): Promise<ComposeDetails>;
    function setComposeDetails(tabId: number, details: Partial<ComposeDetails>): Promise<void>;
    function listAttachments(tabId: number): Promise<ComposeAttachment[]>;
    function addAttachment(tabId: number, data: { file: File; name?: string }): Promise<void>;
    function getAttachmentFile(attachmentId: number): Promise<File>;
    function removeAttachment(tabId: number, attachmentId: number): Promise<void>;
    const onBeforeSend: {
      addListener(callback: (tab: Tab, details: ComposeDetails) => Promise<{ cancel?: boolean; details?: Partial<ComposeDetails> } | void>): void;
    };
    const onAfterSend: {
      addListener(callback: (tab: Tab, sendInfo: { messages: MessageHeader[]; mode: string }) => void): void;
    };
  }

  interface ComposeDetails {
    type: string;
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    body: string;
    plainTextBody: string;
    isPlainText: boolean;
    deliveryFormat: string;
    relatedMessageId?: number;
  }

  interface ComposeAttachment {
    id: number;
    name: string;
    size: number;
  }

  namespace composeAction {
    function enable(tabId?: number): Promise<void>;
    function disable(tabId?: number): Promise<void>;
    function setIcon(details: { tabId?: number; path: string | Record<string, string> }): Promise<void>;
    function setTitle(details: { tabId?: number; title: string }): Promise<void>;
    function setBadgeText(details: { tabId?: number; text: string }): Promise<void>;
    function openPopup(): Promise<void>;
    const onClicked: {
      addListener(callback: (tab: Tab) => void): void;
    };
  }

  namespace messages {
    function get(messageId: number): Promise<MessageHeader>;
    function getFull(messageId: number): Promise<{ headers: Record<string, string[]>; parts?: MessagePart[] }>;
    function listAttachments(messageId: number): Promise<MessageAttachment[]>;
    function getAttachmentFile(messageId: number, partName: string): Promise<File>;
    function update(messageId: number, newProperties: Record<string, unknown>): Promise<void>;
    function move(messageIds: number[], destination: MailFolder): Promise<void>;
    function query(queryInfo: Record<string, unknown>): Promise<{ messages: MessageHeader[] }>;
    function list(folder: MailFolder): Promise<{ messages: MessageHeader[] }>;
    function archive(messageIds: number[]): Promise<void>;
    // import/delete are reserved words — accessed via (browser.messages as any).import() at runtime
    function import_(file: File, destination: MailFolder | string): Promise<MessageHeader>;
    function delete_(messageIds: number[], skipTrash?: boolean): Promise<void>;
  }

  // messages.import() and messages.delete() — these are the actual API names
  // TypeScript uses _import and _delete due to reserved words

  interface MessageHeader {
    id: number;
    date: Date;
    author: string;
    recipients: string[];
    ccList: string[];
    subject: string;
    folder: MailFolder;
    read: boolean;
    flagged: boolean;
  }

  interface MessageAttachment {
    name: string;
    contentType: string;
    size: number;
    partName: string;
  }

  interface MessagePart {
    contentType: string;
    headers: Record<string, string[]>;
    body?: string;
    parts?: MessagePart[];
  }

  interface MailFolder {
    id: string;
    accountId: string;
    path: string;
    name?: string;
    type?: string;
  }

  namespace messageDisplay {
    function getDisplayedMessage(tabId: number): Promise<MessageHeader>;
    function getDisplayedMessages(tabId: number): Promise<{ messages: MessageHeader[] }>;
  }

  namespace scripting {
    namespace messageDisplay {
      function registerScripts(scripts: Array<{
        id: string;
        css?: string[];
        js?: string[];
        runAt?: string;
      }>): Promise<void>;
    }
    namespace compose {
      function registerScripts(scripts: Array<{
        id: string;
        css?: string[];
        js?: string[];
      }>): Promise<void>;
    }
  }

  namespace accounts {
    function list(): Promise<MailAccount[]>;
  }

  interface MailAccount {
    id: string;
    name: string;
    type: string;
    rootFolder?: MailFolder;
    folders: MailFolder[];
    identities: Identity[];
  }

  interface Identity {
    accountId: string;
    email: string;
    name: string;
  }

  namespace identities {
    function getDefault(accountId: string): Promise<Identity>;
  }

  namespace folders {
    function create(parent: MailAccount | MailFolder | string, name: string): Promise<MailFolder>;
    function getSubFolders(folderOrId: MailFolder | string): Promise<MailFolder[]>;
  }

  namespace storage {
    namespace local {
      function get(keys: string | string[] | null): Promise<Record<string, unknown>>;
      function set(items: Record<string, unknown>): Promise<void>;
      function remove(keys: string | string[]): Promise<void>;
    }
  }

  namespace alarms {
    function create(name: string, alarmInfo: { periodInMinutes?: number; delayInMinutes?: number }): void;
    function clear(name: string): Promise<boolean>;
    const onAlarm: {
      addListener(callback: (alarm: { name: string }) => void): void;
      removeListener(callback: (alarm: { name: string }) => void): void;
    };
  }

  namespace i18n {
    function getMessage(messageName: string, substitutions?: string | string[]): string;
  }

  namespace mailTabs {
    function query(queryInfo: Record<string, unknown>): Promise<Array<{ id: number }>>;
    function setSelectedMessages(tabId: number, messageIds: number[]): Promise<void>;
  }

  namespace notifications {
    function create(options: {
      type: string;
      title: string;
      message: string;
      iconUrl?: string;
    }): Promise<string>;
  }
}

// messenger is an alias for browser in Thunderbird
declare const messenger: typeof browser;

// Build-time environment variables replaced by esbuild define
declare namespace process {
  const env: {
    NODE_ENV: string;
    PKG_URL: string;
    CRYPTIFY_URL: string;
    POSTGUARD_WEBSITE_URL: string;
  };
}
