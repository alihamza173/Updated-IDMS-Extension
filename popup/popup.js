const statusEl = document.getElementById("status");
const sendReportsEl = document.getElementById("sendReports");
const sendSingleReportBtn = document.getElementById("sendMondayReport");
const searchAccountsBtn = document.getElementById("searchAccounts");
const accountSearchForm = document.getElementById("accountSearchForm");
const accountNumberInput = document.getElementById("accountNumberInput");
const sendBGRafayBtn = document.getElementById("sendBGRafayReport");
const sendTitanRafayBtn = document.getElementById("sendTitanRafayReport");

// Initialize standard listeners
init().catch((error) => setStatus(`Popup init failed: ${error.message}`));

// Handle Search Accounts (Remains unchanged as requested)
searchAccountsBtn.addEventListener("click", () => {
  accountSearchForm.style.display = "block";
  accountNumberInput.focus();
});

accountSearchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const accNum = accountNumberInput.value.trim();
  
  if (accNum) {
    const url = `https://idms.dealersocket.com/Account/Main/_LookupOptimize?autoSearchAcc=${encodeURIComponent(accNum)}`;
    chrome.tabs.create({ url });
    accountSearchForm.style.display = "none";
    accountNumberInput.value = "";
    setStatus("Navigating to account search...");
  } else {
    setStatus("Please enter an account number.");
  }
});

// Standard Utility Buttons
document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  setStatus("Opened settings.");
});

document.getElementById("toggleDiscovery").addEventListener("click", async () => {
  await sendToActiveTab({ type: "TOGGLE_DISCOVERY_MODE" });
  setStatus("Discovery mode toggled.");
});

document.getElementById("refreshPanel").addEventListener("click", async () => {
  await sendToActiveTab({ type: "REFRESH_PANEL" });
  setStatus("Panel refresh requested.");
});


// ==========================================
// NEW: DYNAMIC UI REPORT TRIGGERS
// These tell background.js to start the "Hunter" flow
// ==========================================

// 1. Trigger for All Daily Reports
async function init() {
  sendReportsEl.addEventListener("click", () => {
    setStatus(`Sending command to background script...`);
    chrome.runtime.sendMessage({ type: "sendReports" }, (response) => {
      if (chrome.runtime.lastError) {
        setStatus("Error: " + chrome.runtime.lastError.message);
      } else {
        setStatus("Running all reports!");
      }
    });
  });
}

// 2. Trigger for the Monday Report (Register Titles)
sendSingleReportBtn.addEventListener("click", () => {
  setStatus(`Sending command to background script...`);
  chrome.runtime.sendMessage({ type: "sendMondayReport" }, (response) => {
    if (chrome.runtime.lastError) {
      setStatus("Error: " + chrome.runtime.lastError.message);
    } else {
      setStatus("Running single report!");
    }
  });
});

// ==========================================
// Helper functions
// ==========================================

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  try {
    await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    const tabUrl = String(tab.url || "");
    if (!/^https?:\/\//i.test(tabUrl)) {
      throw new Error("Open a normal website tab first.");
    }
    // Re-inject content script if needed
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/content.js"]
    });
    await chrome.tabs.sendMessage(tab.id, message);
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}


// Trigger for BG Rafay Report
if (sendBGRafayBtn) {
  sendBGRafayBtn.addEventListener("click", () => {
    setStatus(`Sending BG Rafay command to background...`);
    chrome.runtime.sendMessage({ type: "sendBGRafay" }, (response) => {
      if (chrome.runtime.lastError) setStatus("Error: " + chrome.runtime.lastError.message);
      else setStatus("Running BG Rafay report!");
    });
  });
}

// Trigger for Titan Rafay Report
if (sendTitanRafayBtn) {
  sendTitanRafayBtn.addEventListener("click", () => {
    setStatus(`Sending Titan Rafay command to background...`);
    chrome.runtime.sendMessage({ type: "sendTitanRafay" }, (response) => {
      if (chrome.runtime.lastError) setStatus("Error: " + chrome.runtime.lastError.message);
      else setStatus("Running Titan Rafay report!");
    });
  });
}