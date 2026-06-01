const STORAGE_KEYS = {
  WEBHOOK: "webhookUrl",
  BUTTONS: "buttons",
  SELECTOR_CONFIG: "selectorConfig",
  REPORT_QUEUE_STATE: "reportQueueState"
};
 
const REPORT_VIEWER_URL_PREFIX = "https://idms.dealersocket.com/reportviewer_v11/report11/report_viewer_rdlc.aspx";

const MACHINE_STATES = {
  IDLE: "idle",
  TYPING_SEARCH: "typing_search",
  EVALUATING_RESULTS: "evaluating_results",
  CLICKING_PLAY: "clicking_play",
  CLICKING_GENERATE: "clicking_generate",
  CHANGING_FORMAT: "changing_format",
  CAPTURING_CSV: "capturing_csv",
  POSTING_WEBHOOK: "posting_webhook",
  DONE: "done",
  ERROR: "error",
  CANCELED: "canceled"
};

const runtime = {
  root: null,
  panel: null,
  statusEl: null,
  buttonsWrap: null,
  pickerOverlay: null,
  state: MACHINE_STATES.IDLE,
  busy: false,
  discoveryMode: false,
  discoveryHandler: null,
  currentJobId: null,
  cancelRequested: false,
  selectedResultElement: null,
  lastCsvDownloadEvent: null,
  directCsvFallbackDownload: null,
  networkProbeInstalled: false,
  recentNetworkRequests: [],
  resultsSignatureBeforeSearch: "",
  config: {
    webhookUrl: "",
    buttons: [],
    selectorConfig: {}
  }
};

const RETRY_SETTINGS = {
  delayMs: 5000,
  defaultTimeoutMs: 120000,
  captureTimeoutMs: 240000,
  webhookTimeoutMs: 60000
};

function normalizeQueueItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => ({
      label: String(item?.label || "").trim(),
      url: String(item?.url || "").trim(),
      webhookUrl: item?.webhookUrl ? String(item.webhookUrl).trim() : null
    }))
    .filter((item) => item.label && /^https?:\/\//i.test(item.url));
}

async function startReportQueue(items) {
  if (runtime.busy) {
    setStatus("Busy running another automation job.");
    return;
  }

  const queue = normalizeQueueItems(items);
  if (!queue.length) {
    throw new Error("No valid report URLs were provided.");
  }

  const state = {
    active: true,
    runId: createId(),
    queue,
    index: 0,
    startedAt: new Date().toISOString()
  };

  await chrome.storage.local.set({ [STORAGE_KEYS.REPORT_QUEUE_STATE]: state });
  setStatus(`Queue started: 1/${queue.length} -> ${queue[0].label}`);
  showToast(`Queue started: ${queue.length} reports`, "info", 4500);
  location.href = queue[0].url;
}

function normalizeUrlForCompare(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}?${parsed.searchParams.toString()}`;
  } catch {
    return String(url || "").trim();
  }
}

function getQueueIndexForLocation(queue, fallbackIndex) {
  const current = normalizeUrlForCompare(location.href);
  const exactIndex = queue.findIndex((entry) => normalizeUrlForCompare(entry.url) === current);
  if (exactIndex >= 0) {
    return exactIndex;
  }
  return Number.isInteger(fallbackIndex) ? fallbackIndex : 0;
}

async function resolveStandardViewerButton(selectorConfig, timeoutMs) {
  const fallbackEntry = {
    selectors: [
      "#rpt_viewer_tab_standard",
      "span[id='rpt_viewer_tab_standard']",
      ".subtab_b_active[onclick*='report_viewer_loadreport']",
      "span[onclick*='report_viewer_loadreport(1)']"
    ]
  };

  const found = await waitForElementFromEntry(fallbackEntry, {
    timeoutMs,
    visibleOnly: true
  }).catch(() => null);

  if (found) {
    setStatus("changing_format: found Standard Viewer tab");
    return found;
  }

  const byText = findElementByText(document, "span, a, button, li", "standard viewer");
  if (byText) {
    setStatus("changing_format: found Standard Viewer tab by text");
    return byText;
  }

  throw new Error("Standard Viewer button not found.");
}

function getSearchDocuments(root) {
  const docs = [];
  const seen = new Set();

  function collect(doc) {
    if (!doc || seen.has(doc)) return;
    seen.add(doc);
    docs.push(doc);
    try {
      const frames = doc.querySelectorAll("iframe, frame");
      for (const frame of frames) {
        try {
          const fd = frame.contentDocument;
          if (fd) collect(fd);
        } catch (_) {} 
      }
    } catch (_) {}
  }

  collect(root || document);
  return docs;
}

function getSearchWindows() {
  const wins = [];
  const seen = new Set();

  function collect(win) {
    if (!win || seen.has(win)) return;
    seen.add(win);
    wins.push(win);
    try {
      for (let i = 0; i < win.frames.length; i++) {
        try { collect(win.frames[i]); } catch (_) {}
      }
    } catch (_) {}
  }

  collect(window);
  return wins;
}

async function resolveExportDropdownButton(selectorConfig, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    ensureNotCanceled();

    const searchDocs = getSearchDocuments();
    setStatus(`changing_format: scanning ${searchDocs.length} document(s) for export button`);

    const exactSelectors = [
      "#ReportViewer1_ctl09_ctl04_ctl00_ButtonLink",
      "#ReportViewer1_ctl09_ctl05_ctl00_ButtonLink",
      "#ReportViewer1_ctl10_ctl04_ctl00_ButtonLink",
      "#ReportViewer1_ctl10_ctl05_ctl00_ButtonLink",
      "a.ExportLink",
      "div.ExportLink",
      "a[title='Export drop down menu']",
      "a[aria-label='Export drop down menu']",
      "#ReportViewer1_ctl09_ctl04_ctl00_ButtonImg",
      "#ReportViewer1_ctl09_ctl05_ctl00_ButtonImg",
      "#ReportViewer1_ctl10_ctl04_ctl00_ButtonImg",
      "[id*='ReportViewer'][id*='ButtonLink']",
      "[id*='ReportViewer'][id*='ctl04'][id*='ctl00']",
      "[id*='ReportViewer'][id*='ctl05'][id*='ctl00']",
      "img[src*='export' i]",
      "img[alt*='export' i]",
      "img[title*='export' i]",
      "[onclick*='ExportMenuClick' i]",
      "[onclick*='export' i][onclick*='menu' i]",
    ];

    for (const doc of searchDocs) {
      for (const selector of exactSelectors) {
        try {
          const el = doc.querySelector(selector);
          if (el && isVisible(el)) {
            setStatus("changing_format: found export button in " + (doc === document ? "top doc" : "iframe") + " via: " + selector);
            return await clickExportButton(el, doc.defaultView);
          }
        } catch (_) {}
      }
    }

    for (const doc of searchDocs) {
      try {
        const candidates = Array.from(doc.querySelectorAll(
          "a, button, input[type='button'], span[onclick], div[onclick]"
        ));
        for (const el of candidates) {
          if (!isVisible(el)) continue;
          const id      = String(el.id || "").toLowerCase();
          const cls     = String(el.className || "").toLowerCase();
          const title   = String(el.title || "").toLowerCase();
          const aria    = String(el.getAttribute("aria-label") || "").toLowerCase();
          const onclick = String(el.getAttribute("onclick") || "").toLowerCase();

          if (
            id.includes("export") || cls.includes("export") ||
            title.includes("export") || title.includes("save") ||
            aria.includes("export") ||
            onclick.includes("export") || onclick.includes("exportmenu")
          ) {
            setStatus("changing_format: found export btn via attr scan in " + (doc === document ? "top" : "iframe") + ": " + (el.id || el.className || el.tagName));
            return await clickExportButton(el, doc.defaultView);
          }
        }
      } catch (_) {}
    }

    for (const win of getSearchWindows()) {
      try {
        const rv = win.$find && win.$find("ReportViewer1");
        if (rv) {
          const toolbar = rv._toolbar || rv.toolbar;
          if (toolbar && typeof toolbar.showExportMenu === "function") {
            setStatus("changing_format: triggering $find toolbar.showExportMenu()");
            toolbar.showExportMenu();
            return { _directApi: true };
          }
          if (typeof rv.exportReport === "function") {
            setStatus("changing_format: triggering $find exportReport(EXCELOPENXML)");
            rv.exportReport("EXCELOPENXML");
            return { _directExport: true };
          }
        }
      } catch (_) {}
    }

    for (const doc of searchDocs) {
      try {
        for (const img of Array.from(doc.querySelectorAll("img"))) {
          if (!isVisible(img)) continue;
          const src = String(img.src || img.getAttribute("src") || "").toLowerCase();
          if (src.includes("save") || src.includes("export") || src.includes("floppy") || src.includes("disk")) {
            const parent = img.closest("a, button, [onclick]") || img;
            setStatus("changing_format: found export via img src in " + (doc === document ? "top" : "iframe") + ": " + src.split("/").pop());
            return await clickExportButton(parent, doc.defaultView);
          }
        }
      } catch (_) {}
    }

    await waitForDomMutation(500);
  }

  throw new Error("Export dropdown button not found.");
}

async function clickExportButton(el, win) {
  const w = win || window;
  el.scrollIntoView({ block: "center", behavior: "instant" });
  await wait(300);

  try { el.click(); } catch (_) {}
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent("click",     { bubbles: true, cancelable: true }));

  // Removed the illegal new w.Function(onclickAttr) block that violated CSP

  for (const searchWin of getSearchWindows()) {
    try {
      const rv = searchWin.$find && searchWin.$find("ReportViewer1");
      if (rv && rv._getMenu && rv._getMenu()) {
        rv._getMenu().show();
        break;
      }
    } catch (_) {}
  }

  return el;
}

async function resolveExcelOption(selectorConfig, timeoutMs) {
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await wait(attempt === 1 ? 800 : 600);
    try {
      setStatus(`changing_format: Excel click attempt ${attempt}/${maxAttempts}...`);
      const result = await sendRuntimeMessage({ type: "CLICK_EXCEL_IN_MAIN_WORLD" });
      console.log(`[content] Excel attempt ${attempt}:`, JSON.stringify(result));
      if (result?.clicked) {
        if (typeof showToast === "function") showToast("✅ Excel export triggered!", "success", 4000);
        setStatus("changing_format: Excel triggered → " + JSON.stringify(result.results));
        return { _clicked: true };
      }

      const totalFrames = result?.results?.length || 0;
      setStatus(`changing_format: Searching ${totalFrames} frames... Excel not found yet (attempt ${attempt}/${maxAttempts})`);
    } catch (e) {
      console.warn(`[content] Excel attempt ${attempt} error:`, e.message);
    }
  }

  setStatus("changing_format: MAIN-world exhausted, trying DOM fallbacks...");

  const searchDocs = getSearchDocuments();

  for (const doc of searchDocs) {
    try {
      for (const div of Array.from(doc.querySelectorAll("[id*='Menu'], [class*='Menu'], [class*='menu']"))) {
        if (div.style.display === "none" || div.style.visibility === "hidden") {
          div.style.display = "block";
          div.style.visibility = "visible";
        }
      }
    } catch (_) {}
  }
  await wait(400);

  let excelEl = null;
  let excelWin = null;

  outer:
  for (const doc of searchDocs) {
    const selectors = [
      "a[title='Excel']", "a[title='Excel 2007-2013 (.xlsx)']",
      "a[onclick*='EXCELOPENXML' i]", "a[onclick*='excel' i]",
      "a.ActiveLink[title*='excel' i]", "li[onclick*='excel' i]"
    ];
    for (const sel of selectors) {
      try {
        const el = doc.querySelector(sel);
        if (el) { excelEl = el; excelWin = doc.defaultView; break outer; }
      } catch (_) {}
    }
    try {
      for (const el of Array.from(doc.querySelectorAll("a, li, button, span, td"))) {
        const text    = (el.textContent || "").trim();
        const title   = (el.getAttribute("title") || "");
        const onclick = (el.getAttribute("onclick") || "");
        const href    = (el.getAttribute("href") || "");
        if (
          text.toLowerCase() === "excel" ||
          title.toLowerCase().includes("excel") ||
          onclick.toLowerCase().includes("excelopenxml") ||
          href.toLowerCase().includes("excelopenxml")
        ) {
          excelEl = el; excelWin = doc.defaultView; break outer;
        }
      }
    } catch (_) {}
  }

  if (excelEl) {
    console.log("[ExcelExport] Found element:", {
      tag: excelEl.tagName, id: excelEl.id, text: (excelEl.textContent || "").trim(),
      title: excelEl.getAttribute("title"), onclick: excelEl.getAttribute("onclick"),
      href: excelEl.getAttribute("href"), outerHTML: excelEl.outerHTML.slice(0, 300)
    });
  }


  if (excelEl) {
    const onclickAttr = excelEl.getAttribute("onclick") || "";
    const doPostBackMatch = onclickAttr.match(/__doPostBack\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
    
    // Strategy A: Native doPostBack if available
    if (doPostBackMatch && excelWin && typeof excelWin.__doPostBack === "function") {
      setStatus("changing_format: calling __doPostBack for Excel export");
      excelWin.__doPostBack(doPostBackMatch[1], doPostBackMatch[2]);
      return { _clicked: true };
    }

    // Strategy B: Navigate to href
    const href = excelEl.getAttribute("href") || "";
    if (href && !href.toLowerCase().startsWith("javascript") && href !== "#" && href !== "") {
      setStatus("changing_format: navigating to Excel export href: " + href.slice(0, 80));
      const absoluteUrl = new URL(href, (excelWin || window).location.href).href;
      window.open(absoluteUrl, "_blank");
      return { _clicked: true };
    }

    // Strategy C: Native click (Removed the illegal script tag injection here)
    try {
      setStatus("changing_format: last-resort native click on Excel element");
      excelEl.click();
      return { _clicked: true };
    } catch (_) {}
  

  for (const win of getSearchWindows()) {
    try {
      const rv = win.$find && win.$find("ReportViewer1");
      if (rv && typeof rv.exportReport === "function") {
        setStatus("changing_format: SSRS $find exportReport(EXCELOPENXML)");
        rv.exportReport("EXCELOPENXML");
        return { _clicked: true };
      }
    } catch (_) {}
  }

  const knownControlIds = [
    "ReportViewer1$ctl09$ctl04$ctl00", "ReportViewer1$ctl09$ctl05$ctl00",
    "ReportViewer1$ctl10$ctl04$ctl00", "ReportViewer1$ctl10$ctl05$ctl00", "ReportViewer1$ctl08$ctl04$ctl00",
  ];
  for (const doc of searchDocs) {
    const win = doc.defaultView;
    if (win && typeof win.__doPostBack === "function") {
      for (const ctlId of knownControlIds) {
        try {
          setStatus("changing_format: trying __doPostBack: " + ctlId);
          win.__doPostBack(ctlId, "EXCELOPENXML");
          return { _clicked: true };
        } catch (_) {}
      }
      break; 
    }
  }

  try {
    const baseUrl = new URL(location.href);
    for (const exportId of [1, 2, 3, 5, 7]) {
      const testUrl = new URL(baseUrl.href);
      testUrl.searchParams.set("qexport_id", String(exportId));
      testUrl.searchParams.set("qformat", "EXCELOPENXML");
    }
    const exportUrl = new URL(baseUrl.href);
    exportUrl.searchParams.set("qexport_id", "1");
    setStatus("changing_format: trying direct URL export qexport_id=1");
    window.open(exportUrl.href, "_blank");
    return { _clicked: true };
  } catch (_) {}

  throw new Error("Excel export could not be triggered. Check browser console logs.");
}

  for (const win of getSearchWindows()) {
    try {
      const rv = win.$find && win.$find("ReportViewer1");
      if (rv && typeof rv.exportReport === "function") {
        setStatus("changing_format: SSRS $find exportReport(EXCELOPENXML)");
        rv.exportReport("EXCELOPENXML");
        return { _clicked: true };
      }
    } catch (_) {}
  }

  const knownControlIds = [
    "ReportViewer1$ctl09$ctl04$ctl00", "ReportViewer1$ctl09$ctl05$ctl00",
    "ReportViewer1$ctl10$ctl04$ctl00", "ReportViewer1$ctl10$ctl05$ctl00", "ReportViewer1$ctl08$ctl04$ctl00",
  ];
  for (const doc of searchDocs) {
    const win = doc.defaultView;
    if (win && typeof win.__doPostBack === "function") {
      for (const ctlId of knownControlIds) {
        try {
          setStatus("changing_format: trying __doPostBack: " + ctlId);
          win.__doPostBack(ctlId, "EXCELOPENXML");
          return { _clicked: true };
        } catch (_) {}
      }
      break; 
    }
  }

  try {
    const baseUrl = new URL(location.href);
    for (const exportId of [1, 2, 3, 5, 7]) {
      const testUrl = new URL(baseUrl.href);
      testUrl.searchParams.set("qexport_id", String(exportId));
      testUrl.searchParams.set("qformat", "EXCELOPENXML");
      console.log("[ExcelExport] Trying export URL with qexport_id=" + exportId);
    }
    const exportUrl = new URL(baseUrl.href);
    exportUrl.searchParams.set("qexport_id", "1");
    setStatus("changing_format: trying direct URL export qexport_id=1");
    window.open(exportUrl.href, "_blank");
    return { _clicked: true };
  } catch (_) {}

  throw new Error("Excel export could not be triggered. Check browser console for [ExcelExport] diagnostic logs.");
}

async function clickElementInContext(el, win) {
  const w = win || window;

  try { el.scrollIntoView({ block: "center", behavior: "instant" }); } catch (_) {}
  await wait(200);

  try { el.click(); } catch (_) {}

  try {
    el.dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new w.MouseEvent("mouseup",   { bubbles: true, cancelable: true }));
    el.dispatchEvent(new w.MouseEvent("click",     { bubbles: true, cancelable: true }));
  } catch (_) {}

  const onclickAttr = el.getAttribute("onclick");
  if (onclickAttr) {
    try {
      const fn = new w.Function(onclickAttr);
      fn.call(el);
    } catch (_) {}
  }

  const href = el.getAttribute("href") || "";
  if (href.startsWith("javascript:")) {
    try {
      const code = href.slice("javascript:".length);
      const fn = new w.Function(code);
      fn.call(el);
    } catch (_) {}
  }
}


init().catch((error) => {
  console.error("Report generator content init failed.", error);
});

function showToast(message, type = "info", durationMs = 4000) {
  const existing = document.getElementById("reportgen-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "reportgen-toast";
  toast.textContent = message;

  const colors = {
    info:    "rgba(30, 100, 200, 0.95)",
    success: "rgba(20, 140, 60, 0.95)",
    error:   "rgba(180, 30, 30, 0.95)",
    warning: "rgba(200, 130, 0, 0.95)"
  };

  Object.assign(toast.style, {
    position:     "fixed",
    bottom:       "30px",
    right:        "30px",
    zIndex:       "2147483647",
    background:   colors[type] || colors.info,
    color:        "#fff",
    padding:      "14px 22px",
    borderRadius: "8px",
    fontSize:     "14px",
    fontFamily:   "sans-serif",
    boxShadow:    "0 4px 16px rgba(0,0,0,0.3)",
    maxWidth:     "360px",
    lineHeight:   "1.5",
    transition:   "opacity 0.4s ease"
  });

  document.documentElement.appendChild(toast);

  if (durationMs > 0) {
    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 400);
    }, durationMs);
  }

  return toast;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "AUTOMATE_ACCOUNT_SEARCH" && message.accountNumber) {
    showToast("Inside EVENT IF ", "info", 4000);
    automateAccountSearch(message.accountNumber, message.taskConfig || message);
    sendResponse({ status: "started" });
    return true; 
  }

  if (message?.type === "TOGGLE_DISCOVERY_MODE") {
    setStatus("In-page panel is disabled.");
    showToast("Inside EVENT Discovery", "info", 4000);
  }

  if (message?.type === "REFRESH_PANEL") {
    refreshFromStorage().catch((error) => setStatus(`Refresh failed: ${error.message}`));
  }

  if (message?.type === "CSV_DOWNLOAD_DETECTED") {
    runtime.lastCsvDownloadEvent = message.payload || null;
    setStatus("CSV download detected.");
  }

  if (message?.type === "RUN_QUICK_SEARCH") {
    runJob(message.button, { prefilled: Boolean(message.prefilled) });
  }

 
});

async function waitForDownloadWithJobRetry(jobId, timeoutMs, reportLabel = "Queued_Report") {
  const start = Date.now();
  let attempts = 0;

  while (Date.now() - start < timeoutMs) {
    attempts++;
    try {
      await sendRuntimeMessage({
        type: "START_JOB",
        jobId,
        meta: { label: `${reportLabel}_FinalSequence`, page: location.href }
      }).catch(() => {}); 

      const remaining = Math.max(15000, timeoutMs - (Date.now() - start));
      return await waitForCsvDownload(jobId, Math.min(remaining, 60000));
    } catch (err) {
      const msg = String(err.message || "");
      const isJobError = msg.includes("not active") || msg.includes("Job is not") || msg.includes("timed out");

      if (!isJobError || Date.now() - start >= timeoutMs) {
        throw err;
      }

      console.warn(`[FinalSequence] Download wait attempt ${attempts} failed (${msg}). Re-registering job and retrying...`);
      setStatus(`Final: retrying download wait (attempt ${attempts})...`);
      await wait(2000);
    }
  }

  throw new Error("Timed out waiting for Excel download after retries.");
}

async function cleanupCurrentJobRegistration() {
  if (!runtime.currentJobId) {
    return;
  }
  await sendRuntimeMessage({ type: "END_JOB", jobId: runtime.currentJobId }).catch(() => {});
  runtime.currentJobId = null;
}


// --- REQUIRED HELPERS FOR PHASE 1 ---

// Helper 1: Safely waits for an element to exist in the DOM
function waitForElement(selector, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(selector);
    if (existing) return resolve(existing);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout waiting for element: ${selector}`));
    }, timeout);
  });
}

