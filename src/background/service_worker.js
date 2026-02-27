import { ErrorCode, FlowState, FlowStatus, MAX_RETRIES, MessageType, TIMEOUTS_MS } from "../shared/contracts.js";
import { FlowError, toSafeError } from "../shared/errors.js";
import {
  MAX_REMINDER_ATTEMPTS,
  REMINDER_HOUR_LOCAL,
  getCurrentOrNextCycleBase,
  getCycleKey,
  nextWeekdaySameTime,
  resolveNextDueFromBase
} from "../shared/reminder_schedule.js";

const NAVAN_UPLOAD_RECEIPTS_URL = "https://app.navan.com/app/liquid/user/transactions/upload-receipts";
const LOGIN_CACHE_KEY = "provider_login_cache_v1";
const LOGIN_CACHE_CLEANUP_ALARM = "orange_login_cache_cleanup";
const MONTHLY_REMINDER_ALARM = "monthly_reimbursement_reminder";
const REMINDER_SETTINGS_KEY = "monthly_reminder_settings_v1";
const REMINDER_STATE_KEY = "monthly_reminder_state_v1";
const REMINDER_HISTORY_KEY = "monthly_reminder_history_v1";
const REMINDER_DUE_KEY = "monthly_reminder_due_v1";
const REMINDER_NOTIFICATION_ID = "monthly_reimbursement_notification";
const REMINDER_LATE_GRACE_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const UPDATE_STATUS_KEY = "manifest_update_status_v1";
const REPO_MANIFEST_URL = "https://raw.githubusercontent.com/MrCerise/dataiku-navan/main/manifest.json";
const UPLOAD_ACTION_TIMEOUT_MS = 120_000;
const PROVIDER_CONFIGS = {
  orange_provider: {
    loginUrl: "https://espace-client.orange.fr/selectionner-un-contrat?returnUrl=%2Ffacture-paiement%2F%257B%257Bcid%257D%257D&marketType=RES",
    billingUrl: "https://espace-client.orange.fr/selectionner-un-contrat?returnUrl=%2Ffacture-paiement%2F%257B%257Bcid%257D%257D&marketType=RES"
  },
  sosh_provider: {
    loginUrl: "https://login.orange.fr/?service=sosh&return_url=https%3A%2F%2Fwww.sosh.fr%2F&propagation=true&domain=sosh&force_authent=true",
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
    billingUrl: "https://mobile.free.fr/account/v2"
  },
  navigo_provider: {
    loginUrl: "https://mon-espace.iledefrance-mobilites.fr",
    billingUrl: "https://mon-espace.iledefrance-mobilites.fr"
  }
};

chrome.alarms.create(LOGIN_CACHE_CLEANUP_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  void handleAlarm(alarm);
});
chrome.notifications.onClicked.addListener((notificationId) => {
  if (!String(notificationId || "").startsWith(REMINDER_NOTIFICATION_ID)) return;
  void openReminderLandingPage();
});
chrome.runtime.onStartup.addListener(() => {
  void scheduleMonthlyReminder();
  void refreshReminderBadge();
});
chrome.runtime.onInstalled.addListener(() => {
  void scheduleMonthlyReminder();
  void refreshReminderBadge();
});
void initializeUpdateStatus();
void scheduleMonthlyReminder();
void refreshReminderBadge();

const stateOrder = [
  FlowState.OPEN_ORANGE_LOGIN,
  FlowState.AUTH_ORANGE,
  FlowState.NAVIGATE_ORANGE_BILLING,
  FlowState.DOWNLOAD_OR_SELECT_BILL,
  FlowState.OPEN_NAVAN
];

const flowContext = {
  activeRunId: 0,
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
      return resumeFlow(message.payload || {});
    case MessageType.STOP_FLOW:
      return stopFlow();
    case MessageType.GET_STATUS:
      return { ok: true, data: getStatus() };
    case MessageType.CHECK_UPDATES:
      return { ok: true, data: await checkManifestUpdate(true) };
    case MessageType.UPDATE_REMINDER_SETTINGS:
      return updateReminderSettings(message.payload);
    case MessageType.TRIGGER_REMINDER_TEST:
      return triggerReminderTest();
    default:
      return { ok: false, error: { code: ErrorCode.UNKNOWN, message: "Unsupported message type" } };
  }
}

