/* global chrome, __EXT_SELECTORS__ */
const NAVAN_FORM_AUTOFILL_ENABLED = true;

(function initNavanContent() {
  if (!location.hostname.includes("navan.com")) return;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "RUN_NAVAN_ACTION") return;

    handleNavanAction(message.action, message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({
        ok: false,
        error: {
          code: error.code || "NAVAN_ACTION_FAILED",
          message: error.message || "Navan action failed"
        }
      }));

    return true;
  });

  if (NAVAN_FORM_AUTOFILL_ENABLED) {
    setupNavanRouteWatcher();
    scheduleAutoFillOnForm();
  }
})();

async function handleNavanAction(action, payload) {
  switch (action) {
    case "CHECK_SESSION":
      return checkSession();
    case "CLICK_NEW_TRANSACTION":
      return clickNewTransaction();
    case "AUTOFILL_TRANSACTION":
      return autofillTransaction(payload?.draft);
    case "UPLOAD_DOCUMENT":
      return uploadDocument(payload?.document);
    default:
      throw new Error(`Unsupported navan action: ${action}`);
  }
}

async function checkSession() {
  await wait(500);
  if (location.href.includes("/login") || location.hostname.includes("accounts.google.com")) {
    throw new Error("Navan session not active. Complete Google SSO first.");
  }
  return { authenticated: true };
}

async function clickNewTransaction() {
  if (location.pathname.includes("/transactions/upload-receipts")) {
    return { clicked: true, autofillReceiptClicked: true, skippedNewTransactionClick: true, directUploadPage: true };
  }

  // Preferred path: click Autofill directly if menu item is already visible.
  let autofillButton = await waitForByText("Autofill from a receipt", window.__EXT_SELECTORS__.navan.home.autofillFromReceipt, 1500);
  if (autofillButton) {
    realClick(autofillButton);
    await wait(600);
    return { clicked: true, autofillReceiptClicked: true, skippedNewTransactionClick: true };
  }

  // Fallback: open New transaction menu, then click Autofill.
  const button = await waitForExactNewTransactionButton(15000);
  if (!button) {
    throw new Error("Could not find exact New transaction button");
  }

  realClick(button);
  await wait(500);

  autofillButton = await waitForByText("Autofill from a receipt", window.__EXT_SELECTORS__.navan.home.autofillFromReceipt, 5000);
  if (!autofillButton) {
    throw new Error("Could not find 'Autofill from a receipt' option");
  }

  realClick(autofillButton);
  await wait(600);
  return { clicked: true, autofillReceiptClicked: true, skippedNewTransactionClick: false };
}

function findExactNewTransactionButton() {
  const menuContainer = document.querySelector("pb-dropdown-menu[data-testid='add-transaction']");
  const scopedCandidates = menuContainer
    ? Array.from(menuContainer.querySelectorAll("button.black[type='button']"))
    : [];
  const globalCandidates = Array.from(document.querySelectorAll("button.black[type='button']"));
  const candidates = scopedCandidates.length ? scopedCandidates : globalCandidates;

  return candidates.find((btn) => {
    const textNode = btn.querySelector("span.text") || btn;
    const label = normalizeText(textNode.textContent);
    return label === "new transaction" || label.includes("new transaction");
  }) || null;
}

async function waitForExactNewTransactionButton(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const button = findExactNewTransactionButton();
    if (button && isVisible(button)) return button;
    await wait(150);
  }
  return null;
}

async function autofillTransaction(draft) {
  if (!draft) {
    throw new Error("No draft payload provided for Navan autofill");
  }

  const s = window.__EXT_SELECTORS__.navan.transactionForm;
  setField(s.merchant, draft.merchant);
  setField(s.amount, String(draft.amount));
  setField(s.currency, draft.currency);
  setField(s.date, draft.transactionDateISO);

  if (typeof draft.taxAmount === "number") {
    setField(s.tax, String(draft.taxAmount));
  }

  setField(s.description, draft.description);
  return { autofilled: true };
}

