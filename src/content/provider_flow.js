/* global chrome, __EXT_SELECTORS__ */
(function initOrangeContent() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "RUN_PROVIDER_ACTION" && message?.type !== "RUN_ORANGE_ACTION") return;

    handleProviderAction(message.action, message.payload || {})
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({
        ok: false,
        error: {
          code: error.code || "ORANGE_ACTION_FAILED",
          message: error.message || "Orange action failed"
        }
      }));

    return true;
  });
})();

async function handleProviderAction(action, payload) {
  const provider = normalizeProvider(payload.Provider);
  switch (action) {
    case "CHECK_PROVIDER_SESSION":
    case "CHECK_ORANGE_SESSION":
      return checkProviderSession(provider);
    case "CHECK_PROVIDER_BILLING_READY":
      return checkProviderBillingReady(provider);
    case "AUTH_PROVIDER":
    case "AUTH_ORANGE":
      return authProvider(provider, payload);
    case "NAVIGATE_BILLING":
      return navigateBilling(provider, payload);
    case "DOWNLOAD_AND_EXTRACT_BILL":
      return downloadAndExtractBill(provider);
    default:
      throw new Error(`Unsupported orange action: ${action}`);
  }
}

function getProviderStrategy(provider) {
  const strategy = window.__EXT_PROVIDER_STRATEGIES__?.get(provider);
  if (!strategy) {
    throw new Error(`No provider strategy registered for ${provider}`);
  }
  return strategy;
}

function createProviderContext(provider) {
  return {
    provider,
    document,
    location,
    performance,
    selectors: window.__EXT_SELECTORS__,
    getProviderLoginSelectors,
    getProviderBillingSelectors,
    normalizeText,
    normalizeComparableText,
    normalizeUrl,
    parseFilenameFromContentDisposition,
    getCurrentMonthStartISO,
    queryWithin,
    firstNonEmptyQuery,
    firstNonEmptyQueryWithin,
    pick,
    wait,
    waitForVisible,
    findByText,
    findByLooseText,
    findClickableByText,
    findClickableByLooseText,
    realClick,
    isVisible,
    resolveDownloadUrl,
    waitForDownloadUrl,
    waitForNavigoDownloadUrl,
    forceDownloadFromUrl
  };
}

function checkProviderSession(provider) {
  const strategy = getProviderStrategy(provider);
  const ctx = createProviderContext(provider);
  if (typeof strategy.checkProviderSession === "function") {
    return strategy.checkProviderSession(ctx);
  }
  return {
    authenticated: Boolean(strategy.isAuthenticated?.(ctx))
  };
}

function checkProviderBillingReady(provider) {
  const strategy = getProviderStrategy(provider);
  return strategy.checkBillingReady(createProviderContext(provider));
}

async function authProvider(provider, _payload) {
  const strategy = getProviderStrategy(provider);
  return strategy.auth(createProviderContext(provider), _payload);
}

async function navigateBilling(provider, payload) {
  const strategy = getProviderStrategy(provider);
  return strategy.navigateBilling(createProviderContext(provider), payload);
}

async function downloadAndExtractBill(provider) {
  const strategy = getProviderStrategy(provider);
  const ctx = createProviderContext(provider);
  const startedAt = Date.now();
  const providerSelectors = getProviderBillingSelectors(provider);
  const billing = providerSelectors || window.__EXT_SELECTORS__.providerDefaults.billing;
  const beforeResources = new Set(performance.getEntriesByType("resource").map((entry) => entry.name));
  const plan = await strategy.getDownloadPlan(ctx, { billing, beforeResources, startedAt });
  const downloadControl = plan?.downloadControl;
  if (!downloadControl) {
    throw new Error("Could not find provider PDF download button");
  }

  const didClickControl = Boolean(plan?.didClickControl);
  const href = plan?.href || null;
  const downloadControlMs = plan?.downloadControlMs ?? null;
  const downloadUrlMs = plan?.downloadUrlMs ?? null;
  const totalMs = Date.now() - startedAt;

  const fileName = deriveFileName(provider, href || location.href, "application/pdf", "");

  if (strategy.shouldForceDownload?.(ctx, { href, fileName })) {
    await forceDownloadFromUrl(href, fileName);
  } else if (!didClickControl) {
    realClick(downloadControl);
  }
  const billText = document.body.textContent || "";
  const navanHints = strategy.buildNavanHints?.(ctx, { href, fileName }) || undefined;

  return {
    billText,
    billHints: "",
    document: {
      name: fileName,
      mimeType: "application/pdf",
      dataUrl: null,
      sourceUrl: href,
      manualUploadRequired: true,
      navanHints
    },
    diagnostics: {
      downloadControlMs,
      downloadUrlMs: typeof downloadUrlMs === "number" ? downloadUrlMs : null,
      totalMs,
      sourceUrl: href || null,
      onDetailPage: /\/detail-facture/.test(String(location.href || ""))
    }
  };
}

