/* global globalThis */
(function registerSelectors(root) {
  const selectors = {
    version: 3,
    orange: {
      login: {
        username: [
          "input[data-testid='input-login']",
          "input#login",
          "input[name='login']",
          "input[aria-labelledby*='login-label']",
          "input[type='email']"
        ],
        password: ["input[name='password']", "input[type='password']", "#password"],
        submit: ["button[type='submit']", "button[name='submit']", "input[type='submit']"]
      },
      billing: {
        accountItems: ["a.items-list-item[href*='/facture-paiement/']", "a[data-e2e][href*='/facture-paiement/']"],
        downloadButton: ["button[data-e2e='download-link']", "a[data-e2e='download-link']", "button.btn.btn-primary"]
      }
    },
    providerDefaults: {
      login: {
        username: [
          "input[data-testid*='login']",
          "input[id*='login']",
          "input[name*='login']",
          "input[type='email']",
          "input[name*='user']",
          "input[id*='user']"
        ],
        password: [
          "input[name='password']",
          "input[id*='password']",
          "input[type='password']"
        ],
        submit: [
          "button[type='submit']",
          "button[name='submit']",
          "input[type='submit']",
          "button"
        ]
      },
      billing: {
        invoiceLinks: [
          "a[href*='facture']",
          "a[href*='invoice']",
          "a[href*='factures']",
          "a[href*='billing']",
          "a[href*='.pdf']",
          "button[data-e2e='download-link']",
          "button"
        ],
        downloadButton: [
          "button[data-e2e='download-link']",
          "a[data-e2e='download-link']",
          "button[class*='download']",
          "a[href*='.pdf']",
          "a[href*='download']",
          "button"
        ]
      }
    },
    providers: {
      orange_provider: {
        login: {
          username: [
            "input[data-testid='input-login']",
            "input#login",
            "input[name='login']",
            "input[aria-labelledby*='login-label']",
            "input[type='email']"
          ],
          password: ["input[name='password']", "input[type='password']", "#password"],
          submit: ["button[type='submit']", "button[name='submit']", "input[type='submit']"]
        },
        billing: {
          accountItems: ["a.items-list-item[href*='/facture-paiement/']", "a[data-e2e][href*='/facture-paiement/']"],
          downloadButton: ["button[data-e2e='download-link']", "a[data-e2e='download-link']", "button.btn.btn-primary"]
        }
      },
      redbysfr_provider: {
        login: {
          username: [
            "input#username",
            "input[name='username']",
            "input[autocomplete='username']"
          ],
          password: [
            "input#password",
            "input[name='password']",
            "input[autocomplete='current-password']"
          ],
          submit: [
            "button#identifier[name='identifier']",
            "button#identifier",
            "button[type='submit']",
            "input[type='submit']",
            "button"
          ]
        },
        billing: {
          invoiceLinks: [
            "a.link.download[href*='/facture-fixe/telecharger/']",
            "a[href*='/facture-fixe/telecharger/']",
            "a.link.download"
          ],
          downloadButton: [
            "a.link.download[href*='/facture-fixe/telecharger/']",
            "a[href*='/facture-fixe/telecharger/']",
            "a.link.download"
          ]
        }
      },
      sfr_provider: {},
      bouygues_provider: {},
      free_provider: {
        login: {
          username: [
            "input#login_b[name='login']",
            "input#login_b",
            "input[name='login']"
          ],
          password: [
            "input#pass_b[name='pass']",
            "input#pass_b",
            "input[name='pass']",
            "input[type='password']"
          ],
          submit: [
            "button#ok.login_button",
            "button#ok",
            "button.login_button[type='submit']",
            "button[type='submit']"
          ]
        },
        billing: {
          invoiceLinks: [
            "a.btn_download[href*='facture_pdf.pl']",
            "a[href*='facture_pdf.pl']"
          ],
          downloadButton: [
            "a.btn_download[href*='facture_pdf.pl']",
            "a[href*='facture_pdf.pl']"
          ]
        }
      },
      free_mobile_provider: {
        login: {
          username: [
            "input#login-username[name='username']",
            "input#login-username"
          ],
          password: [
            "input#login-password[name='password']",
            "input#login-password"
          ],
          submit: [
            "button#auth-connect[type='submit']",
            "button#auth-connect",
            "button[type='submit']"
          ]
        },
        billing: {
          invoiceLinks: [
            "a[download][href*='/account/v2/api/SI/invoice/'][href*='display=1']",
            "a[href*='/account/v2/api/SI/invoice/'][href*='display=1']",
            "a[href*='facture']",
            "a[href*='invoice']",
            "a[href*='.pdf']"
          ],
          downloadButton: [
            "a[download][href*='/account/v2/api/SI/invoice/'][href*='display=1']",
            "a[href*='/account/v2/api/SI/invoice/'][href*='display=1']",
            "a[href*='.pdf']",
            "a[href*='facture']"
          ]
        }
      },
      navigo_provider: {
        login: {
          username: [
            "input#id-Mail[name='username']",
            "input#id-Mail",
            "input[name='username']"
          ],
          password: [
            "input#id-pwd[name='password']",
            "input#id-pwd",
            "input[name='password']",
            "input[type='password']"
          ],
          submit: [
            "button#login-bt[type='submit']",
            "button#login-bt",
            "button[name='login']",
            "button[type='submit']"
          ]
        },
        billing: {
          invoiceLinks: [
            "a[href*='attestation']",
            "a[href*='prelevement']",
            "a[href*='download']",
            "a[href*='.pdf']"
          ],
          downloadButton: [
            "a[href*='attestation'][href*='download']",
            "a[href*='attestation']",
            "a[href*='.pdf']",
            "button"
          ]
        }
      }
    },
    navan: {
      home: {
        newTransaction: [
          "button.black",
          "button[data-testid='new-transaction']",
          "button[aria-label*='New Transaction']",
          "button:has(span)",
          "button"
        ],
        autofillFromReceipt: [
          "button.dropdown-menu-item",
          "button[class*='dropdown-menu-item']",
          "button"
        ],
        createSingleTransaction: [
          "button.black[type='button']",
          "button[type='button']",
          "button"
        ]
      },
      transactionForm: {
        merchant: ["input[name='merchant']", "input[aria-label*='merchant']"],
        amount: ["input[name='amount']", "input[aria-label*='amount']"],
        currency: ["input[name='currency']", "input[aria-label*='currency']"],
        date: ["input[name='date']", "input[type='date']"],
        tax: ["input[name='tax']", "input[aria-label*='tax']"],
        description: ["textarea[name='description']", "textarea", "input[name='description']"],
        file: ["input#fileInput", "input[type='file']"]
      }
    }
  };

  root.__EXT_SELECTORS__ = selectors;
})(typeof window !== "undefined" ? window : globalThis);
