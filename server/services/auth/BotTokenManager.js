const crypto = require('crypto');
const config = require('../../config');

class BotTokenManager {
  constructor({ dbAdapter }) {
    this.db = dbAdapter;
  }

  async createBotToken(userId, options = {}) {
    const tokenId = crypto.randomBytes(config.auth.botTokenIdBytes).toString('hex');
    const rawToken = crypto.randomBytes(config.auth.sessionTokenBytes).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const name = options.name || `Bot Token ${new Date().toISOString().slice(0, 10)}`;

    if (!this.db || !this.db.createBotToken) {
      throw new Error('DatabaseAdapterがBotトークン機能に対応していません');
    }

    await this.db.createBotToken(userId, tokenId, tokenHash, name);

    const fullToken = `${config.auth.botTokenPrefix}${tokenId}_${rawToken}`;

    return {
      token: fullToken,
      tokenId,
      name,
      createdAt: new Date(),
    };
  }

  async validateBotToken(token) {
    if (!token || !token.startsWith(config.auth.botTokenPrefix) || !this.db) return null;

    const prefix = config.auth.botTokenPrefix;
    if (!token.startsWith(prefix)) return null;

    const withoutPrefix = token.slice(prefix.length);
    const parts = withoutPrefix.split('_');
    if (parts.length !== 2) return null;

    const tokenId = parts[0];
    const rawToken = parts[1];
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const record = await this.db.getBotTokenById(tokenId);
    if (!record || record.tokenHash !== tokenHash) return null;

		if (this.db.updateBotTokenLastUsed) {
			void this.db.updateBotTokenLastUsed(tokenId).catch(() => {});
		}

    return {
      userId: record.userId,
      tokenId: record.tokenId,
      name: record.name,
      isBot: true,
    };
  }

  async getUserBotTokens(userId) {
    if (!this.db || !this.db.getUserBotTokens) return [];
    return this.db.getUserBotTokens(userId);
  }

  async revokeBotToken(userId, tokenId) {
    if (!this.db || !this.db.revokeBotToken) return false;
    return this.db.revokeBotToken(userId, tokenId);
  }

  async revokeAllBotTokens(userId) {
    return 0;
  }
}

module.exports = BotTokenManager;
