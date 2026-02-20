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
  if (provider === "free_mobile_provider") {
    const diagnostics = getFreeMobileAuthDiagnostics();
    return {
      authenticated: isProviderAuthenticated(provider),
      diagnostics
    };
  }
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
    const diagnostics = getFreeMobileAuthDiagnostics();
    return {
      ready: isProviderAuthenticated(provider),
      diagnostics
    };
  }
  if (provider === "navigo_provider") {
    return {
      ready: isProviderAuthenticated(provider)
        && (findByLooseText("mon navigo") || findByLooseText("mes services") || findByLooseText("bienvenue"))
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
      throw new Error(`Could not locate Free Mobile username field | ${summarizeFreeMobileDiagnostics()}`);
    }

    if (payload.username) {
      setInputValue(username, payload.username || "");
    }
    const password = await waitForVisible(s.password, 8000);
    if (!password) {
      throw new Error(`Could not locate Free Mobile password field | ${summarizeFreeMobileDiagnostics()}`);
    }
    if (hasProvidedPassword) {
      setInputValue(password, providedPassword);
    }

    const submit = pick(s.submit);
    if (!submit) {
      throw new Error(`Could not locate Free Mobile login button | ${summarizeFreeMobileDiagnostics()}`);
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

  if (provider === "navigo_provider") {
    const s = getProviderLoginSelectors(provider);
    const username = await waitForVisible(s.username, 8000);
    if (!username) {
      if (isProviderAuthenticated(provider)) {
        return { authenticated: true, skippedLogin: true, captchaRequired: false };
      }
      throw new Error("Could not locate Navigo username field");
    }

    if (payload.username) {
      setInputValue(username, payload.username || "");
    }
    const password = await waitForVisible(s.password, 8000);
    if (!password) {
      throw new Error("Could not locate Navigo password field");
    }
    if (hasProvidedPassword) {
      setInputValue(password, providedPassword);
    }

    const submit = pick(s.submit);
    if (!submit) {
      throw new Error("Could not locate Navigo login button");
    }
    if (!hasProvidedPassword && !hasInputValue(password)) {
      return { authenticated: false, manualLoginRequired: true, captchaRequired: false };
    }
    realClick(submit);
    await wait(1200);
    if (isProviderAuthenticated(provider)) {
      return { authenticated: true, captchaRequired: false };
    }
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

  if (provider === "free_mobile_provider") {
    if (!location.hostname.includes("mobile.free.fr")) {
      throw new Error("Free Mobile tab is not on mobile.free.fr");
    }
    if (!isProviderAuthenticated(provider)) {
      throw new Error("Free Mobile user is not authenticated");
    }

    const inAccountArea = /^\/account\/v2(?:\/|$)/.test(location.pathname);
    if (inAccountArea) {
      return { navigated: true, detailUrl: location.href };
    }
    return { navigated: true, detailUrl: "https://mobile.free.fr/account/v2" };
  }

  if (provider === "navigo_provider") {
    if (!isProviderAuthenticated(provider)) {
      throw new Error("Navigo user is not authenticated");
    }
    await waitForNavigoRoutingHints(4000);

    const prelevementsUrl = resolveNavigoPrelevementsUrl();
    if (prelevementsUrl) {
      return { navigated: true, detailUrl: prelevementsUrl };
    }

    const directBillingUrl = resolveNavigoBillingEntryUrl();
    if (directBillingUrl) {
      return { navigated: true, detailUrl: directBillingUrl };
    }
    const navigoTab = await clickNavigoBillingPath(8000);
    if (!navigoTab) {
      throw new Error(`Could not open Navigo billing section | ${summarizeNavigoPageDiagnostics()}`);
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

async function waitForNavigoRoutingHints(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hasDetailLink = Boolean(document.querySelector("a[href*='/espace_client/detail/']"));
    const hasMonNavigo = Boolean(findNavigoAnchorByText("mon navigo"));
    const onDetailPage = /\/espace_client\/detail\/[^/?#]+/i.test(String(location.pathname || ""));
    const onPrelevementPage = /\/prelevements\/[^/?#]+/i.test(String(location.pathname || ""));
    if (hasDetailLink || hasMonNavigo || onDetailPage || onPrelevementPage) return;
    await wait(150);
  }
}

async function downloadAndExtractBill(provider) {
  const providerSelectors = getProviderBillingSelectors(provider);
  const billing = providerSelectors || window.__EXT_SELECTORS__.providerDefaults.billing;
  const beforeResources = new Set(performance.getEntriesByType("resource").map((entry) => entry.name));
    const isNavigo = provider === "navigo_provider";
    const downloadControl = provider === "free_provider"
    ? await findBestFreeInvoiceControl(billing.downloadButton, 12000)
    : provider === "free_mobile_provider"
      ? await findBestFreeMobileInvoiceControl(billing, 12000)
    : isNavigo
      ? await findBestNavigoInvoiceControl(billing, 20000)
    : await waitForVisible(billing.downloadButton, 12000);
  if (!downloadControl) {
    throw new Error("Could not find provider PDF download button");
  }

  let didClickControl = false;
  let href = isNavigo ? null : resolveDownloadUrl(downloadControl, beforeResources);
  if (!href || isNavigo) {
    realClick(downloadControl);
    didClickControl = true;
    // Do not wait for physical download completion. Continue flow immediately.
    href = isNavigo
      ? await waitForNavigoDownloadUrl(beforeResources, 8000)
      : await waitForDownloadUrl(downloadControl, beforeResources, 8000);
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
      manualUploadRequired: true,
      navanHints: isNavigo
        ? {
          expenseType: "commuter benefits",
          transactionDateISO: getCurrentMonthStartISO()
        }
        : undefined
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
  if (provider === "free_mobile_provider") {
    const freeMobileName = deriveFreeMobilePdfFileName(url);
    if (freeMobileName) return freeMobileName;
  }
  if (provider === "navigo_provider") {
    const navigoName = deriveNavigoPdfFileName(url);
    if (navigoName) return navigoName;
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

function deriveFreeMobilePdfFileName(url) {
  let parsed = null;
  try {
    parsed = new URL(url, location.href);
  } catch (_error) {
    return null;
  }

  const invoiceId = (parsed.pathname || "").match(/\/api\/SI\/invoice\/(\d+)\b/i)?.[1];
  if (!invoiceId) return null;
  return `facture_free_mobile_${invoiceId}.pdf`;
}

function deriveNavigoPdfFileName(url) {
  let parsed = null;
  try {
    parsed = new URL(url, location.href);
  } catch (_error) {
    return null;
  }

  const rawId = parsed.searchParams.get("id") || parsed.searchParams.get("documentId");
  const documentId = String(rawId || "").trim();
  if (documentId) return `attestation_navigo_${documentId}.pdf`;
  return /attestation|prelev/i.test(parsed.pathname || "")
    ? `attestation_navigo_${getCurrentMonthStartISO().slice(0, 7)}.pdf`
    : null;
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

function resolveNavigoBillingEntryUrl() {
  const monNavigoAnchor = findNavigoAnchorByText("mon navigo");
  const monNavigoHref = normalizeUrl(monNavigoAnchor?.getAttribute("href"));
  if (monNavigoHref) return monNavigoHref;

  return null;
}

function resolveNavigoPrelevementsUrl() {
  const currentPath = String(location.pathname || "");
  const onPrelevements = currentPath.match(/\/prelevements\/([^/?#]+)/i);
  if (onPrelevements?.[1]) {
    return location.href;
  }

  const onDetail = currentPath.match(/\/espace_client\/detail\/([^/?#]+)/i);
  if (onDetail?.[1]) {
    return `https://www.jegeremacartenavigo.iledefrance-mobilites.fr/prelevements/${onDetail[1]}`;
  }

  const annualContractId = findNavigoAnnualContractIdFromList();
  if (annualContractId) {
    return `https://www.jegeremacartenavigo.iledefrance-mobilites.fr/prelevements/${annualContractId}`;
  }

  return null;
}

function findNavigoAnchorByText(text) {
  const target = normalizeComparableText(text);
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const best = anchors.find((a) => normalizeComparableText(a.textContent || "").includes(target));
  if (best) return best;
  return null;
}

function findClickableByLooseText(text) {
  const target = normalizeComparableText(text);
  const nodes = Array.from(document.querySelectorAll("button,a,[role='button'],[role='tab'],option,li,span,div"));
  return nodes.find((node) => normalizeComparableText(node.textContent || "").includes(target) && isVisible(node)) || null;
}

async function clickNavigoBillingPath(timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const monNavigo = findClickableByLooseText("mon navigo");
    if (monNavigo) {
      realClick(monNavigo);
      await wait(800);
    }

    if (hasNavigoAnnualActiveEntry() || hasNavigoPrelevementsEntry()) {
      return true;
    }
    await wait(250);
  }
  return false;
}

async function findBestNavigoInvoiceControl(billingSelectors, timeoutMs) {
  const opened = await openNavigoAttestationFlow(timeoutMs);
  if (!opened) return null;

  const explicitButton = pick([
    "button#download-certificate-btn",
    ".dropdown-menu #download-certificate-btn"
  ]);
  if (explicitButton && !explicitButton.disabled) return explicitButton;
  return null;
}

async function openNavigoAttestationFlow(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const annualActive = findNavigoAnnualActiveEntry();
    if (annualActive) {
      realClick(annualActive);
      await wait(1000);
    }

    const prelevements = findClickableByLooseText("consulter mes prelevements")
      || findClickableByLooseText("consulter mes prélèvements");
    if (prelevements) {
      realClick(prelevements);
      await wait(1000);
    }

    const downloadAttestation = pick(["#label-download"]) || findClickableByLooseText("telecharger mes attestations de prelevements")
      || findClickableByLooseText("télécharger mes attestations de prélèvements");
    if (downloadAttestation) {
      realClick(downloadAttestation);
      await wait(800);
    }

    const exactPeriodInput = pick([
      "ul.dropdown-menu input[name='period'][value='3']",
      "input[name='period'][value='3']"
    ]);
    if (exactPeriodInput) {
      selectNavigoPeriodInput(exactPeriodInput);
      await wait(400);
    } else {
      const dropDown = pick([
        "select",
        "button[aria-haspopup='listbox']",
        "div[role='combobox']",
        "input[role='combobox']"
      ]);
      if (dropDown) {
        await selectNavigoLastThreeMonths(dropDown);
        await wait(600);
      } else {
        const optionByText = findClickableByLooseText("3 derniers mois");
        if (optionByText) {
          realClick(optionByText);
          await wait(800);
        }
      }
    }

    const explicitButton = pick([
      "button#download-certificate-btn",
      ".dropdown-menu #download-certificate-btn"
    ]);
    if (explicitButton) {
      // Ensure button is enabled after the 3-month period is selected.
      if (explicitButton.disabled) {
        const periodInput = pick(["input[name='period'][value='3']"]);
        if (periodInput) {
          selectNavigoPeriodInput(periodInput);
          await wait(400);
        }
      }
      if (!explicitButton.disabled) {
        return true;
      }
    }

    const hasDownloadLink = Boolean(
      document.querySelector("a[href*='attestation'][href*='prelevement']")
      || document.querySelector("a[href*='attestation'][href*='pdf']")
      || document.querySelector("a[href*='prelevement'][href*='pdf']")
    );
    if (hasDownloadLink) return true;

    if ((findByLooseText("3 derniers mois")) && hasNavigoPrelevementsEntry()) {
      return true;
    }
    await wait(250);
  }
  return false;
}

function selectNavigoPeriodInput(input) {
  if (!input) return;
  try {
    input.checked = true;
  } catch (_error) {
    // noop
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  const label = input.closest("label");
  if (label && isVisible(label)) {
    realClick(label);
  } else if (isVisible(input)) {
    realClick(input);
  }
}

function hasNavigoAnnualActiveEntry() {
  return Boolean(findNavigoAnnualActiveEntry());
}

function hasNavigoPrelevementsEntry() {
  return Boolean(
    findByLooseText("consulter mes prelevements")
    || findByLooseText("consulter mes prélèvements")
    || findByLooseText("telecharger mes attestations de prelevements")
    || findByLooseText("télécharger mes attestations de prélèvements")
  );
}

function findNavigoAnnualActiveEntry() {
  const links = Array.from(document.querySelectorAll("a[href]")).filter(isVisible);
  return links.find((link) => {
    const text = normalizeComparableText(link.textContent || "");
    const href = String(link.getAttribute("href") || "");
    return text.includes("navigo annuel") && text.includes("actif") && /\/espace_client\/detail\//.test(href);
  }) || null;
}

function findNavigoAnnualContractIdFromList() {
  const links = Array.from(document.querySelectorAll("a[href*='/espace_client/detail/']"));
  const annualActive = links.find((link) => {
    const text = normalizeComparableText(link.textContent || "");
    return text.includes("navigo annuel") && text.includes("actif");
  });
  if (annualActive) {
    const href = String(annualActive.getAttribute("href") || "");
    const match = href.match(/\/espace_client\/detail\/([^/?#]+)/i);
    if (match?.[1]) return match[1];
  }

  const anyNavigoAnnual = links.find((link) => normalizeComparableText(link.textContent || "").includes("navigo annuel"));
  if (anyNavigoAnnual) {
    const href = String(anyNavigoAnnual.getAttribute("href") || "");
    const match = href.match(/\/espace_client\/detail\/([^/?#]+)/i);
    if (match?.[1]) return match[1];
  }

  return null;
}

async function selectNavigoLastThreeMonths(dropDown) {
  const tag = String(dropDown.tagName || "").toLowerCase();
  if (tag === "select") {
    const option = Array.from(dropDown.options || []).find((opt) => normalizeComparableText(opt.textContent || "").includes("3 derniers mois"));
    if (option) {
      dropDown.value = option.value;
      dropDown.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
  }

  realClick(dropDown);
  await wait(300);
  const optionByText = findClickableByLooseText("3 derniers mois");
  if (optionByText) {
    realClick(optionByText);
  }
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
  if (provider === "orange_provider") return isOrangeAuthenticated();
  if (provider === "free_mobile_provider") return isFreeMobileAuthenticated();
  if (provider === "navigo_provider") return isNavigoAuthenticated();
  const loginSelectors = getProviderLoginSelectors(provider);
  const hasLoginField = Boolean(queryWithin(document, loginSelectors.username) || queryWithin(document, loginSelectors.password));
  return !hasLoginField;
}

function isNavigoAuthenticated() {
  const host = String(location.hostname || "");
  if (!host.includes("iledefrance-mobilites.fr")) return false;

  const hasLoginFields = Boolean(
    document.querySelector("#id-Mail")
    || document.querySelector("#id-pwd")
    || document.querySelector("#form-log")
  );
  if (hasLoginFields) return false;

  const path = String(location.pathname || "");
  const inMonEspace = host.includes("mon-espace.iledefrance-mobilites.fr");
  const inJeGereMaCarte = host.includes("jegeremacartenavigo.iledefrance-mobilites.fr");
      const onLoginPath = /\/auth\/realms\/connect\/login-actions\/authenticate/.test(path);
      if (onLoginPath) return false;

  const text = normalizeComparableText(document.body?.textContent || "");
  const hasAuthenticatedMarker = (
    text.includes("mon espace personnel")
    || text.includes("mon navigo")
    || text.includes("mes services")
    || text.includes("deconnexion")
    || text.includes("déconnexion")
  );
  return (inMonEspace || inJeGereMaCarte) && hasAuthenticatedMarker;
}

function isFreeMobileAuthenticated() {
  if (!location.hostname.includes("mobile.free.fr")) return false;
  if (isFreeMobileOtpRequired()) return false;

  const diagnostics = getFreeMobileAuthDiagnostics();
  return diagnostics.authenticatedGuess;
}

function isFreeMobileOtpRequired() {
  const hasExplicitOtpInput = Boolean(
    queryWithin(document, [
      "input[autocomplete='one-time-code']",
      "input[name='otp']",
      "input[id='otp']",
      "input[name='smsCode']",
      "input[id='smsCode']",
      "input[name='verificationCode']",
      "input[id='verificationCode']"
    ])
  );
  if (hasExplicitOtpInput) return true;

  const hasGenericOtpInput = Boolean(
    queryWithin(document, [
      "input[name*='otp']",
      "input[id*='otp']",
      "input[name*='verification']",
      "input[id*='verification']"
    ])
  );

  const text = normalizeText(document.body?.textContent || "");
  const hasOtpChallengeText = (
    text.includes("code de verification")
    || text.includes("code de vérification")
    || text.includes("saisissez le code")
    || text.includes("entrer le code")
    || text.includes("entrez le code")
    || text.includes("code recu par sms")
    || text.includes("code reçu par sms")
    || text.includes("mot de passe a usage unique")
    || text.includes("mot de passe à usage unique")
  );

  // Avoid false positives from account pages (e.g. "SMS/MMS", "Mes codes promo").
  return hasGenericOtpInput && hasOtpChallengeText;
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


async function waitForDownloadUrl(downloadControl, beforeResources, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const href = resolveDownloadUrl(downloadControl, beforeResources) || queryDownloadCandidateFromPage() || null;
    if (href) return href;
    await wait(200);
  }
  return null;
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

function getFreeMobileAuthDiagnostics() {
  const text = normalizeText(document.body?.textContent || "");
  const pathname = String(location.pathname || "");
  const onLoginRoute = /\/account\/v2\/login(?:\/|$)/.test(pathname);
  const inAccountArea = /^\/account\/v2(?:\/|$)/.test(pathname);
  const hasExplicitLoginField = Boolean(
    document.querySelector("#login-username")
    || document.querySelector("#login-password")
  );
  const hasAuthenticatedMarker = Boolean(
    document.querySelector("#user-login, #user-name, #user-msisdn")
    || document.querySelector("button[aria-controls='invoices']")
    || document.querySelector("#invoices")
    || text.includes("conso et factures")
    || text.includes("mes factures")
    || text.includes("deconnexion")
  );
  const otpRequired = isFreeMobileOtpRequired();
  const authenticatedGuess = !otpRequired && (hasAuthenticatedMarker || (inAccountArea && !onLoginRoute && !hasExplicitLoginField));

  return {
    href: String(location.href || ""),
    pathname,
    onLoginRoute,
    inAccountArea,
    otpRequired,
    hasExplicitLoginField,
    hasAuthenticatedMarker,
    hasUserLoginNode: Boolean(document.querySelector("#user-login")),
    hasUserNameNode: Boolean(document.querySelector("#user-name")),
    hasUserMsisdnNode: Boolean(document.querySelector("#user-msisdn")),
    hasInvoicesPanel: Boolean(document.querySelector("#invoices")),
    hasInvoicesTab: Boolean(document.querySelector("button[aria-controls='invoices']")),
    authenticatedGuess
  };
}

function summarizeFreeMobileDiagnostics() {
  const d = getFreeMobileAuthDiagnostics();
  return `href=${d.href} path=${d.pathname} loginRoute=${d.onLoginRoute} accountArea=${d.inAccountArea} otp=${d.otpRequired} loginFields=${d.hasExplicitLoginField} authMarker=${d.hasAuthenticatedMarker} userNodes=${d.hasUserLoginNode || d.hasUserNameNode || d.hasUserMsisdnNode} invoicesTab=${d.hasInvoicesTab} invoicesPanel=${d.hasInvoicesPanel} authGuess=${d.authenticatedGuess}`;
}
