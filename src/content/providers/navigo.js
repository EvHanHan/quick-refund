/* global window */
(function registerNavigoStrategy(root) {
  const registry = root.__EXT_PROVIDER_STRATEGIES__;
  if (!registry) return;

  registry.register("navigo_provider", {
    checkProviderSession(ctx) {
      const diagnostics = getNavigoAuthDiagnostics(ctx);
      return {
        authenticated: isNavigoAuthenticated(ctx),
        diagnostics
      };
    },

    isAuthenticated(ctx) {
      return isNavigoAuthenticated(ctx);
    },

    checkBillingReady(ctx) {
      const diagnostics = getNavigoAuthDiagnostics(ctx);
      return {
        ready: isNavigoAuthenticated(ctx),
        diagnostics
      };
    },

    async auth(ctx) {
      const diagnostics = getNavigoAuthDiagnostics(ctx);
      if (isNavigoAuthenticated(ctx)) {
        return { authenticated: true, skippedLogin: true, captchaRequired: false, diagnostics };
      }
      return { authenticated: false, manualLoginRequired: true, captchaRequired: false, diagnostics };
    },

    async navigateBilling(ctx, payload) {
      const authenticated = await ensureNavigoAuthenticated(6000, ctx);
      if (!authenticated) {
        const diagnostics = getNavigoAuthDiagnostics(ctx);
        throw new Error(`Navigo user is not authenticated | ${formatNavigoAuthDiagnostics(diagnostics)} | ${summarizeNavigoPageDiagnostics(ctx)}`);
      }
      await waitForNavigoRoutingHints(4000, ctx);
      const accountType = String(payload?.AccountType || "").trim();

      if (accountType === "monthly") {
        const monthly = await navigateNavigoMonthlyPath(20_000, ctx);
        if (!monthly?.navigated) {
          throw new Error(
            `Could not open Navigo monthly attestation flow (${monthly?.reason || "unknown"}) | ${summarizeNavigoPageDiagnostics(ctx)}`
          );
        }
        return { navigated: true, detailUrl: monthly.detailUrl || ctx.location.href };
      }

      const prelevementsUrl = resolveNavigoPrelevementsUrl(ctx);
      if (prelevementsUrl) {
        return { navigated: true, detailUrl: prelevementsUrl };
      }

      const directBillingUrl = resolveNavigoBillingEntryUrl(ctx);
      if (directBillingUrl) {
        return { navigated: true, detailUrl: directBillingUrl };
      }
      const navigoTab = await clickNavigoBillingPath(8000, ctx);
      if (!navigoTab) {
        throw new Error(`Could not open Navigo billing section | ${summarizeNavigoPageDiagnostics(ctx)}`);
      }
      return { navigated: true, detailUrl: ctx.location.href };
    },

    async getDownloadPlan(ctx, options) {
      const billing = options.billing || ctx.getProviderBillingSelectors("navigo_provider");
      const downloadControlStart = Date.now();
      const downloadControl = await findBestNavigoInvoiceControl(billing, 20000, ctx);
      if (!downloadControl) {
        throw new Error("Could not find provider PDF download button");
      }
      const downloadControlMs = Date.now() - downloadControlStart;

      ctx.realClick(downloadControl);
      const downloadUrlStart = Date.now();
      const href = await ctx.waitForNavigoDownloadUrl(options.beforeResources, 8000);
      const downloadUrlMs = Date.now() - downloadUrlStart;

      return {
        downloadControl,
        didClickControl: true,
        href,
        downloadControlMs,
        downloadUrlMs
      };
    },

    deriveFileName(ctx, options) {
      const navigoName = deriveNavigoPdfFileName(options.url, ctx);
      if (navigoName) return navigoName;
      return "attestation_navigo.pdf";
    },

    buildNavanHints(ctx, options) {
      const accountType = String(options?.accountType || "").trim();
      return {
        ...(accountType === "monthly" ? { expenseType: "Commuter Benefits" } : {}),
        transactionDateISO: ctx.getCurrentMonthStartISO()
      };
    }
  });

  async function waitForNavigoRoutingHints(timeoutMs, ctx) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const hasDetailLink = Boolean(ctx.document.querySelector("a[href*='/espace_client/detail/']"));
      const hasMonNavigo = Boolean(findNavigoAnchorByText("mon navigo", ctx));
      const onDetailPage = /\/espace_client\/detail\/[^/?#]+/i.test(String(ctx.location.pathname || ""));
      const onPrelevementPage = /\/prelevements\/[^/?#]+/i.test(String(ctx.location.pathname || ""));
      const onAttestationPage = /\/attestation\/[^/?#]+/i.test(String(ctx.location.pathname || ""));
      if (hasDetailLink || hasMonNavigo || onDetailPage || onPrelevementPage || onAttestationPage) return;
      await ctx.wait(150);
    }
  }

  function summarizeNavigoPageDiagnostics(ctx) {
    const text = ctx.normalizeComparableText(ctx.document.body?.textContent || "");
    const anchors = Array.from(ctx.document.querySelectorAll("a[href],button,[role='button']"))
      .map((node) => {
        const label = ctx.normalizeComparableText(node.textContent || "").slice(0, 80);
        const href = node.getAttribute?.("href") || "";
        return `${label}${href ? ` -> ${href}` : ""}`;
      })
      .filter((line) => line.includes("navigo") || line.includes("prelev") || line.includes("attestation") || line.includes("facture") || line.includes("justificatif"))
      .slice(0, 20);

    return [
      `href=${ctx.location.href}`,
      `path=${ctx.location.pathname}`,
      `hasMonNavigoText=${text.includes("mon navigo")}`,
      `hasPrelevementsText=${text.includes("prelevement") || text.includes("prélèvement")}`,
      `hasAttestationsText=${text.includes("attestation")}`,
      `candidates=[${anchors.join(" | ")}]`
    ].join(" ");
  }

  function resolveNavigoBillingEntryUrl(ctx) {
    const monNavigoAnchor = findNavigoAnchorByText("mon navigo", ctx);
    const monNavigoHref = ctx.normalizeUrl(monNavigoAnchor?.getAttribute("href"));
    if (monNavigoHref) return monNavigoHref;
    return null;
  }

  function resolveNavigoPrelevementsUrl(ctx) {
    const currentPath = String(ctx.location.pathname || "");
    const onPrelevements = currentPath.match(/\/prelevements\/([^/?#]+)/i);
    if (onPrelevements?.[1]) {
      return ctx.location.href;
    }

    const onDetail = currentPath.match(/\/espace_client\/detail\/([^/?#]+)/i);
    if (onDetail?.[1]) {
      return `https://www.jegeremacartenavigo.iledefrance-mobilites.fr/prelevements/${onDetail[1]}`;
    }

    const annualContractId = findNavigoAnnualContractIdFromList(ctx);
    if (annualContractId) {
      return `https://www.jegeremacartenavigo.iledefrance-mobilites.fr/prelevements/${annualContractId}`;
    }

    return null;
  }

  function findNavigoAnchorByText(text, ctx) {
    const target = ctx.normalizeComparableText(text);
    const anchors = Array.from(ctx.document.querySelectorAll("a[href]"));
    return anchors.find((a) => ctx.normalizeComparableText(a.textContent || "").includes(target)) || null;
  }

  function isNavigoEspaceClientRoot(ctx) {
    return /^\/espace_client\/?$/i.test(String(ctx.location.pathname || ""));
  }

  function isNavigoMonEspaceHome(ctx) {
    const host = String(ctx.location.hostname || "").toLowerCase();
    return host.includes("mon-espace.iledefrance-mobilites.fr");
  }

  function isNavigoDetailPage(ctx) {
    return /\/espace_client\/detail\/[^/?#]+/i.test(String(ctx.location.pathname || ""));
  }

  function isNavigoAttestationPage(ctx) {
    return /\/attestation\/[^/?#]+/i.test(String(ctx.location.pathname || ""));
  }

  function extractNavigoContractIdFromPath(pathname) {
    const match = String(pathname || "").match(/\/(?:espace_client\/detail|attestation)\/([^/?#]+)/i);
    return match?.[1] || null;
  }

  async function navigateNavigoMonthlyPath(timeoutMs, ctx) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (isNavigoMonEspaceHome(ctx)) {
        const monNavigoHref = resolveNavigoBillingEntryUrl(ctx);
        if (monNavigoHref) {
          return {
            navigated: true,
            detailUrl: monNavigoHref,
            contractId: extractNavigoContractIdFromPath(new URL(monNavigoHref).pathname)
          };
        }
      }

      if (isNavigoAttestationPage(ctx)) {
        return {
          navigated: true,
          detailUrl: ctx.location.href,
          contractId: extractNavigoContractIdFromPath(ctx.location.pathname)
        };
      }

      if (isNavigoDetailPage(ctx)) {
        const attestationLink = ctx.normalizeUrl(ctx.pick(["#compte-user-detail-contrat-nav-2"])?.getAttribute("href"));
        if (attestationLink) {
          return {
            navigated: true,
            detailUrl: attestationLink,
            contractId: extractNavigoContractIdFromPath(new URL(attestationLink).pathname)
          };
        }
        const contractId = extractNavigoContractIdFromPath(ctx.location.pathname);
        if (contractId) {
          return {
            navigated: true,
            detailUrl: `https://www.jegeremacartenavigo.iledefrance-mobilites.fr/attestation/${contractId}`,
            contractId
          };
        }
        await ctx.wait(250);
        continue;
      }

      if (isNavigoEspaceClientRoot(ctx)) {
        const detailLink = ctx.normalizeUrl(
          ctx.pick(["#compte-user-mon-espace-a-loop-1"])?.getAttribute("href")
            || ctx.pick(["a[href*='/espace_client/detail/']"])?.getAttribute("href")
        );
        if (detailLink) {
          return {
            navigated: true,
            detailUrl: detailLink,
            contractId: extractNavigoContractIdFromPath(new URL(detailLink).pathname)
          };
        }
        await ctx.wait(250);
        continue;
      }

      const fallbackDetailLink = ctx.normalizeUrl(ctx.pick(["a[href*='/espace_client/detail/']"])?.getAttribute("href"));
      if (fallbackDetailLink) {
        return {
          navigated: true,
          detailUrl: fallbackDetailLink,
          contractId: extractNavigoContractIdFromPath(new URL(fallbackDetailLink).pathname)
        };
      }

      await ctx.wait(250);
    }

    return {
      navigated: false,
      reason: `timeout path=${ctx.location.pathname} hasRootButton=${Boolean(ctx.document.querySelector("#compte-user-mon-espace-a-loop-1"))} hasDetailButton=${Boolean(ctx.document.querySelector("#compte-user-detail-contrat-nav-2"))} hasDownloadButton=${Boolean(ctx.document.querySelector("#actes-payment-attestation-txt-5"))}`
    };
  }

  async function clickNavigoBillingPath(timeoutMs, ctx) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const monNavigo = ctx.findClickableByLooseText("mon navigo");
      if (monNavigo) {
        ctx.realClick(monNavigo);
        await ctx.wait(800);
      }

      if (hasNavigoAnnualActiveEntry(ctx) || hasNavigoPrelevementsEntry(ctx)) {
        return true;
      }
      await ctx.wait(250);
    }
    return false;
  }

  async function findBestNavigoInvoiceControl(billingSelectors, timeoutMs, ctx) {
    const monthlyButton = ctx.pick(["#actes-payment-attestation-txt-5"]);
    if (monthlyButton && !monthlyButton.disabled) return monthlyButton;

    const opened = await openNavigoAttestationFlow(timeoutMs, ctx);
    if (!opened) return null;

    const explicitButton = ctx.pick([
      "#actes-payment-attestation-txt-5",
      "button#download-certificate-btn",
      ".dropdown-menu #download-certificate-btn"
    ]);
    if (explicitButton && !explicitButton.disabled) return explicitButton;
    return null;
  }

  async function openNavigoAttestationFlow(timeoutMs, ctx) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const detailToAttestation = ctx.pick(["#compte-user-detail-contrat-nav-2", "a[href*='/attestation/']"]);
      if (detailToAttestation && ctx.isVisible(detailToAttestation)) {
        ctx.realClick(detailToAttestation);
        await ctx.wait(1000);
      }

      const annualActive = findNavigoAnnualActiveEntry(ctx);
      if (annualActive) {
        ctx.realClick(annualActive);
        await ctx.wait(1000);
      }

      const prelevements = ctx.findClickableByLooseText("consulter mes prelevements")
        || ctx.findClickableByLooseText("consulter mes prélèvements");
      if (prelevements) {
        ctx.realClick(prelevements);
        await ctx.wait(1000);
      }

      const downloadAttestation = ctx.pick(["#label-download"]) || ctx.findClickableByLooseText("telecharger mes attestations de prelevements")
        || ctx.findClickableByLooseText("télécharger mes attestations de prélèvements");
      if (downloadAttestation) {
        ctx.realClick(downloadAttestation);
        await ctx.wait(800);
      }

      const exactPeriodInput = ctx.pick([
        "ul.dropdown-menu input[name='period'][value='3']",
        "input[name='period'][value='3']"
      ]);
      if (exactPeriodInput) {
        selectNavigoPeriodInput(exactPeriodInput, ctx);
        await ctx.wait(400);
      } else {
        const dropDown = ctx.pick([
          "select",
          "button[aria-haspopup='listbox']",
          "div[role='combobox']",
          "input[role='combobox']"
        ]);
        if (dropDown) {
          await selectNavigoLastThreeMonths(dropDown, ctx);
          await ctx.wait(600);
        } else {
          const optionByText = ctx.findClickableByLooseText("3 derniers mois");
          if (optionByText) {
            ctx.realClick(optionByText);
            await ctx.wait(800);
          }
        }
      }

      const explicitButton = ctx.pick([
        "button#download-certificate-btn",
        ".dropdown-menu #download-certificate-btn"
      ]);
      if (explicitButton) {
        if (explicitButton.disabled) {
          const periodInput = ctx.pick(["input[name='period'][value='3']"]);
          if (periodInput) {
            selectNavigoPeriodInput(periodInput, ctx);
            await ctx.wait(400);
          }
        }
        if (!explicitButton.disabled) {
          return true;
        }
      }

      const hasDownloadLink = Boolean(
        ctx.document.querySelector("a[href*='attestation'][href*='prelevement']")
        || ctx.document.querySelector("a[href*='attestation'][href*='pdf']")
        || ctx.document.querySelector("a[href*='prelevement'][href*='pdf']")
      );
      if (hasDownloadLink) return true;

      if (ctx.findByLooseText("3 derniers mois") && hasNavigoPrelevementsEntry(ctx)) {
        return true;
      }
      await ctx.wait(250);
    }
    return false;
  }

  function selectNavigoPeriodInput(input, ctx) {
    if (!input) return;
    try {
      input.checked = true;
    } catch (_error) {
      // noop
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const label = input.closest("label");
    if (label && ctx.isVisible(label)) {
      ctx.realClick(label);
    } else if (ctx.isVisible(input)) {
      ctx.realClick(input);
    }
  }

  function hasNavigoAnnualActiveEntry(ctx) {
    return Boolean(findNavigoAnnualActiveEntry(ctx));
  }

  function hasNavigoPrelevementsEntry(ctx) {
    return Boolean(
      ctx.findByLooseText("consulter mes prelevements")
      || ctx.findByLooseText("consulter mes prélèvements")
      || ctx.findByLooseText("telecharger mes attestations de prelevements")
      || ctx.findByLooseText("télécharger mes attestations de prélèvements")
    );
  }

  function findNavigoAnnualActiveEntry(ctx) {
    const links = Array.from(ctx.document.querySelectorAll("a[href]")).filter(ctx.isVisible);
    return links.find((link) => {
      const text = ctx.normalizeComparableText(link.textContent || "");
      const href = String(link.getAttribute("href") || "");
      return text.includes("navigo annuel") && text.includes("actif") && /\/espace_client\/detail\//.test(href);
    }) || null;
  }

  function findNavigoAnnualContractIdFromList(ctx) {
    const links = Array.from(ctx.document.querySelectorAll("a[href*='/espace_client/detail/']"));
    const annualActive = links.find((link) => {
      const text = ctx.normalizeComparableText(link.textContent || "");
      return text.includes("navigo annuel") && text.includes("actif");
    });
    if (annualActive) {
      const href = String(annualActive.getAttribute("href") || "");
      const match = href.match(/\/espace_client\/detail\/([^/?#]+)/i);
      if (match?.[1]) return match[1];
    }

    const anyNavigoAnnual = links.find((link) => ctx.normalizeComparableText(link.textContent || "").includes("navigo annuel"));
    if (anyNavigoAnnual) {
      const href = String(anyNavigoAnnual.getAttribute("href") || "");
      const match = href.match(/\/espace_client\/detail\/([^/?#]+)/i);
      if (match?.[1]) return match[1];
    }

    return null;
  }

  async function selectNavigoLastThreeMonths(dropDown, ctx) {
    const tag = String(dropDown.tagName || "").toLowerCase();
    if (tag === "select") {
      const option = Array.from(dropDown.options || []).find((opt) => ctx.normalizeComparableText(opt.textContent || "").includes("3 derniers mois"));
      if (option) {
        dropDown.value = option.value;
        dropDown.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
    }

    ctx.realClick(dropDown);
    await ctx.wait(300);
    const optionByText = ctx.findClickableByLooseText("3 derniers mois");
    if (optionByText) {
      ctx.realClick(optionByText);
    }
  }

  function deriveNavigoPdfFileName(url, ctx) {
    let parsed = null;
    try {
      parsed = new URL(url, ctx.location.href);
    } catch (_error) {
      return null;
    }

    const rawId = parsed.searchParams.get("id") || parsed.searchParams.get("documentId");
    const documentId = String(rawId || "").trim();
    if (documentId) return `attestation_navigo_${documentId}.pdf`;
    return /attestation|prelev/i.test(parsed.pathname || "")
      ? `attestation_navigo_${ctx.getCurrentMonthStartISO().slice(0, 7)}.pdf`
      : null;
  }

  function isNavigoAuthenticated(ctx) {
    const host = String(ctx.location.hostname || "");
    if (!host.includes("iledefrance-mobilites.fr")) return false;

    const hasLoginFields = Boolean(
      ctx.document.querySelector("#id-Mail")
      || ctx.document.querySelector("#id-pwd")
      || ctx.document.querySelector("#form-log")
    );
    if (hasLoginFields) return false;

    const path = String(ctx.location.pathname || "");
    const inMonEspace = host.includes("mon-espace.iledefrance-mobilites.fr");
    const inJeGereMaCarte = host.includes("jegeremacartenavigo.iledefrance-mobilites.fr");
    const onLoginPath = /\/auth\/realms\/connect\/login-actions\/authenticate/.test(path);
    if (onLoginPath) return false;

    const text = ctx.normalizeComparableText(ctx.document.body?.textContent || "");
    const hasAuthenticatedMarker = (
      text.includes("mon espace personnel")
      || text.includes("mon navigo")
      || text.includes("mes services")
      || text.includes("deconnexion")
      || text.includes("déconnexion")
    );
    if (inMonEspace || inJeGereMaCarte) return true;
    return hasAuthenticatedMarker;
  }

  async function ensureNavigoAuthenticated(timeoutMs, ctx) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (isNavigoAuthenticated(ctx)) return true;
      await ctx.wait(250);
    }
    return isNavigoAuthenticated(ctx);
  }

  function getNavigoAuthDiagnostics(ctx) {
    const host = String(ctx.location.hostname || "").toLowerCase();
    const path = String(ctx.location.pathname || "");
    const href = String(ctx.location.href || "");
    const text = ctx.normalizeComparableText(ctx.document.body?.textContent || "");
    const hasLoginFields = Boolean(
      ctx.document.querySelector("#id-Mail")
      || ctx.document.querySelector("#id-pwd")
      || ctx.document.querySelector("#form-log")
    );
    const onLoginPath = /\/auth\/realms\/connect\/login-actions\/authenticate/.test(path);
    const inMonEspace = host.includes("mon-espace.iledefrance-mobilites.fr");
    const inJeGereMaCarte = host.includes("jegeremacartenavigo.iledefrance-mobilites.fr");
    const hasAuthenticatedMarker = (
      text.includes("mon espace personnel")
      || text.includes("mon navigo")
      || text.includes("mes services")
      || text.includes("deconnexion")
      || text.includes("déconnexion")
    );
    return {
      host,
      path,
      href,
      inMonEspace,
      inJeGereMaCarte,
      onLoginPath,
      hasLoginFields,
      hasMonEspacePersonnelText: text.includes("mon espace personnel"),
      hasMonNavigoText: text.includes("mon navigo"),
      hasMesServicesText: text.includes("mes services"),
      hasDeconnexionText: text.includes("deconnexion") || text.includes("déconnexion"),
      hasAuthenticatedMarker
    };
  }

  function formatNavigoAuthDiagnostics(diagnostics) {
    const d = diagnostics || {};
    return [
      `host=${String(d.host || "")}`,
      `path=${String(d.path || "")}`,
      `monEspaceHost=${Boolean(d.inMonEspace)}`,
      `jgmnHost=${Boolean(d.inJeGereMaCarte)}`,
      `loginPath=${Boolean(d.onLoginPath)}`,
      `loginFields=${Boolean(d.hasLoginFields)}`,
      `marker=${Boolean(d.hasAuthenticatedMarker)}`
    ].join(" ");
  }
})(typeof window !== "undefined" ? window : globalThis);
