const ACTIVE_JOBS = new Map();
const CSV_EVENTS = new Map();
const CSV_WAITERS = new Map();
const PROCESSED_DOWNLOAD_IDS = new Set();
// Stores downloads that arrived when no job was active (service worker restart race)
const ORPHAN_DOWNLOADS = [];
const MAX_ORPHAN_AGE_MS = 300000; // 5 minutes
let pendingVinPayload = null;// Holds data while the Inventory tab fetches mileage
// ============================================================
// FILE DOWNLOAD WATCHER — waits for a download to complete
// then automatically POSTs it to the n8n webhook.
// Key: downloadId (number) | Value: { webhookUrl, taskConfig, fileName, startedAt }
// ============================================================
const PENDING_FILE_WEBHOOKS = new Map();
const FILE_WATCH_TIMEOUT_MS = 300000; // 5 minutes

chrome.runtime.onInstalled.addListener(() => {
  console.log("Automated Report Generator scaffold installed.");
  // Start the 1-minute alarm for n8n polling on install
  chrome.alarms.create("pollN8n", { periodInMinutes: 1 });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

chrome.downloads.onCreated.addListener(async (item) => {
  await tryProcessCsvDownload(item);
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta?.id) return;
  
  // AUDIT: Did Chrome detect a state change?
  if (delta.state) {
    console.log(`[AUDIT - onChanged] Download ID ${delta.id} state changed to: ${delta.state.current}`);
  }

  if (delta.state && delta.state.current === 'complete') {
    const [item] = await chrome.downloads.search({ id: delta.id });
    if (!item) return;
    
    console.log(`[AUDIT - onChanged] Download 100% complete for file: ${item.filename}`);
    
    // AUDIT: Is this download being watched by our script?
    if (PENDING_FILE_WEBHOOKS.has(delta.id)) {
      console.log(`[AUDIT - onChanged] 🟢 MATCH FOUND! ID ${delta.id} is in our pending list. Dispatching to n8n...`);
      const pending = PENDING_FILE_WEBHOOKS.get(delta.id);
      PENDING_FILE_WEBHOOKS.delete(delta.id);
      
      dispatchFileToWebhook(item, pending).then(() => {
        console.log(`[AUDIT - onChanged] Webhook dispatch sequence finished. Attempting to close tab ${pending.tabId}`);
        if (pending.tabId) chrome.tabs.remove(pending.tabId).catch((e) => console.log("[AUDIT] Tab close error:", e.message));
      }).catch((err) => {
        console.error(`[AUDIT - onChanged] 🔴 FATAL DISPATCH ERROR:`, err.message);
        if (pending.tabId) chrome.tabs.remove(pending.tabId).catch(() => {});
      });
    } else {
      console.log(`[AUDIT - onChanged] 🟡 Ignoring ID ${delta.id}. It finished, but wasn't in our PENDING_FILE_WEBHOOKS map.`);
    }
  }
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "PING":
      return { pong: true };
    case "RELEASE_LOCK": {
      chrome.storage.local.set({ MASTER_LOCK: 0 });
      console.log("[background] 🔓 Lock manually released due to error/abort.");
      return { ok: true };
    }

    case "START_VIN_SELLER_ONLY": {
      console.log(`[background] Starting VIN Extraction (Cases 2/3). Seller: ${message.sellerAcc}`);
      chrome.storage.local.set({
        VIN_SELLER_ACC: message.sellerAcc,
        VIN_TASK_CONFIG: message.taskConfig,
        VIN_BUYER_DATA: "MAPPED_COMPANY", // Tells the final step to use the hardcoded company
        VIN_SELLER_DATA: null 
      }, () => {
        const searchUrl = `https://idms.dealersocket.com/Account/Main/_LookupOptimize?autoSearchAcc=${encodeURIComponent(message.sellerAcc)}&botRoute=vinseller`;
        chrome.tabs.create({ url: searchUrl }, (tab) => {
          chrome.storage.local.set({ TAB_ID: tab.id }); 
        });
      });
      return { ok: true };
    }

    case "VIN_BUYER_DONE": {
      console.log("[background] Buyer data extracted. Opening Seller tab...");
      chrome.storage.local.set({ VIN_BUYER_DATA: message.buyerData }, async () => {
        const data = await chrome.storage.local.get("VIN_SELLER_ACC");
        const sellerAcc = data.VIN_SELLER_ACC;
        const searchUrl = `https://idms.dealersocket.com/Account/Main/_LookupOptimize?autoSearchAcc=${encodeURIComponent(sellerAcc)}&botRoute=vinseller`;
        chrome.tabs.create({ url: searchUrl }, (tab) => {
          chrome.storage.local.set({ TAB_ID: tab.id }); 
        });
      });
      return { ok: true };
    }

    case "VIN_SELLER_DONE": {
      console.log("[background] Seller data extracted. Building Mega Payload...");
      const storage = await chrome.storage.local.get(["VIN_BUYER_DATA", "VIN_TASK_CONFIG"]);
      const bData = storage.VIN_BUYER_DATA; 
      const sData = message.sellerData;
      const gData = message.globalData; 
      
      // 🚨 FIX: Pull the stock number directly from the database to prevent it from getting lost!
      const originalN8nPayload = storage.VIN_TASK_CONFIG || {};
      const stockNumber = originalN8nPayload.stockNo || (message.taskConfig && message.taskConfig.stockNo) || "";
      const vinQuery = originalN8nPayload.searchQuery || "";
      const isActive = Boolean(message.taskConfig?.isActive ?? originalN8nPayload.isActive ?? false);
      console.log(`[background] Original n8n payload retrieved from storage:`, originalN8nPayload);
      console.log(`[background] Stock number determined to be: "${message.taskConfig.stockNo}" (This is what will trigger the Inventory tab)`);
      console.log(`[background] VIN query determined to be: "${vinQuery}" (This is what will be used if the VIN is missing from the affidavit)`);
      let finalBuyer = {};
      const today = new Date();
      const todayStr = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;

      if (bData === "MAPPED_COMPANY") {
         finalBuyer = {
            "Buyer Name": gData.buyerCompanyName,
            "Sale Date": todayStr,
            "Street Address": gData.buyerCompanyStreet,
            "City": gData.buyerCompanyCity,
            "State": "AZ",
            "Zip": gData.buyerCompanyZip,
            "Odometer Reading no tenths": "",
            "Buyer Name printed": gData.buyerCompanyName,
            "Buyer Date": todayStr
         };
      } else {
         finalBuyer = {
            "Buyer Name": bData?.buyerName || "",
            "Sale Date": bData?.saleDate || "",
            "Street Address": bData?.streetAddress || "",
            "City": bData?.city || "",
            "State": bData?.state || "AZ",
            "Zip": bData?.zip || "",
            "Odometer Reading no tenths": bData?.odometer || "",
            "Buyer Name printed": bData?.buyerName || "",
            "Buyer Date": bData?.saleDate || ""
         };
      }

      // Save to global variable so the Inventory tab can update it later
      pendingVinPayload = {
        "IsActive": isActive,
         "repossession_affidavit": {
            "Vehicle Identification Number": sData.vin || vinQuery,
            "Year": sData.year || "",
            "Make": sData.make || "",
            "Model": sData.model || "",
            "Registered Owner Name(s) printed": sData.registeredOwner || "",
            "Repossession Date": sData.repossessionDate || "",
            "Sale Date": finalBuyer["Sale Date"],
            "Lienholder Company Name": gData.sellerLienholderCompany || "",
            "Lienholder Agent Name": gData.lienholderAgentName || ""
         },
         "bill_of_sale": {
            ...finalBuyer,
            "Seller Name printed": gData.sellerLienholderCompany || "",
            "Date": finalBuyer["Sale Date"],
            "Seller Street Address": gData.sellerAddress || "",
            "Seller City": gData.sellerCity || "",
            "Seller State": "AZ",
            "Seller Zip": gData.sellerZip || ""
         }
      };
      await chrome.storage.local.set({ PENDING_VIN_PAYLOAD: pendingVinPayload });

      console.log(`[background] Checking for Stock Number to trigger Step 3... Found: "${stockNumber}"`);

      // CHECK FOR STOCK NUMBER AND TRIGGER INVENTORY TAB
      if (stockNumber) {
          console.log("[background] StockNo found! Opening Inventory tab for Mileage overwrite...");
          
   const inventoryUrl = "https://idms.dealersocket.com/Inventory/Main/_lookup?status=A"; 
          
          chrome.tabs.create({ url: inventoryUrl, active: true }, (tab) => {
              chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
                  if (tabId === tab.id && info.status === 'complete') {
                      chrome.tabs.onUpdated.removeListener(listener);
                      
                      setTimeout(async () => {
                          try {
                            await sendTabMessageWithRetry(tabId, {
                              type: "AUTOMATE_ACCOUNT_SEARCH",
                              accountNumber: stockNumber, // Handing the exact stock number to content.js
                              taskConfig: {
                                  ...originalN8nPayload, // Keeps all the original n8n fields
                                  stockNo: stockNumber,
                                  route: "inventory_mileage" // Triggers Step 3
                              }
                            });
                          } catch (error) {
                            console.error("[background] Inventory tab did not accept automation message. Sending original payload.", error.message);
                            await postWithRetry("https://n8n.srv1669099.hstgr.cloud/webhook/testing-fields", pendingVinPayload, 3);
                            await chrome.storage.local.set({ MASTER_LOCK: 0, VIN_BUYER_DATA: null, VIN_SELLER_ACC: null, PENDING_VIN_PAYLOAD: null });
                            chrome.tabs.remove(tabId).catch(() => {});
                          }
                      }, 2000);
                  }
              });
          });
      } else {
          // No stock number? Send to n8n immediately!
          console.warn("[background] NO STOCK NUMBER FOUND! Skipping Step 3 and sending to n8n.");
          await postWithRetry("https://n8n.srv1669099.hstgr.cloud/webhook/testing-fields", pendingVinPayload, 3);
          console.log("[background] 🟢 MEGA PAYLOAD DELIVERED TO N8N (No StockNo)!", pendingVinPayload);
          await chrome.storage.local.set({ MASTER_LOCK: 0, VIN_BUYER_DATA: null, VIN_SELLER_ACC: null, PENDING_VIN_PAYLOAD: null });
      }
      return { ok: true };
    }

    // ==========================================
    // CATCH THE MILEAGE FROM STEP 3 AND SEND TO N8N
    // ==========================================
    case "INVENTORY_MILEAGE_DONE": {
      console.log("[background] Mileage extracted! Overwriting old data...");
      const storedPayload = await chrome.storage.local.get("PENDING_VIN_PAYLOAD");
      const finalPayload = pendingVinPayload || storedPayload.PENDING_VIN_PAYLOAD;

      if (!finalPayload) {
          console.error("[background] Inventory mileage finished, but pending VIN payload was missing.");
          await chrome.storage.local.set({ MASTER_LOCK: 0, VIN_BUYER_DATA: null, VIN_SELLER_ACC: null, PENDING_VIN_PAYLOAD: null });
          return { ok: true };
      }
      
      // Target the exact field you created in your mapping and overwrite it
      if (message.mileage && finalPayload.bill_of_sale) {
          finalPayload.bill_of_sale["Odometer Reading no tenths"] = message.mileage;
      }

      // Add the extra vehicle details from the Inventory Vehicle tab when they are available.
      if (message.extraData && finalPayload.repossession_affidavit) {
          if (message.extraData.fuel) {
              finalPayload.repossession_affidavit["Fuel"] = message.extraData.fuel;
          }
          if (message.extraData.bodyStyle) {
              finalPayload.repossession_affidavit["Body Style"] = message.extraData.bodyStyle;
          }
      }

      // Finally, send the upgraded payload to n8n!
      await postWithRetry("https://n8n.srv1669099.hstgr.cloud/webhook/testing-fields", finalPayload, 3);
      console.log("[background] 🟢 MEGA PAYLOAD DELIVERED TO N8N (With Updated Mileage)!", finalPayload);
      
      // Clean up the lock
      pendingVinPayload = null;
      chrome.storage.local.set({ MASTER_LOCK: 0, VIN_BUYER_DATA: null, VIN_SELLER_ACC: null, PENDING_VIN_PAYLOAD: null });
      return { ok: true };
    }
    case "START_VIN_EXTRACTION": {
      console.log(`[background] Starting VIN Extraction. Buyer: ${message.buyerAcc}, Seller: ${message.sellerAcc}`);
      
      // 1. Save the targets to our permanent "Clipboard"
      chrome.storage.local.set({
        VIN_BUYER_ACC: message.buyerAcc,
        VIN_SELLER_ACC: message.sellerAcc,
        VIN_TASK_CONFIG: message.taskConfig,
        VIN_BUYER_DATA: null, // We will fill this in Phase 2
        VIN_SELLER_DATA: null // We will fill this in Phase 3
      }, () => {
        // 2. Open the Buyer's Account in a new tab to scrape it
        // Note: We use botRoute=vinBuyer so the content script knows what to do when it wakes up!
        const searchUrl = `https://idms.dealersocket.com/Account/Main/_LookupOptimize?autoSearchAcc=${encodeURIComponent(message.buyerAcc)}&botRoute=vinBuyer`;
        
        chrome.tabs.create({ url: searchUrl }, (tab) => {
          chrome.storage.local.set({ TAB_ID: tab.id }); 
        });
      });
      
      return { ok: true };
    }

      // --- ADDED: NEW TAB HANDLER FOR ISOLATED EXPORT ---
    case "OPEN_REPORT_NEW_TAB":
      return new Promise((resolve) => {
        chrome.tabs.create({ url: message.url, active: true }, (newTab) => {
          // Wait for the new tab to finish loading
          chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
            if (tabId === newTab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              
              // Notify the new tab it needs to wait 20s for stabilization
              setTimeout(() => {
                chrome.tabs.sendMessage(newTab.id, { 
                  type: "STABILIZE_ISOLATED_TAB", 
                  queueItem: message.queueItem 
                }, (response) => {
                  resolve(response || { success: true });
                });
              }, 1000);
            }
          });
        });
      });
    case "START_JOB": {
      const existingEvent = CSV_EVENTS.get(message.jobId);
      ACTIVE_JOBS.set(message.jobId, {
        jobId: message.jobId,
        tabId: sender.tab?.id,
        startedAt: Date.now(),
        meta: message.meta || {}
      });
      if (!existingEvent) {
        CSV_EVENTS.delete(message.jobId);
        pruneOrphanDownloads();
        if (ORPHAN_DOWNLOADS.length > 0) {
          const orphan = ORPHAN_DOWNLOADS.pop();
          CSV_EVENTS.set(message.jobId, orphan);
          resolveCsvWaiter(message.jobId, orphan);
          console.log("[background] Matched orphan download to new job.", orphan.filename);
        }
      }
      return { started: true };
    }

    case "END_JOB":
      ACTIVE_JOBS.delete(message.jobId);
      CSV_EVENTS.delete(message.jobId);
      rejectCsvWaiter(message.jobId, "Job ended before CSV capture completed.");
      if (PROCESSED_DOWNLOAD_IDS.size > 500) {
        PROCESSED_DOWNLOAD_IDS.clear();
      }
      return { ended: true };


    case "POST_WEBHOOK_WITH_COOKIES": {
      // 1. Grab all active DealerSocket cookies (Wrapped in a Promise so 'await' works cleanly)
      const cookies = await new Promise((resolve) => {
        chrome.cookies.getAll({ url: "https://idms.dealersocket.com" }, resolve);
      });
      
      // 2. Format them into a standard HTTP Cookie string
      const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

      // 3. Attach the cookies to the payload
      const finalPayload = {
        ...message.payload,
        authCookie: cookieString
      };

      // 4. Send the tiny JSON payload to n8n (No heavy files!)
      const res = await fetch(message.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finalPayload)
      });

      if (!res.ok) {
        throw new Error(`Webhook failed with status: ${res.status}`);
      }

      // 5. Just return the success object. Your traffic cop listener will handle the sendResponse!
      return { delivered: true, status: res.status };
    }

    case "CLOSE_CURRENT_TAB":
      if (sender.tab?.id) {
        // Force Chrome to close the tab that sent this message
        chrome.tabs.remove(sender.tab.id).catch(() => {});
        return { closed: true };
      }
      return { closed: false };

    case "WAIT_FOR_CSV_DOWNLOAD": {
      const { jobId, timeoutMs } = message;
      if (!jobId) throw new Error("Missing jobId.");
      const active = ACTIVE_JOBS.get(jobId);
      if (!active) throw new Error("Job is not active.");
      const cached = CSV_EVENTS.get(jobId);
      if (cached) return cached;
      return await waitForCsv(jobId, timeoutMs || 60000);
    }

    case "CLICK_EXCEL_IN_MAIN_WORLD": {
      const tabId = sender.tab?.id;
      if (!tabId) throw new Error("No tabId from sender.");

      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        func: () => {
          function findExcelCandidates() {
            const raw = Array.from(document.querySelectorAll("a, li, button, [onclick*='excel' i], [title*='excel' i]"))
              .filter(el => {
                const text = (el.textContent || "").trim().toLowerCase();
                const title = (el.getAttribute("title") || "").toLowerCase();
                const oc = (el.getAttribute("onclick") || "").toLowerCase();
                const id = (el.id || "").toLowerCase();
                return text.includes("excel") || title.includes("excel") || oc.includes("excel") || id.includes("excel");
              });
            return raw.filter(el => !raw.some(other => other !== el && other.contains(el)));
          }

          const candidates = findExcelCandidates();
          if (candidates.length === 0) return { clicked: false, found: 0 };

          for (const el of candidates) {
            try {
              const onclick = el.getAttribute("onclick") || "";
              const dpMatch = onclick.match(/__doPostBack\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
              
              if (dpMatch && typeof __doPostBack !== "undefined") {
                __doPostBack(dpMatch[1], dpMatch[2]);
                return { clicked: true, method: "doPostBack", details: el.tagName + "#" + el.id };
              }
              
              if (typeof $find !== "undefined") {
                const rv = $find("ReportViewer1") || $find("ReportViewerControl");
                if (rv && typeof rv.exportReport === "function") {
                  rv.exportReport("EXCELOPENXML");
                  return { clicked: true, method: "$find", details: el.tagName + "#" + el.id };
                }
              }

              el.click();
              return { clicked: true, method: "native_click", details: el.tagName + "#" + el.id };
            } catch (e) {
              console.warn("[MAIN] Click error:", e.message);
            }
          }

          return { clicked: false, found: candidates.length };
        }
      });

      const clicked = results?.some(r => r.result?.clicked === true);
      return { injected: true, clicked, results: results?.map(r => r.result) };
    }

    case "POST_WEBHOOK": {
      const { webhookUrl, payload } = message;
      if (!webhookUrl) throw new Error("Missing webhook URL.");
      
      // RELEASE LOCK ON ERROR/SUCCESS POST
      chrome.storage.local.set({ MASTER_LOCK: 0 });
      // chrome.storage.local.set({ MASTER_LOCK: false }); 
      
      return await postWithRetry(webhookUrl, payload, 3);
    }

    case "WATCH_DOWNLOAD_AND_SEND": {
      const { webhookUrl, taskConfig = {}, fileName = "", mimeHint = "", autoCloseTab } = message;
      if (!webhookUrl) throw new Error("WATCH_DOWNLOAD_AND_SEND: Missing webhookUrl.");

      // Capture the sender's tab ID so we can close it later
      const tabId = autoCloseTab ? sender.tab?.id : null;

      // Kick off the watcher asynchronously
      watchAndSendDownload({ webhookUrl, taskConfig, fileName, mimeHint, tabId }).catch((err) => {
        console.error("[background] WATCH_DOWNLOAD_AND_SEND error:", err.message);
      });

      return { watching: true };
    }

    case "UPLOAD_LARGE_FILE_FROM_URL": {
      const { pdfUrl, webhookUrl, taskConfig, fileName } = message;

      let fileBlob = null;
      let lastFetchError = null;

      // STEP 1: Fetch the file into extension memory (Bypassing DealerSocket blocks)
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log(`[AUDIT] Attempt ${attempt}: Fetching file into memory...`);
          const response = await fetch(pdfUrl, { credentials: "include" });
          
          if (!response.ok) throw new Error(`DealerSocket returned HTTP ${response.status}`);
          
          fileBlob = await response.blob();
          if (!fileBlob || fileBlob.size === 0) throw new Error("File body is empty.");
          
          console.log(`[AUDIT] ✅ File fetched! Size: ${fileBlob.size} bytes.`);
          break; // Success
        } catch (err) {
          lastFetchError = err;
          console.warn(`[AUDIT] Fetch attempt ${attempt} failed: ${err.message}`);
          await wait(2000 * attempt);
        }
      }

      if (!fileBlob) {
        throw new Error(`DealerSocket blocked the fetch: ${lastFetchError?.message}`);
      }

      // STEP 2: Send the file straight to n8n
      const formData = new FormData();
      formData.append("data", fileBlob, fileName);

      // formData.append("accountNumber", taskConfig.accountNumber || "");
      // formData.append("route", taskConfig.route || "");

      if (taskConfig) {
          for (const key in taskConfig) {
              formData.append(key, taskConfig[key]);
          }
      }

      try {
        console.log(`[AUDIT] POSTing to n8n...`);
        const postResponse = await fetch(webhookUrl, { method: "POST", body: formData });
        if (!postResponse.ok) throw new Error(`n8n rejected with HTTP ${postResponse.status}`);
        console.log(`[AUDIT] 🟢 SUCCESS! File sent to n8n.`);
      } catch (error) {
        console.error(`[AUDIT] 🔴 Webhook POST failed: ${error.message}`);
        throw new Error(`n8n upload failed: ${error.message}`);
      }

      // STEP 3: Save a copy to the user's Downloads folder
      console.log(`[AUDIT] Triggering local download to hard drive...`);
      const reader = new FileReader();
      reader.onloadend = () => {
        chrome.downloads.download({
          url: reader.result,
          filename: fileName,
          saveAs: false // Saves directly to Downloads folder without asking
        });
      };
      reader.readAsDataURL(fileBlob);
      // RELEASE LOCK ON SUCCESSFUL FILE UPLOAD
      chrome.storage.local.set({ MASTER_LOCK: 0 });
      // chrome.storage.local.set({ MASTER_LOCK: false });

      return { delivered: true };
    
    }

    case "GET_CONFIG": {
      return await chrome.storage.local.get(["webhookUrl", "buttons", "selectorConfig"]);
    }

    default:
      return { ignored: true };
  }
}