async function uploadDocument(documentPayload) {
  const navanHints = documentPayload?.navanHints || {};
  const attached = await attachDocumentToFileInput(documentPayload, 25_000);
  if (!attached.ok) {
    return {
      uploaded: false,
      manualUploadRequired: true,
      reason: attached.reason || "file_attach_failed",
      debug: attached.debug || {}
    };
  }

  await wait(3_000);
  const createFlow = await waitForCreateSingleTransactionFlow(20_000);
  if (!createFlow.ok) {
    return {
      uploaded: false,
      manualUploadRequired: true,
      reason: "create_single_transaction_not_found",
      debug: {
        ...(attached.debug || {}),
        ...(createFlow.debug || {})
      }
    };
  }

  let descriptionPrefilled = null;
  let hintsApplied = false;
  let expenseTypeSelected = false;

  if (NAVAN_FORM_AUTOFILL_ENABLED) {
    if (createFlow.debug?.modalCleared === true) {
      await wait(1_000);
    }
    descriptionPrefilled = await waitForDescriptionPrefill(3_000);
    if (descriptionPrefilled) {
      setDescriptionFixed("monthly invoice");
    }

    hintsApplied = await applyNavanHints(navanHints);
    expenseTypeSelected = await finalizeExpenseTypeSelection(navanHints.expenseType);
  }
  return {
    uploaded: true,
    attachedFileName: attached.fileName,
    createSingleTransactionClicked: createFlow.clicked,
    expenseTypeSelected,
    hintsApplied,
    debug: {
      ...(attached.debug || {}),
      ...(createFlow.debug || {}),
      autofillEnabled: NAVAN_FORM_AUTOFILL_ENABLED,
      descriptionPrefilled
    }
  };
}

async function attachDocumentToFileInput(documentPayload, timeoutMs) {
  const dataUrl = String(documentPayload?.dataUrl || "");
  if (!dataUrl.startsWith("data:")) {
    return { ok: false, reason: "missing_data_url", debug: { dataUrlPrefix: dataUrl.slice(0, 24) } };
  }

  const fileInput = await waitForNavanFileInput(timeoutMs);
  if (!fileInput) {
    return { ok: false, reason: "file_input_not_found", debug: {} };
  }

  const fileName = String(documentPayload?.name || "invoice.pdf");
  const mimeType = String(documentPayload?.mimeType || "application/pdf");
  const file = dataUrlToFile(dataUrl, fileName, mimeType);
  if (!file) {
    return { ok: false, reason: "invalid_data_url", debug: { fileName, mimeType } };
  }

  const transfer = new DataTransfer();
  transfer.items.add(file);
  fileInput.files = transfer.files;
  fileInput.dispatchEvent(new Event("input", { bubbles: true }));
  fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  const assignedCount = Number(fileInput.files?.length || 0);
  const assignedName = assignedCount > 0 ? String(fileInput.files[0]?.name || "") : "";
  const assignedType = assignedCount > 0 ? String(fileInput.files[0]?.type || "") : "";
  const assignedSize = assignedCount > 0 ? Number(fileInput.files[0]?.size || 0) : 0;
  const debug = {
    inputId: String(fileInput.id || ""),
    inputName: String(fileInput.name || ""),
    inputAccept: String(fileInput.accept || ""),
    assignedCount,
    assignedName,
    assignedType,
    assignedSize
  };
  if (assignedCount === 0) {
    return { ok: false, reason: "file_input_assignment_failed", debug };
  }
  return { ok: true, fileName, debug };
}

async function waitForNavanFileInput(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const fromSelectors = queryAny(window.__EXT_SELECTORS__.navan.transactionForm.file, { allowHidden: true });
    const generic = querySelectorDeep("input[type='file']");
    const input = (fromSelectors || generic);
    if (input instanceof HTMLInputElement && input.type === "file") {
      return input;
    }
    await wait(250);
  }
  return null;
}

function dataUrlToFile(dataUrl, fileName, fallbackMimeType) {
  const parts = String(dataUrl || "").split(",", 2);
  if (parts.length !== 2) return null;

  const header = parts[0];
  const base64 = parts[1];
  const mimeMatch = header.match(/^data:([^;]+);base64$/i);
  const mimeType = mimeMatch?.[1] || fallbackMimeType || "application/pdf";

  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new File([bytes], fileName, { type: mimeType });
  } catch (_error) {
    return null;
  }
}

async function waitForDescriptionPrefill(timeoutMs) {
  const s = window.__EXT_SELECTORS__.navan.transactionForm;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const input = queryAny(s.description, { allowHidden: true });
    if (input && String(input.value || "").trim().length > 0) return true;
    await wait(400);
  }
  return false;
}

function setDescriptionFixed(text) {
  const s = window.__EXT_SELECTORS__.navan.transactionForm;
  setField(s.description, text);
}

