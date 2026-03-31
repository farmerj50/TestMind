const DEFAULTS = {
  apiBase: "http://localhost:8787",
  apiToken: "",
  projectId: "",
  bucket: "locators",
  lastSelection: null,
};

function $(id) {
  return document.getElementById(id);
}

function normalizeBase(url) {
  return String(url || "").replace(/\/+$/, "");
}

function encodeSelector(value) {
  return encodeURIComponent(value);
}

function decodeSelector(value) {
  return decodeURIComponent(value || "");
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function renderSelection(selection) {
  const container = $("selection");
  if (!selection || !selection.candidates || !selection.candidates.length) {
    container.textContent = "No selection yet.";
    return;
  }
  const candidates = selection.candidates.slice(0, 6);
  const items = candidates
    .map(
      (selector, idx) => `
      <div class="row" style="align-items: flex-start">
        <label style="margin: 0; flex: 1">
          <input type="radio" name="primary" value="${encodeSelector(selector)}" ${
            idx === 0 ? "checked" : ""
          } />
          <span class="code">${selector}</span>
        </label>
        <button class="secondary" data-test="${encodeSelector(selector)}">Test</button>
      </div>`
    )
    .join("");

  container.innerHTML = `
    <div class="row" style="justify-content: space-between; align-items: center">
      <span class="pill">${selection.bucket}</span>
      <span class="pill">${selection.pagePath}</span>
    </div>
    <div class="row">
      <div style="flex: 1">
        <label for="elementName">Element name</label>
        <input id="elementName" type="text" value="${selection.suggestedName || ""}" />
      </div>
    </div>
    <div class="row">
      <div style="flex: 1">
        <label for="bucket">Bucket</label>
        <select id="bucket">
          ${["fields", "buttons", "links", "locators"]
            .map(
              (b) => `<option value="${b}" ${b === selection.bucket ? "selected" : ""}>${b}</option>`
            )
            .join("")}
        </select>
      </div>
    </div>
    ${items}
    <div class="row">
      <button id="saveSelection">Save locator</button>
    </div>
  `;

  container.querySelectorAll("[data-test]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const selector = decodeSelector(btn.getAttribute("data-test"));
      const tab = await getActiveTab();
      if (!tab?.id) return;
      chrome.tabs.sendMessage(tab.id, { type: "tm-picker:test", selector });
    });
  });

  $("saveSelection").addEventListener("click", async () => {
    const status = $("saveStatus");
    const tab = await getActiveTab();
    if (!tab?.id) return;
    const primaryInput = document.querySelector('input[name="primary"]:checked');
    const primary = primaryInput ? decodeSelector(primaryInput.value) : selection.primary;
    const fallbacks = selection.candidates.filter((c) => c !== primary).slice(0, 6);
    const elementName = $("elementName").value.trim();
    const bucket = $("bucket").value;

    if (!elementName) {
      status.textContent = "Element name is required.";
      return;
    }
    status.textContent = "Saving...";

    chrome.runtime.sendMessage(
      {
        type: "tm-picker:save",
        payload: {
          projectId: $("projectId").value.trim(),
          pagePath: selection.pagePath,
          bucket,
          elementName,
          primary,
          fallbacks,
          metadata: {
            url: selection.pageUrl,
            tag: selection.tagName,
            role: selection.role,
          },
        },
      },
      (resp) => {
        if (resp && resp.ok) {
          status.textContent = "Saved.";
        } else {
          status.textContent = resp?.error || "Failed to save.";
        }
      }
    );
  });
}

async function load() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  $("apiBase").value = settings.apiBase || DEFAULTS.apiBase;
  $("apiToken").value = settings.apiToken || "";
  $("projectId").value = settings.projectId || "";
  renderSelection(settings.lastSelection);
}

function bindSettings() {
  $("apiBase").addEventListener("input", () => {
    chrome.storage.local.set({ apiBase: normalizeBase($("apiBase").value) });
  });
  $("apiToken").addEventListener("input", () => {
    chrome.storage.local.set({ apiToken: $("apiToken").value.trim() });
  });
  $("projectId").addEventListener("input", () => {
    chrome.storage.local.set({ projectId: $("projectId").value.trim() });
  });
}

function bindPickerControls() {
  $("start").addEventListener("click", async () => {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: "tm-picker:start" });
  });
  $("stop").addEventListener("click", async () => {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: "tm-picker:stop" });
  });
}

load();
bindSettings();
bindPickerControls();

chrome.storage.onChanged.addListener((changes) => {
  if (changes.lastSelection) {
    renderSelection(changes.lastSelection.newValue);
  }
});
