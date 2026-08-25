'use strict';

const fs = require('fs');
const path = require('path');

const MAX_SECURITY_EVENTS = 500;
const MAX_ACCESS_LOGS = 1000;
const DATA_DIR = path.resolve(__dirname, '../../data');
const SECURITY_FILE = path.join(DATA_DIR, 'nmt-security.json');

const SUSPICIOUS_PATH_PATTERNS = [
  /\.env($|\?)/i,
  /wp-admin|wp-login|wp-content|wordpress/i,
  /phpmyadmin|pma|adminer/i,
  /\.git(\/|$)/i,
  /\/\.\.\/|\.\.\//,
  /<script|%3Cscript/i,
  /union.*select|select.*from/i,
  /etc\/passwd|win\.ini/i,
  /\.aws|\.ssh|\.kube/i,
  /actuator\/health|\.well-known\/security\.txt/i,
  /eval\(|base64_decode/i,
];

class SecurityLogManager {
  constructor({ aiService, config = {} } = {}) {
    this.aiService = aiService;
    this.autoAnalysis = config.autoAnalysis ?? false;
    this.securityEvents = [];
    this.recentAccessLogs = [];
    this.ipRequestCounts = new Map(); // ip -> { count, lastSeen, 404s }
    this._load();
  }

  updateConfig(config = {}) {
    if (config.autoAnalysis !== undefined) this.autoAnalysis = Boolean(config.autoAnalysis);
  }

  _load() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      if (fs.existsSync(SECURITY_FILE)) {
        const raw = fs.readFileSync(SECURITY_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) this.securityEvents = parsed.slice(-MAX_SECURITY_EVENTS);
      }
    } catch (e) {
      console.warn('[NMT-Security] Failed to load security logs:', e.message);
      this.securityEvents = [];
    }
  }

  _save() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SECURITY_FILE, JSON.stringify(this.securityEvents.slice(-MAX_SECURITY_EVENTS), null, 2), 'utf8');
    } catch (e) {
      console.warn('[NMT-Security] Failed to save security logs:', e.message);
    }
  }

  recordRequest(req, res, durationMs) {
    const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    const method = req.method;
    const url = req.originalUrl || req.url;
    const statusCode = res.statusCode;

    const logEntry = {
      timestamp: new Date().toISOString(),
      ip,
      method,
      url,
      statusCode,
      durationMs,
      userAgent,
      userId: req.user?.id || null,
    };

    this.recentAccessLogs.unshift(logEntry);
    if (this.recentAccessLogs.length > MAX_ACCESS_LOGS) this.recentAccessLogs.pop();

    // IP 統計と異常検知
    const now = Date.now();
    let ipStat = this.ipRequestCounts.get(ip);
    if (!ipStat || (now - ipStat.windowStart) > 60 * 1000) {
      ipStat = { count: 0, count404: 0, windowStart: now, userAgent };
      this.ipRequestCounts.set(ip, ipStat);
    }
    ipStat.count++;
    if (statusCode === 404) ipStat.count404++;

    // 1. パストラバーサル・脆弱性スキャン検知
    for (const pattern of SUSPICIOUS_PATH_PATTERNS) {
      if (pattern.test(url)) {
        this._recordSecurityEvent({
          reason: `脆弱性スキャン検知 (${pattern.toString()})`,
          severity: 'high',
          ip,
          method,
          url,
          statusCode,
          userAgent,
          details: { matchedPattern: pattern.toString(), durationMs },
        });
        break;
      }
    }

    // 2. 短時間の大量404スキャン検知 (1分間に15回以上の404)
    if (ipStat.count404 === 15) {
      this._recordSecurityEvent({
        reason: '短時間の大量404エラー（エンドポイント探索・辞書攻撃の疑い）',
        severity: 'medium',
        ip,
        method,
        url,
        statusCode,
        userAgent,
        details: { count404InMinute: ipStat.count404, totalInMinute: ipStat.count },
      });
    }

    // 3. 超高頻度リクエスト (1分間に200リクエスト超)
    if (ipStat.count === 200) {
      this._recordSecurityEvent({
        reason: '異常なリクエスト頻度（DoS / 高頻度スクレイピングの疑い）',
        severity: 'high',
        ip,
        method,
        url,
        statusCode,
        userAgent,
        details: { requestsInMinute: ipStat.count },
      });
    }
  }

  async _recordSecurityEvent(eventData) {
    const id = `sec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const eventRecord = {
      id,
      timestamp: new Date().toISOString(),
      reason: eventData.reason || '不審なアクセス',
      severity: eventData.severity || 'medium',
      ip: eventData.ip,
      method: eventData.method,
      url: eventData.url,
      statusCode: eventData.statusCode,
      userAgent: eventData.userAgent,
      details: eventData.details || {},
      analysis: null,
    };

    this.securityEvents.unshift(eventRecord);
    if (this.securityEvents.length > MAX_SECURITY_EVENTS) this.securityEvents.pop();
    this._save();

    if (this.autoAnalysis && this.aiService) {
      this.triggerAnalysis(id).catch((e) => console.warn('[NMT-Security] Auto AI analysis error:', e.message));
    }
  }

  async triggerAnalysis(eventId) {
    const record = this.securityEvents.find((e) => e.id === eventId);
    if (!record || !this.aiService) return null;

    try {
      record.analyzing = true;
      const result = await this.aiService.analyzeSecurityLog(record);
      record.analysis = {
        model: result.model,
        content: result.content,
        provider: result.provider,
        analyzedAt: new Date().toISOString(),
      };
      this._save();
      return record.analysis;
    } finally {
      record.analyzing = false;
      this._save();
    }
  }

  getSecurityEvents({ severity, limit = 50, offset = 0 } = {}) {
    let list = this.securityEvents;
    if (severity && severity !== 'all') {
      list = list.filter((e) => e.severity === severity);
    }
    const total = list.length;
    const paginated = list.slice(offset, offset + limit);
    return { events: paginated, total, limit, offset };
  }

  getRecentAccessLogs({ limit = 100, ip } = {}) {
    let list = this.recentAccessLogs;
    if (ip) list = list.filter((l) => l.ip === ip);
    return list.slice(0, limit);
  }

  clearEvents() {
    this.securityEvents = [];
    this._save();
  }
}

module.exports = SecurityLogManager;
