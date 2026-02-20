/* global globalThis */
(function registerProviders(root) {
  const providers = {
    orange_provider: {
      id: "orange_provider",
      label: "Orange",
      loginUrl: "https://espace-client.orange.fr/selectionner-un-contrat?returnUrl=%2Ffacture-paiement%2F%257B%257Bcid%257D%257D&marketType=RES",
      billingUrl: "https://espace-client.orange.fr/selectionner-un-contrat?returnUrl=%2Ffacture-paiement%2F%257B%257Bcid%257D%257D&marketType=RES",
      hosts: ["orange.fr", "orange.com"],
      requiresContractSelection: true
    },
    sfr_provider: {
      id: "sfr_provider",
      label: "SFR",
      loginUrl: "https://espace-client.sfr.fr/",
      billingUrl: "https://espace-client.sfr.fr/facture-conso",
      hosts: ["sfr.fr"],
      requiresContractSelection: false
    },
    redbysfr_provider: {
      id: "redbysfr_provider",
      label: "Red by SFR",
      loginUrl: "https://espace-client-red.sfr.fr/facture-fixe/consultation",
      billingUrl: "https://espace-client-red.sfr.fr/facture-fixe/consultation",
      hosts: ["espace-client-red.sfr.fr", "sfr.fr"],
      requiresContractSelection: false
    },
    bouygues_provider: {
      id: "bouygues_provider",
      label: "Bouygues",
      loginUrl: "https://www.bouyguestelecom.fr/mon-compte",
      billingUrl: "https://www.bouyguestelecom.fr/mon-compte/factures",
      hosts: ["bouyguestelecom.fr"],
      requiresContractSelection: false
    },
    free_provider: {
      id: "free_provider",
      label: "Free",
      loginUrl: "https://subscribe.free.fr/login/do_login.pl",
      billingUrl: "https://adsl.free.fr/home.pl",
      hosts: ["free.fr"],
      requiresContractSelection: false
    },
    free_mobile_provider: {
      id: "free_mobile_provider",
      label: "Free Mobile",
      loginUrl: "https://mobile.free.fr/account/v2/login",
      billingUrl: "https://mobile.free.fr/account/v2/home",
      hosts: ["mobile.free.fr", "free.fr"],
      requiresContractSelection: false
    }
  };

  root.__EXT_PROVIDER_CONFIGS__ = providers;
})(typeof window !== "undefined" ? window : globalThis);
