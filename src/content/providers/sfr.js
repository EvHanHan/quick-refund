/* global window */
(function registerSfrStrategy(root) {
  const registry = root.__EXT_PROVIDER_STRATEGIES__;
  if (!registry) return;

  registry.register("sfr_provider", {
    isAuthenticated(ctx) {
      const loginSelectors = ctx.getProviderLoginSelectors("sfr_provider");
      const hasLoginField = Boolean(ctx.queryWithin(ctx.document, loginSelectors.username) || ctx.queryWithin(ctx.document, loginSelectors.password));
      return !hasLoginField;
    },

    checkBillingReady(ctx) {
      const text = ctx.normalizeText(ctx.document.body?.textContent || "");
      return {
        ready: text.includes("facture") || text.includes("conso") || this.isAuthenticated(ctx)
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
      const billing = options.billing || ctx.getProviderBillingSelectors("sfr_provider");
      const downloadControlStart = Date.now();
      const downloadControl = await ctx.waitForVisible(billing.downloadButton, 12000);
      if (!downloadControl) {
        throw new Error("Could not find provider PDF download button");
      }
      const downloadControlMs = Date.now() - downloadControlStart;
      let didClickControl = false;
      let href = ctx.resolveDownloadUrl(downloadControl, options.beforeResources, "sfr_provider");
      let downloadUrlMs = null;
      if (!href) {
        ctx.realClick(downloadControl);
        didClickControl = true;
        const downloadUrlStart = Date.now();
        href = await ctx.waitForDownloadUrl(downloadControl, options.beforeResources, "sfr_provider", 8000);
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
      return "sfr-bill.pdf";
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