// Helper 2: Simple sleep timer
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function init() {
  installNetworkProbe();
  removeLegacyPanel();
  startLegacyPanelCleanup();
  await refreshFromStorage();
  setState(MACHINE_STATES.IDLE, "Ready");
  // await continueReportQueueIfNeeded();

  const urlParams = new URLSearchParams(window.location.search);
  const autoSearchAcc = urlParams.get("autoSearchAcc");
  const botRoute = urlParams.get("botRoute") || "contract"; 
  const salesperson = urlParams.get("salesperson") || "";
  const co = urlParams.get("co") || "";
  const stockNo = urlParams.get("stockNo") || "";
  const date = urlParams.get("date") || "";

  if (autoSearchAcc) {
    // Clean the URL so it doesn't loop on refresh
    const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
    window.history.replaceState({path: cleanUrl}, '', cleanUrl);

    const taskConfig = {
      route: botRoute,
      stockNo: stockNo,
      salesperson: salesperson,
      accountNumber: autoSearchAcc,
      co: co,
      date: date
    };

    showToast(`n8n Triggered! Route: ${botRoute.toUpperCase()}`, "info", 6000);
    automateAccountSearch(autoSearchAcc, taskConfig);
  }
}

async function refreshFromStorage() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.WEBHOOK,
    STORAGE_KEYS.BUTTONS,
    STORAGE_KEYS.SELECTOR_CONFIG
  ]);

  runtime.config.webhookUrl = stored[STORAGE_KEYS.WEBHOOK] || "";
  runtime.config.buttons = stored[STORAGE_KEYS.BUTTONS] || [];
  runtime.config.selectorConfig = stored[STORAGE_KEYS.SELECTOR_CONFIG] || {};

  renderButtons();
}

