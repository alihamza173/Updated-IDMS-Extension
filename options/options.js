const KEYS = {
  WEBHOOK: "webhookUrl",
  BUTTONS: "buttons",
  SELECTOR_CONFIG: "selectorConfig"
};

let editingId = null;

const webhookUrlEl = document.getElementById("webhookUrl");
const saveWebhookEl = document.getElementById("saveWebhook");
const buttonFormEl = document.getElementById("buttonForm");
const labelInputEl = document.getElementById("labelInput");
const searchTextInputEl = document.getElementById("searchTextInput");
const buttonsBodyEl = document.getElementById("buttonsBody");
const statusEl = document.getElementById("status");
const selectorConfigPreviewEl = document.getElementById("selectorConfigPreview");

init().catch((error) => setStatus(`Init failed: ${error.message}`, true));

async function init() {
  const stored = await chrome.storage.local.get([KEYS.WEBHOOK, KEYS.BUTTONS, KEYS.SELECTOR_CONFIG]);
  webhookUrlEl.value = stored[KEYS.WEBHOOK] || "";
  renderButtons(stored[KEYS.BUTTONS] || []);
  renderSelectorConfig(stored[KEYS.SELECTOR_CONFIG] || {});

  saveWebhookEl.addEventListener("click", saveWebhook);
  buttonFormEl.addEventListener("submit", saveButton);
}

async function saveWebhook() {
  const value = webhookUrlEl.value.trim();
  await chrome.storage.local.set({ [KEYS.WEBHOOK]: value });
  setStatus("Webhook saved.");
}

async function saveButton(event) {
  event.preventDefault();

  const label = labelInputEl.value.trim();
  const searchText = searchTextInputEl.value.trim();

  if (!label || !searchText) {
    setStatus("Label and Search Text are required.", true);
    return;
  }

  const stored = await chrome.storage.local.get(KEYS.BUTTONS);
  const buttons = stored[KEYS.BUTTONS] || [];

  if (editingId) {
    const idx = buttons.findIndex((b) => b.id === editingId);
    if (idx >= 0) {
      buttons[idx] = { ...buttons[idx], label, searchText };
    }
    editingId = null;
    document.getElementById("saveButton").textContent = "Save Button";
  } else {
    buttons.push({ id: createId(), label, searchText });
  }

  await chrome.storage.local.set({ [KEYS.BUTTONS]: buttons });
  labelInputEl.value = "";
  searchTextInputEl.value = "";
  renderButtons(buttons);
  setStatus("Buttons updated.");
}

function renderButtons(buttons) {
  buttonsBodyEl.innerHTML = "";

  if (!buttons.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 3;
    cell.textContent = "No buttons configured.";
    row.appendChild(cell);
    buttonsBodyEl.appendChild(row);
    return;
  }

  for (const button of buttons) {
    const row = document.createElement("tr");

    const labelCell = document.createElement("td");
    labelCell.textContent = button.label;

    const searchCell = document.createElement("td");
    searchCell.textContent = button.searchText;

    const actionsCell = document.createElement("td");
    actionsCell.className = "actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => startEdit(button));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => removeButton(button.id));

    actionsCell.append(editBtn, deleteBtn);
    row.append(labelCell, searchCell, actionsCell);
    buttonsBodyEl.appendChild(row);
  }
}

function startEdit(button) {
  editingId = button.id;
  labelInputEl.value = button.label;
  searchTextInputEl.value = button.searchText;
  document.getElementById("saveButton").textContent = "Update Button";
}

async function removeButton(id) {
  const stored = await chrome.storage.local.get(KEYS.BUTTONS);
  const buttons = (stored[KEYS.BUTTONS] || []).filter((b) => b.id !== id);
  await chrome.storage.local.set({ [KEYS.BUTTONS]: buttons });
  renderButtons(buttons);
  setStatus("Button removed.");
}

function renderSelectorConfig(selectorConfig) {
  selectorConfigPreviewEl.textContent = JSON.stringify(selectorConfig, null, 2);
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#bf2f2f" : "#1f6f39";
}

function createId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
