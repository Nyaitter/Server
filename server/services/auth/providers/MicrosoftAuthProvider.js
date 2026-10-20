'use strict';

const OAuth2ProviderBase = require('./OAuth2ProviderBase');

class MicrosoftAuthProvider extends OAuth2ProviderBase {
  constructor() {
    super({
      authorizeUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
      userinfoUrl: 'https://graph.microsoft.com/oidc/userinfo',
      scope: 'openid email profile offline_access',
      configKey: 'microsoft',
    });
  }

  get name() {
    return 'microsoft';
  }

  get displayName() {
    return 'Microsoft';
  }

  _authorizeEndpoint(config) {
    const tenant = String(this._methodConfig(config).tenant || 'common').trim();
    return this.authorizeUrl.replace('{tenant}', encodeURIComponent(tenant || 'common'));
  }

  _tokenEndpoint(config) {
    const tenant = String(this._methodConfig(config).tenant || 'common').trim();
    return this.tokenUrl.replace('{tenant}', encodeURIComponent(tenant || 'common'));
  }
}

module.exports = MicrosoftAuthProvider;
