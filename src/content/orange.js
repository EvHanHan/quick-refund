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

function checkProviderSession(provider) {
  return {
    authenticated: isProviderAuthenticated(provider)
  };
}

function checkProviderBillingReady(provider) {
  const text = normalizeText(document.body?.textContent || "");
  if (provider === "redbysfr_provider") {
    const factureHeading = findByText("vos factures") || findByText("facture fixe");
    return {
      ready: Boolean(factureHeading) || text.includes("vos factures") || text.includes("facture fixe") || isProviderAuthenticated(provider)
    };
  }
  if (provider === "free_mobile_provider") {
    return {
      ready: isProviderAuthenticated(provider)
    };
  }

  return {
    ready: isProviderAuthenticated(provider)
  };
}

async function authProvider(provider, payload) {
  const providedPassword = String(payload?.password || "");
  const hasProvidedPassword = providedPassword.length > 0;

  if (isProviderAuthenticated(provider)) {
    return { authenticated: true, skippedLogin: true, captchaRequired: false };
  }

  if (provider === "redbysfr_provider") {
    const s = getProviderLoginSelectors(provider);
    const username = await waitForVisible(s.username, 6000);
    if (username && payload.username) {
      setInputValue(username, payload.username || "");
    }
    const password = await waitForVisible(s.password, 6000);
    if (password && hasProvidedPassword) {
      setInputValue(password, providedPassword);
    }

    // Red by SFR often shows captcha; user must login manually.
    return { authenticated: false, manualLoginRequired: true, captchaRequired: false };
  }

  if (provider === "free_mobile_provider") {
    const s = getProviderLoginSelectors(provider);
    const username = await waitForVisible(s.username, 8000);
    if (!username) {
      if (isProviderAuthenticated(provider)) {
        return { authenticated: true, skippedLogin: true, captchaRequired: false };
      }
      throw new Error("Could not locate Free Mobile username field");
    }

    if (payload.username) {
      setInputValue(username, payload.username || "");
    }
    const password = await waitForVisible(s.password, 8000);
    if (!password) {
      throw new Error("Could not locate Free Mobile password field");
    }
    if (hasProvidedPassword) {
      setInputValue(password, providedPassword);
    }

    const submit = pick(s.submit);
    if (!submit) {
      throw new Error("Could not locate Free Mobile login button");
    }
    if (!hasProvidedPassword && !hasInputValue(password)) {
      return { authenticated: false, manualLoginRequired: true, captchaRequired: false };
    }
    realClick(submit);

    await wait(1200);
    if (isFreeMobileOtpRequired()) {
      return { authenticated: false, manualLoginRequired: true, smsCodeRequired: true };
    }
    if (isProviderAuthenticated(provider)) {
      return { authenticated: true, captchaRequired: false };
    }

    // If an extra challenge appears, wait for user and auto-resume via watcher on page change.
    return { authenticated: false, manualLoginRequired: true, captchaRequired: false };
  }

  if (isCaptchaPresent()) {
    return { authenticated: false, captchaRequired: true };
  }

  const s = getProviderLoginSelectors(provider);
  const username = await waitForVisible(s.username, 8000);
  if (!username) {
    if (isProviderAuthenticated(provider)) {
      return { authenticated: true, skippedLogin: true, captchaRequired: false };
    }
    throw new Error("Could not locate provider username field");
  }

  if (payload.username) {
    setInputValue(username, payload.username || "");
  }

  // Some providers (ex: Free) expose username+password on the same form.
  let password = pick(s.password);
  if (!password) {
    const firstSubmit = pick(s.submit);
    firstSubmit?.click();
    // Many providers use a 2-step auth flow: username page, then password page.
    password = await waitForVisible(s.password, 10000);
  }

  if (!password) {
    throw new Error("Could not locate provider password field after username step");
  }

  if (hasProvidedPassword) {
    setInputValue(password, providedPassword);
  }

  if (!hasProvidedPassword && !hasInputValue(password)) {
    return { authenticated: false, manualLoginRequired: true, captchaRequired: false };
  }
  const finalSubmit = pick(s.submit);
  if (!finalSubmit) {
    throw new Error("Could not locate provider submit button");
  }
  finalSubmit.click();

  await wait(1500);
  if (isCaptchaPresent()) {
    return { authenticated: false, captchaRequired: true };
  }

  return { authenticated: true, captchaRequired: false };
}