async function postWithRetry(url, payload, attempts) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(`Webhook failed: ${response.status}`);
      return { delivered: true, status: response.status };
    } catch (error) {
      lastError = error;
      await wait(500 * (i + 1));
    }
  }
  throw new Error(`Webhook delivery failed after retries: ${lastError?.message || "unknown"}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTabMessageWithRetry(tabId, message, attempts = 6) {
  let lastError = null;

  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      return response;
    } catch (error) {
      lastError = error;
      await wait(750 * (i + 1));
    }
  }

  throw new Error(`Tab message failed after retries: ${lastError?.message || "unknown"}`);
}

function findLatestJobByTab(tabId) {
  if (!tabId && tabId !== 0) return null;
  const jobs = Array.from(ACTIVE_JOBS.values())
    .filter((job) => job.tabId === tabId)
    .sort((a, b) => b.startedAt - a.startedAt);
  return jobs[0] || null;
}

function findLatestActiveJob() {
  const jobs = Array.from(ACTIVE_JOBS.values()).sort((a, b) => b.startedAt - a.startedAt);
  return jobs[0] || null;
}

function isCsvLikeDownload(item) {
  const filename = String(item?.filename || "").toLowerCase();
  const finalUrl = String(item?.finalUrl || "").toLowerCase();
  const url = String(item?.url || "").toLowerCase();
  const mime = String(item?.mime || "").toLowerCase();
  return (
    filename.endsWith(".csv") || filename.endsWith(".xlsx") || filename.endsWith(".xls") ||
    finalUrl.includes(".csv") || finalUrl.includes(".xlsx") || finalUrl.includes(".xls") ||
    url.includes(".csv") || url.includes(".xlsx") || url.includes(".xls") ||
    url.includes("excelopenxml") || url.includes("excel") ||
    mime.includes("csv") || mime.includes("spreadsheet") || mime.includes("excel")
  );
}

async function tryProcessCsvDownload(item) {
  if (!item || !isCsvLikeDownload(item) || PROCESSED_DOWNLOAD_IDS.has(item.id)) return;

  if (ACTIVE_JOBS.size === 0) {
    const payload = {
      id: item.id, filename: item.filename, url: item.url || "", finalUrl: item.finalUrl || "",
      createdAt: new Date().toISOString(), capturedAt: Date.now()
    };
    PROCESSED_DOWNLOAD_IDS.add(item.id);
    const enriched = await enrichCsvPayload(payload);
    pruneOrphanDownloads();
    ORPHAN_DOWNLOADS.push(enriched);
    console.log("[background] Stored orphan download:", item.filename);
    return;
  }

  const matchedJob = findLatestJobByTab(item.tabId) || findLatestActiveJob();
  if (!matchedJob) return;

  const payload = {
    id: item.id, filename: item.filename, url: item.url || "", finalUrl: item.finalUrl || "", createdAt: new Date().toISOString()
  };

  const enriched = await enrichCsvPayload(payload);
  PROCESSED_DOWNLOAD_IDS.add(item.id);

  CSV_EVENTS.set(matchedJob.jobId, enriched);
  resolveCsvWaiter(matchedJob.jobId, enriched);

  if (!matchedJob.tabId && matchedJob.tabId !== 0) return;
  try {
    await chrome.tabs.sendMessage(matchedJob.tabId, { type: "CSV_DOWNLOAD_DETECTED", payload: enriched });
  } catch (error) {
    console.warn("Failed to notify content script about CSV download.", error);
  }
}

function waitForCsv(jobId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      CSV_WAITERS.delete(jobId);
      reject(new Error("Timed out waiting for CSV download event."));
    }, timeoutMs);

    CSV_WAITERS.set(jobId, {
      resolve: (payload) => {
        clearTimeout(timeout);
        CSV_WAITERS.delete(jobId);
        resolve(payload);
      },
      reject: (message) => {
        clearTimeout(timeout);
        CSV_WAITERS.delete(jobId);
        reject(new Error(message));
      }
    });
  });
}

function resolveCsvWaiter(jobId, payload) {
  const waiter = CSV_WAITERS.get(jobId);
  if (!waiter) return;
  waiter.resolve(payload);
}

function rejectCsvWaiter(jobId, message) {
  const waiter = CSV_WAITERS.get(jobId);
  if (!waiter) return;
  waiter.reject(message);
}

function isExcelDownload(payload) {
  const filename = String(payload?.filename || "").toLowerCase();
  const url = String(payload?.finalUrl || payload?.url || "").toLowerCase();
  return (
    filename.endsWith(".xlsx") || filename.endsWith(".xls") || url.includes(".xlsx") || url.includes(".xls") || url.includes("excelopenxml") || url.includes("excel")
  );
}

async function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function enrichCsvPayload(payload) {
  const url = payload.finalUrl || payload.url;
  if (!url || !/^https?:/i.test(url)) return payload;

  const excel = isExcelDownload(payload);
  let lastError = null;

  for (let i = 0; i < 3; i += 1) {
    try {
      const response = await fetch(url, { method: "GET", credentials: "include" });
      if (!response.ok) throw new Error(`File fetch failed: ${response.status}`);

      if (excel) {
        const buffer = await response.arrayBuffer();
        if (!buffer || buffer.byteLength === 0) throw new Error("File body was empty.");
        
        const bytes = new Uint8Array(buffer);
        let binary = "";
        const chunkSize = 8192; 
        for (let j = 0; j < bytes.byteLength; j += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(j, j + chunkSize));
        }
        const fileBase64 = btoa(binary);
        
        return { ...payload, fileType: "excel", fileBase64, csvText: "" };
      } else {
        const csvText = await response.text();
        if (!csvText) throw new Error("CSV body was empty.");
        return { ...payload, fileType: "csv", csvText };
      }
    } catch (error) {
      lastError = error;
      await wait(400 * (i + 1));
    }
  }

  return {
    ...payload, 
    fileType: excel ? "excel" : "csv", 
    csvText: "", fileBase64: "", 
    csvFetchError: lastError?.message || "Unable to fetch file body from download URL."
  };
}

function pruneOrphanDownloads() {
  const cutoff = Date.now() - MAX_ORPHAN_AGE_MS;
  while (ORPHAN_DOWNLOADS.length > 0 && (ORPHAN_DOWNLOADS[0].capturedAt || 0) < cutoff) {
    ORPHAN_DOWNLOADS.shift();
  }
  while (ORPHAN_DOWNLOADS.length > 5) {
    ORPHAN_DOWNLOADS.shift();
  }
}

// ==========================================
// N8N POLLING & TASK ROUTING LOGIC
// ==========================================

// const N8N_POLL_URL = "https://n8n.srv1669099.hstgr.cloud/webhook/test-pole";
const N8N_POLL_URL = "https://n8n.srv1669099.hstgr.cloud/webhook/get-pole";

// ==========================================
// NEW: DYNAMIC TEXT-BASED QUEUES
// ==========================================
const REPORT_QUEUE = [
  { targetText: "closed good", matchBy: "name", webhookUrl: "https://n8n.srv1669099.hstgr.cloud/webhook/get-reports" },
  { targetText: "Repo Report Lite", matchBy: "name", pickFirst: true, webhookUrl: "https://n8n.srv1669099.hstgr.cloud/webhook/get-reports" },
  { targetText: "Only BHPH Sales Report 2026", matchBy: "name", webhookUrl: "https://n8n.srv1669099.hstgr.cloud/webhook/get-reports" },
  { targetText: "Cash & Wholesale NO FLAG", matchBy: "description", webhookUrl: "https://n8n.srv1669099.hstgr.cloud/webhook/get-reports" },
  { targetText: "-----CUSTOMER CREDIT / GIFT CARD", matchBy: "name", webhookUrl: "https://n8n.srv1669099.hstgr.cloud/webhook/get-reports" },
  { targetText: "All Inventory After a Date", matchBy: "name", webhookUrl: "https://n8n.srv1669099.hstgr.cloud/webhook/get-reports" }
];

const SINGLE_REPORT_QUEUE = [
  { targetText: "Register Titles", matchBy: "name", webhookUrl: "https://n8n.srv1669099.hstgr.cloud/webhook/monday-report" }
];

// ==========================================
// NEW: TASK ROUTING FOR POPUP & N8N
async function handleBackgroundAction(task) {
  // task is the object from n8n: { action, accountNumber, salesperson }
  const action = typeof task === 'string' ? task : task.action;
  const accNum = task.accountNumber;
  const salesperson = task.salesperson || "";
  const searchQuery = task.searchQuery || "";
  const co = task.CoBorrower || "";
  const stockNo = task.stockNo || "";
  const date = task.date || "";

  switch (action) {
    case "searchVin":
      if (searchQuery) {
        // Pass the VIN into autoSearchAcc, but label the botRoute as "vin"
        const searchUrl = `https://idms.dealersocket.com/Account/Main/_LookupOptimize?autoSearchAcc=${encodeURIComponent(searchQuery)}&botRoute=vin&stockNo=${encodeURIComponent(stockNo)}`;
        
        console.log(`[background] Triggering VIN search for: ${searchQuery}`);
        chrome.tabs.create({ url: searchUrl }, async (tab) => {
          await chrome.storage.local.set({ TAB_ID: tab.id }); 
        });
      } else {
        console.error("[background] Received searchVin task but searchQuery was missing.");
        await chrome.storage.local.set({ MASTER_LOCK: false }); 
      }
      break;
    case "sendReports":
      runQueueFromBackground(REPORT_QUEUE);
      break;
    case "sendMondayReport":
      runQueueFromBackground(SINGLE_REPORT_QUEUE);
      break;
    // --- NEW: RAFAY REPORTS ---
    case "sendBGRafay":
      await runQueueFromBackground([{ 
        searchText: "rafay",     // Types this in search box
        targetText: "b&g",       // Looks for this in the rows
        webhookUrl: "https://n8n.srv1669099.hstgr.cloud/webhook/reports" // Change if needed!
      }]);
      await chrome.storage.local.set({ MASTER_LOCK: false });
      break;
      
    case "sendTitanRafay":
      await runQueueFromBackground([{ 
        searchText: "rafay",     // Types this in search box
        targetText: "titan",     // Looks for this in the rows
        webhookUrl: "https://n8n.srv1669099.hstgr.cloud/webhook/reports" // Change if needed!
      }]);
      await chrome.storage.local.set({ MASTER_LOCK: false });
      break;


    // CORRECTED: Explicitly handle the n8n search actions
    case "searchContract":
    case "searchCollateral":
      if (accNum) {
        const route = (action === "searchContract") ? "contract" : "collateral";
        // Build the URL with all necessary params for content.js to read on load
        const searchUrl = `https://idms.dealersocket.com/Account/Main/_LookupOptimize?autoSearchAcc=${encodeURIComponent(accNum)}&botRoute=${route}&salesperson=${encodeURIComponent(salesperson)}&co=${encodeURIComponent(co)}&stockNo=${encodeURIComponent(stockNo)}&date=${encodeURIComponent(date)}`;
        
        console.log(`[background] Triggering ${route} search for account: ${accNum}`);
        chrome.tabs.create({ url: searchUrl });
      } else {
        console.error("[background] Received search task but accountNumber was missing.");
      }
      break;
  }
}

