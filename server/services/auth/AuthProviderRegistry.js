'use strict';

const ScratchAuthProvider = require('./providers/ScratchAuthProvider');
const PasskeyAuthProvider = require('./providers/PasskeyAuthProvider');
const EmailAuthProvider = require('./providers/EmailAuthProvider');
const NyaitterAuthProvider = require('./providers/NyaitterAuthProvider');
const GoogleAuthProvider = require('./providers/GoogleAuthProvider');
const MicrosoftAuthProvider = require('./providers/MicrosoftAuthProvider');

class AuthProviderRegistry {
  constructor() {
    this.providers = new Map();
    this._registerDefaultProviders();
  }

  _registerDefaultProviders() {
    this.register(new ScratchAuthProvider());
    this.register(new PasskeyAuthProvider());
    this.register(new EmailAuthProvider());
    this.register(new NyaitterAuthProvider());
    this.register(new GoogleAuthProvider());
    this.register(new MicrosoftAuthProvider());
  }

  /**
   * Register an authentication provider instance.
   * @param {import('./providers/BaseAuthProvider')} provider
   */
  register(provider) {
    if (!provider || typeof provider.name !== 'string') {
      throw new Error('Invalid AuthProvider instance: name is required');
    }
    this.providers.set(provider.name.toLowerCase(), provider);
  }

  /**
   * Unregister an authentication provider by name.
   * @param {string} name
   */
  unregister(name) {
    if (!name) return;
    this.providers.delete(name.toLowerCase());
  }

  /**
   * Get an authentication provider by name.
   * @param {string} name
   * @returns {import('./providers/BaseAuthProvider')|null}
   */
  getProvider(name) {
    if (!name || typeof name !== 'string') return null;
    return this.providers.get(name.toLowerCase()) || null;
  }

  /**
   * Check if a provider exists.
   * @param {string} name
   * @returns {boolean}
   */
  hasProvider(name) {
    return this.getProvider(name) !== null;
  }

  /**
   * List all enabled providers for current config/request.
   * @param {object} config
   * @param {object} [req]
   * @returns {Array<import('./providers/BaseAuthProvider')>}
   */
  listEnabledProviders(config, req = null) {
    const list = [];
    for (const provider of this.providers.values()) {
      if (provider.isEnabled(config, req)) {
        list.push(provider);
      }
    }
    return list;
  }

  /**
   * List enabled provider names.
   * @param {object} config
   * @param {object} [req]
   * @returns {string[]}
   */
  listEnabledProviderNames(config, req = null) {
    return this.listEnabledProviders(config, req).map((p) => p.name);
  }

  /**
   * Get public configuration of all available providers.
   * @param {object} config
   * @param {object} [req]
   * @returns {object[]}
   */
  getPublicProvidersConfig(config, req = null) {
    return this.listEnabledProviders(config, req).map((p) => p.getPublicConfig(config, req));
  }
}

// Default global registry instance
const defaultRegistry = new AuthProviderRegistry();

module.exports = {
  AuthProviderRegistry,
  defaultRegistry,
};
