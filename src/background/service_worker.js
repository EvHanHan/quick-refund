import { ErrorCode, FlowState, FlowStatus, MAX_RETRIES, MessageType, TIMEOUTS_MS } from "../shared/contracts.js";
import { FlowError, toSafeError } from "../shared/errors.js";

const NAVAN_UPLOAD_RECEIPTS_URL = "https://app.navan.com/app/liquid/user/transactions/upload-receipts";
const LOGIN_CACHE_KEY = "provider_login_cache_v1";
const LOGIN_CACHE_CLEANUP_ALARM = "orange_login_cache_cleanup";
const UPDATE_STATUS_KEY = "manifest_update_status_v1";
const REPO_MANIFEST_URL = "https://raw.githubusercontent.com/MrCerise/dataiku-navan/main/manifest.json";
const UPLOAD_ACTION_TIMEOUT_MS = 120_000;
const PROVIDER_CONFIGS = {
  orange_provider: {
    loginUrl: "https://espace-client.orange.fr/selectionner-un-contrat?returnUrl=%2Ffacture-paiement%2F%257B%257Bcid%257D%257D&marketType=RES",
    billingUrl: "https://espace-client.orange.fr/selectionner-un-contrat?returnUrl=%2Ffacture-paiement%2F%257B%257Bcid%257D%257D&marketType=RES"
  },
  sfr_provider: {
    loginUrl: "https://espace-client.sfr.fr/",
    billingUrl: "https://espace-client.sfr.fr/facture-conso"
  },
  redbysfr_provider: {
    loginUrl: "https://espace-client-red.sfr.fr/facture-fixe/consultation",
    billingUrl: "https://espace-client-red.sfr.fr/facture-fixe/consultation"
  },
  bouygues_provider: {
    loginUrl: "https://www.bouyguestelecom.fr/mon-compte",
    billingUrl: "https://www.bouyguestelecom.fr/mon-compte/factures"
  },
  free_provider: {
    loginUrl: "https://subscribe.free.fr/login/do_login.pl",
    billingUrl: "https://adsl.free.fr/home.pl"
  },
  free_mobile_provider: {
    loginUrl: "https://mobile.free.fr/account/v2/login",
    billingUrl: "https://mobile.free.fr/account/v2/home"
  }
};

chrome.alarms.create(LOGIN_CACHE_CLEANUP_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm?.name === LOGIN_CACHE_CLEANUP_ALARM) {
    await clearExpiredLoginCache();
  }
});
void initializeUpdateStatus();

const stateOrder = [
  FlowState.OPEN_ORANGE_LOGIN,
  FlowState.AUTH_ORANGE,
  FlowState.NAVIGATE_ORANGE_BILLING,
  FlowState.DOWNLOAD_OR_SELECT_BILL,
  FlowState.OPEN_NAVAN
];

const flowContext = {
  state: FlowState.IDLE,
  status: FlowStatus.SUCCESS,
  events: [],
  retryCount: {},
  runConfig: null,
  orangeTabId: null,
  navanTabId: null,
  documentPayload: null,
  error: null,
  waitingForUser: false,
  waitingReason: null,
  providerLoginWatcher: null,
  inactivityTimer: null,
  startedAt: null,
  updateStatus: null
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: toSafeError(error) }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case MessageType.START_FLOW:
      return startFlow(message.payload);
    case MessageType.RESUME_FLOW:
      return resumeFlow();
    case MessageType.GET_STATUS:
      return { ok: true, data: getStatus() };
    case MessageType.CHECK_UPDATES:
      return { ok: true, data: await checkManifestUpdate(true) };
    default:
      return { ok: false, error: { code: ErrorCode.UNKNOWN, message: "Unsupported message type" } };
  }
}

async function startFlow(runConfig) {
  clearFlow();
  const normalizedProvider = normalizeProviderId(runConfig?.Provider);
  flowContext.startedAt = Date.now();
  flowContext.runConfig = {
    Username: String(runConfig?.Username || "").trim(),
    Password: String(runConfig?.Password || ""),
    AccountType: runConfig?.AccountType === "mobile_internet" ? "mobile_internet" : "home_internet",
    Provider: PROVIDER_CONFIGS[normalizedProvider] ? normalizedProvider : "orange_provider"
  };

  emitEvent(FlowState.CAPTURE_ORANGE_CREDENTIALS, FlowStatus.SUCCESS, "Credentials captured for this run");
  resetInactivityTimer();
  runStateMachine().catch((error) => failFlow(error));
  return { ok: true, data: getStatus() };
}