async function handleAlarm(alarm) {
  try {
    if (!alarm?.name) return;
    if (alarm.name === LOGIN_CACHE_CLEANUP_ALARM) {
      await clearExpiredLoginCache();
      return;
    }
    if (alarm.name === MONTHLY_REMINDER_ALARM) {
      await handleMonthlyReminderAlarm();
      return;
    }
  } catch (error) {
    console.warn("Reminder alarm failed", error);
  }
}

async function updateReminderSettings(payload) {
  const enabled = Boolean(payload?.enabled);
  await chrome.storage.local.set({ [REMINDER_SETTINGS_KEY]: { enabled } });
  const nextReminderAt = await scheduleMonthlyReminder();
  if (!enabled) {
    await setReminderDue(false);
  }
  return {
    ok: true,
    data: {
      enabled,
      nextReminderAt: nextReminderAt ? nextReminderAt.toISOString() : null
    }
  };
}

async function triggerReminderTest() {
  const permissionLevel = await chrome.notifications.getPermissionLevel();
  if (permissionLevel !== "granted") {
    return {
      ok: false,
      error: {
        code: ErrorCode.UNKNOWN,
        message: `Chrome notification permission is '${permissionLevel}'. Enable notifications for Chrome in system settings.`
      }
    };
  }

  const notificationId = `${REMINDER_NOTIFICATION_ID}_${Date.now()}`;
  await showMonthlyReminderNotification(notificationId, "test");
  await setReminderDue(true, new Date().toISOString());
  return {
    ok: true,
    data: {
      triggeredAt: new Date().toISOString(),
      notificationId,
      permissionLevel,
      created: true
    }
  };
}

async function startFlow(runConfig) {
  await setReminderDue(false);
  clearFlow();
  const runId = beginNewRun();
  const normalizedProvider = normalizeProviderId(runConfig?.Provider);
  flowContext.startedAt = Date.now();
  flowContext.runConfig = {
    Password: String(runConfig?.Password || ""),
    AccountType: runConfig?.AccountType === "mobile_internet" ? "mobile_internet" : "home_internet",
    Provider: PROVIDER_CONFIGS[normalizedProvider] ? normalizedProvider : "orange_provider"
  };

  emitEvent(
    FlowState.CAPTURE_ORANGE_CREDENTIALS,
    FlowStatus.SUCCESS,
    "Flow settings captured for this run"
  );
  resetInactivityTimer();
  runStateMachine(runId).catch((error) => failFlow(error, runId));
  return { ok: true, data: getStatus() };
}

