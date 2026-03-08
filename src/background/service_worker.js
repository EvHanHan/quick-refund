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
const ORANGE_PDF_CAPTURE_TIMEOUT_MS = 20_000;
const DEBUGGER_PROTOCOL_VERSION = "1.3";
const ORANGE_PDF_FETCH_URL_PATTERN = "*://espace-client.orange.fr/ecd_wp/facture/v1.0/pdf*";
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
  FlowState.OPEN_NAVAN,
  FlowState.OPEN_LIQUID_HOME,
  FlowState.CLICK_NEW_TRANSACTION,
  FlowState.UPLOAD_DOCUMENT,
  FlowState.REVIEW_AND_CONFIRM
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
    AccountType: normalizeAccountType(normalizedProvider, runConfig?.AccountType),
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
      : resumedReason === "NAVAN_MODAL_STUCK"
        ? "User resumed after Navan processing modal"
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
      const shouldCaptureOrangePdf = flowContext.runConfig.Provider === "orange_provider";
      const debuggerCapture = shouldCaptureOrangePdf
        ? await startOrangePdfNetworkCapture(flowContext.orangeTabId)
        : null;
      let result;
      let captureData = null;
      try {
        result = await runProviderAction("DOWNLOAD_AND_EXTRACT_BILL", flowContext.orangeTabId, {
          Provider: flowContext.runConfig.Provider
        }, TIMEOUTS_MS.LONG);
        if (debuggerCapture) {
          captureData = await debuggerCapture.waitForDataUrl(ORANGE_PDF_CAPTURE_TIMEOUT_MS);
        }
      } finally {
        if (debuggerCapture) {
          await debuggerCapture.dispose();
        }
      }
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
      if (debuggerCapture) {
        if (captureData?.pdfUrl && !captureData?.dataUrl) {
          const preferredPdfUrl = selectPreferredOrangePdfUrl(captureData);
          const originalPdfUrl = captureData.pdfUrl;
          captureData.pdfUrl = preferredPdfUrl || captureData.pdfUrl;
          emitEvent(
            FlowState.DOWNLOAD_OR_SELECT_BILL,
            FlowStatus.STARTED,
            `Captured Orange PDF URL candidate (${captureData.pdfUrl}) source=${captureData?.debug?.stage || "parsed_payload"} original=${originalPdfUrl || "none"}`
          );
          const fetchedPdf = await fetchPdfDataUrlInTab(flowContext.orangeTabId, captureData.pdfUrl, ORANGE_PDF_CAPTURE_TIMEOUT_MS);
          if (fetchedPdf?.ok && fetchedPdf?.dataUrl) {
            captureData = {
              ...captureData,
              dataUrl: fetchedPdf.dataUrl,
              mimeType: fetchedPdf.mimeType || captureData.mimeType || "application/pdf"
            };
            emitEvent(
              FlowState.DOWNLOAD_OR_SELECT_BILL,
              FlowStatus.STARTED,
              "Fetched Orange PDF bytes from captured URL in page context"
            );
          } else {
            const bgFetchedPdf = await fetchPdfDataUrlInBackground(captureData.pdfUrl, ORANGE_PDF_CAPTURE_TIMEOUT_MS);
            if (bgFetchedPdf?.ok && bgFetchedPdf?.dataUrl) {
              captureData = {
                ...captureData,
                dataUrl: bgFetchedPdf.dataUrl,
                mimeType: bgFetchedPdf.mimeType || captureData.mimeType || "application/pdf"
              };
              emitEvent(
                FlowState.DOWNLOAD_OR_SELECT_BILL,
                FlowStatus.STARTED,
                "Fetched Orange PDF bytes from captured URL in background context"
              );
            } else {
              emitEvent(
                FlowState.DOWNLOAD_OR_SELECT_BILL,
                FlowStatus.STARTED,
                `Captured Orange PDF URL but failed to fetch bytes (pageError=${fetchedPdf?.error || "unknown"} bgError=${bgFetchedPdf?.error || "unknown"} pageMime=${fetchedPdf?.mimeType || "none"} bgMime=${bgFetchedPdf?.mimeType || "none"} pageResponseUrl=${fetchedPdf?.responseUrl || "none"} bgResponseUrl=${bgFetchedPdf?.responseUrl || "none"} captureDebug=${JSON.stringify(captureData?.debug || {})})`
              );
            }
          }
        }
        emitEvent(
          FlowState.DOWNLOAD_OR_SELECT_BILL,
          FlowStatus.STARTED,
          captureData?.dataUrl
            ? `Captured Orange PDF body via debugger (requestId=${captureData.requestId || "n/a"})`
            : `Debugger capture did not return Orange PDF bytes; manual upload fallback remains available (candidates=${(captureData?.candidates || []).join(" || ") || "none"})`
        );
      }
      flowContext.documentPayload = captureData?.dataUrl
        ? {
          ...result.document,
          dataUrl: captureData.dataUrl,
          mimeType: captureData.mimeType || result.document.mimeType || "application/pdf",
          manualUploadRequired: false
        }
        : result.document;
      return;
    }
    case FlowState.OPEN_NAVAN:
      flowContext.navanTabId = await ensureTab(NAVAN_UPLOAD_RECEIPTS_URL, flowContext.navanTabId);
      try {
        await runNavanAction("CHECK_SESSION", flowContext.navanTabId, {}, TIMEOUTS_MS.DEFAULT);
        flowContext.waitingForUser = false;
        flowContext.waitingReason = null;
        emitEvent(FlowState.OPEN_NAVAN, FlowStatus.SUCCESS, "Navan session already active, continuing to upload flow");
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
        emitEvent(
          FlowState.UPLOAD_DOCUMENT,
          FlowStatus.STARTED,
          `Preparing Navan upload payload (hasDataUrl=${Boolean(flowContext.documentPayload?.dataUrl)} mime=${flowContext.documentPayload?.mimeType || "none"} name=${flowContext.documentPayload?.name || "none"} sourceUrl=${flowContext.documentPayload?.sourceUrl || "none"})`
        );
        const uploadResult = await runNavanAction(
          "UPLOAD_DOCUMENT",
          flowContext.navanTabId,
          { document: flowContext.documentPayload },
          UPLOAD_ACTION_TIMEOUT_MS
        );
        emitEvent(
          FlowState.UPLOAD_DOCUMENT,
          FlowStatus.STARTED,
          `Navan upload result (uploaded=${Boolean(uploadResult?.uploaded)} manual=${Boolean(uploadResult?.manualUploadRequired)} reason=${uploadResult?.reason || "none"} file=${uploadResult?.attachedFileName || "none"} modalCleared=${uploadResult?.debug?.modalCleared === undefined ? "n/a" : Boolean(uploadResult?.debug?.modalCleared)} modalStillVisible=${uploadResult?.debug?.modalStillVisible === undefined ? "n/a" : Boolean(uploadResult?.debug?.modalStillVisible)} nudges=${Number(uploadResult?.debug?.dismissNudgeCount || 0)})`
        );
        const modalStillVisible = Boolean(uploadResult?.debug?.modalStillVisible);
        if (modalStillVisible) {
          flowContext.waitingForUser = true;
          flowContext.waitingReason = "NAVAN_MODAL_STUCK";
          emitEvent(
            FlowState.UPLOAD_DOCUMENT,
            FlowStatus.WAITING_USER,
            "Navan is still showing the processing modal. Dismiss it in Navan, then click Resume."
          );
          return;
        }
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

async function startOrangePdfNetworkCapture(tabId) {
  const target = { tabId };
  let attached = false;
  let fetchEnabled = false;
  let settled = false;
  let disposed = false;
  let fallbackCapture = null;
  let latestPdfCandidateUrl = null;
  const watchedRequests = new Map();
  const processedRequestIds = new Set();
  const recentCandidates = [];
  let resolveCapture;
  const capturePromise = new Promise((resolve) => {
    resolveCapture = resolve;
  });

  const settleCapture = (value) => {
    if (settled) return;
    settled = true;
    resolveCapture(value || null);
  };

  const onEvent = (source, method, params) => {
    if (disposed) return;
    if (source?.tabId !== tabId) return;
    if (method === "Fetch.requestPaused") {
      void handleFetchRequestPaused(params);
      return;
    }
    if (method === "Network.responseReceived") {
      const requestId = params?.requestId;
      const response = params?.response;
      if (!requestId || !isLikelyOrangeCaptureResponse(response)) return;
      const url = String(response?.url || "");
      const mimeType = String(response?.mimeType || "");
      const status = Number(response?.status || 0);
      const contentType = String(response?.headers?.["content-type"] || response?.headers?.["Content-Type"] || "");
      const contentDisposition = String(response?.headers?.["content-disposition"] || response?.headers?.["Content-Disposition"] || "");
      watchedRequests.set(requestId, {
        url,
        mimeType,
        status,
        contentType,
        contentDisposition
      });
      if (isLikelyOrangePdfDownloadUrl(url) || /pdf/i.test(mimeType) || /pdf/i.test(contentType) || /pdf/i.test(contentDisposition)) {
        latestPdfCandidateUrl = url;
        if (!processedRequestIds.has(requestId)) {
          processedRequestIds.add(requestId);
          void attemptReadResponseBodyWithRetry(target, requestId, watchedRequests.get(requestId), 10, 150).then((capture) => {
            if (capture?.dataUrl) {
              settleCapture(capture);
              return;
            }
            if (capture?.pdfUrl) {
              fallbackCapture = capture;
            }
          });
        }
      }
      recentCandidates.push(`${status || "n/a"} ${mimeType || contentType || "unknown"} ${url}`);
      if (recentCandidates.length > 12) recentCandidates.shift();
      return;
    }
    if (method === "Network.loadingFailed") {
      watchedRequests.delete(params?.requestId);
      return;
    }
    if (method !== "Network.loadingFinished") return;
    const requestId = params?.requestId;
    const meta = watchedRequests.get(requestId);
    if (!requestId || !meta || settled) return;
    if (processedRequestIds.has(requestId)) return;
    processedRequestIds.add(requestId);
    void readDebuggerResponseBody(target, requestId, meta).then((capture) => {
      watchedRequests.delete(requestId);
      if (capture?.dataUrl) {
        settleCapture(capture);
        return;
      }
      if (capture?.pdfUrl) {
        fallbackCapture = capture;
      }
    });
  };

  async function handleFetchRequestPaused(params) {
    const fetchRequestId = params?.requestId;
    const url = String(params?.request?.url || "");
    const responseStatusCode = Number(params?.responseStatusCode || 0);
    const headers = headersArrayToObject(params?.responseHeaders);
    const contentType = readHeader(headers, "content-type");
    const contentDisposition = readHeader(headers, "content-disposition");

    if (!fetchRequestId) return;
    try {
      if (!isLikelyOrangePdfDownloadUrl(url)) return;
      recentCandidates.push(`${responseStatusCode || "n/a"} ${contentType || "unknown"} ${url}`);
      if (recentCandidates.length > 12) recentCandidates.shift();

      const body = await chrome.debugger.sendCommand(target, "Fetch.getResponseBody", { requestId: fetchRequestId });
      if (!body?.body) return;

      let base64 = null;
      if (body.base64Encoded) {
        base64 = body.body;
      } else if (String(body.body || "").startsWith("%PDF-")) {
        base64 = btoa(body.body);
      }
      if (!base64) return;
      if (!isBase64PdfBody(base64) && !/pdf/i.test(contentType) && !/pdf/i.test(contentDisposition)) return;
      settleCapture({
        requestId: fetchRequestId,
        mimeType: "application/pdf",
        dataUrl: `data:application/pdf;base64,${base64}`
      });
    } catch (error) {
      fallbackCapture = {
        pdfUrl: url,
        debug: {
          stage: "fetch_domain_get_response_body_error",
          error: String(error?.message || error || "unknown_error"),
          contentType,
          contentDisposition
        }
      };
    } finally {
      await continueFetchRequest(target, fetchRequestId);
    }
  }

  const onDetach = (source) => {
    if (source?.tabId !== tabId) return;
    settleCapture(null);
  };

  try {
    await chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION);
    attached = true;
    chrome.debugger.onEvent.addListener(onEvent);
    chrome.debugger.onDetach.addListener(onDetach);
    await chrome.debugger.sendCommand(target, "Network.enable");
    await chrome.debugger.sendCommand(target, "Fetch.enable", {
      patterns: [{ urlPattern: ORANGE_PDF_FETCH_URL_PATTERN, requestStage: "Response" }]
    });
    fetchEnabled = true;
  } catch (error) {
    if (attached) {
      try {
        await chrome.debugger.detach(target);
      } catch (_detachError) {
        // Ignore detach failure.
      }
    }
    emitEvent(
      FlowState.DOWNLOAD_OR_SELECT_BILL,
      FlowStatus.STARTED,
      `Debugger capture unavailable (${error?.message || "unknown error"})`
    );
    return {
      waitForDataUrl: async () => null,
      dispose: async () => {}
    };
  }

  return {
    waitForDataUrl: async (timeoutMs) => {
      const timeoutPromise = sleep(timeoutMs).then(() => null);
      const directCapture = await Promise.race([capturePromise, timeoutPromise]);
      if (directCapture?.dataUrl) return directCapture;
      if (fallbackCapture) {
        return {
          ...fallbackCapture,
          candidates: recentCandidates.slice(-8)
        };
      }
      if (latestPdfCandidateUrl) {
        return {
          pdfUrl: latestPdfCandidateUrl,
          debug: { stage: "latest_pdf_candidate_url" },
          candidates: recentCandidates.slice(-8)
        };
      }
      return { candidates: recentCandidates.slice(-8) };
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      chrome.debugger.onEvent.removeListener(onEvent);
      chrome.debugger.onDetach.removeListener(onDetach);
      settleCapture(null);
      if (!attached) return;
      try {
        if (fetchEnabled) {
          await chrome.debugger.sendCommand(target, "Fetch.disable");
        }
        await chrome.debugger.sendCommand(target, "Network.disable");
      } catch (_error) {
        // Ignore disable failure.
      }
      try {
        await chrome.debugger.detach(target);
      } catch (_error) {
        // Ignore detach failure.
      }
    }
  };
}

