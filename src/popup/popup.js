import { MessageType } from "../shared/contracts.js";

const LOGIN_CACHE_KEY = "provider_login_cache_v1";
const LOGIN_CACHE_TTL_MS = 30 * 60 * 1000;
const REMINDER_SETTINGS_KEY = "monthly_reminder_settings_v1";

const startButton = document.getElementById("startFlow");
const statusLine = document.getElementById("statusLine");
const updateStatusLine = document.getElementById("updateStatus");
const eventLog = document.getElementById("eventLog");
const instructionBanner = document.getElementById("instructionBanner");
const showStatusInput = document.getElementById("ShowStatus");
const statusSection = document.getElementById("statusSection");
const AccountTypeInput = document.getElementById("AccountType");
const ProviderInput = document.getElementById("Provider");
const MonthlyReminderEnabledInput = document.getElementById("MonthlyReminderEnabled");
const DEFAULT_BILLING_OPTIONS = [
  { value: "home_internet", label: "Internet" },
  { value: "mobile_internet", label: "Mobile" }
];
const FREE_BILLING_OPTIONS = [
  { value: "home_internet", label: "Internet" }
];
const FREE_MOBILE_BILLING_OPTIONS = [
  { value: "mobile_internet", label: "Mobile" }
];
const NAVIGO_BILLING_OPTIONS = [
  { value: "monthly", label: "monthly" },
  { value: "yearly", label: "yearly" }
];

AccountTypeInput.addEventListener("change", persistLoginDraft);
ProviderInput.addEventListener("change", () => {
  syncBillingTypeOptions(ProviderInput.value, AccountTypeInput.value);
  persistLoginDraft();
});
window.addEventListener("beforeunload", persistLoginDraft);
MonthlyReminderEnabledInput.addEventListener("change", () => {
  void updateReminderSettings(MonthlyReminderEnabledInput.checked);
});
showStatusInput.addEventListener("change", () => {
  setStatusVisibility(showStatusInput.checked);
});

startButton.addEventListener("click", async () => {
  const AccountType = AccountTypeInput.value;
  const Provider = ProviderInput.value;

  await saveLoginCache({
    AccountType,
    Provider
  });

  startButton.disabled = true;
  statusLine.textContent = "Starting flow...";

  const response = await sendMessage({
    type: MessageType.START_FLOW,
    payload: {
      AccountType,
      Provider
    }
  });

  startButton.disabled = false;
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

  updateInstructionBanner(data);

  const events = data.events || [];
  eventLog.textContent = events
    .slice(-50)
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
  setStatusVisibility(showStatusInput.checked);
  await loadLoginCacheIntoForm();
  await loadReminderSettingsIntoForm();
  await sendMessage({ type: MessageType.CHECK_UPDATES });
  await pollStatus();
}

function setStatusVisibility(visible) {
  statusSection.classList.toggle("hidden", !visible);
}

async function loadLoginCacheIntoForm() {
  const cached = await readLoginCache();
  const provider = cached?.Provider === "freemobile_provider" ? "free_mobile_provider" : cached?.Provider;
  ProviderInput.value = provider || "orange_provider";
  syncBillingTypeOptions(ProviderInput.value, cached?.AccountType);
}

async function saveLoginCache(login) {
  const payload = {
    ...login,
    expiresAt: Date.now() + LOGIN_CACHE_TTL_MS
  };
  await chrome.storage.local.set({ [LOGIN_CACHE_KEY]: payload });
}

async function loadReminderSettingsIntoForm() {
  const result = await chrome.storage.local.get(REMINDER_SETTINGS_KEY);
  const enabled = typeof result?.[REMINDER_SETTINGS_KEY]?.enabled === "boolean"
    ? result[REMINDER_SETTINGS_KEY].enabled
    : true;
  MonthlyReminderEnabledInput.checked = enabled;
}

async function updateReminderSettings(enabled) {
  await chrome.storage.local.set({ [REMINDER_SETTINGS_KEY]: { enabled } });
  await sendMessage({
    type: MessageType.UPDATE_REMINDER_SETTINGS,
    payload: { enabled }
  });
}

async function readLoginCache() {
  const result = await chrome.storage.local.get(LOGIN_CACHE_KEY);
  const cached = result?.[LOGIN_CACHE_KEY];
  if (!cached) return null;

  if (!cached.expiresAt || cached.expiresAt <= Date.now()) {
    await chrome.storage.local.remove(LOGIN_CACHE_KEY);
    return null;
  }

  // Purge legacy fields from old cache schema.
  if (
    Object.prototype.hasOwnProperty.call(cached, "Password")
    || Object.prototype.hasOwnProperty.call(cached, "Username")
  ) {
    const legacyAccountType = cached.AccountType;
    const cleaned = {
      AccountType: legacyAccountType === "mobile_internet"
        ? "mobile_internet"
        : legacyAccountType === "commuter_benefits"
          ? "yearly"
          : legacyAccountType === "yearly"
            ? "yearly"
            : legacyAccountType === "monthly"
              ? "monthly"
          : "home_internet",
      Provider: String(cached.Provider || ""),
      expiresAt: cached.expiresAt
    };
    await chrome.storage.local.set({ [LOGIN_CACHE_KEY]: cleaned });
    return cleaned;
  }

  if (cached.AccountType === "commuter_benefits") {
    const migrated = {
      ...cached,
      AccountType: "yearly"
    };
    await chrome.storage.local.set({ [LOGIN_CACHE_KEY]: migrated });
    return migrated;
  }

  return cached;
}

function persistLoginDraft() {
  const AccountType = AccountTypeInput.value;
  const Provider = ProviderInput.value;
  void saveLoginCache({ AccountType, Provider });
}

function syncBillingTypeOptions(provider, preferredValue) {
  const options = provider === "navigo_provider"
    ? NAVIGO_BILLING_OPTIONS
    : provider === "free_provider"
      ? FREE_BILLING_OPTIONS
    : provider === "free_mobile_provider"
      ? FREE_MOBILE_BILLING_OPTIONS
      : DEFAULT_BILLING_OPTIONS;
  setBillingTypeOptions(options, preferredValue);
}

function setBillingTypeOptions(options, preferredValue) {
  if (!Array.isArray(options) || options.length === 0) return;
  const normalizedPreferredValue = preferredValue === "commuter_benefits"
    ? "yearly"
    : preferredValue;
  const previous = normalizedPreferredValue || AccountTypeInput.value;
  AccountTypeInput.innerHTML = options
    .map((option) => `<option value="${option.value}">${option.label}</option>`)
    .join("");

  const hasPreferred = options.some((option) => option.value === previous);
  AccountTypeInput.value = hasPreferred ? previous : options[0].value;
}