function setField(selectors, value) {
  if (!value && value !== 0) return;
  const input = queryAny(selectors);
  if (!input) return;

  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function scheduleAutoFillOnForm() {
  if (!isNavanTransactionFormPage()) {
    return;
  }
  if (window.__NAVAN_AUTOFILL_RUNNING || window.__NAVAN_AUTOFILL_DONE) {
    return;
  }
  window.__NAVAN_AUTOFILL_RUNNING = true;
  const maxWaitMs = 60_000;
  const pollMs = 500;
  const start = Date.now();

  const tick = async () => {
    if (window.__NAVAN_AUTOFILL_DONE) return;
    const ready = await tryAutoFillExpenseThenDescription();
    if (ready) {
      window.__NAVAN_AUTOFILL_DONE = true;
      window.__NAVAN_AUTOFILL_RUNNING = false;
      return;
    }
    if (Date.now() - start < maxWaitMs) {
      setTimeout(tick, pollMs);
    } else {
      window.__NAVAN_AUTOFILL_RUNNING = false;
    }
  };

  setTimeout(tick, pollMs);
}

function isNavanTransactionFormPage() {
  return location.pathname.includes("/transactions/new-redesign/");
}

function isNavanTransactionFormReady() {
  if (!isNavanTransactionFormPage()) return false;

  const s = window.__EXT_SELECTORS__.navan.transactionForm;
  return Boolean(
    queryAny(s.date, { allowHidden: true })
    || queryAny(s.description, { allowHidden: true })
    || findExpenseTypeInput()
    || findCustomDescriptionInput()
  );
}

function setupNavanRouteWatcher() {
  if (window.__NAVAN_ROUTE_WATCHER) return;
  window.__NAVAN_ROUTE_WATCHER = true;
  window.__NAVAN_LAST_PATH = location.pathname;
  setupNavanDomWatcher();

  const onRouteChange = () => {
    if (window.__NAVAN_LAST_PATH === location.pathname) return;
    window.__NAVAN_LAST_PATH = location.pathname;
    if (isNavanTransactionFormPage()) {
      window.__NAVAN_AUTOFILL_DONE = false;
      window.__NAVAN_AUTOFILL_RUNNING = false;
      scheduleAutoFillOnForm();
    }
  };

  const pushState = history.pushState;
  const replaceState = history.replaceState;
  history.pushState = function (...args) {
    const result = pushState.apply(this, args);
    onRouteChange();
    return result;
  };
  history.replaceState = function (...args) {
    const result = replaceState.apply(this, args);
    onRouteChange();
    return result;
  };
  window.addEventListener("popstate", onRouteChange);
  window.addEventListener("hashchange", onRouteChange);
}

function setupNavanDomWatcher() {
  if (window.__NAVAN_DOM_WATCHER) return;
  window.__NAVAN_DOM_WATCHER = true;
  const observer = new MutationObserver(() => {
    if (isNavanTransactionFormPage() && !window.__NAVAN_AUTOFILL_DONE) {
      scheduleAutoFillOnForm();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

async function tryAutoFillExpenseThenDescription() {
  const expenseSelected = await ensureExpenseTypeSelected("work from home");
  if (!expenseSelected) return false;

  const descriptionInput = await waitForCustomDescriptionInput(10_000);
  if (!descriptionInput) return false;

  setInputValue(descriptionInput, "monthly invoice");
  return true;
}

async function ensureExpenseTypeSelected(expenseTypeLabel) {
  const input = findExpenseTypeInput();
  if (!input) return false;

  const current = normalizeComparableText(input.value || "");
  if (current.includes("work from home") || current.includes("teletravail")) {
    return true;
  }

  openExpenseTypeDropdown(input);
  await wait(200);
  await scrollExpenseTypeListToEnd(3000);

  const desired = normalizeComparableText(expenseTypeLabel || "");
  typeExpenseTypeQuery(input, expenseTypeLabel || "");
  const option = await waitForExpenseTypeOption(desired, 8000);
  if (!option) return false;
  realClick(option);
  await wait(400);

  const updated = normalizeComparableText(input.value || "");
  return updated.includes("work from home") || updated.includes("teletravail");
}

function openExpenseTypeDropdown(input) {
  const wrapper = querySelectorDeep("[data-testid='label-Expense-type']") || input?.closest?.("[data-testid='expense-type-form']") || input;
  if (wrapper) {
    realClick(wrapper);
  } else if (input) {
    realClick(input);
  }
  input?.focus?.();
}

function typeExpenseTypeQuery(input, label) {
  if (!input) return;
  const value = String(label || "");
  input.focus?.();
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
}

async function waitForExpenseTypeOption(looseTarget, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const option = findExpenseTypeOption(looseTarget);
    if (option && isVisible(option)) return option;
    await wait(250);
  }
  return null;
}

async function scrollExpenseTypeListToEnd(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const scroller = findExpenseTypeScrollContainer();
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
      await wait(150);
      scroller.scrollTop = scroller.scrollHeight;
      return true;
    }
    await wait(150);
  }
  return false;
}

function findExpenseTypeScrollContainer() {
  const overlayRoot = document.querySelector(".cdk-overlay-container") || document.body;
  const candidates = Array.from(overlayRoot.querySelectorAll("*"));
  return candidates.find((node) => {
    if (!(node instanceof HTMLElement)) return false;
    if (!isVisible(node)) return false;
    const style = window.getComputedStyle(node);
    if (!style) return false;
    const overflowY = style.overflowY;
    const canScroll = (overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight;
    return canScroll;
  }) || null;
}

async function waitForCustomDescriptionInput(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const input = findCustomDescriptionInput();
    if (input) return input;
    await wait(300);
  }
  return null;
}

function findCustomDescriptionInput() {
  return querySelectorDeep("[data-testid='custom-field-customField3'] input");
}

function setInputValue(input, value) {
  if (!input) return;
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function queryAny(selectors, options = {}) {
  const allowHidden = Boolean(options.allowHidden);
  for (const selector of selectors) {
    try {
      const node = querySelectorDeep(selector);
      if (node && (allowHidden || isVisible(node))) return node;
    } catch (_error) {
      // Ignore invalid selector.
    }
  }
  return null;
}

function querySelectorDeep(selector, root = document) {
  const direct = root.querySelector?.(selector);
  if (direct) return direct;

  const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll("*")) : [];
  for (const node of nodes) {
    const shadow = node.shadowRoot;
    if (!shadow) continue;
    const hit = querySelectorDeep(selector, shadow);
    if (hit) return hit;
  }
  return null;
}

function findByText(text) {
  const target = String(text || "").toLowerCase();
  const candidates = Array.from(document.querySelectorAll("button,a,span,div"));
  return candidates.find((n) => (n.textContent || "").toLowerCase().includes(target)) || null;
}

function findClickableByText(text) {
  const node = findByText(text);
  if (!node) return null;
  return resolveClickableTarget(node);
}

async function waitForByText(text, selectorFallback, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const byText = findClickableByText(text);
    if (byText && isVisible(byText)) return byText;
    const bySelector = resolveClickableTarget(queryAny(selectorFallback));
    if (bySelector && normalizeText(bySelector.textContent).includes(normalizeText(text))) {
      return bySelector;
    }
    await wait(150);
  }
  return null;
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function realClick(el) {
  const target = resolveClickableTarget(el);
  if (!target) return;

  target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  target.focus?.({ preventScroll: true });

  const rect = target.getBoundingClientRect();
  const x = rect.left + Math.max(2, Math.min(rect.width - 2, rect.width / 2));
  const y = rect.top + Math.max(2, Math.min(rect.height - 2, rect.height / 2));

  target.dispatchEvent(new PointerEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerType: "mouse",
    isPrimary: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1
  }));
  target.dispatchEvent(new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1
  }));
  target.dispatchEvent(new PointerEvent("pointerup", {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerType: "mouse",
    isPrimary: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 0
  }));
  target.dispatchEvent(new MouseEvent("mouseup", {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 0
  }));
  target.dispatchEvent(new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 0
  }));
  // Never trigger native click on file inputs: browser requires user activation.
  if (!(target instanceof HTMLInputElement && target.type === "file")) {
    target.click?.();
  }
}