function createPanel() {
  if (document.getElementById("reportgen-root")) {
    return;
  }

  runtime.root = document.createElement("div");
  runtime.root.id = "reportgen-root";

  runtime.panel = document.createElement("section");
  runtime.panel.className = "reportgen-panel";

  const header = document.createElement("header");
  header.className = "reportgen-header";

  const title = document.createElement("span");
  title.className = "reportgen-header-title";
  title.textContent = "Report Generator";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "reportgen-close";
  closeBtn.title = "Hide panel";
  closeBtn.textContent = "x";
  closeBtn.addEventListener("click", () => {
    setDiscoveryMode(false, true);
    hidePanel();
  });

  header.append(title, closeBtn);

  const body = document.createElement("div");
  body.className = "reportgen-body";

  runtime.statusEl = document.createElement("p");
  runtime.statusEl.className = "reportgen-status";
  runtime.statusEl.textContent = "Initializing...";

  runtime.buttonsWrap = document.createElement("div");
  runtime.buttonsWrap.className = "reportgen-buttons";

  const actions = document.createElement("div");
  actions.className = "reportgen-small-actions";

  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.textContent = "Refresh";
  refreshBtn.addEventListener("click", () => {
    refreshFromStorage().catch((error) => setStatus(`Refresh failed: ${error.message}`));
  });

  const discoverBtn = document.createElement("button");
  discoverBtn.type = "button";
  discoverBtn.textContent = "Close";
  discoverBtn.addEventListener("click", () => {
    setDiscoveryMode(false, true);
    hidePanel();
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", cancelCurrentJob);

  actions.append(refreshBtn, discoverBtn, cancelBtn);
  body.append(runtime.statusEl, runtime.buttonsWrap, actions);
  runtime.panel.append(header, body);
  runtime.root.appendChild(runtime.panel);
  document.documentElement.appendChild(runtime.root);
}

function renderButtons() {
  if (!runtime.buttonsWrap) {
    return;
  }

  runtime.buttonsWrap.innerHTML = "";

  if (!runtime.config.buttons.length) {
    const empty = document.createElement("p");
    empty.textContent = "No buttons configured in settings.";
    empty.style.margin = "0";
    runtime.buttonsWrap.appendChild(empty);
    return;
  }

  for (const button of runtime.config.buttons) {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "reportgen-action";
    action.disabled = runtime.busy;
    action.textContent = `${button.label} - ${button.searchText}`;
    action.addEventListener("click", () => runJob(button));
    runtime.buttonsWrap.appendChild(action);
  }
}

async function runJob(buttonConfig, options = {}) {
  if (runtime.busy) {
    return;
  }

  if (!buttonConfig?.searchText) {
    setStatus("Missing button search text.");
    return;
  }

  runtime.busy = true;
  runtime.cancelRequested = false;
  runtime.selectedResultElement = null;
  runtime.lastCsvDownloadEvent = null;
  runtime.directCsvFallbackDownload = null;
  runtime.currentJobId = createId();
  renderButtons();

  try {
    await sendRuntimeMessage({
      type: "START_JOB",
      jobId: runtime.currentJobId,
      meta: {
        label: buttonConfig.label,
        searchText: buttonConfig.searchText,
        page: location.href
      }
    });

    if (!options.prefilled) {
      await transition(MACHINE_STATES.TYPING_SEARCH, `Searching for \"${buttonConfig.searchText}\"`);
      await runPhaseWithRetry(MACHINE_STATES.TYPING_SEARCH, `Searching for "${buttonConfig.searchText}"`, () =>
        AutomationSteps.typeSearch(buttonConfig, runtime.config.selectorConfig)
      );
    } else {
      runtime.resultsSignatureBeforeSearch = "";
      setStatus(`typing_search: prefilled from popup for \"${buttonConfig.searchText}\"`);
    }

    await transition(MACHINE_STATES.EVALUATING_RESULTS, "Evaluating search results");
    await runPhaseWithRetry(MACHINE_STATES.EVALUATING_RESULTS, "Evaluating search results", () =>
      AutomationSteps.evaluateResults(buttonConfig, runtime.config.selectorConfig)
    );

    await transition(MACHINE_STATES.CLICKING_PLAY, "Opening report");
    await runPhaseWithRetry(MACHINE_STATES.CLICKING_PLAY, "Opening report", () =>
      AutomationSteps.clickPlay(buttonConfig, runtime.config.selectorConfig)
    );

    await transition(MACHINE_STATES.CLICKING_GENERATE, "Clicking Generate");
    await runPhaseWithRetry(MACHINE_STATES.CLICKING_GENERATE, "Clicking Generate", () =>
      AutomationSteps.clickGenerate(buttonConfig, runtime.config.selectorConfig)
    );

    await transition(MACHINE_STATES.CHANGING_FORMAT, "Switching output format to CSV");
    await runPhaseWithRetry(MACHINE_STATES.CHANGING_FORMAT, "Switching output format to CSV", () =>
      AutomationSteps.changeFormatToCsv(buttonConfig, runtime.config.selectorConfig)
    );

    await transition(MACHINE_STATES.CAPTURING_CSV, "Waiting for CSV capture");
    const csvResult = await runPhaseWithRetry(MACHINE_STATES.CAPTURING_CSV, "Waiting for CSV capture", () =>
      AutomationSteps.captureCsv(buttonConfig, runtime.config.selectorConfig),
    { timeoutMs: RETRY_SETTINGS.captureTimeoutMs }
    );

    await transition(MACHINE_STATES.POSTING_WEBHOOK, "Posting to webhook");
    await runPhaseWithRetry(MACHINE_STATES.POSTING_WEBHOOK, "Posting to webhook", () =>
      sendWebhook(buttonConfig, csvResult),
    { timeoutMs: RETRY_SETTINGS.webhookTimeoutMs }
    );

    await transition(MACHINE_STATES.DONE, "Done");
    showToast("🎉 All done! Report exported successfully.", "success", 6000); 
  } catch (error) {
    console.error("Automation failed.", error);
    if (runtime.cancelRequested) {
      setState(MACHINE_STATES.CANCELED, "Canceled by user");
      showToast("🚫 Job canceled by user.", "warning");
    } else {
      setState(MACHINE_STATES.ERROR, `Error: ${error.message}`);
      showToast(`❌ Automation failed: ${error.message}`, "error", 10000);
    }
  } finally {
    if (runtime.currentJobId) {
      await sendRuntimeMessage({ type: "END_JOB", jobId: runtime.currentJobId }).catch(() => {});
    }
    runtime.currentJobId = null;
    runtime.busy = false;
    renderButtons();
  }
}

async function sendWebhook(buttonConfig, csvResult) {
  const targetWebhookUrl = buttonConfig.webhookUrl || runtime.config.webhookUrl;

  if (!targetWebhookUrl) {
    throw new Error("Webhook URL is not set in extension settings or report config.");
  }

  const download = csvResult?.download || {};
  const label = (buttonConfig.label || "report").replace(/\s+/g, "_");

  let filename = download.filename || `${label}.xlsx`;
  if (!filename.includes(".")) {
    filename += download.fileType === "csv" ? ".csv" : ".xlsx";
  }

  const payload = {
    filename,
    fileType: download.fileType || "excel",
    fileBase64: download.fileBase64 || "",
    csv: download.csvText || "",
    sourceUrl: download.finalUrl || "",
    timestamp: new Date().toISOString()
  };

  const response = await sendRuntimeMessage({
    type: "POST_WEBHOOK",
    webhookUrl: targetWebhookUrl,
    payload
  });

  if (!response?.delivered) {
    throw new Error("Webhook was not delivered.");
  }
}

async function runPhaseWithRetry(nextState, detail, action, options = {}) {
  const timeoutMs = options.timeoutMs || RETRY_SETTINGS.defaultTimeoutMs;
  const retryDelayMs = options.retryDelayMs || RETRY_SETTINGS.delayMs;
  const start = Date.now();
  let attempt = 0;

  while (true) {
    ensureNotCanceled();
    attempt += 1;

    try {
      return await action();
    } catch (error) {
      if (runtime.cancelRequested) {
        throw error;
      }

      const elapsed = Date.now() - start;
      if (elapsed >= timeoutMs) {
        throw error;
      }

      const remaining = Math.max(0, timeoutMs - elapsed);
      const waitMs = Math.min(retryDelayMs, remaining);
      setStatus(`${nextState}: ${detail} failed on attempt ${attempt}. Retrying in ${Math.ceil(waitMs / 1000)}s`);
      await wait(waitMs);
    }
  }
}

async function transition(nextState, detail) {
  if (nextState !== MACHINE_STATES.CANCELED) {
    ensureNotCanceled();
  }
  runtime.state = nextState;
  setStatus(`${nextState}: ${detail}`);
}

function setState(nextState, detail) {
  runtime.state = nextState;
  setStatus(`${nextState}: ${detail}`);
}

function setStatus(text) {
  if (runtime.statusEl) {
    runtime.statusEl.textContent = text;
  }
  console.log("[Report Generator]", text);
}

function removeLegacyPanel() {
  const existing = document.getElementById("reportgen-root");
  if (existing) {
    existing.remove();
  }
  if (runtime.discoveryHandler) {
    document.removeEventListener("click", runtime.discoveryHandler, true);
    runtime.discoveryHandler = null;
  }
  runtime.root = null;
  runtime.panel = null;
  runtime.statusEl = null;
  runtime.buttonsWrap = null;
}

function startLegacyPanelCleanup() {
  if (window.__reportGenCleanupStarted) {
    return;
  }
  window.__reportGenCleanupStarted = true;

  const observer = new MutationObserver(() => {
    const existing = document.getElementById("reportgen-root");
    if (existing) {
      existing.remove();
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

function hidePanel() {
  // In-page panel is intentionally disabled.
}

function ensurePanelVisible() {
  // In-page panel is intentionally disabled.
}

async function cancelCurrentJob() {
  if (!runtime.busy) {
    setStatus("No active job.");
    return;
  }
  runtime.cancelRequested = true;
  closeResultPicker();
  setState(MACHINE_STATES.CANCELED, "Canceled by user");
}

function toggleDiscoveryMode() {
  setStatus("In-page discovery is disabled.");
}

function setDiscoveryMode(enabled, silent) {
  if (!runtime.panel) {
    runtime.discoveryMode = false;
    return;
  }

  runtime.discoveryMode = enabled;

  if (runtime.discoveryMode) {
    runtime.panel.classList.add("reportgen-discovery-active");
    runtime.discoveryHandler = onDiscoveryClick;
    document.addEventListener("click", runtime.discoveryHandler, true);
    if (!silent) {
      setStatus("Discovery ON. Hold Shift and click to capture.");
    }
    return;
  }

  runtime.panel.classList.remove("reportgen-discovery-active");
  if (runtime.discoveryHandler) {
    document.removeEventListener("click", runtime.discoveryHandler, true);
    runtime.discoveryHandler = null;
  }
  if (!silent) {
    setStatus("Discovery mode OFF.");
  }
}

async function onDiscoveryClick(event) {
  if (!runtime.discoveryMode) {
    return;
  }

  if (!runtime.root) {
    return;
  }

  if (!event.shiftKey) {
    setStatus("Discovery ON: Hold Shift and click element to capture.");
    return;
  }

  if (runtime.root.contains(event.target)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  const key = nextCaptureKey(runtime.config.selectorConfig);

  const candidates = buildSelectorCandidates(event.target);
  runtime.config.selectorConfig[key] = candidates;
  await chrome.storage.local.set({ [STORAGE_KEYS.SELECTOR_CONFIG]: runtime.config.selectorConfig });
  setStatus(`Saved selector: ${key}.`);
}

function nextCaptureKey(selectorConfig) {
  const preferredOrder = [
    "search_input",
    "search_submit",
    "results_container",
    "result_row",
    "result_play_button",
    "generate_button",
    "format_dropdown",
    "format_csv_option",
    "generation_complete_indicator"
  ];

  for (const key of preferredOrder) {
    if (!selectorConfig[key]) {
      return key;
    }
  }

  return `captured_${Date.now()}`;
}

function buildSelectorCandidates(element) {
  const selectors = [];

  if (element.id) {
    selectors.push(`#${cssEscape(element.id)}`);
  }

  for (const attr of ["name", "aria-label", "placeholder", "role", "data-testid"]) {
    const value = element.getAttribute(attr);
    if (value) {
      selectors.push(`${element.tagName.toLowerCase()}[${attr}=${JSON.stringify(value)}]`);
    }
  }

  const text = (element.textContent || "").trim();
  if (text && text.length <= 80) {
    selectors.push({ byText: text, tag: element.tagName.toLowerCase() });
  }

  selectors.push(buildDomPath(element));

  return {
    capturedAt: new Date().toISOString(),
    selectors
  };
}

function buildDomPath(element) {
  const parts = [];
  let node = element;

  while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
    const tag = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }

    const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
    const index = siblings.indexOf(node) + 1;
    const segment = siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag;
    parts.unshift(segment);
    node = parent;
  }

  return parts.join(" > ");
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) {
    return globalThis.CSS.escape(value);
  }
  return value.replace(/([#.:[\],=>+~*\"' ])/g, "\\$1");
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      reject(new Error("Extension messaging unavailable in this page context."));
      return;
    }

    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }

      if (!response?.ok) {
        reject(new Error(response?.error || "Runtime message failed."));
        return;
      }

      resolve(response.result);
    });
  });
}

function createId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// =====================================================================
// FILE EXTRACTION & WEBHOOK UPLOAD LOGIC
// =====================================================================

// 1. EXTRACTOR: For the Main "Files" Tab (Looks for 'contract')
async function extractAndPostContractFile(taskConfig) {
  try {
    showToast("Scanning for Contract document...", "info", 3000);
    let fileGuid = null;

    for (let i = 0; i < 60; i++) {
      const fileRows = document.querySelectorAll('.supportingFilesRowWrapper, tr.row_detail');
      for (const row of fileRows) {
        const descCell = row.querySelector('.supportingFileDescriptionColumn');
        // Looking for "contract"
        if (descCell && descCell.textContent.toLowerCase().includes('contract')) {
          const guidInput = row.querySelector('input#txtEFile_GUID, input[name*="eFileGuid"]');
          if (guidInput && guidInput.value) {
            fileGuid = guidInput.value;
          } else {
            const viewBtn = row.querySelector('input[value="View" i], .btn[value="View" i]');
            if (viewBtn && viewBtn.getAttribute("onclick")) {
              const match = viewBtn.getAttribute("onclick").match(/'([a-f0-9\-]{36})'/i);
              if (match) fileGuid = match[1];
            }
          }
          break;
        }
      }
      if (fileGuid) break;
      await wait(500);
    }

    if (!fileGuid) throw new Error("Could not find any file named 'contract' in the list.");
    
    // Pass to uploader with the specific Contract webhook
    await fetchPdfAndPostToWebhook(fileGuid, taskConfig, "https://n8n.srv1669099.hstgr.cloud/webhook/contract-file", "Contract.pdf");

  } catch (e) {
    showToast(e.message, "error", 5000);
    await sendErrorToN8n(e.message, taskConfig, "https://n8n.srv1669099.hstgr.cloud/webhook/contract-file");
  }
}

// 2. EXTRACTOR: For the Collateral "Files" Sub-Tab (Hunts for 'emission')
async function extractAndPostCollateralFile(taskConfig) {
  try {
    showToast("Scanning for Emission document...", "info", 3000);
    let fileGuid = null;

    for (let i = 0; i < 60; i++) {
      const fileRows = document.querySelectorAll('.supportingFilesRowWrapper, tr.row_detail');
      
      // Loop through all rows instead of just grabbing fileRows[0]
      for (const row of fileRows) {
        const descCell = row.querySelector('.supportingFileDescriptionColumn');
        
        // Looking for "emission"
        // if (descCell && descCell.textContent.toLowerCase().includes('emission')) 
          if (descCell && (descCell.textContent.toLowerCase().includes('emission') || descCell.textContent.toLowerCase().includes('emmission') || descCell.textContent.toLowerCase().includes('coi'))){
          const guidInput = row.querySelector('input#txtEFile_GUID, input[name*="eFileGuid"]');
          if (guidInput && guidInput.value) {
            fileGuid = guidInput.value;
          } else {
            const viewBtn = row.querySelector('input[value="View" i], .btn[value="View" i]');
            if (viewBtn && viewBtn.getAttribute("onclick")) {
              const match = viewBtn.getAttribute("onclick").match(/'([a-f0-9\-]{36})'/i);
              if (match) fileGuid = match[1];
            }
          }
          break; // Stop looking once we find the emission file
        }
      }
      if (fileGuid) break; // Break the outer wait loop
      await wait(500);
    }

    if (!fileGuid) throw new Error("Could not find any file named 'emission' in the Collateral list.");
    
    // Pass to uploader with the specific Collateral webhook
    await fetchPdfAndPostToWebhook(fileGuid, taskConfig, "https://n8n.srv1669099.hstgr.cloud/webhook/collateral-file", "Emission.pdf");

  } catch (e) {
    showToast(e.message, "error", 5000);
    await sendErrorToN8n(e.message, taskConfig, "https://n8n.srv1669099.hstgr.cloud/webhook/collateral-file");
  }
}


async function fetchPdfAndPostToWebhook(fileGuid, taskConfig, defaultWebhookUrl, fileName) {
  try {
    showToast("📥 Processing file...", "info", 4000);
    const pdfUrl = `${window.location.origin}/pages/ecabinet/_ecabinet_pdffile.aspx?qefile_guid=${fileGuid}`;
    const targetWebhook = taskConfig.webhookUrl || defaultWebhookUrl;

    // Tell the background script to fetch it, send it, and save it.
    const response = await sendRuntimeMessage({
      type: "UPLOAD_LARGE_FILE_FROM_URL",
      pdfUrl: pdfUrl,
      webhookUrl: targetWebhook,
      taskConfig: taskConfig,
      fileName: fileName
    });

    if (response && response.delivered) {
      showToast("✅ File saved to computer AND sent to n8n!", "success", 4000);
      await wait(2000);
      await sendRuntimeMessage({ type: "CLOSE_CURRENT_TAB" });
    } else {
      throw new Error("Failed to process file.");
      await sendRuntimeMessage({ type: "CLOSE_CURRENT_TAB" });
    }

  } catch (e) {
    showToast("Upload to n8n failed: " + e.message, "error", 6000);
    await sendErrorToN8n(e.message, taskConfig, defaultWebhookUrl);
    await sendRuntimeMessage({ type: "CLOSE_CURRENT_TAB" });
  }
}

async function sendErrorToN8n(errorMessage, taskConfig, defaultWebhookUrl) {
  try {
    const targetWebhook = taskConfig.webhookUrl || defaultWebhookUrl;
    await sendRuntimeMessage({
      type: "POST_WEBHOOK",
      webhookUrl: targetWebhook,
      payload: {
        ...taskConfig,
        error: true,
        errorMessage: errorMessage,
        timestamp: new Date().toISOString()
      }
    });
    await wait(3000);
    await sendRuntimeMessage({ type: "CLOSE_CURRENT_TAB" });
  } catch(e) {
    console.error("Failed to send error state back to n8n.");
    await sendRuntimeMessage({ type: "CLOSE_CURRENT_TAB" });
  } finally {
    // THIS GUARANTEES THE LOCK BREAKS EVEN IF N8N IS DOWN
    await sendRuntimeMessage({ type: "RELEASE_LOCK" }).catch(()=>{});
    await wait(2000);
    await sendRuntimeMessage({ type: "CLOSE_CURRENT_TAB" }).catch(()=>{});
  }
}


// HELPER: Scrolls down to the tab bar and clicks the right arrow until the tab is revealed
async function findAndRevealTab(tabSelector) {
  for (let i = 0; i < 60; i++) { // 30 second timeout
    const tab = document.querySelector(tabSelector);
    
    if (tab) {
      // 1. Scroll the container into view so the UI is on screen
      const container = tab.closest('.tabScroller');
      if (container) {
         try { container.scrollIntoView({ block: "center", behavior: "instant" }); } catch(e){}
      }

      // 2. Check if the tab is actually visible yet
      if (isVisible(tab)) {
        return tab; // Found it and it's visible! We can click it.
      }

      // 3. It exists in the HTML, but DealerSocket has it hidden. Click the right arrow to cycle the tabs!
      const rightArrow = document.querySelector(".moveTabsRight:not(.disabled)");
      if (rightArrow) {
         rightArrow.click();
      }
    }
    await wait(500); // Wait half a second for the UI to slide and check again
  }
  return null;
}

async function automateInventoryMileage(accountNumber, taskConfig = {}) {
  const stockNo = String(taskConfig.stockNo || taskConfig.stockNumber || accountNumber || "").trim();

  async function finishInventoryMileage(mileage = "", extraDataOrError = {}, maybeErrorMessage = "") {
    const hasExtraData = extraDataOrError && typeof extraDataOrError === "object" && !Array.isArray(extraDataOrError);
    const extraData = hasExtraData ? extraDataOrError : {};
    const errorMessage = hasExtraData ? maybeErrorMessage : String(extraDataOrError || maybeErrorMessage || "");

    if (errorMessage) {
      console.warn("[Inventory Mileage]", errorMessage);
    }

    await sendRuntimeMessage({
      type: "INVENTORY_MILEAGE_DONE",
      mileage,
      extraData,
      errorMessage,
      taskConfig: {
        ...taskConfig,
        stockNo
      }
    }).catch((err) => {
      console.error("[Inventory Mileage] Failed to notify background:", err);
    });

    await wait(1500);
    await sendRuntimeMessage({ type: "CLOSE_CURRENT_TAB" }).catch(() => {});
  }

  function cleanInventoryValue(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isUsefulInventoryValue(value) {
    const cleaned = cleanInventoryValue(value);
    return cleaned && cleaned !== "-1" && !/^\[custom/i.test(cleaned) && !cleaned.endsWith(":");
  }

  function extractInventoryCardValue(labelText) {
    const wantedLabel = cleanInventoryValue(labelText).toLowerCase();
    const labels = Array.from(document.querySelectorAll(".cardFieldName"));

    for (const label of labels) {
      if (cleanInventoryValue(label.textContent).toLowerCase() !== wantedLabel) {
        continue;
      }

      const row = label.closest("div");
      const valueEl = row?.querySelector(".cardFieldValue b, .cardFieldValue");
      const value = cleanInventoryValue(valueEl?.textContent);
      if (isUsefulInventoryValue(value)) {
        return value;
      }
    }

    return "";
  }

  function extractInputValueByTitle(labelText) {
    const wantedLabel = cleanInventoryValue(labelText).toLowerCase();
    const wrappers = Array.from(document.querySelectorAll(".inputWrapper"));

    for (const wrapper of wrappers) {
      const title = wrapper.querySelector(".inputWrapperTitle");
      if (cleanInventoryValue(title?.textContent).toLowerCase() !== wantedLabel) {
        continue;
      }

      const input = wrapper.querySelector("input");
      if (input && isUsefulInventoryValue(input.value)) {
        return cleanInventoryValue(input.value);
      }

      const select = wrapper.querySelector("select");
      const selectedOpt = select?.options?.[select.selectedIndex];
      if (selectedOpt && isUsefulInventoryValue(selectedOpt.value) && isUsefulInventoryValue(selectedOpt.text)) {
        return cleanInventoryValue(selectedOpt.text);
      }
    }

    return "";
  }

  try {
    showToast("Inventory Page Reached! Waiting for loaders...", "warning", 3000);

    if (!stockNo) {
      showToast("No stock number found. Keeping original mileage.", "warning", 4000);
      await finishInventoryMileage("", "Inventory mileage skipped: missing stock number.");
      return;
    }

    for (let w = 0; w < 15; w++) {
      if (!isLoadingIndicatorVisible()) break;
      await wait(1000);
    }
    await wait(1500);

    showToast("Typing Stock Number...", "info", 2000);
    let searchInput = null;
    const searchSelectors = [
      "input[placeholder*='Search' i]",
      "input[id*='Search' i]",
      "input[id*='Keyword' i]",
      "input[name*='Search' i]",
      "input[name*='Keyword' i]"
    ];

    for (let i = 0; i < 20; i++) {
      searchInput = searchSelectors
        .map((selector) => document.querySelector(selector))
        .find((el) => el && isVisible(el));
      if (searchInput) break;
      await wait(500);
    }

    if (!searchInput) {
      showToast("Could not find the inventory search box. Keeping original mileage.", "warning", 5000);
      await finishInventoryMileage("", "Inventory mileage skipped: search box not found.");
      return;
    }

    safeType(searchInput, stockNo);

    showToast("Unchecking all statuses...", "info", 2000);
    try {
      const invStatusCheckboxes = document.querySelectorAll('input[id^="Status"][type="checkbox"]');

      invStatusCheckboxes.forEach(cb => {
        if (cb.checked) {
          cb.checked = false;
          cb.removeAttribute('checked');
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });

      const hiddenStatusInput = document.getElementById("Status");
      if (hiddenStatusInput) {
        hiddenStatusInput.value = "";
        hiddenStatusInput.dispatchEvent(new Event('change', { bubbles: true }));
      }

      const displayStatusInput = document.getElementById("StatusDisplay");
      if (displayStatusInput) {
        displayStatusInput.value = "";
      }
    } catch (err) {
      console.warn("Could not uncheck inventory statuses:", err);
    }

    await wait(1000);
    showToast("Searching for vehicle...", "info", 2000);
    const searchBtn = Array.from(document.querySelectorAll("button, a, input[type='button'], input[type='submit']")).find(el => {
      if (!isVisible(el)) return false;
      const label = (el.textContent || el.value || "").trim().toLowerCase();
      const id = (el.id || "").toLowerCase();
      return label === "search" || id.includes("btnsearch");
    });

    if (searchBtn) {
      safeClick(searchBtn);
    } else {
      dispatchEnter(searchInput);
    }

    await wait(1500);
    for (let w = 0; w < 15; w++) {
      if (!isLoadingIndicatorVisible()) break;
      await wait(1000);
    }
    await wait(2000);

    showToast("Extracting Mileage...", "info", 3000);
    let finalMileage = "";
    const stockNeedle = normalizeText(stockNo);
    const rows = Array.from(document.querySelectorAll("tr"));
    const targetRow = rows.find((tr) => normalizeText(tr.innerText).includes(stockNeedle));

    if (targetRow) {
      const table = targetRow.closest("table") || document;
      const headers = Array.from(table.querySelectorAll("th")).map(th => normalizeText(th.innerText));
      const mileageIndex = headers.findIndex(h => h.includes("mileage") || h.includes("odometer"));
      const tds = targetRow.querySelectorAll("td");

      if (mileageIndex !== -1 && tds.length > mileageIndex) {
        finalMileage = tds[mileageIndex].innerText.trim();
      } else if (tds.length >= 12) {
        finalMileage = tds[11].innerText.trim();
      }
    }

    if (finalMileage) {
      showToast(`Mileage grabbed: ${finalMileage}`, "success", 4000);
    } else {
      showToast("Could not find Mileage. Keeping original.", "warning", 4000);
    }

    let extractedFuel = "";
    let extractedBodyStyle = "";

    if (targetRow) {
      showToast("Opening vehicle record...", "info", 2000);
      safeClick(targetRow);
      try { targetRow.click(); } catch (e) {}

      await wait(2000);
      for (let w = 0; w < 15; w++) {
        if (!isLoadingIndicatorVisible()) break;
        await wait(1000);
      }
      await wait(1500);

      extractedBodyStyle = extractInventoryCardValue("Body Style:");

      const vehicleTab = await findAndRevealTab("span#Vehicle");
      if (vehicleTab) {
        showToast("Clicking Vehicle tab...", "info", 2000);
        safeClick(vehicleTab);
        try { vehicleTab.click(); } catch (e) {}

        await wait(1500);
        for (let w = 0; w < 15; w++) {
          if (!isLoadingIndicatorVisible()) break;
          await wait(1000);
        }
        await wait(1500);

        showToast("Extracting Fuel and Body Style...", "info", 3000);

        const fuelInput = document.getElementById("txtFuelType");
        if (fuelInput && isUsefulInventoryValue(fuelInput.value)) {
          extractedFuel = cleanInventoryValue(fuelInput.value);
        }

        if (!extractedFuel) {
          extractedFuel = extractInputValueByTitle("Fuel:");
        }

        const fuelSelect = document.getElementById("ddlFuelType");
        if (!extractedFuel && fuelSelect) {
          const selectedOpt = fuelSelect.options[fuelSelect.selectedIndex];
          if (selectedOpt && isUsefulInventoryValue(selectedOpt.value) && isUsefulInventoryValue(selectedOpt.text)) {
            extractedFuel = cleanInventoryValue(selectedOpt.text);
          }
        }

        if (!extractedBodyStyle) {
          extractedBodyStyle = extractInventoryCardValue("Body Style:");
        }

        showToast(`Fuel: ${extractedFuel || "Not found"} | Style: ${extractedBodyStyle || "Not found"}`, "success", 4000);
      } else {
        showToast("Could not find Vehicle tab.", "error", 3000);
      }
    }

    await finishInventoryMileage(finalMileage, { fuel: extractedFuel, bodyStyle: extractedBodyStyle });
  } catch (err) {
    showToast("Inventory mileage failed. Keeping original.", "warning", 5000);
    await finishInventoryMileage("", {}, `Inventory mileage failed: ${err.message}`);
  }
}

async function automateAccountSearch(accountNumber, taskConfig = {}) {
  try {
    const targetRoute = (taskConfig.route || "contract").toLowerCase();
    if (targetRoute === "inventory_mileage") {
      await automateInventoryMileage(accountNumber, taskConfig);
      return;
      
      // 🛑 LOADER GATE
// 2. Uncheck all Statuses (Direct DOM Injection)
      if (false) {
      // 🛑 LOADER GATE (Wait for table to refresh with results)
          showToast(`✅ Mileage grabbed: ${finalMileage}`, "success", 4000);
          showToast("⚠️ Could not find Mileage. Keeping original.", "warning", 4000);
      }

      // 5. Send the mileage back to Background.js to update the payload!
    }



    showToast("Waiting for search box to load...", "info", 3000);

    // 1. Smart Polling: Explicitly target the INPUT tag
    let searchInput = null;
    for (let i = 0; i < 20; i++) {
      searchInput = document.querySelector('input#SpecialSearch, input[name="SpecialSearch"]');
      if (searchInput && isVisible(searchInput)) break;
      await wait(500); 
    }

    if (!searchInput) {
      showToast("Search input 'SpecialSearch' not found!", "error", 4000);
      await sendErrorToN8n("Search input 'SpecialSearch' not found on the page.", taskConfig, "https://n8n.srv1669099.hstgr.cloud/webhook/contract-file");
      return;
    }

    showToast("Filling account number...", "info", 2500);

    // 2. Aggressive Value Injection
    searchInput.focus();
    searchInput.value = accountNumber;
    searchInput.setAttribute("value", accountNumber);

    try {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (nativeSetter) nativeSetter.call(searchInput, accountNumber);
    } catch (e) {}

    // Blast events to wake up the CRM
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    searchInput.dispatchEvent(new Event("change", { bubbles: true }));
    searchInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", keyCode: 13 }));
    searchInput.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", keyCode: 13 }));
    searchInput.dispatchEvent(new Event("blur", { bubbles: true }));

    safeType(searchInput, accountNumber);
    showToast("Account number filled!", "success", 2000);
    await wait(800); 

    // ---------------------------------------------------------
    // SMART STATUS CHECKBOXES (Conditional based on route)
    // ---------------------------------------------------------
    try {
      const statusCheckboxes = document.querySelectorAll('input[id^="AccountStatus"][type="checkbox"]');
      let allValues = [];

      if (taskConfig.route === "vin") {
        showToast("VIN Search: Unchecking ALL Account Statuses...", "warning", 2000);
        statusCheckboxes.forEach(cb => {
          if (cb.checked) {
            cb.checked = false;
            cb.removeAttribute('checked');
            cb.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });

        const hiddenStatusInput = document.getElementById("AccountStatus");
        if (hiddenStatusInput) {
          hiddenStatusInput.value = ""; 
          hiddenStatusInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const displayStatusInput = document.getElementById("AccountStatusDisplay");
        if (displayStatusInput) displayStatusInput.value = "None Selected (Auto)";

      } else {
        showToast("Ensuring ALL Account Statuses are selected...", "info", 2000);
        statusCheckboxes.forEach(cb => {
          allValues.push(cb.value);
          if (!cb.checked) {
            cb.checked = true;
            cb.setAttribute('checked', 'checked');
            cb.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
        const hiddenStatusInput = document.getElementById("AccountStatus");
        if (hiddenStatusInput && allValues.length > 0) {
          hiddenStatusInput.value = allValues.join(",");
          hiddenStatusInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const displayStatusInput = document.getElementById("AccountStatusDisplay");
        if (displayStatusInput) displayStatusInput.value = "All Statuses (Auto-Selected)";
      }
      await wait(500);
    } catch (err) {
      console.warn("Could not modify account statuses:", err);
    }
    
    await wait(800); 
    showToast("Clicking search button...", "info", 2000);

    // 3. Robust button detection
    let searchBtn = document.querySelector(".fa-search, .icon-search, button[title*='Search' i], button[aria-label*='Search' i]");

    if (!searchBtn) {
      searchBtn = Array.from(document.querySelectorAll('button, a, img, svg')).find(el => {
        if (!isVisible(el)) return false;
        const style = getComputedStyle(el);
        const bg = style.backgroundColor || "";
        const color = style.color || "";
        return (bg.includes('128') && bg.includes('0')) || 
               (color.includes('128') && color.includes('0')) ||
               el.className.toLowerCase().includes('search');
      });
    }

    // 4. Execution
    if (searchBtn) {
      const clickableTarget = searchBtn.closest('button, a') || searchBtn;
      safeClick(clickableTarget); 
      showToast("Search triggered! Waiting for results...", "info", 3000);
    } else {
      showToast("Search button not found. Triggering Enter...", "warning", 3000);
      dispatchEnter(searchInput); 
      triggerInputBoundSearch(searchInput);
    }
    // ---------------------------------------------------------
    // 5. Wait for the result rows OR direct dashboard to appear
    // ---------------------------------------------------------
    let foundRows = [];
    let isDirectDashboard = false;

    for (let i = 0; i < 60; i++) { // 30 second timeout
      let dashElement = document.querySelector('[data-e2e="borrowerFullName"], [data-e2e="vin"]');
      if (dashElement && isVisible(dashElement)) {
        isDirectDashboard = true;
        break;
      }

      // Collect all potential rows
      let candidateRows = [];
      const trs = document.querySelectorAll("tr#row_detail, tr.row_detail, .row_detail");
      if (trs.length > 0) {
        candidateRows = Array.from(trs);
      } else {
        const allTrs = document.querySelectorAll("tr");
        for (const tr of allTrs) {
          if (tr.innerText.includes("Take Action") || tr.innerText.includes("View Notes")) {
            candidateRows.push(tr);
          }
        }
      }

      // Check if the first found row is visible
      if (candidateRows.length > 0 && isVisible(candidateRows[0])) {
        // Give the table 1 extra second to fully populate all rows
        await wait(1000);

        // Re-query to get the complete list of rows
        const finalTrs = document.querySelectorAll("tr#row_detail, tr.row_detail, .row_detail");
        if (finalTrs.length > 0) {
          foundRows = Array.from(finalTrs);
        } else {
          foundRows = Array.from(document.querySelectorAll("tr")).filter(tr => tr.innerText.includes("Take Action") || tr.innerText.includes("View Notes"));
        }
        break;
      }

      await wait(500);
    }

    if (foundRows.length === 0 && !isDirectDashboard) {
      showToast("Search completed, but no account record appeared within 30 seconds.", "error", 5000);
      await sendErrorToN8n("Account search yielded no results", taskConfig, "https://n8n.srv1669099.hstgr.cloud/webhook/contract-file");
      return;
    }

    let resultRow = null;

    if (!isDirectDashboard && foundRows.length > 0) {
      showToast(`Found ${foundRows.length} accounts. Selecting highest priority...`, "info", 3000);

      // --- SMART PRIORITY ENGINE ---
      let parsedRows = [];

      foundRows.forEach(row => {
        let statusText = "";
        let timestamp = 0;

        // Try to get status from the 4th column (index 3)
        const tds = row.querySelectorAll("td");
        if (tds.length >= 6) {
          statusText = tds[3].innerText.trim().toLowerCase();
        } else {
          statusText = row.innerText.toLowerCase(); // Fallback to scanning the whole row
        }

        // Try to get timestamp for tie-breaking
        const dateMatch = row.innerText.match(/(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s+[AP]M)/i);
        if (dateMatch) {
          timestamp = new Date(dateMatch[1]).getTime();
        }

        // Apply Priority Logic
        let priority = 5; // Default (Worst)
        if (statusText.includes('active')) priority = 1;
        else if (statusText.includes('charge off') || statusText.includes('charged off')) priority = 2;
        else if (statusText.includes('closed')) priority = 3;
        else if (statusText.includes('delete')) priority = 4;

        parsedRows.push({
          element: row,
          priority: priority,
          timestamp: timestamp
        });
      });

      // Sort: Lowest Priority Number first, then Newest Timestamp first
      parsedRows.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return b.timestamp - a.timestamp;
      });

      // Set the absolute best row to be clicked!
      resultRow = parsedRows[0].element;
    }

   
    // ==========================================
    // PATH C: THE VIN ROUTE (Decision Engine)
    // ==========================================
    if (targetRoute === "vin") {
      if (isDirectDashboard) {
         showToast("VIN search went directly to a single account. Treating as Case 1.", "warning", 5000);
         await wait(1500);
         await sendRuntimeMessage({ type: "CLOSE_CURRENT_TAB" }).catch(()=>{});
         return; 
      }
      
      showToast("VIN Search Complete! Analyzing accounts...", "info", 4000);
      await wait(1500); 
      
      const allRows = document.querySelectorAll("tr");
      let accountData = [];

      allRows.forEach(row => {
        const rowText = row.innerText;
        const dateMatch = rowText.match(/(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s+[AP]M)/i);
        const tds = row.querySelectorAll("td");
        
        if (tds.length >= 6 && dateMatch) {
           const acctText = tds[1].innerText.trim().split('\n')[0]; 
           const statusText = tds[3].innerText.trim().toLowerCase(); 
           const dateText = dateMatch[1];
           const timestamp = new Date(dateText).getTime();

           if (!isNaN(timestamp) && acctText) {
               accountData.push({ accountNumber: acctText, status: statusText, timestamp: timestamp });
           }
        }
      });

      if (accountData.length === 0) {
         showToast("No valid accounts found.", "error", 5000);
         await wait(1500);
         await sendRuntimeMessage({ type: "CLOSE_CURRENT_TAB" }).catch(()=>{});
         return;
      }

      accountData.sort((a, b) => b.timestamp - a.timestamp);
      
      const latest = accountData[0];
      const isLatestActive = latest.status.includes('active');

      // CASE 1: 1 Account & Active (SKIP)
      if (accountData.length === 1 && isLatestActive) {
          showToast("CASE 1: Single account is Active. Skipping.", "warning", 5000);
          await wait(1500);
          await sendRuntimeMessage({ type: "CLOSE_CURRENT_TAB" }).catch(()=>{});
          return;
      }

      // CASES 2 & 3: Top Account is NOT Active
      if (!isLatestActive) {
          showToast("CASES 2/3: Top account not Active. Extracting Seller only...", "info", 4000);
          await wait(2000);
          await sendRuntimeMessage({
             type: "START_VIN_SELLER_ONLY",
             sellerAcc: latest.accountNumber,
             taskConfig: taskConfig
          });
         await wait(1500);
         await sendRuntimeMessage({ type: "CLOSE_CURRENT_TAB" }).catch(()=>{});
          return;
      }

      // CASE 4: 2+ Accounts & Top is Active
      if (isLatestActive && accountData.length >= 2) {
          const buyer = accountData[0];
          const seller = accountData[1];
          showToast(`CASE 4: Buyer: ${buyer.accountNumber} | Seller: ${seller.accountNumber}`, "success", 4000);
          await wait(2000);
          await sendRuntimeMessage({
             type: "START_VIN_EXTRACTION",
             buyerAcc: buyer.accountNumber,
             sellerAcc: seller.accountNumber,
             taskConfig: taskConfig
          });
         await wait(1500);
         await sendRuntimeMessage({ type: "CLOSE_CURRENT_TAB" }).catch(()=>{});
          return;
      }
      return; // End VIN Route completely
    }
    // ==========================================
    // ROW CLICKER (For vinbuyer, vinseller, contract, collateral)
    // ==========================================
    if (resultRow && !isDirectDashboard) {
      showToast("Account record found! Opening now...", "success", 3000);
      safeClick(resultRow);
      try { resultRow.click(); } catch(e){} 
      await wait(4000); 
    }
    showToast("Waiting for Account tabs to load...", "info", 3000);
    // ==========================================
    // PATH D: BUYER DATA EXTRACTION (CASE 4 ONLY)
    // ==========================================
   if (targetRoute === "vinbuyer") {
      showToast("Waiting for Buyer Dashboard to load...", "info", 4000);
      const isDashboardLoaded = await waitForElement('[data-e2e="borrowerFullName"], [data-e2e="add1"]', 15000).catch(() => null);
      
      if (!isDashboardLoaded) {
          showToast("Failed to load Buyer Dashboard", "error", 5000);
          await sendRuntimeMessage({ type: "CLOSE_CURRENT_TAB" });
          return;
      }

      showToast("Extracting Buyer Data...", "success", 3000);
      await wait(1000);

      let bData = {};
      bData.buyerName = document.querySelector('[data-e2e="borrowerFullName"]')?.textContent.trim() || "";
      bData.streetAddress = document.querySelector('[data-e2e="add1"]')?.textContent.trim() || "";
      
      let csz = document.querySelector('[data-e2e="csz"]')?.textContent.trim() || "";
      if (csz.includes(",")) {
          let parts = csz.split(",");
          bData.city = parts[0].trim();
          let stateZip = parts[1].trim().replace(/\s+/g, " ").split(" ");
          bData.state = stateZip[0] || "";
          bData.zip = stateZip[1] || "";
      }

      let balancesTab = await findAndRevealTab("span#Balances");
      if (balancesTab) {
         safeClick(balancesTab);
         try { balancesTab.click(); } catch(e) {}
         for(let i=0; i<20; i++){
             let contractDateEl = document.querySelector("#lblContractDate");
             if(contractDateEl && isVisible(contractDateEl)){
                 bData.saleDate = contractDateEl.textContent.trim();
                 break;
             }
             await wait(500);
         }
      }

      let collateralTab = await findAndRevealTab("span#Collateral");
      if (collateralTab) {
         safeClick(collateralTab);
         try { collateralTab.click(); } catch(e) {}
         for(let i=0; i<20; i++){
             let vehTab = document.getElementById("tab_supportingfiles__account_collateral_vehicle");
             if(vehTab && isVisible(vehTab)){
                 safeClick(vehTab);
                 try { vehTab.click(); } catch(e) {}
                 break;
             }
             await wait(500);
         }
         for(let i=0; i<20; i++){
             let odoEl = document.querySelector("#_inventory_detail_control1_txtMileage");
             if(odoEl && isVisible(odoEl)){
                 bData.odometer = odoEl.value || "";
                 break;
             }
             await wait(500);
         }
      }

      showToast("Buyer Extracted! Moving to Seller...", "success", 3000);
      await sendRuntimeMessage({ type: "VIN_BUYER_DONE", buyerData: bData });
      await wait(1000);
      await sendRuntimeMessage({ type: "CLOSE_CURRENT_TAB" });
      return;

    // ==========================================
    // PATH E: SELLER DATA EXTRACTION
    // ==========================================
    } else if (targetRoute === "vinseller") {
      showToast("Waiting for Seller Dashboard to load...", "info", 4000);
      const isDashboardLoaded = await waitForElement('[data-e2e="vin"], [data-e2e="lenderDescription"]', 15000).catch(() => null);
      
      if (!isDashboardLoaded) {
          showToast("Failed to load Seller Dashboard", "error", 5000);
          await sendRuntimeMessage({ type: "CLOSE_CURRENT_TAB" });
          return;
      }

      // 🛑 LOADER GATE 1: Wait for the main dashboard to finish fetching
      showToast("Waiting for loaders to finish...", "warning", 3000);
      for(let w = 0; w < 15; w++) {
          if (!isLoadingIndicatorVisible()) break;
          await wait(1000);
      }
      await wait(1000); // Give the DOM 1 second to settle

      showToast("Extracting Seller Data...", "success", 3000);

      let sData = {};
      sData.vin = document.querySelector('[data-e2e="vin"]')?.textContent.trim() || "";
      sData.lenderRaw = document.querySelector('[data-e2e="lenderDescription"]')?.textContent.trim() || "";
      
      let yearMake = document.querySelector('[data-e2e="yearMakeMode"]')?.textContent.trim() || "";
      let ymParts = yearMake.split(" ");
      sData.year = ymParts[0] || "";
      sData.make = ymParts[1] || ""; 
      sData.model = ymParts[2] || "";
      
      // Grab the fallback name instantly just in case
      let fallbackName = document.querySelector('[data-e2e="borrowerFullName"]')?.textContent.trim() || "";
      sData.registeredOwner = fallbackName; 

      let collateralTab = await findAndRevealTab("span#Collateral");
      if (collateralTab) {
         safeClick(collateralTab);
         try { collateralTab.click(); } catch(e) {}
         
         // 🛑 LOADER GATE 2: Wait for the Collateral tab to fetch its data!
         await wait(1000); // Give loader a second to appear
         for(let w = 0; w < 15; w++) {
             if (!isLoadingIndicatorVisible()) break;
             await wait(1000);
         }
         await wait(1000); // Settle DOM
         
         // Look for the Vehicle sub-tab if it exists
         for(let i=0; i<10; i++){
             let vehTab = document.getElementById("tab_supportingfiles__account_collateral_vehicle");
             if(vehTab && isVisible(vehTab)){
                 safeClick(vehTab);
                 try { vehTab.click(); } catch(e) {}
                 await wait(1000); // Give it a second after clicking
                 break;
             }
             await wait(500);
         }

         // Now scan for Notes!
         for(let i=0; i<20; i++){
             // Using a broader selector: looks for ANY textarea with 'txtNotes' in the ID
             let ownerEl = document.querySelector("textarea[id*='txtNotes']");
             
             if(ownerEl){
                 let notesText = (ownerEl.value || ownerEl.textContent || "").trim();
                 
                 // If notes exist and do NOT contain a line break, overwrite the fallback
                 if (notesText !== "" && !notesText.includes("\n")) {
                     sData.registeredOwner = notesText;
                 }
                 break; // Found the box, stop the timer
             }
             await wait(500);
         }
      }

      let transTab = await findAndRevealTab("span#Transactions");
      if (transTab) {
         safeClick(transTab);
         try { transTab.click(); } catch(e) {}
         
         // 🛑 LOADER GATE 3: Wait for Transactions tab to fetch
         await wait(1000); 
         for(let w = 0; w < 15; w++) {
             if (!isLoadingIndicatorVisible()) break;
             await wait(1000);
         }
         await wait(1000);

         for(let i=0; i<40; i++){
             let firstTransRow = document.querySelector("tr.transactionRowOverview");
             if(firstTransRow){
                 let tds = firstTransRow.querySelectorAll("td");
                 if(tds.length >= 2){
                     let dateHtml = tds[1].innerHTML.split('<br>')[0];
                     let cleanDateTime = dateHtml.replace(/<[^>]*>?/gm, '').trim();
                     sData.repossessionDate = cleanDateTime.split(' ')[0];
                 }
                 break; 
             }
             await wait(500);
         }
      }

      // GLOBAL LLC DATA CALCULATOR
      let gData = {
         lienholderAgentName: "Jazmin Aguilar",
         sellerLienholderCompany: "America Financial LLC", 
         sellerAddress: "3911 W indian School Rd",
         sellerCity: "Phoenix",
         sellerZip: "85019",
         buyerCompanyName: "Titan Auto Group",
         buyerCompanyStreet: "3911 W indian School Rd",
         buyerCompanyCity: "Phoenix",
         buyerCompanyZip: "85019"
      };

      const lenderLower = sData.lenderRaw.toLowerCase();
      if (lenderLower.includes("b&g") || lenderLower.includes("desert")) {
         gData.sellerLienholderCompany = "Desert finance LLC";
         gData.sellerAddress = "2231 W Main St";
         gData.sellerCity = "Mesa";
         gData.sellerZip = "85201";
         gData.buyerCompanyName = "B&G Auto Sales";
         gData.buyerCompanyStreet = "2231 W Main St";
         gData.buyerCompanyCity = "Mesa";
         gData.buyerCompanyZip = "85201";
      } else if (lenderLower.includes("blue") || lenderLower.includes("diamond")) {
         gData.sellerLienholderCompany = "Blue Diamond Enterprises";
         gData.sellerAddress = "2231 W Main St";
         gData.sellerCity = "Mesa";
         gData.sellerZip = "85201";
         gData.buyerCompanyName = "Blue Diamond Enterprises";
         gData.buyerCompanyStreet = "2231 W Main St";
         gData.buyerCompanyCity = "Mesa";
         gData.buyerCompanyZip = "85201";
      }

      showToast("Seller Extracted! Sending Payload to n8n...", "success", 3000);
      await sendRuntimeMessage({ type: "VIN_SELLER_DONE", sellerData: sData, globalData: gData, taskConfig: taskConfig});
      await wait(1500);
      await sendRuntimeMessage({ type: "CLOSE_CURRENT_TAB" }).catch(()=>{});
      return;
    }
    else if (targetRoute === "contract") {
    // ==========================================
    // PATH A: CONTRACT ROUTE
    // PATH A: CONTRACT ROUTE
    // PATH A: CONTRACT ROUTE
    // ==========================================
      showToast("Dashboard reached. Waiting for background loaders to finish...", "warning", 3000);
      
      // NEW: THE LOADER GATE - Wait for the double-loaders to finish their background fetching
      for(let w = 0; w < 15; w++) {
          if (!isLoadingIndicatorVisible()) break;
          await wait(1000);
      }
      await wait(2000); // Give the DOM 2 seconds to settle after loaders die
      
      let filesTab = await findAndRevealTab("span#Files");
      if (filesTab) {
        showToast("Files tab located. Attempting to open...", "info", 2000);
        
        let isTabActive = false;
        for (let i = 0; i < 10; i++) {
            let currentTab = document.querySelector("span#Files");
            if (currentTab && currentTab.classList.contains("activeTab")) {
                isTabActive = true;
                break;
            }
            safeClick(currentTab || filesTab);
            try { (currentTab || filesTab).click(); } catch(e){}
            await wait(1000); 
        }

        if (!isTabActive) {
            showToast("Failed to physically open the Files tab.", "error", 5000);
            await sendErrorToN8n("Navigation Error: Clicked Files tab but it refused to open.", taskConfig, "https://n8n.srv1669099.hstgr.cloud/webhook/contract-file");
            return;
        }

        showToast("Files tab is ACTIVE. Waiting for list to load...", "success", 3000);
        await wait(2000); 
        
        let filesLoaded = false;
        let emptyStateMsg = null;

        for (let i = 0; i < 60; i++) {
          // NEW: RUBBERBAND DEFENDER - If CRM kicked us out of the tab, fight back!
          let activeCheck = document.querySelector("span#Files");
          if (activeCheck && !activeCheck.classList.contains("activeTab")) {
              showToast("CRM forced tab reset! Fighting back and re-clicking Files...", "warning", 1500);
              safeClick(activeCheck);
              try { activeCheck.click(); } catch(e){}
              await wait(1500);
              continue; // Skip scanning this second and let it load
          }

          const fileRows = document.querySelectorAll('.supportingFilesRowWrapper, tr.row_detail');
          if (fileRows.length > 0) {
            filesLoaded = true;
            break;
          }

          const emptyNode = Array.from(document.querySelectorAll("td, div, span, p")).find(el => {
             const text = el.innerText.replace(/\s+/g, " ").trim().toLowerCase();
             return text.includes("no supporting files have been uploaded") || 
                    text.includes("no records") || 
                    text.includes("no files");
          });
          
          if (emptyNode && isVisible(emptyNode)) {
             emptyStateMsg = "Could not find any file named 'contract' in the list";
             break;
          }
          await wait(500);
        }

        if (filesLoaded) {
          showToast("Files list verified! Extracting Contract...", "success", 2000);
          await wait(1000); 
          await extractAndPostContractFile(taskConfig); 
        } else if (emptyStateMsg) {
          showToast(emptyStateMsg, "warning", 5000);
          await sendErrorToN8n(emptyStateMsg, taskConfig, "https://n8n.srv1669099.hstgr.cloud/webhook/contract-file");
        } else {
          showToast("Timed out waiting for Files list to load.", "error", 5000);
          await sendErrorToN8n("Timed out waiting for Files list to load.", taskConfig, "https://n8n.srv1669099.hstgr.cloud/webhook/contract-file");
        }
      } else {
        showToast("Timed out waiting for the Files tab to appear.", "error", 5000);
        await sendErrorToN8n("Timed out waiting for Files tab to appear.", taskConfig, "https://n8n.srv1669099.hstgr.cloud/webhook/contract-file");
      }
    }

    else if (targetRoute === "collateral") {

showToast("Dashboard reached. Waiting for background loaders to finish...", "warning", 3000);
      
      // NEW: THE LOADER GATE
      for(let w = 0; w < 15; w++) {
          if (!isLoadingIndicatorVisible()) break;
          await wait(1000);
      }
      await wait(2000);

      let collateralTab = await findAndRevealTab("span#Collateral");
      if (collateralTab) {
        showToast("Collateral tab found! Waiting 1s to stabilize...", "info", 2000);
        await wait(1000); 
        showToast("Clicking Collateral tab...", "success", 3000);
        safeClick(collateralTab);
        try { collateralTab.click(); } catch(e){} 
        showToast("Waiting for Collateral Sub-tabs...", "info", 3000);
        
        let colFilesTab = null;
        for (let i = 0; i < 60; i++) {
          colFilesTab = document.getElementById("tab_supportingfiles__account_collateral_header");
          if (colFilesTab && isVisible(colFilesTab)) break;
          
          if (i === 10 || i === 20 || i === 30 || i === 40) {
             showToast("Website is slow, clicking Collateral again...", "warning", 2000);
             let freshTab = document.getElementById("Collateral");
             if (freshTab) {
               safeClick(freshTab);
               try { freshTab.click(); } catch(e){}
             }
          }
          await wait(500);
        }

        if (colFilesTab) {
          showToast("Collateral Files sub-tab found! Waiting 1s...", "success", 2000);
          await wait(1000); 
          showToast("Clicking Collateral Files sub-tab...", "success", 3000);
          safeClick(colFilesTab);
          try { colFilesTab.click(); } catch(e){}
          await extractAndPostCollateralFile(taskConfig);
        } else {
           showToast("Timed out waiting for Collateral Files sub-tab.", "error", 5000);
           await sendErrorToN8n("Timed out waiting for Collateral Files sub-tab", taskConfig, "https://n8n.srv1669099.hstgr.cloud/webhook/collateral-file");
        }
      } else {
        showToast("Timed out waiting for the Collateral tab.", "error", 5000);
        await sendErrorToN8n("Timed out waiting for Collateral tab", taskConfig, "https://n8n.srv1669099.hstgr.cloud/webhook/collateral-file");
      }
    }

  } catch (e) {
    showToast("Automation error: " + e.message, "error", 4000);
    console.error("[Account Search Error]", e);
    await sendErrorToN8n(`Automation error: ${e.message}`, taskConfig, "https://n8n.srv1669099.hstgr.cloud/webhook/contract-file");
  }
}

const AutomationSteps = {
  async typeSearch(buttonConfig, selectorConfig) {
    runtime.resultsSignatureBeforeSearch = getResultsSignature(selectorConfig);

    const searchInput = await resolveSearchInput(selectorConfig, 15000);
    safeType(searchInput, buttonConfig.searchText);

    const submitElement = findFirstElementByKey(selectorConfig, "search_submit", {
      timeoutMs: 800,
      visibleOnly: true
    });

    if (submitElement) {
      safeClick(submitElement);
    } else {
      dispatchEnter(searchInput);
      triggerInputBoundSearch(searchInput);
    }

    await wait(200);
  },

  async evaluateResults(buttonConfig, selectorConfig) {
    const container = await resolveResultsContainer(selectorConfig, 15000);
    let rows = await waitForResultsReady(container, selectorConfig, buttonConfig.searchText, 20000);

    if (!rows.length) {
      throw new Error("No result rows found.");
    }

    if (rows.length === 1) {
      runtime.selectedResultElement = rows[0];
      setStatus("evaluating_results: Found 1 result, auto-selected.");
      return;
    }

    setStatus(`evaluating_results: Found ${rows.length} results, waiting for selection.`);
    runtime.selectedResultElement = await showResultPicker(rows);
  },

  async clickPlay(buttonConfig, selectorConfig) {
    let target = null;

    if (selectorConfig.result_play_button && runtime.selectedResultElement) {
      target = findFirstElementByKey(selectorConfig, "result_play_button", {
        root: runtime.selectedResultElement,
        visibleOnly: true
      });
    }

    if (!target && selectorConfig.result_play_button) {
      target = await waitForSelectorKey(selectorConfig, "result_play_button", 15000);
    }

    if (!target) {
      target = findFallbackPlayButton(runtime.selectedResultElement) || findFallbackPlayButton(document);
    }

    if (!target) {
      throw new Error("Play button not found. Capture result_play_button selector in discovery mode.");
    }

    safeClick(target);
    await waitForStableDom(500, 12000);
  },

  async clickGenerate(buttonConfig, selectorConfig) {
    await waitForGenerateReady(20000);
    const generateButton = await resolveGenerateButton(selectorConfig, 15000);
    showToast("🖱️ Clicking Generate Report button...", "info", 3000);
    safeClick(generateButton);
    await waitForStableDom(450, 12000);
  },

  async changeFormatToCsv(buttonConfig, selectorConfig) {
    if (typeof showToast === "function") showToast("✅ Generate clicked! Waiting for report to finish...", "info", 6000);
    setStatus("changing_format: waiting for Generate to complete");

    let generateDone = false;
    const genStart = Date.now();
    while (Date.now() - genStart < 120000) {
      if (document.readyState === "complete" && !isLoadingIndicatorVisible()) {
        await waitForStableDom(1000, 3000);
        if (!isLoadingIndicatorVisible()) {
          generateDone = true;
          break;
        }
      }
      await wait(1000);
    }

    if (!generateDone) {
      throw new Error("Timeout: Generation took longer than 2 minutes.");
    }

    setStatus("changing_format: Generation complete, navigating to standard report URL");
    if (typeof showToast === "function") showToast("✅ Generation complete! Navigating...", "success", 3000);

    const targetUrl = "https://idms.dealersocket.com/reportviewer_v11/report11/report_viewer_rdlc.aspx?qstandalone=1&qefile_guid=bec3e4dc-4e40-4dea-ba87-24464fb1bf91&qexport_id=0&qdebug=0";
    if (location.href !== targetUrl) {
      location.href = targetUrl;
      return; 
    }

    await waitForStableDom(1000, 15000);
    if (typeof showToast === "function") showToast("🔍 Looking for export button...", "info", 3000);

    try {
      await resolveExportDropdownButton(selectorConfig, 120000);
      if (typeof showToast === "function") showToast("✅ Export dropdown opened!", "success", 3000);
      setStatus("changing_format: export dropdown clicked, waiting for menu");
    } catch (error) {
      if (typeof showToast === "function") showToast(`❌ Export button not found: ${error.message}`, "error", 8000);
      setStatus(`changing_format: failed — ${error.message}`);
      throw new Error(`Export dropdown click failed: ${error.message}`);
    }

    if (typeof showToast === "function") showToast("🔍 Looking for Excel option...", "info", 3000);
    try {
      await resolveExcelOption(selectorConfig, 10000);
      if (typeof showToast === "function") showToast("✅ Excel selected! Downloading...", "success", 5000);
      setStatus("changing_format: Excel option clicked");
    } catch (error) {
      if (typeof showToast === "function") showToast(`❌ Excel option not found: ${error.message}`, "error", 8000);
      setStatus(`changing_format: failed — ${error.message}`);
      throw new Error(`Excel option click failed: ${error.message}`);
    }

    await waitForStableDom(450, 12000);
  },

  async captureCsv(buttonConfig, selectorConfig) {
    if (runtime.directCsvFallbackDownload) {
      return {
        strategy: "direct-csv-fallback",
        download: runtime.directCsvFallbackDownload
      };
    }

    if (selectorConfig.generation_complete_indicator) {
      await waitForSelectorKey(selectorConfig, "generation_complete_indicator", 30000);
    }

    const csvEvent = await waitForCsvDownload(runtime.currentJobId, 180000);

    return {
      strategy: "download-event",
      download: csvEvent
    };
  }
};

function assertSelectorConfig(selectorConfig, requiredKeys) {
  const missing = requiredKeys.filter((key) => !selectorConfig[key]);
  if (missing.length) {
    throw new Error(`Missing selector keys: ${missing.join(", ")}`);
  }
}

async function resolveSearchInput(selectorConfig, timeoutMs) {
  if (selectorConfig.search_input) {
    return await waitForSelectorKey(selectorConfig, "search_input", timeoutMs);
  }

  const fallbackEntry = {
    selectors: [
      "#txtFilter_ReportName",
      "input[name='txtFilter_ReportName']",
      "input[id*='Filter_ReportName']",
      "input[name*='Filter_ReportName']"
    ]
  };

  const fallback = await waitForElementFromEntry(fallbackEntry, {
    timeoutMs,
    visibleOnly: true
  });

  setStatus("typing_search: using fallback search_input selector");
  return fallback;
}

async function resolveResultsContainer(selectorConfig, timeoutMs) {
  if (selectorConfig.results_container) {
    return await waitForSelectorKey(selectorConfig, "results_container", timeoutMs);
  }

  const fallbackEntry = {
    selectors: [
      "table tbody",
      "[role='grid']",
      "[role='table']",
      "[id*='report'][id*='list']",
      "[class*='report'][class*='list']",
      ".table-responsive tbody"
    ]
  };

  const fallback = await waitForElementFromEntry(fallbackEntry, {
    timeoutMs,
    visibleOnly: true
  });

  setStatus("evaluating_results: using fallback results_container selector");
  return fallback;
}

async function waitForResultsReady(container, selectorConfig, searchText, timeoutMs) {
  const start = Date.now();
  let stableSince = 0;
  let lastSignature = "";
  const baseline = runtime.resultsSignatureBeforeSearch || "";
  const normalizedSearch = normalizeText(searchText);

  while (Date.now() - start < timeoutMs) {
    ensureNotCanceled();

    let rows = collectRowsByConfig(container, selectorConfig).filter((el) => isVisible(el));
    const signature = rowsSignature(rows);
    const changed = !baseline || (signature && signature !== baseline);
    const containsSearch = !normalizedSearch || rows.some((row) => normalizeText(row.textContent).includes(normalizedSearch));
    const ready = rows.length > 0 && (changed || containsSearch) && !isLoadingIndicatorVisible();

    if (ready) {
      if (signature === lastSignature) {
        if (!stableSince) {
          stableSince = Date.now();
        }
        if (Date.now() - stableSince >= 900) {
          return rows;
        }
      } else {
        lastSignature = signature;
        stableSince = 0;
      }
    } else {
      stableSince = 0;
      lastSignature = signature;
    }

    await waitForDomMutation(280);
  }

  return collectRowsByConfig(container, selectorConfig).filter((el) => isVisible(el));
}

function collectRowsByConfig(container, selectorConfig) {
  const rowConfig = selectorConfig.result_row;
  let rows = [];

  if (rowConfig) {
    rows = findElementsFromEntry(rowConfig, container);
    if (!rows.length) {
      rows = findElementsFromEntry(rowConfig);
    }
    if (rows.length) {
      return rows;
    }
  }

  return collectRowsFromContainer(container);
}

function getResultsSignature(selectorConfig) {
  const container = findFirstElementByKey(selectorConfig, "results_container", {
    visibleOnly: true
  }) || findFirstElementFromEntry({
    selectors: [
      "table tbody",
      "[role='grid']",
      "[role='table']",
      "[id*='report'][id*='list']",
      "[class*='report'][class*='list']",
      ".table-responsive tbody"
    ]
  }, document, true);

  if (!container) {
    return "";
  }

  return rowsSignature(collectRowsByConfig(container, selectorConfig).filter((el) => isVisible(el)));
}

function rowsSignature(rows) {
  const top = rows.slice(0, 6).map((row) => normalizeText(row.textContent).slice(0, 80));
  return `${rows.length}|${top.join("||")}`;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function isLoadingIndicatorVisible() {
  // 1. Check for standard CSS classes and specific Microsoft SSRS IDs
  const selectors = [
    "[aria-busy='true']",
    "[class*='loading' i]",
    "[class*='spinner' i]",
    "[class*='progress' i]",
    ".fa-spinner",
    "[id*='AsyncWait']",        // Catches the exact Microsoft SSRS loading box
    "[id*='UpdateProgress']",   // Catches standard ASP.NET loaders
    ".WaitControlBackground"    // Catches SSRS overlay backgrounds
  ];

  for (const selector of selectors) {
    const items = document.querySelectorAll(selector);
    for (const item of items) {
      if (isVisible(item)) {
        return true;
      }
    }
  }

  // 2. TEXT SCANNER: Explicitly look for the exact "Loading..." text from your screenshot
  const allElements = document.querySelectorAll("div, span, td");
  for (const el of allElements) {
    if (isVisible(el)) {
      // Only check elements that actually hold text (leaf nodes)
      if (el.childElementCount === 0) {
        const text = (el.textContent || "").trim();
        if (text === "Loading..." || text === "Loading") {
          return true;
        }
      }
    }
  }

  return false;
}

async function resolveGenerateButton(selectorConfig, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    ensureNotCanceled();

    if (selectorConfig.generate_button) {
      const configured = findFirstElementByKey(selectorConfig, "generate_button", {
        visibleOnly: true
      });
      if (configured && isActionable(configured)) {
        return configured;
      }
    }

    const fallback = findGenerateButtonCandidate();
    if (fallback) {
      setStatus("clicking_generate: using fallback Generate Report detection");
      return fallback;
    }

    await waitForDomMutation(250);
  }

  throw new Error("Generate button not found.");
}

function findGenerateButtonCandidate() {
  const exact = document.querySelector("#btnGenerate");
  if (exact && isActionable(exact)) {
    return exact;
  }

  const selectors = [
    "#btnGenerate",
    "button[aria-label*='generate' i]",
    "button[id*='generate' i]",
    "button[class*='generate' i]",
    "button[title*='generate' i]",
    "[role='button'][aria-label*='generate' i]",
    "[onclick*='generate' i]",
    "input[type='button'][value*='generate' i]",
    "input[type='submit'][value*='generate' i]",
    "a[title*='generate' i]"
  ];

  const candidates = [];
  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector));
    for (const node of nodes) {
      if (isVisible(node) && isActionable(node)) {
        candidates.push(node);
      }
    }
  }

  const textCandidate = findElementByText(document, "button, [role='button'], a, span", "generate report")
    || findElementByText(document, "button, [role='button'], a, span", "generate");

  if (textCandidate && isActionable(textCandidate)) {
    candidates.push(textCandidate);
  }

  const valueCandidate = findInputByValue("generate report") || findInputByValue("generate");
  if (valueCandidate && isActionable(valueCandidate)) {
    candidates.push(valueCandidate);
  }

  if (!candidates.length) {
    return null;
  }

  candidates.sort((a, b) => scoreTopRight(b) - scoreTopRight(a));
  return candidates[0];
}

function findInputByValue(needle) {
  const query = "input[type='button'], input[type='submit'], input[type='reset']";
  const wanted = normalizeText(needle);
  const nodes = Array.from(document.querySelectorAll(query));
  for (const node of nodes) {
    const value = normalizeText(node.value || "");
    if (value.includes(wanted) && isVisible(node)) {
      return node;
    }
  }
  return null;
}

function scoreTopRight(element) {
  const rect = element.getBoundingClientRect();
  const xWeight = rect.right;
  const yWeight = Math.max(0, window.innerHeight - rect.top);
  return xWeight + yWeight;
}

function isActionable(element) {
  if (!element || !isVisible(element)) {
    return false;
  }

  if (element.matches("[disabled], [aria-disabled='true']")) {
    return false;
  }

  if (element instanceof HTMLInputElement || element instanceof HTMLButtonElement) {
    return !element.disabled;
  }

  return true;
}

async function resolveFormatDropdown(selectorConfig, timeoutMs) {
  if (selectorConfig.format_dropdown) {
    return await waitForSelectorKey(selectorConfig, "format_dropdown", timeoutMs);
  }

  const fallbackEntry = {
    selectors: [
      "select[id*='format' i]",
      ".wrExportDropdownButton",
      "button[id*='ExportSelectCtrl_ExportDropdownButton' i]",
      "[id*='ExportSelectCtrl_ExportDropdownButton' i]",
      "button[id*='ExportDropdownButton' i]",
      "[id*='ExportDropdownButton' i]",
      "button[aria-label*='export' i]",
      "button[title*='export' i]",
      "[role='combobox'][aria-label*='format' i]",
      "button[aria-label*='format' i]"
    ]
  };

  const found = await waitForElementFromEntry(fallbackEntry, {
    timeoutMs,
    visibleOnly: true
  }).catch(() => null);

  if (found) {
    setStatus("changing_format: using fallback format_dropdown selector");
    return found;
  }

  return null;
}

async function resolveDirectCsvExportButton(selectorConfig, timeoutMs) {
  const fallbackEntry = {
    selectors: [
      ".wrExportButton",
      "button[id*='ExportSelectCtrl_ExportButton' i]"
    ]
  };

  const found = await waitForElementFromEntry(fallbackEntry, {
    timeoutMs,
    visibleOnly: true
  }).catch(() => null);

  if (found && normalizeText(found.textContent).includes("csv")) {
    setStatus("changing_format: using direct CSV export button");
    return found;
  }

  return null;
}

async function resolveDirectPdfExportButton(selectorConfig, timeoutMs) {
  const fallbackEntry = {
    selectors: [
      ".wrExportButton",
      "button[id*='ExportSelectCtrl_ExportButton' i]",
      "button[title*='pdf' i]",
      "button[aria-label*='pdf' i]"
    ]
  };

  const found = await waitForElementFromEntry(fallbackEntry, {
    timeoutMs,
    visibleOnly: true
  }).catch(() => null);

  if (found && normalizeText(found.textContent).includes("pdf")) {
    setStatus("changing_format: using direct PDF export button");
    return found;
  }

  throw new Error("Direct PDF export button not found.");
}

async function resolveCsvOption(selectorConfig, timeoutMs) {
  if (selectorConfig.format_csv_option) {
    return await waitForSelectorKey(selectorConfig, "format_csv_option", timeoutMs);
  }

  const fallbackEntry = {
    selectors: [
      "option[value*='csv' i]",
      ".wrPopupMenuItem[data-key='csv']",
      ".wrPopupMenuItemSlim[data-key='csv']",
      "[data-key='csv']",
      "[data-key='csv'] .wrPopupMenuItemText",
      "[role='option'][aria-label*='csv' i]",
      "[data-value*='csv' i]",
      "button[aria-label*='csv' i]",
      "li"
    ]
  };

  const bySelector = await waitForElementFromEntry(fallbackEntry, {
    timeoutMs,
    visibleOnly: true
  }).catch(() => null);

  if (bySelector) {
    setStatus("changing_format: using fallback format_csv_option selector");
    return bySelector;
  }

  const byText = findElementByText(document, "option, [role='option'], button, li, span, a", "csv");
  if (byText) {
    setStatus("changing_format: using fallback format_csv_option text match");
    return byText;
  }

  throw new Error("CSV option not found.");
}

function ensureNotCanceled() {
  if (runtime.cancelRequested) {
    throw new Error("Automation canceled.");
  }
}

async function waitForSelectorKey(selectorConfig, key, timeoutMs) {
  assertSelectorConfig(selectorConfig, [key]);
  const found = await waitForElementFromEntry(selectorConfig[key], {
    timeoutMs,
    visibleOnly: true
  });
  return found;
}

async function waitForElementFromEntry(entry, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    ensureNotCanceled();
    const element = findFirstElementFromEntry(entry, options.root, options.visibleOnly);
    if (element) {
      return element;
    }
    await waitForDomMutation(350);
  }
  throw new Error("Timed out waiting for element.");
}

function findFirstElementByKey(selectorConfig, key, options = {}) {
  const entry = selectorConfig[key];
  if (!entry) {
    return null;
  }

  return findFirstElementFromEntry(entry, options.root, options.visibleOnly, options.timeoutMs);
}

function findFirstElementFromEntry(entry, root, visibleOnly = true) {
  const list = findElementsFromEntry(entry, root);
  if (!visibleOnly) {
    return list[0] || null;
  }
  return list.find((el) => isVisible(el)) || null;
}

function findElementsFromEntry(entry, root) {
  const normalized = normalizeSelectorEntry(entry);
  const searchRoot = root || document;
  const output = [];

  for (const candidate of normalized.selectors) {
    if (typeof candidate === "string") {
      try {
        const elements = searchRoot.querySelectorAll(candidate);
        output.push(...elements);
      } catch {
      }
      continue;
    }

    if (candidate && typeof candidate === "object" && candidate.byText) {
      output.push(...findByTextCandidate(candidate, searchRoot));
    }
  }

  return uniqueElements(output);
}

function normalizeSelectorEntry(entry) {
  if (!entry) {
    return { selectors: [] };
  }

  if (Array.isArray(entry)) {
    return { selectors: entry };
  }

  if (typeof entry === "string") {
    return { selectors: [entry] };
  }

  if (entry.selectors && Array.isArray(entry.selectors)) {
    return entry;
  }

  return { selectors: [] };
}

function findByTextCandidate(candidate, root) {
  const text = String(candidate.byText || "").trim();
  if (!text) {
    return [];
  }

  const tag = String(candidate.tag || "*").toLowerCase();
  const pool = root.querySelectorAll(tag);
  const matches = [];
  for (const el of pool) {
    if ((el.textContent || "").trim() === text) {
      matches.push(el);
    }
  }
  return matches;
}

function uniqueElements(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    output.push(item);
  }
  return output;
}

function isVisible(element) {
  if (!element || !element.isConnected) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function safeClick(element) {
  ensureNotCanceled();
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  try {
    element.click();
  } catch {
  }
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function safeType(element, value) {
  ensureNotCanceled();
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  element.focus();

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    const prototype = element instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

    if (descriptor?.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  if (element.isContentEditable) {
    element.textContent = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  throw new Error("Target element is not typable.");
}

function dispatchEnter(element) {
  const keyboardEventOptions = {
    bubbles: true,
    cancelable: true,
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13
  };

  element.dispatchEvent(new KeyboardEvent("keydown", keyboardEventOptions));
  element.dispatchEvent(new KeyboardEvent("keypress", keyboardEventOptions));
  element.dispatchEvent(new KeyboardEvent("keyup", keyboardEventOptions));
}

function triggerInputBoundSearch(inputElement) {
  const attrScripts = [
    inputElement.getAttribute("ondtenter"),
    inputElement.getAttribute("onkeydown"),
    inputElement.getAttribute("onkeyup"),
    inputElement.getAttribute("onchange")
  ].filter(Boolean);

  const candidateNames = new Set([
    "_report_list_folders_dotsearch",
    "dotsearch"
  ]);

  for (const scriptText of attrScripts) {
    for (const fnName of extractFunctionNames(scriptText)) {
      candidateNames.add(fnName);
    }
  }

  for (const name of candidateNames) {
    const fn = globalThis[name];
    if (typeof fn !== "function") {
      continue;
    }

    try {
      fn();
      return true;
    } catch {
    }
  }

  if (inputElement.form?.requestSubmit) {
    inputElement.form.requestSubmit();
    return true;
  }

  return false;
}

function extractFunctionNames(scriptText) {
  const names = [];
  const seen = new Set();
  const regex = /([A-Za-z_$][\w$]*)\s*\(/g;
  let match = regex.exec(scriptText);

  while (match) {
    const name = match[1];
    if (!seen.has(name) && !isJsKeyword(name)) {
      seen.add(name);
      names.push(name);
    }
    match = regex.exec(scriptText);
  }

  return names;
}

function isJsKeyword(name) {
  return [
    "if",
    "for",
    "while",
    "switch",
    "return",
    "function"
  ].includes(name);
}

function collectRowsFromContainer(container) {
  const taggedRows = Array.from(container.querySelectorAll("[role='row'], tr, li"));
  if (taggedRows.length) {
    return taggedRows;
  }

  return Array.from(container.children).filter((child) => {
    if (!(child instanceof HTMLElement)) {
      return false;
    }
    return isVisible(child);
  });
}

function findFallbackPlayButton(root) {
  if (!root || !(root instanceof Element || root instanceof Document)) {
    return null;
  }

  const selectorList = [
    "[aria-label*='play' i]",
    "[title*='play' i]",
    "[class*='play' i]",
    "[data-icon*='play' i]",
    "button",
    "a",
    "span",
    "i"
  ];

  for (const selector of selectorList) {
    const nodes = Array.from(root.querySelectorAll(selector));
    for (const node of nodes) {
      if (!isVisible(node)) {
        continue;
      }

      const text = (node.textContent || "").trim().toLowerCase();
      const className = String(node.className || "").toLowerCase();
      const marker = `${text} ${className}`;

      if (
        marker.includes("play") ||
        text === "▶" ||
        text === ">"
      ) {
        return node;
      }
    }
  }

  return null;
}

function findElementByText(root, selector, textNeedle) {
  const needle = String(textNeedle || "").trim().toLowerCase();
  if (!needle) {
    return null;
  }

  const nodes = Array.from(root.querySelectorAll(selector));
  for (const node of nodes) {
    if (!isVisible(node)) {
      continue;
    }

    const text = (node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (text.includes(needle)) {
      return node;
    }
  }

  return null;
}

function showResultPicker(rows) {
  return new Promise((resolve, reject) => {
    closeResultPicker();

    const overlay = document.createElement("div");
    overlay.className = "reportgen-picker-overlay";

    const dialog = document.createElement("section");
    dialog.className = "reportgen-picker-dialog";

    const title = document.createElement("h3");
    title.textContent = "Select Report Row";

    const list = document.createElement("div");
    list.className = "reportgen-picker-list";

    rows.forEach((row, idx) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "reportgen-picker-item";
      item.textContent = formatRowLabel(row, idx + 1);
      item.addEventListener("click", () => {
        closeResultPicker();
        resolve(row);
      });
      list.appendChild(item);
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "reportgen-picker-close";
    closeBtn.textContent = "Cancel";
    closeBtn.addEventListener("click", () => {
      closeResultPicker();
      reject(new Error("Result selection canceled."));
    });

    dialog.append(title, list, closeBtn);
    overlay.appendChild(dialog);

    runtime.pickerOverlay = overlay;
    document.documentElement.appendChild(overlay);
  });
}

function closeResultPicker() {
  if (runtime.pickerOverlay && runtime.pickerOverlay.isConnected) {
    runtime.pickerOverlay.remove();
  }
  runtime.pickerOverlay = null;
}

function formatRowLabel(row, index) {
  const text = (row.textContent || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return `Row ${index}`;
  }
  return `Row ${index}: ${text.slice(0, 140)}`;
}

function waitForDomMutation(timeoutMs = 350) {
  return new Promise((resolve) => {
    let done = false;
    const obs = new MutationObserver(() => {
      if (done) {
        return;
      }
      done = true;
      obs.disconnect();
      resolve();
    });

    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true
    });

    setTimeout(() => {
      if (done) {
        return;
      }
      done = true;
      obs.disconnect();
      resolve();
    }, timeoutMs);
  });
}

async function waitForStableDom(stableWindowMs = 450, maxWaitMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    ensureNotCanceled();
    await waitForDomMutation(stableWindowMs);
    if (Date.now() - start >= stableWindowMs) {
      return;
    }
  }
}

async function waitForGenerateReady(maxWaitMs = 20000) {
  const start = Date.now();
  const minDelayMs = 10000;

  while (Date.now() - start < maxWaitMs) {
    ensureNotCanceled();
    const elapsed = Date.now() - start;

    if (elapsed >= minDelayMs && document.readyState === "complete" && !isLoadingIndicatorVisible()) {
      await waitForStableDom(600, 3000);
      if (!isLoadingIndicatorVisible()) {
        return;
      }
    }

    await waitForDomMutation(300);
  }

  setStatus("clicking_generate: proceeding after max wait for page readiness");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCsvDownload(jobId, timeoutMs) {
  ensureNotCanceled();

  if (runtime.lastCsvDownloadEvent) {
    return runtime.lastCsvDownloadEvent;
  }

  return await sendRuntimeMessage({
    type: "WAIT_FOR_CSV_DOWNLOAD",
    jobId,
    timeoutMs
  });
}

function installNetworkProbe() {
  if (runtime.networkProbeInstalled) {
    return;
  }
  runtime.networkProbeInstalled = true;

  installFetchProbe();
  installXhrProbe();
}

function installFetchProbe() {
  if (typeof globalThis.fetch !== "function") {
    return;
  }

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async function patchedFetch(input, init) {
    try {
      const details = buildFetchRequestDetails(input, init);
      rememberNetworkRequest(details);
    } catch {
    }

    return originalFetch(input, init);
  };
}

function installXhrProbe() {
  if (!globalThis.XMLHttpRequest) {
    return;
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, async, user, password) {
    this.__reportProbe = {
      method: String(method || "GET").toUpperCase(),
      url: toAbsoluteUrl(url),
      headers: {}
    };
    return originalOpen.call(this, method, url, async, user, password);
  };

  XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
    if (this.__reportProbe) {
      this.__reportProbe.headers[String(name || "")] = String(value || "");
    }
    return originalSetHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body) {
    try {
      const details = this.__reportProbe || {
        method: "GET",
        url: "",
        headers: {}
      };

      rememberNetworkRequest({
        transport: "xhr",
        method: details.method,
        url: details.url,
        headers: details.headers,
        bodyText: serializeBody(body),
        bodyInit: normalizeBodyForReplay(body),
        timestamp: Date.now()
      });
    } catch {
    }

    return originalSend.call(this, body);
  };
}

function buildFetchRequestDetails(input, init) {
  const requestLike = input instanceof Request ? input : null;
  const method = String(init?.method || requestLike?.method || "GET").toUpperCase();
  const url = toAbsoluteUrl(requestLike?.url || input);
  const headers = headersToObject(init?.headers || requestLike?.headers);
  const bodyCandidate = init?.body;

  return {
    transport: "fetch",
    method,
    url,
    headers,
    bodyText: serializeBody(bodyCandidate),
    bodyInit: normalizeBodyForReplay(bodyCandidate),
    timestamp: Date.now()
  };
}

function rememberNetworkRequest(details) {
  if (!details?.url) {
    return;
  }

  runtime.recentNetworkRequests.push(details);
  if (runtime.recentNetworkRequests.length > 60) {
    runtime.recentNetworkRequests.splice(0, runtime.recentNetworkRequests.length - 60);
  }
}

async function tryDirectCsvFallback(buttonConfig, sourceError) {
  const candidate = findDirectCsvRequestCandidate();
  if (!candidate) {
    setStatus(`changing_format: menu open failed (${sourceError?.message || "unknown"}); no direct CSV request candidate`);
    return false;
  }

  try {
    const csvText = await replayCsvRequest(candidate);
    const safeLabel = (buttonConfig?.label || "report").replace(/\s+/g, "_");

    runtime.directCsvFallbackDownload = {
      id: `direct-${Date.now()}`,
      filename: `${safeLabel}.csv`,
      url: candidate.url,
      finalUrl: candidate.url,
      createdAt: new Date().toISOString(),
      csvText
    };

    setStatus("changing_format: direct CSV fallback succeeded");
    return true;
  } catch (fallbackError) {
    setStatus(`changing_format: direct CSV fallback failed: ${fallbackError.message}`);
    return false;
  }
}

function findDirectCsvRequestCandidate() {
  const scored = runtime.recentNetworkRequests
    .map((req) => ({ req, score: scoreCsvRequestCandidate(req) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.req.timestamp - a.req.timestamp);

  return scored[0]?.req || null;
}

function scoreCsvRequestCandidate(request) {
  if (!request?.url) {
    return 0;
  }

  const method = String(request.method || "GET").toUpperCase();
  const url = request.url.toLowerCase();
  const body = String(request.bodyText || "").toLowerCase();
  const haystack = `${url} ${body}`;

  let score = 0;
  if (haystack.includes("csv")) {
    score += 8;
  }
  if (haystack.includes("export")) {
    score += 5;
  }
  if (haystack.includes("download")) {
    score += 4;
  }
  if (haystack.includes("report")) {
    score += 2;
  }
  if (method === "GET" || method === "POST") {
    score += 1;
  }
  if (!/^https?:/i.test(request.url)) {
    score -= 4;
  }

  return score;
}

async function replayCsvRequest(candidate) {
  const method = String(candidate.method || "GET").toUpperCase();
  const headers = sanitizeReplayHeaders(candidate.headers || {});
  const body = method === "GET" || method === "HEAD" ? undefined : candidate.bodyInit;

  const response = await fetch(candidate.url, {
    method,
    credentials: "include",
    headers,
    body
  });

  if (!response.ok) {
    throw new Error(`direct request failed: ${response.status}`);
  }

  const text = await response.text();
  if (!text) {
    throw new Error("direct request returned empty body");
  }

  return text;
}

function sanitizeReplayHeaders(input) {
  const blocked = new Set([
    "content-length",
    "host",
    "origin",
    "referer",
    "cookie",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-dest"
  ]);

  const output = {};
  for (const [name, value] of Object.entries(input || {})) {
    const key = String(name || "").toLowerCase();
    if (!key || blocked.has(key)) {
      continue;
    }
    output[name] = value;
  }

  return output;
}

function headersToObject(headersLike) {
  if (!headersLike) {
    return {};
  }

  if (headersLike instanceof Headers) {
    const out = {};
    headersLike.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }

  if (Array.isArray(headersLike)) {
    const out = {};
    for (const [key, value] of headersLike) {
      out[String(key)] = String(value);
    }
    return out;
  }

  return { ...headersLike };
}

function serializeBody(body) {
  if (!body) {
    return "";
  }

  if (typeof body === "string") {
    return body.slice(0, 2000);
  }

  if (body instanceof URLSearchParams) {
    return body.toString().slice(0, 2000);
  }

  if (body instanceof FormData) {
    const pairs = [];
    for (const [key, value] of body.entries()) {
      pairs.push(`${key}=${String(value)}`);
    }
    return pairs.join("&").slice(0, 2000);
  }

  return String(body).slice(0, 2000);
}

function normalizeBodyForReplay(body) {
  if (!body) {
    return undefined;
  }

  if (typeof body === "string") {
    return body;
  }

  if (body instanceof URLSearchParams) {
    return body.toString();
  }

  if (body instanceof FormData) {
    const params = new URLSearchParams();
    for (const [key, value] of body.entries()) {
      params.append(key, String(value));
    }
    return params.toString();
  }

  return undefined;
}

function toAbsoluteUrl(value) {
  try {
    return new URL(String(value || ""), location.href).toString();
  } catch {
    return "";
  }
}

async function executeReportSearchSingle(queueItem) {
  //  --- PHASE 1: SEARCH & PLAY ---
  const searchBox = await waitForElement("#txtFilter_ReportName");
  const searchBtn = await waitForElement("#btnFilter_ReportName");
  const textToType = queueItem.searchText || queueItem.targetText;
  searchBox.value = textToType;
  searchBox.dispatchEvent(new Event("input", { bubbles: true }));
  searchBox.dispatchEvent(new Event("change", { bubbles: true }));
  
  await wait(500); 
  searchBtn.click();
  showToast("Waiting for results...", "info", 4000);

  let targetPlayButton = null; 
  let attempts = 0;
  
  while (attempts < 40) {
    await wait(500); 
    attempts++;
    if (isLoadingIndicatorVisible()) continue; 

    const rows = document.querySelectorAll("tr");
    for (const row of rows) {
      const playBtn = row.querySelector(".fa-play");
      if (!playBtn) continue; 

      const rowText = row.innerText.toLowerCase();
      const target = queueItem.targetText.toLowerCase();
      const onclickAttr = playBtn.getAttribute("onclick") || "";
      
      if (queueItem.pickFirst && rowText.includes(target)) {
        targetPlayButton = playBtn;
        break;
      }
      if (onclickAttr.toLowerCase().includes(target) || rowText.includes(target)) {
        targetPlayButton = playBtn;
        break;
      }
    }
    if (targetPlayButton) break; 
  }

  if (!targetPlayButton) {
    throw new Error(`Could not find a play button for: ${queueItem.targetText}`);
  }

  showToast(`Found "${queueItem.targetText}"! Clicking Play...`, "success", 3000);
  await wait(500); 
  targetPlayButton.click();

  // --- PHASE 2: CLICK GENERATE ---
  showToast("Play clicked! Waiting 5s for parameters to load...", "warning", 5000);
  await wait(10000); 

  let generateBtn = null;
  generateBtn = document.querySelector("#btnGenerate");
  if (!generateBtn) {
    const iframe = document.getElementById("ifm__report_viewer");
    if (iframe && iframe.contentDocument) {
      generateBtn = iframe.contentDocument.querySelector("#btnGenerate");
    }
  }

  if (generateBtn) {
    showToast("Generate button found! Clicking...", "success", 3000);
    try { generateBtn.scrollIntoView({ block: 'center' }); } catch(e){}
    await wait(5000);
    generateBtn.click();
    
    showToast("Generate clicked! Waiting 15s for report to render...", "warning", 15000);
    await wait(15000);
  } else {
    throw new Error("Could not find the 'Generate Report' button (#btnGenerate).");
  }
  // --- PHASE 3: SWITCH TO STANDARD VIEWER ---
  showToast("Hunting for 'Standard Viewer' tab...", "info", 3000);
  let standardTab = document.querySelector("#rpt_viewer_tab_standard");
  if (!standardTab) {
    const iframe = document.getElementById("ifm__report_viewer");
    if (iframe && iframe.contentDocument) {
      standardTab = iframe.contentDocument.querySelector("#rpt_viewer_tab_standard");
    }
  }

  if (standardTab) {
    showToast("Standard Viewer found! Switching...", "success", 3000);
    try { standardTab.scrollIntoView({ block: 'center' }); } catch(e){}
    await wait(500);
    standardTab.click();

    // 1. YOUR REQUESTED 20s WAIT FOR APPEARANCE
    showToast("Waiting 20s for Standard Viewer to stabilize...", "warning", 20000);
    await wait(20000);
  } else {
    throw new Error("Could not find the 'Standard Viewer' tab.");
  }

  // --- PHASE 4: FETCH IFRAME URL & OPEN NEW TAB ---
  showToast("Extracting direct report URL from iframe...", "info", 3000);
  
  const reportIframe = document.getElementById("ifm__report_viewer");
  if (!reportIframe || !reportIframe.src) {
    throw new Error("Target iframe '#ifm__report_viewer' not found or has no source URL.");
  }

  const directReportUrl = reportIframe.src;
  showToast("URL Captured! Opening in isolated tab...", "success", 4000);

  // Tell background.js to open this URL and start the final wait
  const result = await sendRuntimeMessage({
     type: "OPEN_REPORT_NEW_TAB",
     url: directReportUrl,
     queueItem: queueItem
  });

  if (result && result.error) {
    throw new Error("Failed to process isolated tab: " + result.error);
  }

  // ... after the sendRuntimeMessage that opens the new tab
showToast("Handoff successful! Closing search tab...", "success", 2000);
await wait(2000); 
await sendRuntimeMessage({ type: "CLOSE_CURRENT_TAB" });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "RUN_SINGLE_UI_REPORT") {
    executeReportSearchSingle(message.queueItem)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // Keep channel open for async execution
  }

 
  if (message.type === "STABILIZE_ISOLATED_TAB") {
    (async () => {
      showToast("Isolated Tab Loaded! Waiting 20s to stabilize...", "warning", 20000);
      await wait(20000);

      try {
        // 1. Click the Export Dropdown
        showToast("Opening Export menu...", "info", 3000);
        const exportBtn = document.querySelector("#ReportViewer1_ctl09_ctl04_ctl00_ButtonLink");
        if (exportBtn) {
          exportBtn.click();
          await wait(2000); // Wait for dropdown animation
        } else {
          throw new Error("Export dropdown button not found.");
        }

        // 2. Register the background watcher before triggering the download
        showToast("Preparing download watcher...", "info", 3000);
        const targetWebhook = message.queueItem.webhookUrl || runtime.config.webhookUrl;
        await sendRuntimeMessage({
          type: "WATCH_DOWNLOAD_AND_SEND",
          webhookUrl: targetWebhook,
          taskConfig: { label: message.queueItem.targetText },
          fileName: `${message.queueItem.targetText.replace(/\s+/g, '_')}.xlsx`
        });

        // 3. Click the Excel option
        showToast("Triggering Excel export...", "success", 3000);
        const excelOption = document.querySelector("a[title='Excel']");
        if (excelOption) {
          excelOption.click();
        } else {
          // USE THIS - It tells the background to handle the execution
           showToast("Bypassing CSP: Triggering Excel via Background API...", "info", 3000);
           await sendRuntimeMessage({ type: "CLICK_EXCEL_IN_MAIN_WORLD" });
        }

        showToast("Download started! File will be sent to n8n automatically.", "success", 10000);
        
        // Signal success back to background.js
        sendResponse({ success: true });

        // ... after the excelOption.click() or script injection
        showToast("Export triggered! Closing isolated tab in 5s...", "success", 5000);
        await wait(10000); 
        await sendRuntimeMessage({ type: "CLOSE_CURRENT_TAB" });

      } catch (err) {
        showToast(`❌ Export Error: ${err.message}`, "error", 10000);
        sendResponse({ error: err.message });
      }
    })();
    return true; 
  }
});