// Update your existing message listener to use this router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "sendReports" || message.type === "sendMondayReport" || message.type === "sendBGRafay" || message.type === "sendTitanRafay") {
    handleBackgroundAction(message.type);
    sendResponse({ ok: true });
    return true;
  }

});

// --- ADD THIS TO BACKGROUND.JS TO MAKE POLLING WORK ---
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pollN8n") {
    console.log("[background] Polling n8n for new tasks...");
    checkN8nForTasks();
  }
});

async function checkN8nForTasks() {
  try {
    // ==========================================
    // 🕒 WORKING HOURS GATE (7 AM to 2 PM)
    // To test outside of these hours, just add // in front of the 'if' statement and 'return'!
    // ==========================================
    const currentHour = new Date().getHours(); // Gets current hour in 24h format (0-23)
    const currentMin = new Date().getMinutes(); // Gets current minute (0-59)
    
    // 1. THE 10-MINUTE TIME-LEASE LOCK CHECK
    const storage = await chrome.storage.local.get("MASTER_LOCK");
    const lockTime = storage.MASTER_LOCK || 0; // Defaults to 0 (Unlocked)
    const now = Date.now();
    const TEN_MINUTES = 10 * 60 * 1000;

    // If locked AND the lock is less than 10 minutes old, respect the lock
    if (lockTime > 0 && (now - lockTime) < TEN_MINUTES) {
      console.log("[background] ⏳ Poller paused: A job is currently running (Lock active).");
      return; 
    }

    // If we are here, it's either unlocked (0) OR the lock is stuck (> 10 mins old)
    if (lockTime > 0 && (now - lockTime) >= TEN_MINUTES) {
      console.log("[background] ⚠️ Breaking stuck lock! It was older than 10 minutes.");
    }

    const response = await fetch(N8N_POLL_URL, { method: "GET" });
    if (!response.ok) return;

    const task = await response.json();
    
    // n8n returns { hasTask: true, action: "...", accountNumber: "..." }
    if (task && task.hasTask && task.action) {
       console.log("[background] Task detected:", task.action);
       
       // 2. ACTIVATE THE LOCK (Save the exact start millisecond)
       await chrome.storage.local.set({ MASTER_LOCK: Date.now() });
       
       handleBackgroundAction(task); 
    }
  } catch (error) {
    console.error("[background] Polling failed:", error.message);
  }
}

