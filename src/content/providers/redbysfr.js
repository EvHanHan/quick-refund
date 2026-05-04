/* global window */
(function registerRedBySfrStrategy(root) {
  const registry = root.__EXT_PROVIDER_STRATEGIES__;
  if (!registry) return;

  registry.register("redbysfr_provider", {
    hasInvoiceContentVisible(ctx, billing) {
      const heading = ctx.findByText("vos factures") || ctx.findByText("facture fixe");
      if (heading) return true;
      const downloadSelectors = billing?.downloadButton || [];
      const invoiceSelectors = billing?.invoiceLinks || [];
      return Boolean(ctx.queryWithin(ctx.document, [...downloadSelectors, ...invoiceSelectors]));
    },

    isConsoTabActive(ctx) {
      const tabNodes = Array.from(ctx.document.querySelectorAll("button[role='tab'],a[role='tab'],[role='tab']"));
      for (const node of tabNodes) {
        const text = ctx.normalizeText(node.textContent || "");
        const selected = String(node.getAttribute("aria-selected") || "").toLowerCase() === "true";
        const active = node.classList.contains("active") || node.classList.contains("selected");
        if ((selected || active) && text.includes("conso en cours")) {
          return true;
        }
      }
      return false;
    },

    findFacturesTab(ctx) {
      const tabNodes = Array.from(ctx.document.querySelectorAll("button,a,[role='tab']"));
      const candidates = tabNodes.filter((node) => {
        const text = ctx.normalizeText(node.textContent || "");
        return text.includes("factures") || text === "facture" || text.includes("mes factures");
      });
      const semanticCandidate = candidates.find((node) => {
        const role = String(node.getAttribute("role") || "").toLowerCase();
        const controls = ctx.normalizeText(node.getAttribute("aria-controls") || "");
        const labelledBy = ctx.normalizeText(node.getAttribute("aria-labelledby") || "");
        return role === "tab" || controls.includes("facture") || labelledBy.includes("facture");
      });
      return semanticCandidate || candidates[0] || null;
    },

    async ensureFacturesTabVisible(ctx, billing) {
      if (this.hasInvoiceContentVisible(ctx, billing)) return;
      const timeoutMs = 7000;
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (this.hasInvoiceContentVisible(ctx, billing)) return;
        const facturesTab = this.findFacturesTab(ctx);
        if (facturesTab) {
          ctx.realClick(facturesTab);
          await ctx.wait(350);
          continue;
        }
        if (!this.isConsoTabActive(ctx)) {
          await ctx.wait(250);
          continue;
        }
        await ctx.wait(250);
      }
      throw new Error("Could not switch RED by SFR page from 'Conso en cours' to 'Factures'");
    },

    isAuthenticated(ctx) {
      const loginSelectors = ctx.getProviderLoginSelectors("redbysfr_provider");
      const hasLoginField = Boolean(ctx.queryWithin(ctx.document, loginSelectors.username) || ctx.queryWithin(ctx.document, loginSelectors.password));
      return !hasLoginField;
    },

    checkBillingReady(ctx) {
      const text = ctx.normalizeText(ctx.document.body?.textContent || "");
      const factureHeading = ctx.findByText("vos factures") || ctx.findByText("facture fixe");
      return {
        ready: Boolean(factureHeading) || text.includes("vos factures") || text.includes("facture fixe") || this.isAuthenticated(ctx)
      };
    },

    async auth(ctx) {
      if (this.isAuthenticated(ctx)) {
        return { authenticated: true, skippedLogin: true, captchaRequired: false };
      }
      return { authenticated: false, manualLoginRequired: true, captchaRequired: false };
    },

    async navigateBilling(ctx) {
      return { navigated: true, detailUrl: ctx.location.href };
    },

    async getDownloadPlan(ctx, options) {
      const billing = options.billing || ctx.getProviderBillingSelectors("redbysfr_provider");
      await this.ensureFacturesTabVisible(ctx, billing);
      const downloadControlStart = Date.now();
      const downloadControl = await ctx.waitForVisible(billing.downloadButton, 12000);
      if (!downloadControl) {
        throw new Error("Could not find provider PDF download button");
      }
      const downloadControlMs = Date.now() - downloadControlStart;
      let didClickControl = false;
      let href = ctx.resolveDownloadUrl(downloadControl, options.beforeResources, "redbysfr_provider");
      let downloadUrlMs = null;
      if (!href) {
        ctx.realClick(downloadControl);
        didClickControl = true;
        const downloadUrlStart = Date.now();
        href = await ctx.waitForDownloadUrl(downloadControl, options.beforeResources, "redbysfr_provider", 8000);
        downloadUrlMs = Date.now() - downloadUrlStart;
      }
      return { downloadControl, didClickControl, href, downloadControlMs, downloadUrlMs };
    },

    deriveFileName(ctx, options) {
      const fromDisposition = ctx.parseFilenameFromContentDisposition(options.contentDisposition);
      if (fromDisposition) return fromDisposition;
      const url = String(options.url || "");
      const fromUrl = url.split("?")[0].split("/").pop();
      if (fromUrl && fromUrl.includes(".")) return fromUrl;
      return "red-bill.pdf";
    },

    buildNavanHints(_ctx, options) {
      const accountType = String(options?.accountType || "").trim();
      if (accountType === "mobile_internet") {
        return { expenseType: "Work from home" };
      }
      return { expenseType: "Work from home" };
    }
  });
})(typeof window !== "undefined" ? window : globalThis);