async function readDebuggerResponseBody(target, requestId, meta) {
  const mimeType = String(meta?.mimeType || "");
  const contentType = String(meta?.contentType || "");
  const contentDisposition = String(meta?.contentDisposition || "");
  const url = String(meta?.url || "");
  const normalizedMime = mimeType || contentType;
  const pdfLikeResponse = /pdf/i.test(normalizedMime)
    || /pdf/i.test(contentDisposition)
    || /\/pdf\b|\.pdf(\?|#|$)|credentialkeyforpdf=/i.test(url);
  try {
    const body = await chrome.debugger.sendCommand(target, "Network.getResponseBody", { requestId });
    if (!body?.body) {
      return pdfLikeResponse
        ? {
          requestId,
          mimeType: "application/pdf",
          pdfUrl: url,
          debug: {
            stage: "get_response_body_empty",
            mimeType,
            contentType,
            contentDisposition
          }
        }
        : null;
    }
    if (normalizedMime && /pdf/i.test(normalizedMime) && body.base64Encoded) {
      const finalMime = /pdf/i.test(mimeType) ? mimeType : "application/pdf";
      return {
        requestId,
        mimeType: "application/pdf",
        dataUrl: `data:${finalMime};base64,${body.body}`
      };
    }
    if (body.base64Encoded && isBase64PdfBody(body.body)) {
      return {
        requestId,
        mimeType: "application/pdf",
        dataUrl: `data:application/pdf;base64,${body.body}`
      };
    }
    if (/pdf/i.test(contentDisposition) && body.base64Encoded) {
      return {
        requestId,
        mimeType: "application/pdf",
        dataUrl: `data:application/pdf;base64,${body.body}`
      };
    }

    const textBody = body.base64Encoded ? decodeBase64Safe(body.body) : String(body.body || "");
    if (!textBody) return null;

    const pdfUrl = extractPdfUrlFromInvoicePayload(textBody, meta?.url || "");
    if (!pdfUrl) return null;
    return {
      requestId,
      mimeType: "application/pdf",
      pdfUrl
    };
  } catch (error) {
    if (!pdfLikeResponse) return null;
    return {
      requestId,
      mimeType: "application/pdf",
      pdfUrl: url,
      debug: {
        stage: "get_response_body_error",
        error: String(error?.message || error || "unknown_error"),
        mimeType,
        contentType,
        contentDisposition
      }
    };
  }
}

async function attemptReadResponseBodyWithRetry(target, requestId, meta, attempts, waitMs) {
  for (let i = 0; i < attempts; i += 1) {
    const capture = await readDebuggerResponseBody(target, requestId, meta);
    if (capture?.dataUrl || capture?.pdfUrl) return capture;
    await sleep(waitMs);
  }
  return null;
}

function isLikelyOrangeCaptureResponse(response) {
  const url = String(response?.url || "");
  if (!url || isIgnoredCaptureUrl(url)) return false;
  const mimeType = String(response?.mimeType || "");
  const headerContentType = String(response?.headers?.["content-type"] || response?.headers?.["Content-Type"] || "");
  const contentDisposition = String(response?.headers?.["content-disposition"] || response?.headers?.["Content-Disposition"] || "");
  if (/pdf/i.test(mimeType) || /pdf/i.test(headerContentType) || /pdf/i.test(contentDisposition)) return true;
  if (!isLikelyOrangeInvoiceUrl(url)) return false;
  return /json|octet-stream|text/i.test(mimeType)
    || /pdf|json/i.test(headerContentType)
    || /\.pdf(\?|#|$)/i.test(url)
    || /\/pdf\b/i.test(url)
    || /billsandpaymentinfos|facture\/v\d+\.\d+/i.test(url);
}

function isIgnoredCaptureUrl(url) {
  return /doubleclick|googletagmanager|google-analytics|tagmanager|kameleoon|_pdb\.gif/i.test(String(url || ""));
}

function isLikelyOrangeInvoiceUrl(url) {
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch (_error) {
    return false;
  }
  const host = String(parsed.hostname || "");
  if (!host.includes("orange.fr") && !host.includes("orange.com")) return false;
  const signal = `${parsed.pathname || ""} ${parsed.search || ""}`.toLowerCase();
  return /facture|invoice|pdf|bill|ecd_wp/.test(signal);
}

function decodeBase64Safe(input) {
  try {
    return atob(String(input || ""));
  } catch (_error) {
    return "";
  }
}

function isBase64PdfBody(base64) {
  const sample = String(base64 || "").slice(0, 20);
  if (!sample) return false;
  return sample.startsWith("JVBERi0");
}

function headersArrayToObject(headers) {
  const out = {};
  if (!Array.isArray(headers)) return out;
  for (const header of headers) {
    const name = String(header?.name || "").toLowerCase().trim();
    if (!name) continue;
    out[name] = String(header?.value || "");
  }
  return out;
}

function readHeader(headers, name) {
  return String(headers?.[String(name || "").toLowerCase()] || "");
}

async function continueFetchRequest(target, requestId) {
  if (!requestId) return;
  try {
    await chrome.debugger.sendCommand(target, "Fetch.continueRequest", { requestId });
  } catch (_error) {
    // Ignore; request may already be continued or target detached.
  }
}

function extractPdfUrlFromInvoicePayload(textBody, baseUrl) {
  const fromJson = extractPdfUrlFromJsonText(textBody, baseUrl);
  if (fromJson) return fromJson;

  const directUrlMatch = textBody.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  for (const raw of directUrlMatch) {
    const normalized = normalizePdfCandidateUrl(raw, baseUrl);
    if (normalized) return normalized;
  }
  return null;
}

function extractPdfUrlFromJsonText(textBody, baseUrl) {
  let parsed = null;
  try {
    parsed = JSON.parse(textBody);
  } catch (_error) {
    return null;
  }
  return findPdfUrlInObject(parsed, baseUrl);
}

function findPdfUrlInObject(node, baseUrl) {
  if (!node) return null;
  if (typeof node === "string") {
    return normalizePdfCandidateUrl(node, baseUrl);
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findPdfUrlInObject(item, baseUrl);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node === "object") {
    for (const value of Object.values(node)) {
      const hit = findPdfUrlInObject(value, baseUrl);
      if (hit) return hit;
    }
  }
  return null;
}

function normalizePdfCandidateUrl(candidate, baseUrl) {
  const raw = String(candidate || "").trim();
  if (!raw) return null;
  if (!/(pdf|facture|invoice|bill|download|ecd_wp)/i.test(raw)) return null;
  try {
    const parsed = new URL(raw, baseUrl || undefined);
    const normalized = parsed.toString();
    if (!isLikelyOrangeInvoiceUrl(normalized)) return null;
    if (!isLikelyOrangePdfDownloadUrl(normalized)) return null;
    return normalized;
  } catch (_error) {
    return null;
  }
}

function isLikelyOrangePdfDownloadUrl(url) {
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch (_error) {
    return false;
  }
  const signal = `${parsed.pathname || ""} ${parsed.search || ""}`.toLowerCase();
  if (/\.pdf(\?|#|$)/i.test(url)) return true;
  if (/\/billsandpaymentinfos\//i.test(signal)) return false;
  if (/credentialkeyforpdf=|billdate=|\/ecd_wp\/facture\//i.test(signal)) return true;
  if (/\/v\d+\.\d+\/pdf\b/i.test(signal)) return true;
  return false;
}

function selectPreferredOrangePdfUrl(captureData) {
  const direct = String(captureData?.pdfUrl || "");
  const candidates = Array.isArray(captureData?.candidates) ? captureData.candidates : [];

  const fromCandidates = candidates
    .map((entry) => String(entry || ""))
    .map((entry) => {
      const match = entry.match(/\bhttps?:\/\/\S+$/i);
      if (!match?.[0]) return null;
      const url = match[0];
      const isPdfMime = /\bapplication\/pdf\b/i.test(entry);
      return { url, isPdfMime };
    })
    .filter(Boolean)
    .filter((item) => isLikelyOrangePdfDownloadUrl(item.url))
    .sort((a, b) => Number(b.isPdfMime) - Number(a.isPdfMime));

  if (fromCandidates.length) return fromCandidates[0].url;
  return isLikelyOrangePdfDownloadUrl(direct) ? direct : null;
}

async function fetchPdfDataUrlInTab(tabId, url, timeoutMs = TIMEOUTS_MS.LONG) {
  const result = await withTimeout(
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [url],
      func: async (targetUrl) => {
        try {
          const response = await fetch(targetUrl, {
            credentials: "include",
            cache: "no-store"
          });
          if (!response.ok) {
            return { ok: false, error: `fetch_failed_${response.status}` };
          }
          const blob = await response.blob();
          const isPdfMime = /pdf/i.test(String(blob.type || ""));
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const hasPdfMagic = bytes.length >= 4
            && bytes[0] === 0x25
            && bytes[1] === 0x50
            && bytes[2] === 0x44
            && bytes[3] === 0x46;
          if (!isPdfMime && !hasPdfMagic) {
            return {
              ok: false,
              error: "not_pdf_response",
              mimeType: String(blob.type || ""),
              responseUrl: String(response.url || targetUrl || "")
            };
          }
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => reject(new Error("file_reader_error"));
            reader.readAsDataURL(blob);
          });
          return {
            ok: true,
            dataUrl,
            mimeType: "application/pdf"
          };
        } catch (error) {
          return { ok: false, error: String(error?.message || error || "fetch_error") };
        }
      }
    }),
    timeoutMs,
    "Timed out while fetching Orange PDF in page context"
  );

  const payload = result?.[0]?.result;
  if (!payload?.ok || !payload?.dataUrl) return payload || { ok: false, error: "missing_payload" };
  if (!String(payload.dataUrl).startsWith("data:")) {
    return { ok: false, error: "invalid_data_url_prefix", mimeType: String(payload?.mimeType || "") };
  }
  return {
    ok: true,
    dataUrl: payload.dataUrl,
    mimeType: payload.mimeType || "application/pdf",
    responseUrl: payload.responseUrl || ""
  };
}

async function fetchPdfDataUrlInBackground(url, timeoutMs = TIMEOUTS_MS.LONG) {
  try {
    const response = await withTimeout(
      fetch(url, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: {
          Accept: "application/pdf,application/octet-stream,*/*"
        }
      }),
      timeoutMs,
      "Timed out while fetching Orange PDF in background context"
    );
    if (!response.ok) {
      return { ok: false, error: `fetch_failed_${response.status}`, responseUrl: String(response.url || url || "") };
    }
    const blob = await response.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const isPdfMime = /pdf/i.test(String(blob.type || ""));
    const hasPdfMagic = bytes.length >= 4
      && bytes[0] === 0x25
      && bytes[1] === 0x50
      && bytes[2] === 0x44
      && bytes[3] === 0x46;
    if (!isPdfMime && !hasPdfMagic) {
      return {
        ok: false,
        error: "not_pdf_response",
        mimeType: String(blob.type || ""),
        responseUrl: String(response.url || url || "")
      };
    }
    const base64 = bytesToBase64(bytes);
    return {
      ok: true,
      dataUrl: `data:application/pdf;base64,${base64}`,
      mimeType: "application/pdf",
      responseUrl: String(response.url || url || "")
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error || "fetch_error"), responseUrl: String(url || "") };
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new FlowError(ErrorCode.ACTION_TIMEOUT, message));
    }, timeoutMs);
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
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
  const intervalMs = flowContext.runConfig?.Provider === "free_mobile_provider" ? 3500 : 1500;
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
  }, intervalMs);
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

function normalizeAccountType(provider, accountType) {
  const value = String(accountType || "").trim();
  if (provider === "navigo_provider") {
    if (value === "commuter_benefits" || value === "yearly") return "yearly";
    if (value === "monthly") return "monthly";
    return "monthly";
  }
  return value === "mobile_internet" ? "mobile_internet" : "home_internet";
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