async function forceDownloadFromUrl(url, fileName) {
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Failed to download invoice PDF (${response.status})`);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = fileName || "invoice.pdf";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }
}

function deriveFileName(provider, url, contentType, contentDisposition) {
  const strategy = getProviderStrategy(provider);
  return strategy.deriveFileName(createProviderContext(provider), {
    url,
    contentType,
    contentDisposition
  });
}

async function findBestFreeMobileInvoiceControl(billingSelectors, timeoutMs) {
  const invoicesVisible = await ensureFreeMobileInvoicesVisible(timeoutMs);
  if (!invoicesVisible) return null;

  const invoicesPanel = getFreeMobileInvoicesPanel();
  if (!invoicesPanel) return null;

  const latestSelectors = [
    "a[download][href*='/account/v2/api/SI/invoice/'][href*='display=1']",
    "a[download][href*='/api/SI/invoice/'][href*='display=1']",
    "a[href*='/account/v2/api/SI/invoice/'][href*='display=1']",
    "a[href*='/api/SI/invoice/'][href*='display=1']"
  ];

  const latestCta = pickFreeMobileLatestInvoiceCta(invoicesPanel, latestSelectors);
  if (latestCta) return latestCta;

  const fallbackSelectors = [
    "#invoices ul li a[href*='/api/SI/invoice/'][href*='display=1']",
    "#invoices a[href*='/api/SI/invoice/'][href*='display=1']",
    ...((billingSelectors?.downloadButton && Array.isArray(billingSelectors.downloadButton))
      ? billingSelectors.downloadButton.map((selector) => selector.startsWith("#invoices") ? selector : `#invoices ${selector}`)
      : [])
  ];

  return waitForVisible(fallbackSelectors, 4000);
}

function pickFreeMobileLatestInvoiceCta(invoicesPanel, selectors) {
  const ctas = firstNonEmptyQueryWithin(invoicesPanel, selectors);
  if (!ctas.length) return null;
  const preferred = ctas.find((node) => {
    const text = normalizeText(node.textContent || "");
    return text.includes("telecharger ma facture");
  });
  return preferred || ctas[0] || null;
}

async function ensureFreeMobileInvoicesVisible(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const panel = getFreeMobileInvoicesPanel();
    if (panel) return true;

    if (!/^\/account\/v2(?:\/|$)/.test(location.pathname)) {
      const consoAndFactures = findClickableByText("conso et factures");
      if (consoAndFactures) {
        realClick(consoAndFactures);
        await wait(500);
      }
    }

    const invoicesTab = pick([
      "button[role='tab'][aria-controls='invoices']",
      "button[aria-controls='invoices']",
      "#invoices ~ ul [aria-controls='invoices']"
    ]);
    if (invoicesTab) {
      realClick(invoicesTab);
      await wait(350);
    } else {
      const invoicesByText = findClickableByText("mes factures");
      if (invoicesByText) {
        realClick(invoicesByText);
        await wait(350);
      }
    }
  }
  return false;
}

function getFreeMobileInvoicesPanel() {
  const panel = document.querySelector("#invoices");
  if (!panel) return null;
  if (!isVisible(panel)) return null;
  if (panel.hasAttribute("hidden") || panel.classList.contains("hidden")) return null;
  return panel;
}

function findClickableByText(text) {
  const target = normalizeText(text);
  const nodes = Array.from(document.querySelectorAll("button,a,[role='tab']"));
  return nodes.find((node) => normalizeText(node.textContent || "").includes(target) && isVisible(node)) || null;
}

function findByLooseText(text) {
  const target = normalizeComparableText(text);
  const candidates = Array.from(document.querySelectorAll("button,a,div,span,label,h1,h2,h3,p"));
  return candidates.find((node) => normalizeComparableText(node.textContent || "").includes(target)) || null;
}

function findClickableByLooseText(text) {
  const target = normalizeComparableText(text);
  const nodes = Array.from(document.querySelectorAll("button,a,[role='button'],[role='tab'],option,li,span,div"));
  return nodes.find((node) => normalizeComparableText(node.textContent || "").includes(target) && isVisible(node)) || null;
}

async function waitForNavigoPathMatch(pattern, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pattern.test(String(location.pathname || ""))) return true;
    await wait(150);
  }
  return false;
}

