/* global chrome, __EXT_SELECTORS__ */
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
  void documentPayload;
  await wait(15_000);
  const created = await waitAndClickCreateSingleTransaction(5_000);
  if (!created) {
    return {
      uploaded: false,
      manualUploadRequired: true,
      reason: "create_single_transaction_not_found"
    };
  }

  const expenseTypeSelected = await finalizeExpenseTypeSelection();
  return {
    uploaded: true,
    createSingleTransactionClicked: created,
    expenseTypeSelected
  };
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

async function finalizeExpenseTypeSelection() {
  await wait(15_000);
  clickDraftTag();
  await wait(400);
  return selectExpenseTypeWorkFromHome(20_000);
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

async function selectExpenseTypeWorkFromHome(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const input = findExpenseTypeInput();
    if (input) {
      realClick(input);
      input.focus?.();
      await wait(200);
      const option = findWorkFromHomeOption();
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
  const labels = Array.from(document.querySelectorAll("span,div,label"));
  const container = labels.find((node) => normalizeText(node.textContent).includes("expense type"));
  if (!container) return null;
  return container.closest("span,div,section,form")?.querySelector("input[type='text']") || null;
}

function findWorkFromHomeOption() {
  const candidates = Array.from(document.querySelectorAll("button,li,div,span,[role='option']"));
  return candidates.find((node) => {
    const text = normalizeText(node.textContent);
    return text.includes("work from home") || text.includes("work frol home");
  }) || null;
}