async function resumeFlow(payload) {
  if (!flowContext.waitingForUser) {
    return { ok: false, error: { code: ErrorCode.UNKNOWN, message: "Flow is not waiting for user input" } };
  }

  if (flowContext.waitingReason === "PROVIDER_MANUAL_LOGIN" && typeof payload?.Password === "string" && payload.Password.trim()) {
    flowContext.runConfig.Password = payload.Password;
    flowContext.status = FlowStatus.RETRY;
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
  const runId = flowContext.activeRunId;
  runStateMachine(runId).catch((error) => failFlow(error, runId));
  return { ok: true, data: getStatus() };
}

async function stopFlow() {
  beginNewRun();
  const hadActiveFlow = flowContext.state !== FlowState.IDLE || flowContext.waitingForUser;
  clearFlow();
  emitEvent(
    FlowState.IDLE,
    FlowStatus.SUCCESS,
    hadActiveFlow ? "Flow stopped by user" : "No active flow to stop"
  );
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

async function runStateMachine(runId) {
  for (const state of stateOrder) {
    if (!isRunActive(runId)) return;
    if (flowContext.waitingForUser) return;
    if (flowContext.state === FlowState.DONE || flowContext.state === FlowState.FAILED) return;

    const currentIndex = stateOrder.indexOf(flowContext.state);
    const targetIndex = stateOrder.indexOf(state);
    if (flowContext.status === FlowStatus.SUCCESS && currentIndex >= 0 && targetIndex <= currentIndex) continue;

    await executeState(state, async () => runStep(state), runId);
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
        emitEvent(
          FlowState.AUTH_ORANGE,
          FlowStatus.STARTED,
          `Provider action CHECK_PROVIDER_SESSION (provider=${flowContext.runConfig.Provider}, timeout=${TIMEOUTS_MS.DEFAULT}ms)`
        );
        const session = await runProviderAction("CHECK_PROVIDER_SESSION", flowContext.orangeTabId, {
          Provider: flowContext.runConfig.Provider
        }, TIMEOUTS_MS.DEFAULT);
        emitEvent(
          FlowState.AUTH_ORANGE,
          FlowStatus.STARTED,
          `Provider action CHECK_PROVIDER_SESSION completed (authenticated=${Boolean(session?.authenticated)})`
        );
        if (flowContext.runConfig.Provider === "free_mobile_provider" && session?.diagnostics) {
          emitEvent(
            FlowState.AUTH_ORANGE,
            FlowStatus.STARTED,
            `Free Mobile session probe: auth=${Boolean(session?.authenticated)} | ${formatFreeMobileDiagnostics(session.diagnostics)}`
          );
        }
        if (session?.authenticated) {
          clearRunPassword();
          emitEvent(
            FlowState.AUTH_ORANGE,
            FlowStatus.SUCCESS,
            `${flowContext.runConfig.Provider} session already active, skipping login${flowContext.runConfig.Provider === "free_mobile_provider" && session?.diagnostics ? ` | ${formatFreeMobileDiagnostics(session.diagnostics)}` : ""}`
          );
          return;
        }

        emitEvent(
          FlowState.AUTH_ORANGE,
          FlowStatus.STARTED,
          `Provider action AUTH_PROVIDER (provider=${flowContext.runConfig.Provider}, timeout=${TIMEOUTS_MS.DEFAULT}ms)`
        );
        const authResult = await runProviderAction("AUTH_PROVIDER", flowContext.orangeTabId, {
          Provider: flowContext.runConfig.Provider
        }, TIMEOUTS_MS.DEFAULT);
        emitEvent(
          FlowState.AUTH_ORANGE,
          FlowStatus.STARTED,
          `Provider action AUTH_PROVIDER completed (authenticated=${Boolean(authResult?.authenticated)} manual=${Boolean(authResult?.manualLoginRequired)} captcha=${Boolean(authResult?.captchaRequired)})`
        );
        if (flowContext.runConfig.Provider === "free_mobile_provider") {
          emitEvent(
            FlowState.AUTH_ORANGE,
            FlowStatus.STARTED,
            `Free Mobile auth result: manual=${Boolean(authResult?.manualLoginRequired)} captcha=${Boolean(authResult?.captchaRequired)} otp=${Boolean(authResult?.smsCodeRequired)}`
          );
        }

        if (authResult?.manualLoginRequired) {
          flowContext.waitingForUser = true;
          flowContext.waitingReason = "PROVIDER_MANUAL_LOGIN";
          emitEvent(
            FlowState.AUTH_ORANGE,
            FlowStatus.WAITING_USER,
            "Finish login in provider tab. The flow resumes automatically after provider login is detected."
          );
          startProviderLoginWatcher();
        } else if (authResult?.captchaRequired) {
          flowContext.waitingForUser = true;
          flowContext.waitingReason = "ORANGE_CAPTCHA";
          emitEvent(FlowState.AUTH_ORANGE, FlowStatus.WAITING_USER, "Captcha detected on provider. Solve it in the tab, or click Stop to cancel.");
        } else {
          clearRunPassword();
        }
      }
      return;
    case FlowState.NAVIGATE_ORANGE_BILLING:
      // Free ADSL uses session params in URL (ex: idt), avoid overriding current session page.
      if (
        flowContext.runConfig.Provider !== "free_provider"
        && flowContext.runConfig.Provider !== "free_mobile_provider"
        && flowContext.runConfig.Provider !== "navigo_provider"
      ) {
        await navigateTab(
          flowContext.orangeTabId,
          providerConfig.billingUrl
        );
      }
      {
        emitEvent(
          FlowState.NAVIGATE_ORANGE_BILLING,
          FlowStatus.STARTED,
          `Provider action NAVIGATE_BILLING (provider=${flowContext.runConfig.Provider}, timeout=${TIMEOUTS_MS.DEFAULT}ms)`
        );
        let navigation = await runProviderAction("NAVIGATE_BILLING", flowContext.orangeTabId, {
        Provider: flowContext.runConfig.Provider,
        AccountType: flowContext.runConfig.AccountType
      }, TIMEOUTS_MS.DEFAULT);
        emitEvent(
          FlowState.NAVIGATE_ORANGE_BILLING,
          FlowStatus.STARTED,
          `Provider action NAVIGATE_BILLING completed (navigated=${Boolean(navigation?.navigated)} detailUrl=${navigation?.detailUrl || "none"})`
        );
        if (!navigation?.detailUrl) {
          throw new FlowError(ErrorCode.ORANGE_BILL_NOT_FOUND, "Could not resolve provider bill detail URL");
        }
        await navigateTab(flowContext.orangeTabId, navigation.detailUrl);

        if (flowContext.runConfig.Provider === "navigo_provider") {
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            const onPrelevements = /\/prelevements\/[^/?#]+/i.test(String(navigation.detailUrl || ""));
            if (onPrelevements) break;

            emitEvent(
              FlowState.NAVIGATE_ORANGE_BILLING,
              FlowStatus.STARTED,
              `Navigo extra NAVIGATE_BILLING pass ${attempt}/2`
            );
            navigation = await runProviderAction("NAVIGATE_BILLING", flowContext.orangeTabId, {
              Provider: flowContext.runConfig.Provider,
              AccountType: flowContext.runConfig.AccountType
            }, TIMEOUTS_MS.DEFAULT);
            emitEvent(
              FlowState.NAVIGATE_ORANGE_BILLING,
              FlowStatus.STARTED,
              `Navigo extra pass ${attempt}/2 resolved detailUrl=${navigation?.detailUrl || "none"}`
            );
            if (!navigation?.detailUrl) break;
            await navigateTab(flowContext.orangeTabId, navigation.detailUrl);
          }
        }
      }
      return;
    case FlowState.DOWNLOAD_OR_SELECT_BILL: {
      emitEvent(
        FlowState.DOWNLOAD_OR_SELECT_BILL,
        FlowStatus.STARTED,
        `Provider action DOWNLOAD_AND_EXTRACT_BILL (provider=${flowContext.runConfig.Provider}, timeout=${TIMEOUTS_MS.LONG}ms)`
      );
      const result = await runProviderAction("DOWNLOAD_AND_EXTRACT_BILL", flowContext.orangeTabId, {
        Provider: flowContext.runConfig.Provider
      }, TIMEOUTS_MS.LONG);
      emitEvent(
        FlowState.DOWNLOAD_OR_SELECT_BILL,
        FlowStatus.STARTED,
        `Provider action DOWNLOAD_AND_EXTRACT_BILL completed (hasDocument=${Boolean(result?.document)} sourceUrl=${result?.document?.sourceUrl || "none"})`
      );
      if (result?.diagnostics) {
        const d = result.diagnostics;
        emitEvent(
          FlowState.DOWNLOAD_OR_SELECT_BILL,
          FlowStatus.STARTED,
          `Download diagnostics (controlMs=${d.downloadControlMs ?? "n/a"} urlMs=${d.downloadUrlMs ?? "n/a"} totalMs=${d.totalMs ?? "n/a"} onDetail=${Boolean(d.onDetailPage)} sourceUrl=${d.sourceUrl || "none"})`
        );
      }
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
        emitEvent(FlowState.WAIT_FOR_USER_GOOGLE_SSO, FlowStatus.WAITING_USER, "Complete Google SSO in Navan, or click Stop to cancel.");
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
            "Upload the file manually in Navan, or click Stop to cancel."
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

async function executeState(state, action, runId) {
  if (!isRunActive(runId)) return;
  flowContext.state = state;
  emitEvent(state, FlowStatus.STARTED, `Entering ${state}`);

  if (state === FlowState.WAIT_FOR_USER_GOOGLE_SSO && flowContext.waitingForUser) {
    return;
  }

  const key = state;
  let attempt = flowContext.retryCount[key] || 0;

  while (attempt <= MAX_RETRIES) {
    if (!isRunActive(runId)) return;
    try {
      await action();
      if (!isRunActive(runId)) return;
      flowContext.retryCount[key] = attempt;
      flowContext.status = FlowStatus.SUCCESS;
      emitEvent(state, FlowStatus.SUCCESS, `${state} succeeded`);
      if (state === FlowState.REVIEW_AND_CONFIRM) {
        flowContext.state = FlowState.DONE;
        emitEvent(FlowState.DONE, FlowStatus.SUCCESS, "Flow completed and awaiting user submit");
      }
      return;
    } catch (error) {
      if (!isRunActive(runId)) return;
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

function failFlow(error, runId = flowContext.activeRunId) {
  if (!isRunActive(runId)) return;
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

function beginNewRun() {
  flowContext.activeRunId += 1;
  return flowContext.activeRunId;
}

function isRunActive(runId) {
  return runId === flowContext.activeRunId;
}

function clearRunPassword() {
  if (!flowContext.runConfig) return;
  flowContext.runConfig.Password = "";
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
  const runId = flowContext.activeRunId;
  flowContext.providerLoginWatcher = setInterval(async () => {
    if (!isRunActive(runId)) {
      stopProviderLoginWatcher();
      return;
    }
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
      runStateMachine(runId).catch((error) => failFlow(error, runId));
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

async function handleMonthlyReminderAlarm() {
  const settings = await getReminderSettings();
  if (!settings.enabled) {
    await clearReminderSchedule();
    return;
  }

  const state = await getReminderState();
  if (!state) {
    await scheduleMonthlyReminder();
    return;
  }

  const nowMs = Date.now();
  await showMonthlyReminderNotification(REMINDER_NOTIFICATION_ID, "monthly");
  await setReminderDue(true, new Date().toISOString());
  if (state.attemptNumber === 1 && nowMs - state.nextDueAtMs <= REMINDER_LATE_GRACE_MS) {
    const nextCycle = buildNewCycleState(new Date(state.nextDueAtMs + DAY_MS));
    await chrome.storage.local.set({ [REMINDER_STATE_KEY]: nextCycle });
    await chrome.alarms.create(MONTHLY_REMINDER_ALARM, { when: nextCycle.nextDueAtMs });
    return;
  }

  const advanced = advanceReminderState(state);
  await chrome.storage.local.set({ [REMINDER_STATE_KEY]: advanced });
  await scheduleMonthlyReminder();
}

async function scheduleMonthlyReminder(now = new Date()) {
  const settings = await getReminderSettings();
  if (!settings.enabled) {
    await clearReminderSchedule();
    return null;
  }

  const state = await getReminderState();
  const resolved = resolveReminderStateForNow(state, now);
  await chrome.storage.local.set({ [REMINDER_STATE_KEY]: resolved });
  await chrome.alarms.create(MONTHLY_REMINDER_ALARM, { when: resolved.nextDueAtMs });
  return new Date(resolved.nextDueAtMs);
}

async function clearReminderSchedule() {
  await chrome.alarms.clear(MONTHLY_REMINDER_ALARM);
  await chrome.storage.local.remove(REMINDER_STATE_KEY);
}

async function setReminderDue(due, sinceISO = null) {
  const payload = due
    ? {
      due: true,
      since: sinceISO || new Date().toISOString()
    }
    : {
      due: false,
      since: null
    };
  await chrome.storage.local.set({ [REMINDER_DUE_KEY]: payload });
  await applyReminderBadge(payload);
}

async function refreshReminderBadge() {
  const result = await chrome.storage.local.get(REMINDER_DUE_KEY);
  const payload = result?.[REMINDER_DUE_KEY];
  await applyReminderBadge(payload);
}

async function applyReminderBadge(payload) {
  const isDue = Boolean(payload?.due);
  if (isDue) {
    await chrome.action.setBadgeBackgroundColor({ color: "#dc3545" });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setTitle({ title: "Reminder due: start reimbursement flow" });
    return;
  }
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "1-click navan refund" });
}

function resolveReminderStateForNow(state, now = new Date()) {
  const nowMs = now.getTime();
  if (!state || !Number.isFinite(state.baseDueAtMs) || !Number.isFinite(state.nextDueAtMs) || !Number.isInteger(state.attemptNumber)) {
    return buildNewCycleState(now);
  }

  if (nowMs <= state.nextDueAtMs) {
    return state;
  }

  const baseDueAt = new Date(state.baseDueAtMs);
  const nextDue = resolveNextDueFromBase(baseDueAt, now, MAX_REMINDER_ATTEMPTS - 1);
  if (!nextDue) {
    return buildNewCycleState(now);
  }

  return {
    cycleKey: getCycleKey(baseDueAt),
    baseDueAtMs: baseDueAt.getTime(),
    nextDueAtMs: nextDue.dueAt.getTime(),
    attemptNumber: nextDue.attemptNumber
  };
}

function buildNewCycleState(now = new Date()) {
  const baseDueAt = getCurrentOrNextCycleBase(now, REMINDER_HOUR_LOCAL);
  return {
    cycleKey: getCycleKey(baseDueAt),
    baseDueAtMs: baseDueAt.getTime(),
    nextDueAtMs: baseDueAt.getTime(),
    attemptNumber: 1
  };
}

function advanceReminderState(state) {
  if (!state || !Number.isFinite(state.nextDueAtMs) || !Number.isInteger(state.attemptNumber)) {
    return buildNewCycleState();
  }

  if (state.attemptNumber >= MAX_REMINDER_ATTEMPTS) {
    return buildNewCycleState(new Date(state.nextDueAtMs + DAY_MS));
  }

  const nextDueAt = nextWeekdaySameTime(new Date(state.nextDueAtMs));
  return {
    cycleKey: state.cycleKey,
    baseDueAtMs: state.baseDueAtMs,
    nextDueAtMs: nextDueAt.getTime(),
    attemptNumber: state.attemptNumber + 1
  };
}

async function getReminderSettings() {
  const result = await chrome.storage.local.get(REMINDER_SETTINGS_KEY);
  const raw = result?.[REMINDER_SETTINGS_KEY];
  if (!raw || typeof raw.enabled !== "boolean") {
    return { enabled: true };
  }
  return { enabled: raw.enabled };
}

async function getReminderState() {
  const result = await chrome.storage.local.get(REMINDER_STATE_KEY);
  const raw = result?.[REMINDER_STATE_KEY];
  if (!raw || typeof raw !== "object") return null;
  const baseDueAtMs = Number(raw.baseDueAtMs);
  const nextDueAtMs = Number(raw.nextDueAtMs);
  const attemptNumber = Number.parseInt(raw.attemptNumber, 10);
  if (!Number.isFinite(baseDueAtMs) || !Number.isFinite(nextDueAtMs) || !Number.isInteger(attemptNumber)) {
    return null;
  }
  return {
    cycleKey: String(raw.cycleKey || ""),
    baseDueAtMs,
    nextDueAtMs,
    attemptNumber
  };
}

async function showMonthlyReminderNotification(notificationId = REMINDER_NOTIFICATION_ID, source = "monthly") {
  const iconPrimary = chrome.runtime.getURL("assets/icon-128.png");
  try {
    await chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: iconPrimary,
      title: "Reimbursement reminder",
      message: "It is reimbursement time. Start your flow now."
    });
    await appendReminderHistory({
      source,
      notificationId,
      status: "shown",
      detail: "Notification created with primary icon."
    });
  } catch (_error) {
    const iconFallback = chrome.runtime.getURL("assets/icon-48.png");
    try {
      await chrome.notifications.create(notificationId, {
        type: "basic",
        iconUrl: iconFallback,
        title: "Reimbursement reminder",
        message: "It is reimbursement time. Start your flow now."
      });
      await appendReminderHistory({
        source,
        notificationId,
        status: "shown",
        detail: "Notification created with fallback icon."
      });
    } catch (fallbackError) {
      await appendReminderHistory({
        source,
        notificationId,
        status: "failed",
        detail: String(fallbackError?.message || fallbackError || "Unknown notification error")
      });
      throw fallbackError;
    }
  }
}

async function appendReminderHistory(entry) {
  const result = await chrome.storage.local.get(REMINDER_HISTORY_KEY);
  const existing = Array.isArray(result?.[REMINDER_HISTORY_KEY]) ? result[REMINDER_HISTORY_KEY] : [];
  const next = [
    ...existing,
    {
      timestamp: new Date().toISOString(),
      source: String(entry?.source || "monthly"),
      notificationId: String(entry?.notificationId || ""),
      status: String(entry?.status || "shown"),
      detail: String(entry?.detail || "")
    }
  ].slice(-30);
  await chrome.storage.local.set({ [REMINDER_HISTORY_KEY]: next });
}

async function openReminderLandingPage() {
  const popupUrl = chrome.runtime.getURL("src/popup/popup.html");
  await chrome.tabs.create({ url: popupUrl, active: true });
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

function formatFreeMobileDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object") return "no diagnostics";
  const d = diagnostics;
  return [
    `path=${String(d.pathname || "")}`,
    `loginRoute=${Boolean(d.onLoginRoute)}`,
    `accountArea=${Boolean(d.inAccountArea)}`,
    `otp=${Boolean(d.otpRequired)}`,
    `loginFields=${Boolean(d.hasExplicitLoginField)}`,
    `authMarker=${Boolean(d.hasAuthenticatedMarker)}`,
    `userNodes=${Boolean(d.hasUserLoginNode || d.hasUserNameNode || d.hasUserMsisdnNode)}`,
    `invoicesTab=${Boolean(d.hasInvoicesTab)}`,
    `invoicesPanel=${Boolean(d.hasInvoicesPanel)}`,
    `authGuess=${Boolean(d.authenticatedGuess)}`
  ].join(" ");
}
