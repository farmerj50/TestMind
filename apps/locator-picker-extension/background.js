/* TestMind Locator Picker background service worker */
const DEFAULTS = {
  apiBase: "http://localhost:8787",
  apiToken: "",
  projectId: "",
  bucket: "locators",
};

function normalizeBase(url) {
  return String(url || "").replace(/\/+$/, "");
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "tm-picker:selected") {
    chrome.storage.local.set({ lastSelection: msg.payload || null });
    return;
  }

  if (msg.type === "tm-picker:save") {
    (async () => {
      const storage = await chrome.storage.local.get(DEFAULTS);
      const apiBase = normalizeBase(msg.payload?.apiBase || storage.apiBase);
      const apiToken = msg.payload?.apiToken || storage.apiToken;
      const projectId = msg.payload?.projectId || storage.projectId;

      if (!apiToken) {
        sendResponse({ ok: false, error: "Missing API token in extension settings." });
        return;
      }
      if (!projectId) {
        sendResponse({ ok: false, error: "Missing projectId in settings or picker panel." });
        return;
      }

      const body = {
        projectId,
        pagePath: msg.payload?.pagePath,
        urlPattern: msg.payload?.urlPattern,
        bucket: msg.payload?.bucket || storage.bucket,
        elementName: msg.payload?.elementName,
        name: msg.payload?.name,
        primary: msg.payload?.primary,
        fallbacks: msg.payload?.fallbacks,
        metadata: msg.payload?.metadata,
      };

      try {
        const res = await fetch(`${apiBase}/locators`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiToken}`,
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          sendResponse({ ok: false, error: text || `${res.status} ${res.statusText}` });
          return;
        }
        const data = await res.json().catch(() => ({}));
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || "Failed to save locator." });
      }
    })();
    return true;
  }
});
