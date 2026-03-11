/* global window */
(function registerOrangeFamilyStrategies(root) {
  const registry = root.__EXT_PROVIDER_STRATEGIES__;
  if (!registry) return;

  function createOrangeFamilyStrategy(providerId) {
    return {
      isAuthenticated(ctx) {
        if (providerId === "orange_provider") {
          const onClientHost = ctx.location.hostname.includes("espace-client.orange.fr");
          if (!onClientHost) return false;
        }
        const loginSelectors = ctx.getProviderLoginSelectors(providerId);
        const hasLoginField = Boolean(ctx.queryWithin(ctx.document, loginSelectors.username) || ctx.queryWithin(ctx.document, loginSelectors.password));
        return !hasLoginField;
      },

      checkBillingReady(ctx) {
        if (providerId === "sosh_provider") {
          const href = String(ctx.location.href || "");
          const onDetailPage = /\/facture-paiement\/\d+\/detail-facture/.test(href);
          if (onDetailPage) {
            return { ready: true };
          }
          const billing = ctx.getProviderBillingSelectors(providerId);
          const downloadButton = ctx.queryWithin(ctx.document, billing.downloadButton);
          return { ready: Boolean(downloadButton) || this.isAuthenticated(ctx) };
        }
        return { ready: this.isAuthenticated(ctx) };
      },

      async auth(ctx) {
        if (this.isAuthenticated(ctx)) {
          return { authenticated: true, skippedLogin: true, captchaRequired: false };
        }
        return { authenticated: false, manualLoginRequired: true, captchaRequired: false };
      },

      async navigateBilling(ctx, payload) {
        const accountType = payload?.AccountType === "mobile_internet" ? "mobile_internet" : "home_internet";
        const href = String(ctx.location.href || "");
        const onSelectionPage = href.startsWith("https://espace-client.orange.fr/selectionner-un-contrat");
        const accountIdFromUrl = extractAccountId(null, href, ctx);
        const onBillingPage = /\/facture-paiement\/\d+/.test(href);
        if (!onSelectionPage && !onBillingPage) {
          throw new Error("Orange/Sosh is not on contract selection or billing page");
        }

        let accountId = accountIdFromUrl;
        if (!accountId) {
          const accountWaitMs = providerId === "sosh_provider" ? 1000 : 15000;
          let selectedAccountLink = await waitForAccountItem(accountType, accountWaitMs, ctx);
          if (!selectedAccountLink && providerId === "sosh_provider") {
            selectedAccountLink = await waitForAnyAccountItem(1000, ctx);
          }
          if (!selectedAccountLink) {
            throw new Error(`Could not find Orange account card for type: ${accountType}`);
          }
          const accountHref = ctx.normalizeUrl(selectedAccountLink.getAttribute("href"));
          accountId = extractAccountId(selectedAccountLink, accountHref, ctx);
          if (!accountId) {
            throw new Error("Could not extract Orange account id from selected card");
          }
        }

        const detailUrl = /\/detail-facture/.test(href)
          ? href
          : `https://espace-client.orange.fr/facture-paiement/${accountId}/detail-facture`;
        return { navigated: true, accountId, detailUrl };
      },

      async getDownloadPlan(ctx, options) {
        if (providerId === "sosh_provider") {
          const href = String(ctx.location.href || "");
          if (!/\/facture-paiement\/\d+\/detail-facture/.test(href)) {
            throw new Error("Sosh is not on invoice detail page");
          }
        }

        const billing = options.billing || ctx.getProviderBillingSelectors(providerId);
        const downloadWaitMs = providerId === "sosh_provider" ? 1000 : 12000;
        const downloadUrlWaitMs = 1000;
        const downloadControlStart = Date.now();
        const downloadControl = await ctx.waitForVisible(billing.downloadButton, downloadWaitMs);
        if (!downloadControl) {
          throw new Error("Could not find provider PDF download button");
        }
        const downloadControlMs = Date.now() - downloadControlStart;

        let didClickControl = false;
        let href = ctx.resolveDownloadUrl(downloadControl, options.beforeResources, providerId);
        let downloadUrlMs = null;
        if (!href) {
          ctx.realClick(downloadControl);
          didClickControl = true;
          const downloadUrlStart = Date.now();
          href = await ctx.waitForDownloadUrl(downloadControl, options.beforeResources, providerId, downloadUrlWaitMs);
          downloadUrlMs = Date.now() - downloadUrlStart;
        }

        return {
          downloadControl,
          didClickControl,
          href,
          downloadControlMs,
          downloadUrlMs
        };
      },

      deriveFileName(ctx, options) {
        const accountId = extractAccountIdFromLocation(ctx);
        const billDateISO = extractBillDateISO(ctx);
        if (accountId && billDateISO) {
          return `facture_${accountId}_${billDateISO}.pdf`;
        }

        const fromDisposition = ctx.parseFilenameFromContentDisposition(options.contentDisposition);
        if (fromDisposition) return fromDisposition;

        const url = String(options.url || "");
        const fromUrl = url.split("?")[0].split("/").pop();
        if (fromUrl && fromUrl.includes(".")) return fromUrl;
        if (String(options.contentType || "").includes("html")) return "orange-bill.html";
        return "orange-bill.pdf";
      }
    };
  }

  async function waitForAccountItem(accountType, timeoutMs, ctx) {
    const start = Date.now();
    const selectors = ctx.selectors.orange.billing.accountItems;
    while (Date.now() - start < timeoutMs) {
      const items = ctx.firstNonEmptyQuery(selectors);
      const selected = items.find((node) => matchesAccountType(node, accountType, ctx));
      if (selected) return selected;
      await ctx.wait(250);
    }
    return null;
  }

  async function waitForAnyAccountItem(timeoutMs, ctx) {
    const start = Date.now();
    const selectors = ctx.selectors.orange.billing.accountItems;
    while (Date.now() - start < timeoutMs) {
      const items = ctx.firstNonEmptyQuery(selectors);
      if (items.length) return items[0];
      await ctx.wait(250);
    }
    return null;
  }

  function matchesAccountType(node, accountType, ctx) {
    const text = ctx.normalizeText(node?.textContent || "");
    if (accountType === "mobile_internet") {
      return text.includes("forfait mobile");
    }
    return text.includes("offre internet");
  }

  function extractAccountId(node, href, ctx) {
    if (node && node.getAttribute) {
      const dataE2e = node.getAttribute("data-e2e");
      if (dataE2e && /^\d{6,}$/.test(dataE2e)) return dataE2e;
    }
    const url = href || (node && node.getAttribute ? ctx.normalizeUrl(node.getAttribute("href")) : null);
    if (!url) return null;
    const match = url.match(/\/facture-paiement\/(\d+)/);
    return match ? match[1] : null;
  }

  function extractAccountIdFromLocation(ctx) {
    const match = String(ctx.location.pathname || "").match(/\/facture-paiement\/(\d+)/);
    return match ? match[1] : null;
  }

  function extractBillDateISO(ctx) {
    const button = ctx.document.querySelector("button[data-e2e='download-link'], a[data-e2e='download-link']");
    const text = ctx.normalizeText(button?.textContent || ctx.document.body?.textContent || "");
    if (!text) return null;

    const isoMatch = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (isoMatch?.[1]) return isoMatch[1];

    const frMatch = text.match(/\b(\d{1,2})\s+(janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre)\s+(20\d{2})\b/i);
    if (!frMatch) return null;

    const day = frMatch[1].padStart(2, "0");
    const month = frenchMonthToNumber(frMatch[2], ctx);
    const year = frMatch[3];
    if (!month) return null;
    return `${year}-${month}-${day}`;
  }

  function frenchMonthToNumber(value, ctx) {
    const month = ctx.normalizeText(value)
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

  registry.register("orange_provider", createOrangeFamilyStrategy("orange_provider"));
  registry.register("sosh_provider", createOrangeFamilyStrategy("sosh_provider"));
})(typeof window !== "undefined" ? window : globalThis);