// NEW: Background-based loop to keep the queue alive
async function runQueueFromBackground(queueData) {
  if (!queueData || queueData.length === 0) return;

  for (let i = 0; i < queueData.length; i++) {
    const queueItem = queueData[i];
    console.log(`[background] Starting Report ${i + 1}/${queueData.length}: ${queueItem.targetText}`);

    // Create a Promise that resolves only when this specific report is done
    await new Promise((resolve) => {
      const mainReportsUrl = "https://idms.dealersocket.com/Reports/Main?reportType=2";
      
      chrome.tabs.create({ url: mainReportsUrl, active: true }, (tab) => {
        chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
          if (tabId === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            
            // Tell the content script to process JUST ONE report
            setTimeout(() => {
              chrome.tabs.sendMessage(tabId, { 
                type: "RUN_SINGLE_UI_REPORT", 
                queueItem: queueItem 
              }, (response) => {
                // When the content script says it's done (or fails), move to next loop iteration
                resolve();
              });
            }, 2000);
          }
        });
      });
    });

    // Short pause between reports for stability
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log("[background] Entire queue finished!");
  chrome.storage.local.set({ MASTER_LOCK: 0 });
}

// ============================================================
async function watchAndSendDownload({ webhookUrl, taskConfig = {}, fileName = "", mimeHint = "", tabId }) {
  const watchStarted = Date.now();
  console.log(`[AUDIT - Watcher] 🔎 Started scanning for new downloads. Tab ID to close later: ${tabId}`);

  let downloadId = null;
  const scanDeadline = Date.now() + 20000;
  
  while (Date.now() < scanDeadline) {
    const recent = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 5 });
    const candidate = recent.find(
      (d) => Date.now() - new Date(d.startTime).getTime() < 15000 && !PENDING_FILE_WEBHOOKS.has(d.id)
    );
    
    if (candidate) {
      downloadId = candidate.id;
      console.log(`[AUDIT - Watcher] 🟢 Caught new download! ID: ${downloadId}, Filename: ${candidate.filename}`);
      break;
    }
    await wait(500);
  }

  if (!downloadId) {
    console.warn(`[AUDIT - Watcher] 🔴 Timeout: No download started within 20 seconds. Aborting.`);
    if (tabId) chrome.tabs.remove(tabId).catch(() => {});
    return;
  }

  const pending = { webhookUrl, taskConfig, fileName, mimeHint, tabId, startedAt: watchStarted };
  PENDING_FILE_WEBHOOKS.set(downloadId, pending);
  console.log(`[AUDIT - Watcher] Added ID ${downloadId} to PENDING_FILE_WEBHOOKS map. Waiting for Chrome to say it's complete...`);
  // Step 3 — polling loop as a fallback (5 s intervals, 5 min max)
  const deadline = watchStarted + FILE_WATCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await wait(5000);
    
    // If the onChanged handler already handled it, bail out
    if (!PENDING_FILE_WEBHOOKS.has(downloadId)) return;

    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!item) {
      PENDING_FILE_WEBHOOKS.delete(downloadId);
      if (tabId) chrome.tabs.remove(tabId).catch(() => {});
      return;
    }

    if (item.state === "complete") {
      PENDING_FILE_WEBHOOKS.delete(downloadId);
      console.log("[background] watchAndSendDownload: download complete via polling. Dispatching webhook...");
      
      await dispatchFileToWebhook(item, pending);
      
      // CLOSE THE TAB ONCE POLLING UPLOAD IS COMPLETE
      if (tabId) chrome.tabs.remove(tabId).catch(() => {});
      return;
    }

    if (item.state === "interrupted") {
      PENDING_FILE_WEBHOOKS.delete(downloadId);
      console.error("[background] watchAndSendDownload: download interrupted:", item.error);
      
      // Send the error payload to n8n
      await postWithRetry(webhookUrl, {
        status: "Failed",
        error: `Download interrupted: ${item.error}`,
        fileName: item.filename || fileName,
        timestamp: new Date().toISOString()
      }, 1).catch(() => {});
      
      if (tabId) chrome.tabs.remove(tabId).catch(() => {});
      return;
    }
  }

  // Step 4 — Timeout reached (Outside the while loop)
  PENDING_FILE_WEBHOOKS.delete(downloadId);
  console.error("[background] watchAndSendDownload: 5-minute timeout reached for download id=", downloadId);
  
  // Send timeout error to n8n
  await postWithRetry(webhookUrl, {
    status: "Failed",
    error: "Download did not complete within the 5-minute timeout.",
    fileName: fileName,
    timestamp: new Date().toISOString()
  }, 1).catch(() => {});
  
  if (tabId) chrome.tabs.remove(tabId).catch(() => {});
}