async function clickNavigoSelector(selector, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const button = pick([selector]);
    if (button) {
      realClick(button);
      return true;
    }
    await wait(150);
  }
  return false;
}


function findLinkByText(words) {
  const links = Array.from(document.querySelectorAll("a,button"));
  return links.find((el) => words.some((word) => (el.textContent || "").toLowerCase().includes(word)));
}

function findByText(text) {
  const candidates = Array.from(document.querySelectorAll("button,a,div,span,label"));
  const target = String(text || "").toLowerCase();
  return candidates.find((node) => (node.textContent || "").toLowerCase().includes(target)) || null;
}

async function waitForAccountItem(accountType, timeoutMs) {
  const start = Date.now();
  const selectors = window.__EXT_SELECTORS__.orange.billing.accountItems;

  while (Date.now() - start < timeoutMs) {
    const items = firstNonEmptyQuery(selectors);
    const selected = items.find((node) => matchesAccountType(node, accountType));
    if (selected) return selected;
    await wait(250);
  }

  return null;
}

async function waitForAnyAccountItem(timeoutMs) {
  const start = Date.now();
  const selectors = window.__EXT_SELECTORS__.orange.billing.accountItems;

  while (Date.now() - start < timeoutMs) {
    const items = firstNonEmptyQuery(selectors);
    if (items.length) return items[0];
    await wait(250);
  }

  return null;
}

function matchesAccountType(node, accountType) {
  const text = normalizeText(node.textContent);
  if (accountType === "mobile_internet") {
    return text.includes("forfait mobile");
  }
  return text.includes("offre internet");
}

function extractAccountId(node, href) {
  if (node && node.getAttribute) {
    const dataE2e = node.getAttribute("data-e2e");
    if (dataE2e && /^\d{6,}$/.test(dataE2e)) return dataE2e;
  }

  const url = href || (node && node.getAttribute ? normalizeUrl(node.getAttribute("href")) : null);
  if (!url) return null;
  const match = url.match(/\/facture-paiement\/(\d+)/);
  return match ? match[1] : null;
}

function pick(selectors) {
  return queryWithin(document, selectors);
}

function queryWithin(root, selectors) {
  for (const selector of selectors) {
    try {
      const candidate = root.querySelector(selector);
      if (candidate && isVisible(candidate)) return candidate;
    } catch (_error) {
      // Invalid selector support for :has, continue.
    }
  }
  return null;
}

function firstNonEmptyQuery(selectors) {
  for (const selector of selectors) {
    try {
      const nodes = Array.from(document.querySelectorAll(selector)).filter(isVisible);
      if (nodes.length) return nodes;
    } catch (_error) {
      // Ignore invalid selectors.
    }
  }
  return [];
}