async function resumeFlow() {
  if (!flowContext.waitingForUser) {
    return { ok: false, error: { code: ErrorCode.UNKNOWN, message: "Flow is not waiting for user input" } };
  }

  flowContext.waitingForUser = false;
  const resumedReason = flowContext.waitingReason;
  flowContext.waitingReason = null;
  const resumeMessage = resumedReason === "ORANGE_CAPTCHA"
    ? "User resumed after Orange captcha"
    : resumedReason === "PROVIDER_MANUAL_LOGIN"
      ? "User resumed after provider manual login"
    : resumedReason === "NAVAN_MANUAL_UPLOAD"
      ? "User resumed after manual Navan upload"
      : "User resumed after Navan SSO checkpoint";
  emitEvent(flowContext.state, FlowStatus.SUCCESS, resumeMessage);
  stopProviderLoginWatcher();
  resetInactivityTimer();
  runStateMachine().catch((error) => failFlow(error));
  return { ok: true, data: getStatus() };
}

function getStatus() {
  return {
    state: flowContext.state,
    status: flowContext.status,
    events: flowContext.events.slice(-20),
    waitingForUser: flowContext.waitingForUser,
    error: flowContext.error,
    startedAt: flowContext.startedAt,
    updateStatus: flowContext.updateStatus
  };
}

async function runStateMachine() {
  for (const state of stateOrder) {
    if (flowContext.waitingForUser) return;
    if (flowContext.state === FlowState.DONE || flowContext.state === FlowState.FAILED) return;

    const currentIndex = stateOrder.indexOf(flowContext.state);
    const targetIndex = stateOrder.indexOf(state);
    if (flowContext.status === FlowStatus.SUCCESS && currentIndex >= 0 && targetIndex <= currentIndex) continue;

    await executeState(state, async () => runStep(state));
  }
}