function resolveClickableTarget(node) {
  if (!node) return null;
  if (node.matches?.("button,a,[role='button']")) return node;
  const ancestor = node.closest?.("button,a,[role='button']");
  return ancestor || node;
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clickFarRightOfPage() {
  const width = Math.max(window.innerWidth || 0, document.documentElement?.clientWidth || 0);
  const height = Math.max(window.innerHeight || 0, document.documentElement?.clientHeight || 0);
  const x = Math.max(5, width - 5);
  const y = Math.max(5, Math.floor(height / 2));
  const target = document.elementFromPoint(x, y) || document.body;
  if (!target) return;
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
}

async function waitAndClickCreateSingleTransaction(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const button = findCreateSingleTransactionButton();
    if (button && isVisible(button)) {
      realClick(button);
      await wait(250);
      return true;
    }
    await wait(250);
  }
  return false;
}

async function waitForCreateSingleTransactionFlow(timeoutMs) {
  if (isNavanTransactionFormReady()) {
    const modalWait = await waitForCreatingTransactionModalToClear(Math.min(8_000, timeoutMs));
    return {
      ok: true,
      clicked: false,
      debug: {
        alreadyOnForm: true,
        modalCleared: modalWait.cleared,
        dismissNudgeCount: modalWait.dismissNudgeCount
      }
    };
  }

  const clicked = await waitAndClickCreateSingleTransaction(Math.min(8_000, timeoutMs));
  if (!clicked) {
    return {
      ok: false,
      clicked: false,
      debug: {
        alreadyOnForm: false,
        formReady: isNavanTransactionFormReady(),
        modalVisible: isCreatingTransactionModalVisible()
      }
    };
  }

  const formReady = await waitForTransactionFormReady(timeoutMs);
  const modalWait = formReady
    ? await waitForCreatingTransactionModalToClear(Math.min(15_000, timeoutMs))
    : { cleared: false, dismissNudgeCount: 0 };
  return {
    ok: formReady,
    clicked: true,
    debug: {
      alreadyOnForm: false,
      formReady,
      modalCleared: modalWait.cleared,
      modalStillVisible: formReady && !modalWait.cleared,
      dismissNudgeCount: modalWait.dismissNudgeCount
    }
  };
}