function firstNonEmptyQueryWithin(root, selectors) {
  for (const selector of selectors) {
    try {
      const nodes = Array.from(root.querySelectorAll(selector)).filter(isVisible);
      if (nodes.length) return nodes;
    } catch (_error) {
      // Ignore invalid selectors.
    }
  }
  return [];
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function setInputValue(input, value) {
  const text = String(value ?? "");
  realClick(input);
  input.focus({ preventScroll: true });
  input.select?.();

  // Prefer paste-like insertion because some login pages only react to this flow.
  const pasted = tryPasteLikeInput(input, text);
  if (!pasted) {
    setNativeInputValue(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function hasInputValue(input) {
  if (!input) return false;
  const value = typeof input.value === "string" ? input.value : input.getAttribute("value");
  return String(value || "").trim().length > 0;
}

function normalizeUrl(href) {
  if (!href) return null;
  try {
    return new URL(href, location.href).toString();
  } catch (_error) {
    return null;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForVisible(selectors, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const el = queryWithin(document, selectors);
    if (el) return el;
    await wait(150);
  }
  return null;
}

function isCaptchaPresent() {
  const captchaSelectors = [
    "iframe[src*='captcha']",
    ".g-recaptcha",
    "#captcha",
    "[id*='captcha']",
    "[class*='captcha']",
    "input[name*='captcha']"
  ];

  return captchaSelectors.some((selector) => {
    try {
      return Boolean(document.querySelector(selector));
    } catch (_error) {
      return false;
    }
  });
}

function isOrangeAuthenticated() {
  const onClientHost = location.hostname.includes("espace-client.orange.fr");
  if (!onClientHost) return false;

  const s = window.__EXT_SELECTORS__?.orange?.login;
  if (!s) return true;
  const hasLoginField = Boolean(queryWithin(document, s.username) || queryWithin(document, s.password));
  return !hasLoginField;
}

function isProviderAuthenticated(provider) {
  const strategy = getProviderStrategy(provider);
  return Boolean(strategy.isAuthenticated?.(createProviderContext(provider)));
}

function getProviderLoginSelectors(provider) {
  const specific = window.__EXT_SELECTORS__.providers?.[provider]?.login;
  return specific || window.__EXT_SELECTORS__.providerDefaults.login;
}

function getProviderBillingSelectors(provider) {
  const specific = window.__EXT_SELECTORS__.providers?.[provider]?.billing;
  if (!specific) return window.__EXT_SELECTORS__.providerDefaults.billing;
  return {
    ...window.__EXT_SELECTORS__.providerDefaults.billing,
    ...specific
  };
}

function normalizeProvider(provider) {
  if (typeof provider === "string" && provider.trim()) return provider.trim();
  return "orange_provider";
}

function isSupportedProviderHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  const configs = window.__EXT_PROVIDER_CONFIGS || {};
  return Object.values(configs).some((provider) =>
    Array.isArray(provider?.hosts) && provider.hosts.some((token) => host.includes(String(token).toLowerCase()))
  );
}

function resolveDownloadUrl(downloadControl, beforeResources, provider) {
  const direct = normalizeUrl(
    downloadControl.getAttribute("href")
    || downloadControl.getAttribute("data-href")
    || downloadControl.getAttribute("data-url")
  );
  const filteredDirect = filterDownloadUrl(direct, provider);
  if (filteredDirect) return filteredDirect;

  const parentAnchor = downloadControl.closest("a[href]");
  const parentHref = normalizeUrl(parentAnchor?.getAttribute("href"));
  const filteredParent = filterDownloadUrl(parentHref, provider);
  if (filteredParent) return filteredParent;

  const pageCandidate = filterDownloadUrl(queryDownloadCandidateFromPage(), provider);
  if (pageCandidate) return pageCandidate;

  const newResource = findNewDownloadResource(beforeResources, provider);
  if (newResource) return newResource;

  return null;
}

function queryDownloadCandidateFromPage() {
  const anchor = document.querySelector("a[data-e2e='download-link'][href], a[href*='.pdf'], a[href*='download']");
  const href = normalizeUrl(anchor?.getAttribute("href"));
  if (href) return href;

  const scripts = Array.from(document.scripts).map((s) => s.textContent || "").join(" ");
  const match = scripts.match(/https?:\/\/[^"'\s]+(?:\.pdf|download[^"'\s]*)/i)
    || scripts.match(/\/[^"'\s]*(?:\.pdf|download[^"'\s]*)/i);
  if (!match) return null;
  return normalizeUrl(match[0]);
}

function findNewDownloadResource(beforeResources, provider) {
  const entries = performance.getEntriesByType("resource");
  const fresh = entries
    .map((entry) => entry.name)
    .filter((name) => !beforeResources.has(name))
    .find((name) => /pdf|download|facture|invoice|bill|telecharg/i.test(name));
  return filterDownloadUrl(fresh, provider);
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function getCurrentMonthStartISO() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

function summarizeNavigoPageDiagnostics() {
  const text = normalizeComparableText(document.body?.textContent || "");
  const anchors = Array.from(document.querySelectorAll("a[href],button,[role='button']"))
    .map((node) => {
      const label = normalizeComparableText(node.textContent || "").slice(0, 80);
      const href = node.getAttribute?.("href") || "";
      return `${label}${href ? ` -> ${href}` : ""}`;
    })
    .filter((line) => line.includes("navigo") || line.includes("prelev") || line.includes("attestation") || line.includes("facture") || line.includes("justificatif"))
    .slice(0, 20);

  return [
    `href=${location.href}`,
    `path=${location.pathname}`,
    `hasMonNavigoText=${text.includes("mon navigo")}`,
    `hasPrelevementsText=${text.includes("prelevement") || text.includes("prélèvement")}`,
    `hasAttestationsText=${text.includes("attestation")}`,
    `candidates=[${anchors.join(" | ")}]`
  ].join(" ");
}

function parseFilenameFromContentDisposition(value) {
  const raw = String(value || "");
  if (!raw) return null;

  const utfMatch = raw.match(/filename\*=UTF-8''([^;]+)/i);
  if (utfMatch?.[1]) return decodeURIComponentSafe(utfMatch[1].replace(/"/g, ""));

  const plainMatch = raw.match(/filename="?([^";]+)"?/i);
  if (plainMatch?.[1]) return plainMatch[1].trim();

  return null;
}

function extractAccountIdFromLocation() {
  const match = location.pathname.match(/\/facture-paiement\/(\d+)/);
  return match ? match[1] : null;
}

function extractBillDateISO() {
  const button = document.querySelector("button[data-e2e='download-link'], a[data-e2e='download-link']");
  const text = normalizeText(button?.textContent || document.body.textContent || "");
  if (!text) return null;

  const isoMatch = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (isoMatch?.[1]) return isoMatch[1];

  const frMatch = text.match(/\b(\d{1,2})\s+(janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre)\s+(20\d{2})\b/i);
  if (!frMatch) return null;

  const day = frMatch[1].padStart(2, "0");
  const month = frenchMonthToNumber(frMatch[2]);
  const year = frMatch[3];
  if (!month) return null;
  return `${year}-${month}-${day}`;
}

function frenchMonthToNumber(value) {
  const month = normalizeText(value)
    .replace("é", "e")
    .replace("û", "u")
    .replace("ô", "o")
    .replace("à", "a")
    .replace("ç", "c");

  const map = {
    janvier: "01",
    fevrier: "02",
    mars: "03",
    avril: "04",
    mai: "05",
    juin: "06",
    juillet: "07",
    aout: "08",
    septembre: "09",
    octobre: "10",
    novembre: "11",
    decembre: "12"
  };

  return map[month] || null;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}


async function waitForDownloadUrl(downloadControl, beforeResources, provider, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const href = resolveDownloadUrl(downloadControl, beforeResources, provider) || filterDownloadUrl(queryDownloadCandidateFromPage(), provider) || null;
    if (href) return href;
    await wait(200);
  }
  return null;
}

function filterDownloadUrl(url, provider) {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  if (!isAllowedDownloadHost(normalized, provider)) return null;
  if (isTrackingUrl(normalized)) return null;
  if (isLikelyInvoiceDownload(normalized)) return normalized;
  return null;
}

function isAllowedDownloadHost(url, provider) {
  try {
    const parsed = new URL(url, location.href);
    if (provider === "orange_provider" || provider === "sosh_provider") {
      return parsed.hostname.includes("orange.fr") || parsed.hostname.includes("orange.com");
    }
    return true;
  } catch (_error) {
    return true;
  }
}

function isLikelyInvoiceDownload(url) {
  return /(\.pdf)(\?|#|$)/i.test(url)
    || /facture|invoice|bill|telecharg/i.test(url);
}

function isTrackingUrl(url) {
  if (/\.(gif|png|jpg|jpeg)(\?|#|$)/i.test(url)) return true;
  if (/kameleoon|pdata\.orange\.fr|doubleclick|googletagmanager|google-analytics|tagmanager/i.test(url)) return true;
  return /\/_pdb\.gif/i.test(url);
}

async function waitForNavigoDownloadUrl(beforeResources, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const entries = performance.getEntriesByType("resource");
    const fresh = entries
      .map((entry) => entry.name)
      .filter((name) => !beforeResources.has(name))
      .find((name) => /prelev|pr[eé]lev|attestation|certificate|pdf/i.test(name));
    if (fresh) return fresh;
    await wait(200);
  }
  return null;
}

function tryPasteLikeInput(input, text) {
  try {
    input.setRangeText?.("", 0, input.value.length, "end");
    input.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: new DataTransfer()
    }));
    input.setRangeText?.(text, 0, input.value.length, "end");
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertFromPaste",
      data: text
    }));
    if (input.value !== text) {
      setNativeInputValue(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return true;
  } catch (_error) {
    return false;
  }
}

function realClick(el) {
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = el.getBoundingClientRect();
  const x = rect.left + Math.max(2, Math.min(rect.width - 2, rect.width / 2));
  const y = rect.top + Math.max(2, Math.min(rect.height - 2, rect.height / 2));

  const pointerDown = new PointerEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerType: "mouse",
    isPrimary: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1
  });
  const mouseDown = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1
  });
  const pointerUp = new PointerEvent("pointerup", {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerType: "mouse",
    isPrimary: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 0
  });
  const mouseUp = new MouseEvent("mouseup", {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 0
  });
  const click = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 0
  });

  el.dispatchEvent(pointerDown);
  el.dispatchEvent(mouseDown);
  el.dispatchEvent(pointerUp);
  el.dispatchEvent(mouseUp);
  el.dispatchEvent(click);
}

function setNativeInputValue(input, value) {
  const prototype = Object.getPrototypeOf(input);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) {
    descriptor.set.call(input, value);
    return;
  }
  input.value = value;
}
