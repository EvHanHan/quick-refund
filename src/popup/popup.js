import { MessageType } from "../shared/contracts.js";

const LOGIN_CACHE_KEY = "provider_login_cache_v1";
const LOGIN_CACHE_TTL_MS = 30 * 60 * 1000;

const startButton = document.getElementById("startFlow");
const resumeButton = document.getElementById("resumeFlow");
const statusLine = document.getElementById("statusLine");
const updateStatusLine = document.getElementById("updateStatus");
const eventLog = document.getElementById("eventLog");
const instructionBanner = document.getElementById("instructionBanner");
const UsernameInput = document.getElementById("Username");
const PasswordInput = document.getElementById("Password");
const AccountTypeInput = document.getElementById("AccountType");
const ProviderInput = document.getElementById("Provider");
const DEFAULT_BILLING_OPTIONS = [
  { value: "home_internet", label: "Home internet (Offre internet)" },
  { value: "mobile_internet", label: "Mobile internet (Forfait mobile)" }
];
const NAVIGO_BILLING_OPTIONS = [
  { value: "commuter_benefits", label: "Commuter Benefits" }
];

UsernameInput.addEventListener("input", persistLoginDraft);
AccountTypeInput.addEventListener("change", persistLoginDraft);
ProviderInput.addEventListener("change", () => {
  syncBillingTypeOptions(ProviderInput.value, AccountTypeInput.value);
  persistLoginDraft();
});
window.addEventListener("beforeunload", persistLoginDraft);

startButton.addEventListener("click", async () => {
  const Username = UsernameInput.value.trim();
  const Password = PasswordInput.value;
  const AccountType = AccountTypeInput.value;
  const Provider = ProviderInput.value;

  if (!Username) {
    statusLine.textContent = "Username is required.";
    return;
  }

  await saveLoginCache({
    Username,
    AccountType,
    Provider
  });

  startButton.disabled = true;
  statusLine.textContent = "Starting flow...";

  const response = await sendMessage({
    type: MessageType.START_FLOW,
    payload: {
      Username,
      Password,
      AccountType,
      Provider
    }
  });

  startButton.disabled = false;
  renderResponse(response);
});

resumeButton.addEventListener("click", async () => {
  resumeButton.disabled = true;
  const response = await sendMessage({
    type: MessageType.RESUME_FLOW,
    payload: {
      Password: PasswordInput.value
    }
  });
  renderResponse(response);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MessageType.FLOW_EVENT) {
    pollStatus();
  }
});

setInterval(pollStatus, 1000);
initPopup().catch(() => {
  // Ignore cache bootstrap failure and continue.
});

async function pollStatus() {
  const response = await sendMessage({ type: MessageType.GET_STATUS });
  renderResponse(response);
}

function renderResponse(response) {
  if (!response?.ok) {
    statusLine.textContent = `Error: ${response?.error?.message || "Unknown error"}`;
    return;
  }

  const data = response.data;
  statusLine.textContent = `${data.state} (${data.status})`;
  renderUpdateStatus(data.updateStatus);

  resumeButton.disabled = !data.waitingForUser;
  updateInstructionBanner(data);

  const events = data.events || [];
  eventLog.textContent = events
    .slice(-8)
    .map((event) => `${event.timestamp} | ${event.state} | ${event.status} | ${event.details || ""}`)
    .join("\n");
}

function renderUpdateStatus(updateStatus) {
  if (!updateStatusLine) return;
  if (!updateStatus || !updateStatus.checked) {
    updateStatusLine.textContent = "Update check: pending";
    return;
  }
  if (updateStatus.error) {
    updateStatusLine.textContent = `Update check failed (${updateStatus.error})`;
    return;
  }
  if (updateStatus.updateAvailable) {
    updateStatusLine.textContent = `Update available: ${updateStatus.remoteVersion} (current ${updateStatus.localVersion})`;
    return;
  }
  updateStatusLine.textContent = `Up to date (${updateStatus.localVersion})`;
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: { message: chrome.runtime.lastError.message } });
        return;
      }
      resolve(response || { ok: false, error: { message: "No response" } });
    });
  });
}

function updateInstructionBanner(data) {
  if (!data.waitingForUser) {
    instructionBanner.textContent = "";
    instructionBanner.classList.add("hidden");
    return;
  }

  const events = data.events || [];
  const waitingEvent = [...events].reverse().find((event) => event.status === "waiting_user");
  if (!waitingEvent) {
    instructionBanner.textContent = "";
    instructionBanner.classList.add("hidden");
    return;
  }

  instructionBanner.textContent = waitingEvent.details || "Action required from user.";
  instructionBanner.classList.remove("hidden");
}

async function initPopup() {
  await loadLoginCacheIntoForm();
  await sendMessage({ type: MessageType.CHECK_UPDATES });
  await pollStatus();
}

async function loadLoginCacheIntoForm() {
  const cached = await readLoginCache();
  const provider = cached?.Provider === "freemobile_provider" ? "free_mobile_provider" : cached?.Provider;
  ProviderInput.value = provider || "orange_provider";
  syncBillingTypeOptions(ProviderInput.value, cached?.AccountType);
  if (!cached) return;
  UsernameInput.value = cached.Username || "";
}

async function saveLoginCache(login) {
  const payload = {
    ...login,
    expiresAt: Date.now() + LOGIN_CACHE_TTL_MS
  };
  await chrome.storage.local.set({ [LOGIN_CACHE_KEY]: payload });
}

async function readLoginCache() {
  const result = await chrome.storage.local.get(LOGIN_CACHE_KEY);
  const cached = result?.[LOGIN_CACHE_KEY];
  if (!cached) return null;

  if (!cached.expiresAt || cached.expiresAt <= Date.now()) {
    await chrome.storage.local.remove(LOGIN_CACHE_KEY);
    return null;
  }

  // Purge legacy password fields from old cache schema.
  if (Object.prototype.hasOwnProperty.call(cached, "Password")) {
    const cleaned = {
      Username: String(cached.Username || "").trim(),
      AccountType: cached.AccountType === "mobile_internet" ? "mobile_internet" : "home_internet",
      Provider: String(cached.Provider || ""),
      expiresAt: cached.expiresAt
    };
    await chrome.storage.local.set({ [LOGIN_CACHE_KEY]: cleaned });
    return cleaned;
  }

  return cached;
}

function persistLoginDraft() {
  const Username = UsernameInput.value.trim();
  const AccountType = AccountTypeInput.value;
  const Provider = ProviderInput.value;
  if (!Username) return;
  void saveLoginCache({ Username, AccountType, Provider });
}

function syncBillingTypeOptions(provider, preferredValue) {
  const options = provider === "navigo_provider" ? NAVIGO_BILLING_OPTIONS : DEFAULT_BILLING_OPTIONS;
  setBillingTypeOptions(options, preferredValue);
}

function setBillingTypeOptions(options, preferredValue) {
  if (!Array.isArray(options) || options.length === 0) return;
  const previous = preferredValue || AccountTypeInput.value;
  AccountTypeInput.innerHTML = options
    .map((option) => `<option value="${option.value}">${option.label}</option>`)
    .join("");

  const hasPreferred = options.some((option) => option.value === previous);
  AccountTypeInput.value = hasPreferred ? previous : options[0].value;
}