async function runStep(state) {
  const providerConfig = PROVIDER_CONFIGS[flowContext.runConfig.Provider] || PROVIDER_CONFIGS.orange_provider;
  switch (state) {
    case FlowState.OPEN_ORANGE_LOGIN:
      flowContext.orangeTabId = await ensureTab(
        providerConfig.loginUrl,
        flowContext.orangeTabId
      );
      return;
    case FlowState.AUTH_ORANGE:
      {
        const session = await runProviderAction("CHECK_PROVIDER_SESSION", flowContext.orangeTabId, {
          Provider: flowContext.runConfig.Provider
        }, TIMEOUTS_MS.DEFAULT);
        if (session?.authenticated) {
          emitEvent(FlowState.AUTH_ORANGE, FlowStatus.SUCCESS, `${flowContext.runConfig.Provider} session already active, skipping login`);
          return;
        }

        const authResult = await runProviderAction("AUTH_PROVIDER", flowContext.orangeTabId, {
        Provider: flowContext.runConfig.Provider,
        username: flowContext.runConfig.Username,
        password: flowContext.runConfig.Password
      }, TIMEOUTS_MS.DEFAULT);

        if (authResult?.manualLoginRequired) {
          flowContext.waitingForUser = true;
          flowContext.waitingReason = "PROVIDER_MANUAL_LOGIN";
          emitEvent(
            FlowState.AUTH_ORANGE,
            FlowStatus.WAITING_USER,
            "Click Connexion and complete login/captcha manually. The flow will continue automatically once billing page is detected."
          );
          startProviderLoginWatcher();
        } else if (authResult?.captchaRequired) {
          flowContext.waitingForUser = true;
          flowContext.waitingReason = "ORANGE_CAPTCHA";
          emitEvent(FlowState.AUTH_ORANGE, FlowStatus.WAITING_USER, "Captcha detected on provider. Solve it in the tab, then click Resume.");
        }
      }
      return;
    case FlowState.NAVIGATE_ORANGE_BILLING:
      // Free ADSL uses session params in URL (ex: idt), avoid overriding current session page.
      if (flowContext.runConfig.Provider !== "free_provider") {
        await navigateTab(
          flowContext.orangeTabId,
          providerConfig.billingUrl
        );
      }
      {
        const navigation = await runProviderAction("NAVIGATE_BILLING", flowContext.orangeTabId, {
        Provider: flowContext.runConfig.Provider,
        AccountType: flowContext.runConfig.AccountType
      }, TIMEOUTS_MS.DEFAULT);
        if (!navigation?.detailUrl) {
          throw new FlowError(ErrorCode.ORANGE_BILL_NOT_FOUND, "Could not resolve provider bill detail URL");
        }
        await navigateTab(flowContext.orangeTabId, navigation.detailUrl);
      }
      return;
    case FlowState.DOWNLOAD_OR_SELECT_BILL: {
      const result = await runProviderAction("DOWNLOAD_AND_EXTRACT_BILL", flowContext.orangeTabId, {
        Provider: flowContext.runConfig.Provider
      }, TIMEOUTS_MS.LONG);
      if (!result?.document) {
        throw new FlowError(ErrorCode.ORANGE_BILL_NOT_FOUND, "Could not find downloadable billing document");
      }
      flowContext.documentPayload = result.document;
      return;
    }
    case FlowState.OPEN_NAVAN:
      flowContext.navanTabId = await ensureTab(NAVAN_UPLOAD_RECEIPTS_URL, flowContext.navanTabId);
      try {
        await runNavanAction("CHECK_SESSION", flowContext.navanTabId, {}, TIMEOUTS_MS.DEFAULT);
        flowContext.waitingForUser = false;
        flowContext.waitingReason = null;
        emitEvent(FlowState.OPEN_NAVAN, FlowStatus.SUCCESS, "Navan session already active, skipping SSO checkpoint");
        flowContext.state = FlowState.DONE;
        emitEvent(FlowState.DONE, FlowStatus.SUCCESS, "Flow completed after opening Navan");
      } catch (_error) {
        flowContext.waitingForUser = true;
        flowContext.waitingReason = "NAVAN_SSO";
        emitEvent(FlowState.WAIT_FOR_USER_GOOGLE_SSO, FlowStatus.WAITING_USER, "Complete Google SSO in Navan, then click Resume to finish");
      }
      return;
    case FlowState.WAIT_FOR_USER_GOOGLE_SSO:
      if (flowContext.waitingForUser) return;
      return;
    case FlowState.OPEN_LIQUID_HOME:
      await navigateTab(flowContext.navanTabId, NAVAN_UPLOAD_RECEIPTS_URL);
      await runNavanAction("CHECK_SESSION", flowContext.navanTabId, {}, TIMEOUTS_MS.DEFAULT);
      return;
    case FlowState.CLICK_NEW_TRANSACTION:
      await runNavanAction("CLICK_NEW_TRANSACTION", flowContext.navanTabId, {}, TIMEOUTS_MS.DEFAULT);
      return;
    case FlowState.UPLOAD_DOCUMENT:
      {
        const uploadResult = await runNavanAction(
          "UPLOAD_DOCUMENT",
          flowContext.navanTabId,
          { document: flowContext.documentPayload },
          UPLOAD_ACTION_TIMEOUT_MS
        );
        if (uploadResult?.manualUploadRequired) {
          flowContext.waitingForUser = true;
          flowContext.waitingReason = "NAVAN_MANUAL_UPLOAD";
          emitEvent(
            FlowState.UPLOAD_DOCUMENT,
            FlowStatus.WAITING_USER,
            "Upload the file manually in Navan, then click Resume."
          );
        }
      }
      return;
    case FlowState.REVIEW_AND_CONFIRM:
      emitEvent(FlowState.REVIEW_AND_CONFIRM, FlowStatus.WAITING_USER, "Review the transaction and submit manually");
      return;
    case FlowState.DONE:
      return;
    default:
      throw new FlowError(ErrorCode.UNKNOWN, `Unhandled state: ${state}`);
  }
}

async function executeState(state, action) {
  flowContext.state = state;
  emitEvent(state, FlowStatus.STARTED, `Entering ${state}`);

  if (state === FlowState.WAIT_FOR_USER_GOOGLE_SSO && flowContext.waitingForUser) {
    return;
  }

  const key = state;
  let attempt = flowContext.retryCount[key] || 0;

  while (attempt <= MAX_RETRIES) {
    try {
      await action();
      flowContext.retryCount[key] = attempt;
      flowContext.status = FlowStatus.SUCCESS;
      emitEvent(state, FlowStatus.SUCCESS, `${state} succeeded`);
      if (state === FlowState.REVIEW_AND_CONFIRM) {
        flowContext.state = FlowState.DONE;
        emitEvent(FlowState.DONE, FlowStatus.SUCCESS, "Flow completed and awaiting user submit");
      }
      return;
    } catch (error) {
      attempt += 1;
      flowContext.retryCount[key] = attempt;
      if (attempt > MAX_RETRIES) {
        throw error;
      }

      flowContext.status = FlowStatus.RETRY;
      emitEvent(state, FlowStatus.RETRY, `${state} retry ${attempt}/${MAX_RETRIES}`);
      await sleep(400 * attempt);
    }
  }
}