// ============================================================
// dispatchFileToWebhook
// Fetches the completed file via its finalUrl (cookies included)
// and POSTs it to the n8n webhook as multipart FormData.
// Falls back to posting just the metadata if the fetch fails.
// ============================================================

async function dispatchFileToWebhook(item, pending) {
  const { webhookUrl, taskConfig = {}, fileName = "" } = pending;
  const fileUrl = item.finalUrl || item.url || "";
  const resolvedName = item.filename ? item.filename.split(/[\\/]/).pop() : (fileName || "downloaded_file");

  console.log(`[AUDIT - Dispatcher] 🚀 Starting dispatch for ${resolvedName}. URL: ${fileUrl}`);

  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (!fileUrl || !/^https?:/i.test(fileUrl)) throw new Error("No valid download URL available to fetch.");

      console.log(`[AUDIT - Dispatcher] Attempt ${attempt}: Fetching file data into memory...`);
      const response = await fetch(fileUrl, { credentials: "include" });
      
      if (!response.ok) throw new Error(`HTTP ${response.status} from DealerSocket`);

      const fileBlob = await response.blob();
      if (!fileBlob || fileBlob.size === 0) throw new Error("Blob is empty.");
      
      console.log(`[AUDIT - Dispatcher] ✅ File fetched! Size: ${fileBlob.size} bytes. Building n8n payload...`);

      const formData = new FormData();
      formData.append("data", fileBlob, resolvedName);
      formData.append("accountNumber", taskConfig.accountNumber || "");
      formData.append("route", taskConfig.route || "");
      
      console.log(`[AUDIT - Dispatcher] POSTing to webhook: ${webhookUrl}`);
      const postRes = await fetch(webhookUrl, { method: "POST", body: formData });
      
      if (!postRes.ok) throw new Error(`n8n rejected webhook with HTTP ${postRes.status}`);

      console.log(`[AUDIT - Dispatcher] 🟢 SUCCESS! n8n received the file.`);
      return { delivered: true, status: postRes.status };

    } catch (err) {
      lastError = err;
      console.warn(`[AUDIT - Dispatcher] 🟡 Attempt ${attempt} failed: ${err.message}`);
      await wait(1000 * attempt);
    }
  }

  console.error(`[AUDIT - Dispatcher] 🔴 ALL ATTEMPTS FAILED. Sending fallback error to n8n.`);
  // ... (Keep your fallback postWithRetry here)
  console.error("[background] dispatchFileToWebhook: all fetch attempts failed. Sending metadata fallback.");
  await postWithRetry(webhookUrl, {
    status: "Failed",
    error: lastError?.message || "File fetch failed",
    fileName: resolvedName,
    downloadUrl: fileUrl,
    taskConfig,
    timestamp: new Date().toISOString()
  }, 2).catch(() => {});
}
