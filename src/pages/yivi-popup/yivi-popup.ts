/// <reference path="../../types/thunderbird.d.ts" />
export {};

interface YiviPopupData {
  hostname: string;
  header: Record<string, string>;
  con: Array<{ t: string; v?: string }>;
  sort: string;
  hints?: Array<{ t: string; v: string }>;
  senderId?: string;
}

const titleEl = document.getElementById("title") as HTMLElement;
const subtitleEl = document.getElementById("subtitle") as HTMLElement;
const senderEl = document.getElementById("sender-info") as HTMLElement;
const hintsEl = document.getElementById("hints") as HTMLElement;
const errorEl = document.getElementById("error") as HTMLElement;
const loadingEl = document.getElementById("loading") as HTMLElement;
const qrContainer = document.getElementById("yivi-web-form") as HTMLElement;

async function init() {
  const data = (await browser.runtime.sendMessage({
    type: "yiviPopupInit",
  })) as YiviPopupData | null;

  if (!data) {
    showError("Failed to initialize session.");
    return;
  }

  // Update UI
  if (data.sort === "Decryption") {
    titleEl.textContent = browser.i18n.getMessage("displayMessageTitle");
    subtitleEl.textContent = browser.i18n.getMessage("displayMessageHeading");
  } else {
    titleEl.textContent = "PostGuard — Sign";
    subtitleEl.textContent = browser.i18n.getMessage("displayMessageQrPrefix");
  }

  if (data.senderId) {
    senderEl.innerHTML = `From: <strong>${escapeHtml(data.senderId)}</strong>`;
    senderEl.style.display = "block";
  }

  if (data.hints) {
    for (const hint of data.hints) {
      const badge = document.createElement("span");
      badge.className = "hint-badge";
      const label =
        browser.i18n.getMessage(hint.t) || hint.t.split(".").pop() || hint.t;
      badge.textContent = hint.v ? `${label}: ${hint.v}` : label;
      hintsEl.appendChild(badge);
    }
  }

  try {
    // Start Yivi session via PKG
    const resp = await fetch(`${data.hostname}/v2/request/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...data.header },
      body: JSON.stringify({ con: data.con }),
    });
    if (!resp.ok) throw new Error(`Session start failed: ${resp.status}`);

    const { sessionPtr, token } = await resp.json();
    console.log("[PostGuard] Yivi session started, token:", token);
    loadingEl.style.display = "none";

    // Show QR code from the IRMA session pointer
    showQrCode(sessionPtr);

    // Poll IRMA server for session status, then retrieve JWT from PKG
    await pollIrmaStatus(sessionPtr.u);
    console.log("[PostGuard] IRMA session DONE, fetching JWT from PKG...");

    // Fetch JWT from PKG (returned as plain text, not JSON)
    const jwtResp = await fetch(
      `${data.hostname}/v2/request/jwt/${token}`,
      { headers: data.header }
    );
    if (!jwtResp.ok) throw new Error(`JWT fetch failed: ${jwtResp.status}`);
    const jwt = await jwtResp.text();

    console.log("[PostGuard] JWT received, sending to background");
    await browser.runtime.sendMessage({ type: "yiviPopupDone", jwt });

    // Auto-close after a short delay
    setTimeout(async () => {
      const win = await browser.windows.getCurrent();
      browser.windows.remove(win.id);
    }, 750);
  } catch (e) {
    console.error("[PostGuard] Yivi session error:", e);
    showError(e instanceof Error ? e.message : "Yivi session failed.");
  }
}

// Poll the IRMA server's status endpoint until the session is DONE.
async function pollIrmaStatus(sessionUrl: string): Promise<void> {
  const maxAttempts = 240; // 2 minutes at 500ms interval
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const resp = await fetch(`${sessionUrl}/status`);
      if (!resp.ok) continue;
      const status = await resp.json();
      console.log("[PostGuard] IRMA status:", status);

      if (status === "DONE") return;
      if (status === "CANCELLED" || status === "TIMEOUT") {
        throw new Error(`Yivi session ${status.toLowerCase()}`);
      }
    } catch (e) {
      if (e instanceof Error && (e.message.includes("cancelled") || e.message.includes("timeout"))) {
        throw e;
      }
      // Network errors during polling are ok, keep trying
    }
  }
  throw new Error("Yivi session timed out");
}

function showQrCode(sessionPtr: { u: string; irmaqr: string }) {
  // The QR code should contain the raw session pointer JSON for the Yivi app
  const qrData = JSON.stringify(sessionPtr);

  qrContainer.innerHTML = `
    <div style="text-align:center;padding:20px;">
      <div id="qr-canvas" style="display:inline-block;background:#fff;padding:16px;border-radius:8px;border:1px solid #e5e7eb;"></div>
    </div>
  `;

  // Generate QR code via external API
  const size = 200;
  const img = document.createElement("img");
  img.src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(qrData)}`;
  img.width = size;
  img.height = size;
  img.alt = "Yivi QR Code";
  img.style.borderRadius = "4px";

  const canvas = document.getElementById("qr-canvas")!;
  canvas.appendChild(img);
}

function showError(msg: string) {
  loadingEl.style.display = "none";
  errorEl.textContent = msg;
  errorEl.style.display = "block";
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

init();
