/* global window */
(function registerGenericProviderStrategy(root) {
  const registry = root.__EXT_PROVIDER_STRATEGIES__;
  if (!registry) return;

  const genericStrategy = {
    isAuthenticated(ctx) {
      const loginSelectors = ctx.getProviderLoginSelectors(ctx.provider);
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
      const generic = ctx.selectors.providerDefaults.billing.invoiceLinks;
      const invoiceEntry = await ctx.waitForVisible(generic, 8000);
      if (invoiceEntry) {
        const href = ctx.normalizeUrl(invoiceEntry.getAttribute("href"));
        if (href) {
          return { navigated: true, detailUrl: href };
        }
        ctx.realClick(invoiceEntry);
      }
      return { navigated: true, detailUrl: ctx.location.href };
    },

    async getDownloadPlan(ctx, options) {
      const billing = options.billing || ctx.getProviderBillingSelectors(ctx.provider);
      const downloadControlStart = Date.now();
      const downloadControl = await ctx.waitForVisible(billing.downloadButton, 12000);
      if (!downloadControl) {
        throw new Error("Could not find provider PDF download button");
      }
      const downloadControlMs = Date.now() - downloadControlStart;

      let didClickControl = false;
      let href = ctx.resolveDownloadUrl(downloadControl, options.beforeResources, ctx.provider);
      let downloadUrlMs = null;
      if (!href) {
        ctx.realClick(downloadControl);
        didClickControl = true;
        const downloadUrlStart = Date.now();
        href = await ctx.waitForDownloadUrl(downloadControl, options.beforeResources, ctx.provider, 8000);
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
  };

  registry.register("generic", genericStrategy);
})(typeof window !== "undefined" ? window : globalThis);
