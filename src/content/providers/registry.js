/* global window */
(function registerProviderStrategyRegistry(root) {
  const strategies = {};

  root.__EXT_PROVIDER_STRATEGIES__ = {
    register(providerIds, strategy) {
      const ids = Array.isArray(providerIds) ? providerIds : [providerIds];
      for (const id of ids) {
        if (!id) continue;
        strategies[id] = strategy;
      }
    },
    get(providerId) {
      return strategies[providerId] || strategies.generic || null;
    },
    list() {
      return { ...strategies };
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
