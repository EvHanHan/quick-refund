/* global window */
(function registerFreeMobileStrategy(root) {
  const registry = root.__EXT_PROVIDER_STRATEGIES__;
  if (!registry) return;

  registry.register("free_mobile_provider", {
    checkProviderSession(ctx) {
      const diagnostics = getFreeMobileAuthDiagnostics(ctx);
      return {
        authenticated: isFreeMobileAuthenticated(ctx),
        diagnostics
      };
    },

    isAuthenticated(ctx) {
      return isFreeMobileAuthenticated(ctx);
    },

    checkBillingReady(ctx) {
      const diagnostics = getFreeMobileAuthDiagnostics(ctx);
      return {
        ready: isFreeMobileAuthenticated(ctx),
        diagnostics
      };
    },

    async auth(ctx) {
      if (isFreeMobileAuthenticated(ctx)) {
        return { authenticated: true, skippedLogin: true, captchaRequired: false };
      }
      if (isFreeMobileOtpRequired(ctx)) {
        return { authenticated: false, manualLoginRequired: true, smsCodeRequired: true };
      }
      return { authenticated: false, manualLoginRequired: true, captchaRequired: false };
    },

    async navigateBilling(ctx) {
      if (!ctx.location.hostname.includes("mobile.free.fr")) {
        throw new Error("Free Mobile tab is not on mobile.free.fr");
      }
      if (!isFreeMobileAuthenticated(ctx)) {
        throw new Error("Free Mobile user is not authenticated");
      }

      const inAccountArea = /^\/account\/v2(?:\/|$)/.test(ctx.location.pathname);
      if (inAccountArea) {
        return { navigated: true, detailUrl: ctx.location.href };
      }
      return { navigated: true, detailUrl: "https://mobile.free.fr/account/v2" };
    },

    async getDownloadPlan(ctx, options) {
      const billing = options.billing || ctx.getProviderBillingSelectors("free_mobile_provider");
      const downloadControlStart = Date.now();
      const downloadControl = await findBestFreeMobileInvoiceControl(billing, 12000, ctx);
      if (!downloadControl) {
        throw new Error("Could not find provider PDF download button");
      }
      const downloadControlMs = Date.now() - downloadControlStart;
      let didClickControl = false;
      let href = ctx.resolveDownloadUrl(downloadControl, options.beforeResources, "free_mobile_provider");
      let downloadUrlMs = null;
      if (!href) {
        ctx.realClick(downloadControl);
        didClickControl = true;
        const downloadUrlStart = Date.now();
        href = await ctx.waitForDownloadUrl(downloadControl, options.beforeResources, "free_mobile_provider", 8000);
        downloadUrlMs = Date.now() - downloadUrlStart;
      }
      return { downloadControl, didClickControl, href, downloadControlMs, downloadUrlMs };
    },

    deriveFileName(_ctx, options) {
      const freeMobileName = deriveFreeMobilePdfFileName(options.url);
      if (freeMobileName) return freeMobileName;
      return "facture_free_mobile.pdf";
    },

    buildNavanHints() {
      return { expenseType: "Work from home" };
    }
  });

  async function findBestFreeMobileInvoiceControl(billingSelectors, timeoutMs, ctx) {
    const invoicesVisible = await ensureFreeMobileInvoicesVisible(timeoutMs, ctx);
    if (!invoicesVisible) return null;

    const invoicesPanel = getFreeMobileInvoicesPanel(ctx);
    if (!invoicesPanel) return null;

    const latestSelectors = [
      "a[download][href*='/account/v2/api/SI/invoice/'][href*='display=1']",
      "a[download][href*='/api/SI/invoice/'][href*='display=1']",
      "a[href*='/account/v2/api/SI/invoice/'][href*='display=1']",
      "a[href*='/api/SI/invoice/'][href*='display=1']"
    ];

    const latestCta = pickFreeMobileLatestInvoiceCta(invoicesPanel, latestSelectors, ctx);
    if (latestCta) return latestCta;

    const fallbackSelectors = [
      "#invoices ul li a[href*='/api/SI/invoice/'][href*='display=1']",
      "#invoices a[href*='/api/SI/invoice/'][href*='display=1']",
      ...((billingSelectors?.downloadButton && Array.isArray(billingSelectors.downloadButton))
        ? billingSelectors.downloadButton.map((selector) => selector.startsWith("#invoices") ? selector : `#invoices ${selector}`)
        : [])
    ];

    return ctx.waitForVisible(fallbackSelectors, 4000);
  }

  function pickFreeMobileLatestInvoiceCta(invoicesPanel, selectors, ctx) {
    const ctas = ctx.firstNonEmptyQueryWithin(invoicesPanel, selectors);
    if (!ctas.length) return null;
    const preferred = ctas.find((node) => {
      const text = ctx.normalizeText(node.textContent || "");
      return text.includes("telecharger ma facture");
    });
    return preferred || ctas[0] || null;
  }

  async function ensureFreeMobileInvoicesVisible(timeoutMs, ctx) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const panel = getFreeMobileInvoicesPanel(ctx);
      if (panel) return true;

      if (!/^\/account\/v2(?:\/|$)/.test(ctx.location.pathname)) {
        const consoAndFactures = findClickableByText("conso et factures", ctx);
        if (consoAndFactures) {
          ctx.realClick(consoAndFactures);
          await ctx.wait(500);
        }
      }

      const invoicesTab = ctx.pick([
        "button[role='tab'][aria-controls='invoices']",
        "button[aria-controls='invoices']",
        "#invoices ~ ul [aria-controls='invoices']"
      ]);
      if (invoicesTab) {
        ctx.realClick(invoicesTab);
        await ctx.wait(350);
      } else {
        const invoicesByText = findClickableByText("mes factures", ctx);
        if (invoicesByText) {
          ctx.realClick(invoicesByText);
          await ctx.wait(350);
        }
      }
    }
    return false;
  }

  function getFreeMobileInvoicesPanel(ctx) {
    const panel = ctx.document.querySelector("#invoices");
    if (!panel) return null;
    if (!ctx.isVisible(panel)) return null;
    if (panel.hasAttribute("hidden") || panel.classList.contains("hidden")) return null;
    return panel;
  }

  function findClickableByText(text, ctx) {
    const target = ctx.normalizeText(text);
    const nodes = Array.from(ctx.document.querySelectorAll("button,a,[role='tab']"));
    return nodes.find((node) => ctx.normalizeText(node.textContent || "").includes(target) && ctx.isVisible(node)) || null;
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

  function isFreeMobileAuthenticated(ctx) {
    if (!ctx.location.hostname.includes("mobile.free.fr")) return false;
    if (isFreeMobileOtpRequired(ctx)) return false;
    const diagnostics = getFreeMobileAuthDiagnostics(ctx);
    return diagnostics.authenticatedGuess;
  }

  function isFreeMobileOtpRequired(ctx) {
    const hasExplicitOtpInput = Boolean(
      ctx.queryWithin(ctx.document, [
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
    if (hasFreeMobileOtpDigitInputs(ctx)) return true;

    const hasGenericOtpInput = Boolean(
      ctx.queryWithin(ctx.document, [
        "input[name*='otp']",
        "input[id*='otp']",
        "input[name*='verification']",
        "input[id*='verification']"
      ])
    );

    return hasGenericOtpInput && hasFreeMobileOtpChallengeText(ctx);
  }

  function getFreeMobileAuthDiagnostics(ctx) {
    const text = getFreeMobileAuthScopeText(ctx);
    const pathname = String(ctx.location.pathname || "");
    const onLoginRoute = /\/account\/v2\/login(?:\/|$)/.test(pathname);
    const inAccountArea = /^\/account\/v2(?:\/|$)/.test(pathname);
    const hasExplicitLoginField = Boolean(
      ctx.document.querySelector("#login-username")
      || ctx.document.querySelector("#login-password")
    );
    const hasAuthenticatedMarker = Boolean(
      ctx.document.querySelector("#user-login, #user-name, #user-msisdn")
      || ctx.document.querySelector("button[aria-controls='invoices']")
      || ctx.document.querySelector("#invoices")
      || text.includes("conso et factures")
      || text.includes("mes factures")
      || text.includes("deconnexion")
    );
    const otpRequired = isFreeMobileOtpRequired(ctx);
    const authenticatedGuess = !otpRequired && (hasAuthenticatedMarker || (inAccountArea && !onLoginRoute && !hasExplicitLoginField));

    return {
      href: String(ctx.location.href || ""),
      pathname,
      onLoginRoute,
      inAccountArea,
      otpRequired,
      hasExplicitLoginField,
      hasAuthenticatedMarker,
      hasUserLoginNode: Boolean(ctx.document.querySelector("#user-login")),
      hasUserNameNode: Boolean(ctx.document.querySelector("#user-name")),
      hasUserMsisdnNode: Boolean(ctx.document.querySelector("#user-msisdn")),
      hasInvoicesPanel: Boolean(ctx.document.querySelector("#invoices")),
      hasInvoicesTab: Boolean(ctx.document.querySelector("button[aria-controls='invoices']")),
      authenticatedGuess
    };
  }

  function hasFreeMobileOtpChallengeText(ctx) {
    const text = getFreeMobileAuthScopeText(ctx);
    if (!text) return false;
    return (
      text.includes("code de verification")
      || text.includes("code de vérification")
      || text.includes("code de securite")
      || text.includes("code de sécurité")
      || text.includes("saisissez le code")
      || text.includes("entrer le code")
      || text.includes("entrez le code")
      || text.includes("code recu par sms")
      || text.includes("code reçu par sms")
      || text.includes("mot de passe a usage unique")
      || text.includes("mot de passe à usage unique")
    );
  }

  function hasFreeMobileOtpDigitInputs(ctx) {
    const hasSecurityCodeLabel = Boolean(
      ctx.findByLooseText("code de securite")
      || ctx.findByLooseText("code de sécurité")
    );
    if (!hasSecurityCodeLabel) return false;

    const singleDigitInputs = Array.from(ctx.document.querySelectorAll("input"))
      .filter((input) => {
        if (!ctx.isVisible(input)) return false;
        const maxLength = Number(input.getAttribute("maxlength") || 0);
        const type = String(input.getAttribute("type") || "").toLowerCase();
        const inputMode = String(input.getAttribute("inputmode") || "").toLowerCase();
        const isSingleChar = maxLength === 1;
        const acceptsDigitLike = type === "number" || type === "tel" || inputMode === "numeric" || inputMode === "decimal";
        return isSingleChar || acceptsDigitLike;
      });

    return singleDigitInputs.length >= 4 && singleDigitInputs.length <= 8;
  }

  function getFreeMobileAuthScopeText(ctx) {
    const roots = [
      ctx.document.querySelector("main"),
      ctx.document.querySelector("form"),
      ctx.document.querySelector("[role='main']"),
      ctx.document.querySelector("#app"),
      ctx.document.querySelector("#root"),
      ctx.document.body
    ].filter(Boolean);

    const chunks = [];
    for (const root of roots) {
      const raw = String(root.textContent || "").trim();
      if (!raw) continue;
      chunks.push(raw.slice(0, 4000));
      if (chunks.length >= 2) break;
    }

    return ctx.normalizeText(chunks.join(" "));
  }
})(typeof window !== "undefined" ? window : globalThis);