async function navigateBilling(provider, payload) {
  if (provider === "orange_provider") {
    const accountType = payload?.AccountType === "mobile_internet" ? "mobile_internet" : "home_internet";
    if (!location.href.startsWith("https://espace-client.orange.fr/selectionner-un-contrat")) {
      throw new Error("Orange is not on contract selection page");
    }

    const selectedAccountLink = await waitForAccountItem(accountType, 15000);
    if (!selectedAccountLink) {
      throw new Error(`Could not find Orange account card for type: ${accountType}`);
    }

    const accountHref = normalizeUrl(selectedAccountLink.getAttribute("href"));
    const accountId = extractAccountId(selectedAccountLink, accountHref);
    if (!accountId) {
      throw new Error("Could not extract Orange account id from selected card");
    }

    const detailUrl = `https://espace-client.orange.fr/facture-paiement/${accountId}/detail-facture`;
    return { navigated: true, accountId, detailUrl };
  }

  if (provider === "redbysfr_provider") {
    return { navigated: true, detailUrl: location.href };
  }

  if (provider === "free_provider") {
    // Free ADSL session is carried in URL query params (id/idt). Stay on the current session page.
    // We only verify that at least one invoice PDF link is visible.
    const billing = getProviderBillingSelectors(provider);
    const invoices = firstNonEmptyQuery(billing.invoiceLinks || []);
    if (!invoices.length) {
      throw new Error("Could not find Free invoice link (facture_pdf.pl)");
    }
    return { navigated: true, detailUrl: location.href };
  }

  // Generic provider path: navigate to a discoverable invoice page/link.
  const generic = window.__EXT_SELECTORS__.providerDefaults.billing.invoiceLinks;
  const invoiceEntry = await waitForVisible(generic, 8000);
  if (invoiceEntry) {
    const href = normalizeUrl(invoiceEntry.getAttribute("href"));
    if (href) {
      return { navigated: true, detailUrl: href };
    }
    realClick(invoiceEntry);
  }
  return { navigated: true, detailUrl: location.href };
}

