'use strict';

const OAuth2ProviderBase = require('./OAuth2ProviderBase');

class GoogleAuthProvider extends OAuth2ProviderBase {
  constructor() {
    super({
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      scope: 'openid email profile',
      configKey: 'google',
    });
  }

  get name() {
    return 'google';
  }

  get displayName() {
    return 'Google';
  }
}

module.exports = GoogleAuthProvider;