async function waitForTransactionFormReady(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isNavanTransactionFormReady()) return true;
    await wait(250);
  }
  return false;
}

async function waitForCreatingTransactionModalToClear(timeoutMs) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  let pollCount = 0;
  let dismissNudgeCount = 0;

  while (Date.now() < deadline) {
    const visible = isCreatingTransactionModalVisible();
    if (visible) {
      if (shouldNudgeModalDismiss(Date.now() - start, pollCount)) {
        nudgeCreatingTransactionModalDismiss();
        dismissNudgeCount += 1;
      }
    }
    if (!visible) {
      return { cleared: true, dismissNudgeCount };
    }
    pollCount += 1;
    await wait(250);
  }
  return { cleared: false, dismissNudgeCount };
}

function isCreatingTransactionModalVisible() {
  const textNode = findCreatingTransactionTextNode();
  const lottieNode = findCreatingTransactionLottieNode();
  const root = resolveModalRoot(textNode || lottieNode);
  return Boolean(root && isVisible(root));
}

function findCreatingTransactionTextNode() {
  const nodes = Array.from(document.querySelectorAll("h1,h2,h3,div,span,p"));
  return nodes.find((node) => isVisible(node) && normalizeText(node.textContent).includes("creating a transaction")) || null;
}

function findCreatingTransactionLottieNode() {
  const node = querySelectorDeep("#animation-container.main, [aria-label*='Lottie animation'], lottie-player");
  return (node && isVisible(node)) ? node : null;
}

function resolveModalRoot(node) {
  if (!node) return null;
  const root = node.closest?.(
    "[role='dialog'], .modal-container, .cdk-overlay-pane, .cdk-global-overlay-wrapper, pb-modal, section[class*='modal'], div[class*='modal']"
  );
  return root || node;
}

function shouldNudgeModalDismiss(elapsedMs, pollCount) {
  if (!isNavanTransactionFormPage()) return false;
  if (elapsedMs < 1000) return false;
  return pollCount % 4 === 0;
}

function nudgeCreatingTransactionModalDismiss() {
  clickNavanModalBackdrop();
  dispatchEscapeKey();
  clickFarRightOfPage();
  clickPageSide();
}

function dispatchEscapeKey() {
  const target = document.activeElement || document.body;
  if (!target) return;
  target.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    bubbles: true,
    cancelable: true
  }));
  target.dispatchEvent(new KeyboardEvent("keyup", {
    key: "Escape",
    code: "Escape",
    bubbles: true,
    cancelable: true
  }));
}

function clickNavanModalBackdrop() {
  const candidates = Array.from(document.querySelectorAll(
    ".cdk-overlay-backdrop, .cdk-overlay-container, .cdk-global-overlay-wrapper, [role='dialog']"
  ));
  for (const node of candidates) {
    if (!(node instanceof HTMLElement) || !isVisible(node)) continue;
    const style = window.getComputedStyle(node);
    if (!style || style.pointerEvents === "none") continue;
    clickElementCenter(node);
    break;
  }
}