async function runProviderAction(action, tabId, payload, timeoutMs) {
  if (!tabId) {
    throw new FlowError(ErrorCode.ORANGE_TAB_NOT_FOUND, "Orange tab was not initialized");
  }

  const response = await sendTabMessage(tabId, {
    type: MessageType.RUN_PROVIDER_ACTION,
    action,
    payload
  }, timeoutMs);

  if (!response?.ok) {
    throw new FlowError(response?.error?.code || ErrorCode.ORANGE_BILL_NOT_FOUND, response?.error?.message || "Provider action failed");
  }

  return response.data;
}

async function runNavanAction(action, tabId, payload, timeoutMs) {
  if (!tabId) {
    throw new FlowError(ErrorCode.NAVAN_TAB_NOT_FOUND, "Navan tab was not initialized");
  }

  const response = await sendTabMessage(tabId, {
    type: MessageType.RUN_NAVAN_ACTION,
    action,
    payload
  }, timeoutMs);

  if (!response?.ok) {
    throw new FlowError(response?.error?.code || ErrorCode.NAVAN_FORM_FILL_FAILED, response?.error?.message || "Navan action failed");
  }

  return response.data;
}

function sendTabMessage(tabId, message, timeoutMs = TIMEOUTS_MS.DEFAULT) {
  return sendTabMessageWithRetry(tabId, message, timeoutMs, 3);
}

async function ensureTab(url, existingTabId) {
  if (existingTabId) {
    try {
      const tab = await chrome.tabs.get(existingTabId);
      if (tab?.id) {
        await navigateTab(tab.id, url);
        await chrome.tabs.update(tab.id, { active: true });
        return tab.id;
      }
    } catch (_error) {
      // Ignore and create a new tab.
    }
  }

  const tab = await chrome.tabs.create({ url, active: true });
  if (!tab.id) {
    throw new FlowError(ErrorCode.UNKNOWN, `Failed to create tab for ${url}`);
  }
  await waitForTabComplete(tab.id, TIMEOUTS_MS.LONG);
  return tab.id;
}

async function navigateTab(tabId, url) {
  await chrome.tabs.update(tabId, { url, active: true });
  await waitForTabComplete(tabId, TIMEOUTS_MS.LONG);
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new FlowError(ErrorCode.ACTION_TIMEOUT, `Tab load timeout for ${tabId}`));
    }, timeoutMs);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab?.status === "complete") finish();
    });
  });
}

function emitEvent(state, status, details, errorCode) {
  const event = {
    state,
    status,
    timestamp: new Date().toISOString(),
    errorCode,
    details
  };

  flowContext.events.push(event);
  if (flowContext.events.length > 200) {
    flowContext.events = flowContext.events.slice(-200);
  }

  chrome.runtime.sendMessage({ type: MessageType.FLOW_EVENT, payload: event }, () => {
    void chrome.runtime.lastError;
  });
}

function failFlow(error) {
  stopProviderLoginWatcher();
  const safe = toSafeError(error, ErrorCode.UNKNOWN);
  flowContext.state = FlowState.FAILED;
  flowContext.status = FlowStatus.FAILED;
  flowContext.error = safe;
  emitEvent(FlowState.FAILED, FlowStatus.FAILED, safe.message, safe.code);
  resetInactivityTimer();
}

function clearFlow() {
  stopProviderLoginWatcher();
  flowContext.state = FlowState.IDLE;
  flowContext.status = FlowStatus.SUCCESS;
  flowContext.events = [];
  flowContext.retryCount = {};
  flowContext.runConfig = null;
  flowContext.documentPayload = null;
  flowContext.error = null;
  flowContext.waitingForUser = false;
  flowContext.waitingReason = null;
  flowContext.providerLoginWatcher = null;
  flowContext.startedAt = null;
  if (flowContext.inactivityTimer) {
    clearTimeout(flowContext.inactivityTimer);
    flowContext.inactivityTimer = null;
  }
}

