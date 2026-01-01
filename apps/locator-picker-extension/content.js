/* TestMind Locator Picker content script */
(() => {
  if (location.protocol.startsWith("chrome")) return;

  let pickerActive = false;
  let lockedElement = null;
  let outlineEl = null;
  let panelEl = null;
  let lastSelection = null;

  const OUTLINE_ID = "tm-picker-outline";
  const PANEL_ID = "tm-picker-panel";

  const ATTR_PRIORITY = ["data-testid", "data-test", "data-qa"];
  const MAX_ALTERNATES = 6;

  function ensureOutline() {
    if (outlineEl) return outlineEl;
    outlineEl = document.createElement("div");
    outlineEl.id = OUTLINE_ID;
    outlineEl.setAttribute("data-tm-picker", "true");
    Object.assign(outlineEl.style, {
      position: "fixed",
      zIndex: 2147483647,
      pointerEvents: "none",
      border: "2px solid #2563eb",
      borderRadius: "4px",
      boxShadow: "0 0 0 2px rgba(37, 99, 235, 0.15)",
      background: "rgba(37, 99, 235, 0.05)",
      display: "none",
    });
    document.documentElement.appendChild(outlineEl);
    return outlineEl;
  }

  function showOutlineForRect(rect, color) {
    const el = ensureOutline();
    el.style.display = "block";
    el.style.borderColor = color || "#2563eb";
    el.style.boxShadow = `0 0 0 2px ${color ? "rgba(16, 185, 129, 0.2)" : "rgba(37, 99, 235, 0.15)"}`;
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
  }

  function hideOutline() {
    if (outlineEl) outlineEl.style.display = "none";
  }

  function slugify(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function looksRandom(value) {
    if (!value) return true;
    if (value.length >= 32) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      return true;
    }
    const digitCount = (value.match(/\d/g) || []).length;
    if (digitCount >= 6 && digitCount / value.length > 0.3) return true;
    if (/[A-Z]{3,}\d{3,}/.test(value)) return true;
    return false;
  }

  function isStableToken(value) {
    if (!value) return false;
    if (looksRandom(value)) return false;
    return true;
  }

  function getLabelTextForControl(el) {
    if (!(el instanceof HTMLElement)) return "";
    const id = el.getAttribute("id");
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label && label.textContent) return label.textContent.trim();
    }
    const parentLabel = el.closest("label");
    if (parentLabel && parentLabel.textContent) return parentLabel.textContent.trim();
    return "";
  }

  function getAccessibleName(el) {
    if (!(el instanceof HTMLElement)) return "";
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((node) => node.textContent || "")
        .join(" ")
        .trim();
      if (parts) return parts;
    }
    const labelText = getLabelTextForControl(el);
    if (labelText) return labelText;
    const text = (el.textContent || "").trim();
    return text;
  }

  function getRole(el) {
    if (!(el instanceof HTMLElement)) return "";
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim();
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.getAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      return "textbox";
    }
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    return "";
  }

  function buildRoleSelector(el) {
    const role = getRole(el);
    if (!role) return "";
    const name = getAccessibleName(el);
    if (!name) return "";
    const safeName = name.replace(/"/g, '\\"');
    return `role=${role}[name="${safeName}"]`;
  }

  function buildLabelSelector(el) {
    const label = getLabelTextForControl(el);
    if (!label) return "";
    const safe = label.replace(/"/g, '\\"');
    return `label="${safe}"`;
  }

  function buildTextSelector(el) {
    const text = getAccessibleName(el);
    if (!text) return "";
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return "";
    if (normalized.length > 80) return "";
    if (/^\d{3,}$/.test(normalized)) return "";
    const safe = normalized.replace(/"/g, '\\"');
    return `text="${safe}"`;
  }

  function cssSegment(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.getAttribute("id");
    if (id && isStableToken(id)) return `#${CSS.escape(id)}`;
    let segment = tag;
    const classList = Array.from(el.classList || []).filter(isStableToken).slice(0, 2);
    if (classList.length) {
      segment += `.${classList.map((c) => CSS.escape(c)).join(".")}`;
    }
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (s) => s.tagName.toLowerCase() === tag
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(el) + 1;
        segment += `:nth-of-type(${index})`;
      }
    }
    return segment;
  }

  function buildCssPath(el) {
    if (!(el instanceof HTMLElement)) return "";
    if (el.getAttribute("id") && isStableToken(el.getAttribute("id"))) {
      return `#${CSS.escape(el.getAttribute("id"))}`;
    }
    const segments = [];
    let node = el;
    while (node && node instanceof HTMLElement && segments.length < 4) {
      const segment = cssSegment(node);
      segments.unshift(segment);
      const selector = segments.join(" > ");
      try {
        if (document.querySelectorAll(selector).length === 1) return selector;
      } catch {
        /* ignore invalid selectors */
      }
      node = node.parentElement;
    }
    return segments.join(" > ");
  }

  function buildXPath(el) {
    if (!(el instanceof HTMLElement)) return "";
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const tag = node.tagName.toLowerCase();
      let index = 1;
      let sibling = node.previousElementSibling;
      while (sibling) {
        if (sibling.tagName.toLowerCase() === tag) index += 1;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${tag}[${index}]`);
      node = node.parentElement;
    }
    return `xpath=/${parts.join("/")}`;
  }

  function candidateSelectors(el) {
    const candidates = [];
    const push = (value) => {
      if (!value) return;
      const trimmed = value.trim();
      if (!trimmed) return;
      if (!candidates.includes(trimmed)) candidates.push(trimmed);
    };

    ATTR_PRIORITY.forEach((attr) => {
      const val = el.getAttribute(attr);
      if (val) push(`[${attr}="${val}"]`);
    });

    push(buildRoleSelector(el));

    if (el.matches("input, textarea, select")) {
      push(buildLabelSelector(el));
    }

    const id = el.getAttribute("id");
    if (id && isStableToken(id)) push(`#${CSS.escape(id)}`);

    push(buildTextSelector(el));
    push(buildCssPath(el));
    push(buildXPath(el));
    return candidates;
  }

  function bucketForElement(el) {
    const tag = el.tagName.toLowerCase();
    const role = getRole(el);
    if (tag === "input" || tag === "textarea" || tag === "select") return "fields";
    if (tag === "a" || role === "link") return "links";
    if (tag === "button" || role === "button") return "buttons";
    return "locators";
  }

  function selectionFromElement(el) {
    const candidates = candidateSelectors(el);
    const primary = candidates[0] || "";
    const alternates = candidates.slice(1, MAX_ALTERNATES + 1);
    const nameSeed = getAccessibleName(el) || el.getAttribute("name") || el.getAttribute("id") || el.tagName;
    return {
      primary,
      alternates,
      candidates,
      pagePath: `${location.pathname || "/"}${location.search || ""}`,
      pageUrl: location.href,
      bucket: bucketForElement(el),
      suggestedName: slugify(nameSeed) || "element",
      tagName: el.tagName.toLowerCase(),
      role: getRole(el),
    };
  }

  function renderPanel(selection) {
    if (!panelEl) {
      panelEl = document.createElement("div");
      panelEl.id = PANEL_ID;
      panelEl.setAttribute("data-tm-picker", "true");
      document.documentElement.appendChild(panelEl);
    }
    const candidates = selection.candidates.slice(0, MAX_ALTERNATES + 1);
    const rows = candidates
      .map(
        (selector, idx) => `
        <div class="tm-row">
          <label>
            <input type="radio" name="tm-primary" value="${encodeURIComponent(selector)}" ${idx === 0 ? "checked" : ""} />
            <span class="tm-code">${escapeHtml(selector)}</span>
          </label>
          <button class="tm-btn tm-test" data-selector="${encodeURIComponent(selector)}">Test</button>
        </div>`
      )
      .join("");

    panelEl.innerHTML = `
      <style>
        #${PANEL_ID} { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
          width: 360px; background: #0f172a; color: #e2e8f0; border-radius: 12px;
          box-shadow: 0 12px 40px rgba(0,0,0,0.25); font-family: ui-sans-serif, system-ui, sans-serif;
        }
        #${PANEL_ID} .tm-header { display: flex; align-items: center; justify-content: space-between;
          padding: 10px 12px; border-bottom: 1px solid #1e293b; font-size: 13px;
        }
        #${PANEL_ID} .tm-body { padding: 12px; }
        #${PANEL_ID} .tm-field { margin-bottom: 8px; }
        #${PANEL_ID} label { display: block; font-size: 11px; color: #94a3b8; margin-bottom: 4px; }
        #${PANEL_ID} input[type="text"], #${PANEL_ID} select {
          width: 100%; padding: 6px 8px; border-radius: 8px; border: 1px solid #334155;
          background: #0b1220; color: #e2e8f0; font-size: 12px;
        }
        #${PANEL_ID} .tm-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
        #${PANEL_ID} .tm-row label { display: flex; gap: 6px; align-items: center; margin: 0; font-size: 12px; color: #e2e8f0; }
        #${PANEL_ID} .tm-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
        #${PANEL_ID} .tm-btn { background: #1f2937; color: #e2e8f0; border: 1px solid #334155;
          border-radius: 6px; padding: 4px 8px; font-size: 11px; cursor: pointer;
        }
        #${PANEL_ID} .tm-btn:hover { background: #334155; }
        #${PANEL_ID} .tm-actions { display: flex; gap: 8px; margin-top: 10px; }
        #${PANEL_ID} .tm-status { margin-top: 6px; font-size: 11px; color: #94a3b8; min-height: 14px; }
      </style>
      <div class="tm-header">
        <strong>TestMind Picker</strong>
        <button class="tm-btn tm-close">Close</button>
      </div>
      <div class="tm-body">
        <div class="tm-field">
          <label>Project ID</label>
          <input type="text" id="tm-project-id" value="${escapeHtml(selection.projectId || "")}" placeholder="project id" />
        </div>
        <div class="tm-field">
          <label>Element name</label>
          <input type="text" id="tm-element-name" value="${escapeHtml(selection.suggestedName || "")}" />
        </div>
        <div class="tm-field">
          <label>Bucket</label>
          <select id="tm-bucket">
            ${["fields", "buttons", "links", "locators"]
              .map((b) => `<option value="${b}" ${b === selection.bucket ? "selected" : ""}>${b}</option>`)
              .join("")}
          </select>
        </div>
        <div class="tm-field">
          <label>Primary + alternates</label>
          ${rows}
        </div>
        <div class="tm-actions">
          <button class="tm-btn tm-save">Save</button>
          <button class="tm-btn tm-stop">Stop picker</button>
        </div>
        <div class="tm-status" id="tm-status"></div>
      </div>
    `;

    panelEl.querySelector(".tm-close").addEventListener("click", () => {
      panelEl.remove();
      panelEl = null;
    });

    panelEl.querySelector(".tm-stop").addEventListener("click", () => stopPicker());

    panelEl.querySelectorAll(".tm-test").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        const selector = decodeURIComponent(btn.getAttribute("data-selector") || "");
        testSelector(selector);
      });
    });

    panelEl.querySelector(".tm-save").addEventListener("click", async () => {
      const projectId = panelEl.querySelector("#tm-project-id").value.trim();
      const elementName = panelEl.querySelector("#tm-element-name").value.trim();
      const bucket = panelEl.querySelector("#tm-bucket").value;
      const statusEl = panelEl.querySelector("#tm-status");

      const primaryInput = panelEl.querySelector('input[name="tm-primary"]:checked');
      const primary = primaryInput ? decodeURIComponent(primaryInput.value) : selection.primary;
      const fallbacks = selection.candidates.filter((c) => c !== primary).slice(0, MAX_ALTERNATES);

      if (!projectId) {
        statusEl.textContent = "Project ID is required.";
        return;
      }
      if (!elementName) {
        statusEl.textContent = "Element name is required.";
        return;
      }

      statusEl.textContent = "Saving...";
      chrome.runtime.sendMessage(
        {
          type: "tm-picker:save",
          payload: {
            projectId,
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
            statusEl.textContent = "Saved.";
            chrome.storage.local.set({ tmProjectId: projectId });
          } else {
            statusEl.textContent = resp?.error || "Failed to save.";
          }
        }
      );
    });
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function testSelector(selector) {
    try {
      const matches = findMatches(selector);
      if (matches.length) {
        const rect = matches[0].getBoundingClientRect();
        showOutlineForRect(rect, "#10b981");
        setTimeout(() => {
          if (!pickerActive) hideOutline();
        }, 1200);
      }
    } catch {
      /* ignore */
    }
  }

  function findMatches(selector) {
    if (!selector) return [];
    if (selector.startsWith("text=")) {
      const text = selector.replace(/^text=/, "").replace(/^"|"$/g, "");
      return Array.from(document.querySelectorAll("*")).filter((el) =>
        (el.textContent || "").trim().includes(text)
      );
    }
    if (selector.startsWith("role=")) {
      const match = selector.match(/^role=([^\[]+)(?:\[name="([^"]+)"\])?/);
      if (!match) return [];
      const role = match[1];
      const name = match[2] || "";
      return Array.from(document.querySelectorAll("*")).filter((el) => {
        if (!(el instanceof HTMLElement)) return false;
        if (getRole(el) !== role) return false;
        if (!name) return true;
        return getAccessibleName(el) === name;
      });
    }
    if (selector.startsWith("label=")) {
      const text = selector.replace(/^label=/, "").replace(/^"|"$/g, "");
      const labels = Array.from(document.querySelectorAll("label")).filter(
        (label) => (label.textContent || "").trim() === text
      );
      const controls = labels
        .map((label) => {
          const forId = label.getAttribute("for");
          if (forId) return document.getElementById(forId);
          const nested = label.querySelector("input, textarea, select");
          return nested;
        })
        .filter(Boolean);
      return controls;
    }
    if (selector.startsWith("xpath=") || selector.startsWith("//")) {
      const xpath = selector.startsWith("xpath=") ? selector.replace(/^xpath=/, "") : selector;
      const result = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      const nodes = [];
      for (let i = 0; i < result.snapshotLength; i += 1) {
        nodes.push(result.snapshotItem(i));
      }
      return nodes.filter(Boolean);
    }
    return Array.from(document.querySelectorAll(selector));
  }

  function onMouseMove(event) {
    if (!pickerActive || lockedElement) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest(`[data-tm-picker]`)) return;
    const rect = target.getBoundingClientRect();
    showOutlineForRect(rect);
  }

  function onClick(event) {
    if (!pickerActive || lockedElement) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest(`[data-tm-picker]`)) return;
    event.preventDefault();
    event.stopPropagation();

    lockedElement = target;
    const selection = selectionFromElement(target);
    lastSelection = selection;

    chrome.storage.local.get({ tmProjectId: "" }, (stored) => {
      const projectId = stored.tmProjectId || "";
      selection.projectId = projectId;
      renderPanel(selection);
    });

    chrome.runtime.sendMessage({ type: "tm-picker:selected", payload: selection });
  }

  function startPicker() {
    if (pickerActive) return;
    pickerActive = true;
    lockedElement = null;
    ensureOutline();
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
  }

  function stopPicker() {
    pickerActive = false;
    lockedElement = null;
    hideOutline();
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "tm-picker:start") startPicker();
    if (msg.type === "tm-picker:stop") stopPicker();
    if (msg.type === "tm-picker:test" && msg.selector) testSelector(msg.selector);
    if (msg.type === "tm-picker:get-selection") {
      chrome.runtime.sendMessage({ type: "tm-picker:selected", payload: lastSelection || {} });
    }
  });
})();