function clickElementCenter(target) {
  const rect = target.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  target.click?.();
}

function findCreateSingleTransactionButton() {
  const selectors = window.__EXT_SELECTORS__.navan.home.createSingleTransaction || [];
  const bySelectors = queryAny(selectors);
  if (bySelectors && normalizeText(bySelectors.textContent) === "create a single transaction") {
    return resolveClickableTarget(bySelectors);
  }

  const exact = findClickableByText("Create a single transaction");
  if (exact && normalizeText(exact.textContent) === "create a single transaction") {
    return exact;
  }

  const candidates = Array.from(document.querySelectorAll("button.black[type='button'], button[type='button'], button"));
  return candidates.find((btn) => normalizeText(btn.textContent) === "create a single transaction") || null;
}

async function finalizeExpenseTypeSelection(expenseTypeHint) {
  await waitForExpenseTypeSectionReady(5_000);
  clickDraftTag();
  await wait(250);
  const desiredType = normalizeText(expenseTypeHint || "work from home");
  return selectExpenseTypeByLabel(desiredType, 8_000);
}

async function waitForExpenseTypeSectionReady(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (findExpenseTypeInput()) return true;
    await wait(250);
  }
  return false;
}

function clickPageSide() {
  const body = document.body;
  if (!body) return;
  const rect = body.getBoundingClientRect();
  const x = Math.max(5, Math.floor(rect.left + 12));
  const y = Math.max(5, Math.floor(rect.top + rect.height / 2));
  body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
}

function clickDraftTag() {
  const draftNode = findDraftTagNode();
  if (!draftNode) return;
  realClick(draftNode);
}

function findDraftTagNode() {
  const exact = querySelectorDeep("div.tag-container.gray .ellipse");
  if (exact && normalizeText(exact.textContent) === "draft") {
    return exact.closest("div.tag-container") || exact;
  }

  const candidates = Array.from(document.querySelectorAll("div.tag-container, div.ellipse, div"));
  return candidates.find((node) => normalizeText(node.textContent) === "draft") || null;
}

async function applyNavanHints(hints) {
  if (!hints || typeof hints !== "object") return false;

  let changed = false;
  if (typeof hints.transactionDateISO === "string" && hints.transactionDateISO) {
    const dateSet = await setTransactionDate(hints.transactionDateISO);
    changed = changed || dateSet;
  }
  return changed;
}

async function setTransactionDate(transactionDateISO) {
  const s = window.__EXT_SELECTORS__.navan.transactionForm;
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const dateInput = queryAny(s.date);
    if (dateInput) {
      setField(s.date, transactionDateISO);
      return true;
    }
    await wait(250);
  }
  return false;
}

async function selectExpenseTypeByLabel(optionText, timeoutMs) {
  const start = Date.now();
  const looseTarget = normalizeComparableText(optionText || "");
  while (Date.now() - start < timeoutMs) {
    const input = findExpenseTypeInput();
    if (input) {
      realClick(input);
      input.focus?.();
      await wait(200);
      const option = findExpenseTypeOption(looseTarget);
      if (option) {
        realClick(option);
        return true;
      }
    }
    await wait(300);
  }
  return false;
}

function findExpenseTypeInput() {
  const byTestId = querySelectorDeep("[data-testid='expense-type-form'] input[type='text']");
  if (byTestId) return byTestId;

  const labels = Array.from(document.querySelectorAll("span,div,label"));
  const container = labels.find((node) => normalizeText(node.textContent).includes("expense type"));
  if (!container) return null;
  return container.closest("span,div,section,form")?.querySelector("input[type='text']") || null;
}

function findExpenseTypeOption(looseTarget) {
  const candidates = getExpenseTypeOptionCandidates();
  return candidates.find((node) => {
    const text = normalizeComparableText(node.textContent);
    if (text.includes(looseTarget)) return true;
    // English/French fallback.
    return text.includes("work from home") || text.includes("work frol home") || text.includes("teletravail");
  }) || null;
}

function getExpenseTypeOptionCandidates() {
  const overlayRoot = document.querySelector(".cdk-overlay-container") || document.body;
  const candidates = Array.from(overlayRoot.querySelectorAll("[role='option'],li,button,div,span"));
  return candidates.filter((node) => {
    if (!isVisible(node)) return false;
    const text = normalizeComparableText(node.textContent);
    if (!text || text.length < 2 || text.length > 80) return false;
    return true;
  });
}

function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
