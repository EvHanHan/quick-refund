/* global window */
(function registerBouyguesStrategy(root) {
  const registry = root.__EXT_PROVIDER_STRATEGIES__;
  if (!registry) return;

  const BOUYGUES_BILLING_URL = "https://www.bouyguestelecom.fr/mon-compte/mes-factures";

  function isAssistancePage(ctx) {
    const host = String(ctx.location.hostname || "").toLowerCase();
    const path = String(ctx.location.pathname || "").toLowerCase();
    return host.includes("assistance.bouyguestelecom.fr") || path.startsWith("/s/article/");
  }

  function isAssistanceUrl(url) {
    const raw = String(url || "").trim();
    if (!raw) return false;
    try {
      const parsed = new URL(raw, "https://www.bouyguestelecom.fr");
      const host = String(parsed.hostname || "").toLowerCase();
      const path = String(parsed.pathname || "").toLowerCase();
      return host.includes("assistance.bouyguestelecom.fr") || path.startsWith("/s/article/");
    } catch (_error) {
      return raw.toLowerCase().includes("assistance.bouyguestelecom.fr");
    }
  }

  function isCouponUrl(url) {
    return /\/static\/odr\/|coupon|byou_clients_box/i.test(String(url || ""));
  }

  function isLikelyBouyguesInvoiceUrl(url) {
    const raw = String(url || "").trim();
    if (!raw) return false;
    if (isAssistanceUrl(raw)) return false;
    if (isCouponUrl(raw)) return false;
    if (/\.(js|css|map)(\?|#|$)/i.test(raw)) return false;
    if (/assets\.bouyguestelecom\.fr\/ACO\//i.test(raw)) return false;
    return /(\.pdf)(\?|#|$)/i.test(raw) || /facture|invoice|bill|telecharg/i.test(raw);
  }

  async function waitForBouyguesInvoiceUrl(ctx, downloadControl, beforeResources, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const candidate = ctx.resolveDownloadUrl(downloadControl, beforeResources, "bouygues_provider");
      if (isLikelyBouyguesInvoiceUrl(candidate)) return candidate;
      await ctx.wait(200);
    }
    return null;
  }

  function hasLoginFields(ctx) {
    const loginSelectors = ctx.getProviderLoginSelectors("bouygues_provider");
    return Boolean(
      ctx.queryWithin(ctx.document, loginSelectors.username)
      || ctx.queryWithin(ctx.document, loginSelectors.password)
    );
  }

  function hasInvoiceSignals(ctx) {
    const text = ctx.normalizeText(ctx.document.body?.textContent || "");
    if (text.includes("mes factures") || text.includes("vos factures")) return true;
    if (text.includes("telecharger") && text.includes("facture")) return true;
    return Boolean(ctx.document.querySelector("a[href*='facture'],a[href*='invoice'],a[href*='.pdf']"));
  }

  function getBouyguesDiagnostics(ctx) {
    const path = String(ctx.location.pathname || "");
    const fullUrl = String(ctx.location.href || "");
    const assistancePage = isAssistancePage(ctx);
    const loginFields = hasLoginFields(ctx);
    const invoiceSignals = hasInvoiceSignals(ctx);
    const onBillingPath = /\/mon-compte\/(?:mes-)?factures(?:\/|$)/i.test(path);
    return {
      host: String(ctx.location.hostname || ""),
      path,
      url: fullUrl,
      assistancePage,
      loginFields,
      invoiceSignals,
      onBillingPath,
      authenticatedGuess: !assistancePage && !loginFields
    };
  }

  function lineTypeFromValue(value) {
    const digits = String(value || "").replace(/\D+/g, "");
    if (digits.startsWith("06") || digits.startsWith("07")) return "mobile_internet";
    return "home_internet";
  }

  function getRowLineValue(row, billing) {
    const candidates = Array.isArray(billing?.lineCell) ? billing.lineCell : [];
    for (const selector of candidates) {
      try {
        const cell = row.querySelector(selector);
        if (cell && String(cell.textContent || "").trim()) {
          return String(cell.textContent || "").trim();
        }
      } catch (_error) {
        // Ignore invalid selectors.
      }
    }
    const fallback = String(row.textContent || "").match(/\b0[1-9](?:[\s.-]?\d{2}){4}\b/);
    return fallback?.[0] || "";
  }

  function findRowDownloadLink(row, billing, ctx) {
    const selectors = [
      ...(Array.isArray(billing?.rowDownloadLinks) ? billing.rowDownloadLinks : []),
      "a",
      "button",
      "[role='button']"
    ];
    const controls = [];
    for (const selector of selectors) {
      try {
        controls.push(...Array.from(row.querySelectorAll(selector)));
      } catch (_error) {
        // Ignore invalid selectors.
      }
    }
    const uniqueControls = Array.from(new Set(controls)).filter((node) => ctx.isVisible(node));
    if (!uniqueControls.length) return null;

    const scored = uniqueControls.map((node) => {
      const text = ctx.normalizeComparableText(node.textContent || "");
      const href = String(node.getAttribute?.("href") || "");
      let score = 0;
      if (text.includes("telecharger la facture")) score += 100;
      else if (text.includes("telecharger")) score += 80;
      else if (text.includes("facture")) score += 30;

      if (text.includes("consulter/payer") || text.includes("consulter") || text.includes("payer")) score -= 120;
      if (href) score += 10;
      if (/facture|invoice|telecharg/i.test(href)) score += 50;
      if (/pdf|telecharg/i.test(href)) score += 40;
      if (/facture-detaillee|consulter|payer/i.test(href)) score -= 60;
      if (isCouponUrl(href)) score -= 200;
      return { node, score };
    }).sort((a, b) => b.score - a.score);

    const explicitDownload = scored.find((item) => {
      const text = ctx.normalizeComparableText(item.node.textContent || "");
      const href = String(item.node.getAttribute?.("href") || "");
      return text.includes("telecharger") && !isCouponUrl(href);
    });
    if (explicitDownload) return explicitDownload.node;

    return null;
  }

  async function waitForInvoiceRows(ctx, billing, timeoutMs) {
    const selectors = Array.isArray(billing?.invoiceRows) && billing.invoiceRows.length
      ? billing.invoiceRows
      : ["table tbody tr"];
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const rows = [];
      for (const selector of selectors) {
        try {
          rows.push(...Array.from(ctx.document.querySelectorAll(selector)));
        } catch (_error) {
          // Ignore invalid selectors.
        }
      }

      const candidates = rows.filter((row) => {
        if (!ctx.isVisible(row)) return false;
        const rowText = ctx.normalizeText(row.textContent || "");
        if (!rowText) return false;
        return Boolean(findRowDownloadLink(row, billing, ctx));
      });
      if (candidates.length) return candidates;
      await ctx.wait(200);
    }
    return [];
  }

  registry.register("bouygues_provider", {
    checkProviderSession(ctx) {
      const diagnostics = getBouyguesDiagnostics(ctx);
      return {
        authenticated: this.isAuthenticated(ctx),
        diagnostics
      };
    },

    isAuthenticated(ctx) {
      if (isAssistancePage(ctx)) return false;
      return !hasLoginFields(ctx);
    },

    checkBillingReady(ctx) {
      const diagnostics = getBouyguesDiagnostics(ctx);
      const authenticated = this.isAuthenticated(ctx);
      return {
        ready: authenticated && (diagnostics.onBillingPath || diagnostics.invoiceSignals),
        diagnostics
      };
    },

    async auth(ctx) {
      const diagnostics = getBouyguesDiagnostics(ctx);
      if (this.isAuthenticated(ctx)) {
        return { authenticated: true, skippedLogin: true, captchaRequired: false, diagnostics };
      }
      return { authenticated: false, manualLoginRequired: true, captchaRequired: false, diagnostics };
    },

    async navigateBilling(ctx) {
      const diagnostics = getBouyguesDiagnostics(ctx);
      if (isAssistancePage(ctx)) {
        return {
          navigated: true,
          detailUrl: BOUYGUES_BILLING_URL,
          diagnostics: {
            ...diagnostics,
            resolution: "assistance_fallback_to_billing_url"
          }
        };
      }

      if (diagnostics.onBillingPath) {
        return {
          navigated: true,
          detailUrl: String(ctx.location.href || BOUYGUES_BILLING_URL),
          diagnostics: {
            ...diagnostics,
            resolution: "current_url_is_billing"
          }
        };
      }

      return {
        navigated: true,
        detailUrl: BOUYGUES_BILLING_URL,
        diagnostics: {
          ...diagnostics,
          resolution: "default_billing_fallback"
        }
      };
    },

    async getDownloadPlan(ctx, options) {
      const billing = options.billing || ctx.getProviderBillingSelectors("bouygues_provider");
      const targetType = options.accountType === "mobile_internet" ? "mobile_internet" : "home_internet";
      const rows = await waitForInvoiceRows(ctx, billing, 12000);
      if (!rows.length) {
        throw new Error("Could not find Bouygues invoice rows");
      }

      const withType = rows.map((row, index) => {
        const line = getRowLineValue(row, billing);
        const type = lineTypeFromValue(line);
        return { row, index, line, type };
      });

      let selected = withType.find((entry) => entry.type === targetType) || null;
      let usedFallbackRow = false;
      if (!selected) {
        selected = withType[0];
        usedFallbackRow = true;
      }

      const downloadControl = findRowDownloadLink(selected.row, billing, ctx);
      if (!downloadControl) {
        throw new Error("Could not find Bouygues 'Telecharger la facture' link in selected row");
      }

      const downloadControlStart = Date.now();
      let didClickControl = false;
      let href = ctx.resolveDownloadUrl(downloadControl, options.beforeResources, "bouygues_provider");
      if (!isLikelyBouyguesInvoiceUrl(href)) {
        href = null;
      }
      let downloadUrlMs = null;
      if (!href) {
        ctx.realClick(downloadControl);
        didClickControl = true;
        const downloadUrlStart = Date.now();
        href = await waitForBouyguesInvoiceUrl(ctx, downloadControl, options.beforeResources, 10000);
        downloadUrlMs = Date.now() - downloadUrlStart;
      }
      if (!href) {
        throw new Error("Could not resolve Bouygues invoice download URL");
      }

      const actionText = ctx.normalizeText(downloadControl.textContent || "");
      options.diagnostics = {
        rowCount: withType.length,
        selectedRowIndex: selected.index,
        selectedLine: selected.line,
        selectedType: selected.type,
        requestedType: targetType,
        fallbackRowUsed: usedFallbackRow,
        selectedAction: actionText || "none",
        selectedActionHref: String(downloadControl.getAttribute("href") || "")
      };

      return {
        downloadControl,
        didClickControl,
        href,
        downloadControlMs: Date.now() - downloadControlStart,
        downloadUrlMs,
        diagnostics: options.diagnostics
      };
    },

    deriveFileName(ctx, options) {
      const fromDisposition = ctx.parseFilenameFromContentDisposition(options.contentDisposition);
      if (fromDisposition) return fromDisposition;

      const url = String(options.url || "");
      const fromUrl = url.split("?")[0].split("/").pop();
      if (fromUrl && fromUrl.includes(".")) return fromUrl;

      if (String(options.contentType || "").includes("html")) return "provider-bill.html";
      return "provider-bill.pdf";
    },

    shouldForceDownload() {
      return false;
    },

    buildNavanHints() {
      return undefined;
    }
  });
})(typeof window !== "undefined" ? window : globalThis);
