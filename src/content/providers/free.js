/* global window */
(function registerFreeStrategy(root) {
  const registry = root.__EXT_PROVIDER_STRATEGIES__;
  if (!registry) return;

  registry.register("free_provider", {
    isAuthenticated(ctx) {
      const loginSelectors = ctx.getProviderLoginSelectors("free_provider");
      const hasLoginField = Boolean(ctx.queryWithin(ctx.document, loginSelectors.username) || ctx.queryWithin(ctx.document, loginSelectors.password));
      return !hasLoginField;
    },

    checkBillingReady(ctx) {
      return { ready: this.isAuthenticated(ctx) };
    },

    async auth(ctx) {
      if (this.isAuthenticated(ctx)) {
        return { authenticated: true, skippedLogin: true, captchaRequired: false };
      }
      return { authenticated: false, manualLoginRequired: true, captchaRequired: false };
    },

    async navigateBilling(ctx) {
      const billing = ctx.getProviderBillingSelectors("free_provider");
      const invoices = ctx.firstNonEmptyQuery(billing.invoiceLinks || []);
      if (!invoices.length) {
        throw new Error("Could not find Free invoice link (facture_pdf.pl)");
      }
      return { navigated: true, detailUrl: ctx.location.href };
    },

    async getDownloadPlan(ctx, options) {
      const billing = options.billing || ctx.getProviderBillingSelectors("free_provider");
      const downloadControlStart = Date.now();
      const downloadControl = await findBestFreeInvoiceControl(billing.downloadButton, 12000, ctx);
      if (!downloadControl) {
        throw new Error("Could not find provider PDF download button");
      }
      const downloadControlMs = Date.now() - downloadControlStart;
      const href = ctx.resolveDownloadUrl(downloadControl, options.beforeResources, "free_provider");
      return {
        downloadControl,
        didClickControl: false,
        href,
        downloadControlMs,
        downloadUrlMs: null
      };
    },

    deriveFileName(_ctx, options) {
      const freeName = deriveFreePdfFileName(options.url);
      if (freeName) return freeName;
      return "facture_free.pdf";
    },

    shouldForceDownload(_ctx, details) {
      return Boolean(details.href);
    },

    buildNavanHints() {
      return { expenseType: "Work from home" };
    }
  });

  async function findBestFreeInvoiceControl(selectors, timeoutMs, ctx) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const links = ctx.firstNonEmptyQuery(selectors || []);
      if (links.length) {
        const preferred = pickBestFreeInvoiceByMonth(links, ctx);
        if (preferred) return preferred;
        return links[0];
      }
      await ctx.wait(200);
    }
    return null;
  }

  function pickBestFreeInvoiceByMonth(links, ctx) {
    const current = new Date();
    const currentKey = `${current.getFullYear()}${String(current.getMonth() + 1).padStart(2, "0")}`;

    const scored = links.map((el) => {
      const href = String(el.getAttribute("href") || "");
      const title = String(el.getAttribute("title") || "");
      const text = `${title} ${el.textContent || ""}`;
      const monthKey = extractMonthKeyFromFreeInvoice(href, text, ctx);
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

  function extractMonthKeyFromFreeInvoice(href, text, ctx) {
    const monthInHref = String(href || "").match(/[?&]mois=(\d{6})\b/i);
    if (monthInHref?.[1]) return monthInHref[1];

    const normalized = ctx.normalizeText(text || "");
    const frMatch = normalized.match(/\b(janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre)\s+(20\d{2})\b/i);
    if (!frMatch) return null;

    const month = frenchMonthToNumber(frMatch[1], ctx);
    if (!month) return null;
    return `${frMatch[2]}${month}`;
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
})(typeof window !== "undefined" ? window : globalThis);