async function downloadAndExtractBill(provider) {
  const providerSelectors = getProviderBillingSelectors(provider);
  const billing = providerSelectors || window.__EXT_SELECTORS__.providerDefaults.billing;
  const beforeResources = new Set(performance.getEntriesByType("resource").map((entry) => entry.name));
  const downloadControl = provider === "free_provider"
    ? await findBestFreeInvoiceControl(billing.downloadButton, 12000)
    : await waitForVisible(billing.downloadButton, 12000);
  if (!downloadControl) {
    throw new Error("Could not find provider PDF download button");
  }

  let didClickControl = false;
  let href = resolveDownloadUrl(downloadControl, beforeResources);
  if (!href) {
    realClick(downloadControl);
    didClickControl = true;
    // Do not wait for physical download completion. Continue flow immediately.
    href = await waitForDownloadUrl(downloadControl, beforeResources, 8000);
  }

  const fileName = deriveFileName(provider, href || location.href, "application/pdf", "");

  // Free invoice links usually open PDF in a new tab; force a real download in the current page context.
  if (provider === "free_provider" && href) {
    await forceDownloadFromUrl(href, fileName);
  } else if (!didClickControl) {
    realClick(downloadControl);
  }
  const billText = document.body.textContent || "";

  return {
    billText,
    billHints: "",
    document: {
      name: fileName,
      mimeType: "application/pdf",
      dataUrl: null,
      sourceUrl: href,
      manualUploadRequired: true
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

async function findBestFreeInvoiceControl(selectors, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const links = firstNonEmptyQuery(selectors || []);
    if (links.length) {
      const preferred = pickBestFreeInvoiceByMonth(links);
      if (preferred) return preferred;
      return links[0];
    }
    await wait(200);
  }
  return null;
}

function pickBestFreeInvoiceByMonth(links) {
  const current = new Date();
  const currentKey = `${current.getFullYear()}${String(current.getMonth() + 1).padStart(2, "0")}`;

  const scored = links.map((el) => {
    const href = String(el.getAttribute("href") || "");
    const title = String(el.getAttribute("title") || "");
    const text = `${title} ${el.textContent || ""}`;
    const monthKey = extractMonthKeyFromFreeInvoice(href, text);
    return { el, monthKey };
  });

  const sameMonth = scored.find((item) => item.monthKey === currentKey);
  if (sameMonth) return sameMonth.el;

  const withMonth = scored
    .filter((item) => /^\d{6}$/.test(item.monthKey))
    .sort((a, b) => Number(b.monthKey) - Number(a.monthKey));
  if (withMonth.length) return withMonth[0].el;

  return scored[0]?.el || null;
}

function extractMonthKeyFromFreeInvoice(href, text) {
  const monthInHref = String(href || "").match(/[?&]mois=(\d{6})\b/i);
  if (monthInHref?.[1]) return monthInHref[1];

  const normalized = normalizeText(text || "");
  const frMatch = normalized.match(/\b(janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre)\s+(20\d{2})\b/i);
  if (!frMatch) return null;

  const month = frenchMonthToNumber(frMatch[1]);
  if (!month) return null;
  return `${frMatch[2]}${month}`;
}

function deriveFileName(provider, url, contentType, contentDisposition) {
  const accountId = extractAccountIdFromLocation();
  const billDateISO = extractBillDateISO();
  if (provider === "orange_provider" && accountId && billDateISO) {
    return `facture_${accountId}_${billDateISO}.pdf`;
  }

  if (provider === "free_provider") {
    const freeName = deriveFreePdfFileName(url);
    if (freeName) return freeName;
  }

  const fromDisposition = parseFilenameFromContentDisposition(contentDisposition);
  if (fromDisposition) return fromDisposition;

  const fromUrl = url.split("?")[0].split("/").pop();
  if (fromUrl && fromUrl.includes(".")) return fromUrl;

  if (String(contentType || "").includes("html")) return "orange-bill.html";
  return "orange-bill.pdf";
}

function deriveFreePdfFileName(url) {
  let parsed = null;
  try {
    parsed = new URL(url, location.href);
  } catch (_error) {
    return null;
  }

  const path = parsed.pathname || "";
  const isFreeInvoiceEndpoint = /facture_pdf\.pl$/i.test(path) || parsed.searchParams.has("no_facture");
  if (!isFreeInvoiceEndpoint) return null;

  const noFacture = (parsed.searchParams.get("no_facture") || "").trim();
  const mois = (parsed.searchParams.get("mois") || "").trim();
  if (noFacture && /^\d{6}$/.test(mois)) {
    return `facture_${noFacture}_${mois}.pdf`;
  }
  if (noFacture) return `facture_${noFacture}.pdf`;
  if (/^\d{6}$/.test(mois)) return `facture_${mois}.pdf`;
  return "facture_free.pdf";
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

function matchesAccountType(node, accountType) {
  const text = normalizeText(node.textContent);
  if (accountType === "mobile_internet") {
    return text.includes("forfait mobile");
  }
  return text.includes("offre internet");
}

function extractAccountId(node, href) {
  const dataE2e = node.getAttribute("data-e2e");
  if (dataE2e && /^\d{6,}$/.test(dataE2e)) return dataE2e;

  const url = href || normalizeUrl(node.getAttribute("href"));
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
  if (provider === "orange_provider") return isOrangeAuthenticated();
  if (provider === "free_mobile_provider") return isFreeMobileAuthenticated();
  const loginSelectors = getProviderLoginSelectors(provider);
  const hasLoginField = Boolean(queryWithin(document, loginSelectors.username) || queryWithin(document, loginSelectors.password));
  return !hasLoginField;
}

function isFreeMobileAuthenticated() {
  if (!location.hostname.includes("mobile.free.fr")) return false;
  if (isFreeMobileOtpRequired()) return false;

  const loginSelectors = getProviderLoginSelectors("free_mobile_provider");
  const hasLoginField = Boolean(queryWithin(document, loginSelectors.username) || queryWithin(document, loginSelectors.password));
  if (hasLoginField) return false;

  // Login route means we are not fully authenticated yet.
  if (location.pathname.includes("/account/v2/login")) return false;
  return true;
}

function isFreeMobileOtpRequired() {
  const otpSelectors = [
    "input[autocomplete='one-time-code']",
    "input[name*='code']",
    "input[id*='code']",
    "input[name*='otp']",
    "input[id*='otp']"
  ];
  const hasOtpInput = otpSelectors.some((selector) => {
    try {
      return Boolean(document.querySelector(selector));
    } catch (_error) {
      return false;
    }
  });
  if (hasOtpInput) return true;

  const text = normalizeText(document.body?.textContent || "");
  return text.includes("code") && text.includes("sms");
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

function resolveDownloadUrl(downloadControl, beforeResources) {
  const direct = normalizeUrl(
    downloadControl.getAttribute("href")
    || downloadControl.getAttribute("data-href")
    || downloadControl.getAttribute("data-url")
  );
  if (direct) return direct;

  const parentAnchor = downloadControl.closest("a[href]");
  const parentHref = normalizeUrl(parentAnchor?.getAttribute("href"));
  if (parentHref) return parentHref;

  const pageCandidate = queryDownloadCandidateFromPage();
  if (pageCandidate) return pageCandidate;

  const newResource = findNewDownloadResource(beforeResources);
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

function findNewDownloadResource(beforeResources) {
  const entries = performance.getEntriesByType("resource");
  const fresh = entries
    .map((entry) => entry.name)
    .filter((name) => !beforeResources.has(name))
    .find((name) => /pdf|download|facture/i.test(name));
  return fresh || null;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
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


async function waitForDownloadUrl(downloadControl, beforeResources, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const href = resolveDownloadUrl(downloadControl, beforeResources) || queryDownloadCandidateFromPage() || null;
    if (href) return href;
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