function resetInactivityTimer() {
  if (flowContext.inactivityTimer) {
    clearTimeout(flowContext.inactivityTimer);
  }

  flowContext.inactivityTimer = setTimeout(() => {
    clearFlow();
    emitEvent(FlowState.IDLE, FlowStatus.SUCCESS, "Flow cleared after inactivity timeout");
  }, TIMEOUTS_MS.INACTIVITY);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startProviderLoginWatcher() {
  stopProviderLoginWatcher();
  flowContext.providerLoginWatcher = setInterval(async () => {
    if (!flowContext.waitingForUser || flowContext.waitingReason !== "PROVIDER_MANUAL_LOGIN") {
      stopProviderLoginWatcher();
      return;
    }
    if (!flowContext.orangeTabId) return;

    try {
      const ready = await runProviderAction(
        "CHECK_PROVIDER_BILLING_READY",
        flowContext.orangeTabId,
        { Provider: flowContext.runConfig?.Provider },
        TIMEOUTS_MS.DEFAULT
      );
      if (!ready?.ready) return;

      flowContext.waitingForUser = false;
      flowContext.waitingReason = null;
      stopProviderLoginWatcher();
      emitEvent(FlowState.AUTH_ORANGE, FlowStatus.SUCCESS, "Provider billing page detected (Vos factures). Continuing flow.");
      runStateMachine().catch((error) => failFlow(error));
    } catch (_error) {
      // keep polling
    }
  }, 1500);
}

function stopProviderLoginWatcher() {
  if (!flowContext.providerLoginWatcher) return;
  clearInterval(flowContext.providerLoginWatcher);
  flowContext.providerLoginWatcher = null;
}

async function sendTabMessageWithRetry(tabId, message, timeoutMs, maxAttempts) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await sendTabMessageOnce(tabId, message, timeoutMs);
    } catch (error) {
      lastError = error;
      const text = String(error?.message || "");
      const shouldRetry = text.includes("Receiving end does not exist");
      if (!shouldRetry || attempt === maxAttempts) {
        throw error;
      }
      await sleep(300 * attempt);
    }
  }
  throw lastError || new FlowError(ErrorCode.ACTION_TIMEOUT, "Failed to send tab message");
}

function sendTabMessageOnce(tabId, message, timeoutMs) {
  return Promise.race([
    new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new FlowError(ErrorCode.ACTION_TIMEOUT, chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new FlowError(ErrorCode.ACTION_TIMEOUT, `Action timed out after ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
}

async function clearExpiredLoginCache() {
  const result = await chrome.storage.local.get(LOGIN_CACHE_KEY);
  const cached = result?.[LOGIN_CACHE_KEY];
  if (!cached?.expiresAt) return;
  if (cached.expiresAt > Date.now()) return;
  await chrome.storage.local.remove(LOGIN_CACHE_KEY);
}

function normalizeProviderId(provider) {
  const value = String(provider || "").trim();
  if (value === "freemobile_provider") return "free_mobile_provider";
  return value;
}

async function initializeUpdateStatus() {
  const result = await chrome.storage.local.get(UPDATE_STATUS_KEY);
  flowContext.updateStatus = result?.[UPDATE_STATUS_KEY] || null;
}

async function checkManifestUpdate(force) {
  const current = flowContext.updateStatus;
  if (!force && current?.lastCheckedAt && Date.now() - current.lastCheckedAt < 5 * 60_000) {
    return current;
  }

  const localVersion = chrome.runtime.getManifest()?.version || "0.0.0";
  try {
    const response = await fetch(REPO_MANIFEST_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const remoteManifest = await response.json();
    const remoteVersion = String(remoteManifest?.version || "").trim();
    if (!remoteVersion) {
      throw new Error("Remote manifest has no version");
    }

    const status = {
      checked: true,
      updateAvailable: compareVersions(remoteVersion, localVersion) > 0,
      localVersion,
      remoteVersion,
      source: REPO_MANIFEST_URL,
      error: null,
      lastCheckedAt: Date.now()
    };

    flowContext.updateStatus = status;
    await chrome.storage.local.set({ [UPDATE_STATUS_KEY]: status });
    return status;
  } catch (error) {
    const status = {
      checked: true,
      updateAvailable: false,
      localVersion,
      remoteVersion: current?.remoteVersion || null,
      source: REPO_MANIFEST_URL,
      error: String(error?.message || error),
      lastCheckedAt: Date.now()
    };
    flowContext.updateStatus = status;
    await chrome.storage.local.set({ [UPDATE_STATUS_KEY]: status });
    return status;
  }
}

function compareVersions(a, b) {
  const left = String(a).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const l = left[i] || 0;
    const r = right[i] || 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}
