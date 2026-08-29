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
  constructor({ aiService, config = {}, notificationManager = null } = {}) {
    this.aiService = aiService;
    this.notificationManager = notificationManager;
    this.autoAnalysis = config.autoAnalysis ?? false;
    this.securityEvents = [];
    this.recentAccessLogs = [];
    this.ipRequestCounts = new Map(); // ip -> { count, lastSeen, 404s }
    this._load();
  }

  setNotificationManager(notificationManager) {
    this.notificationManager = notificationManager;
  }

  updateConfig(config = {}) {
    if (config.autoAnalysis !== undefined) this.autoAnalysis = Boolean(config.autoAnalysis);
  }

  async recordIncidentFromError(error) {
    if (!error) return null;
    return this._recordSecurityEvent({
      reason: `エラーからセキュリティインシデントへ昇格: ${String(error.message || '').slice(0, 180)}`,
      severity: 'high',
      ip: error.context?.ip || null,
      method: error.context?.method || null,
      url: error.context?.url || null,
      userAgent: error.context?.userAgent || null,
      details: {
        source: 'error-escalation',
        errorId: error.id,
        stack: error.stack || '',
        classification: error.classification || null,
      },
      error,
    });
  }

  _startSecurityResponse(eventRecord, errorRecord) {
    if (eventRecord.responseStatus) return;
    if (!this.aiService || typeof this.aiService.respondToSecurityIncident !== 'function') return;

    eventRecord.responseStatus = 'running';
    this._save();
    this.aiService.respondToSecurityIncident(errorRecord, eventRecord)
      .then((result) => {
        eventRecord.responseStatus = 'completed';
        eventRecord.response = {
          content: result?.content || String(result || ''),
          completedAt: new Date().toISOString(),
        };
        this._save();
      })
      .catch((error) => {
        eventRecord.responseStatus = 'failed';
        eventRecord.responseError = error.message;
        this._save();
      });
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
        reason: '短時間の大量404エラー',
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
        reason: '異常なリクエスト頻度',
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

    if (eventData.error) {
      this._startSecurityResponse(eventRecord, eventData.error);
    } else if (eventRecord.severity === 'high') {
      this._startSecurityResponse(eventRecord, {
        id: `access_${eventRecord.id}`,
        message: eventRecord.reason,
        stack: '',
        context: {
          source: 'security-access-detection',
          method: eventRecord.method,
          url: eventRecord.url,
          ip: eventRecord.ip,
          userAgent: eventRecord.userAgent,
        },
        classification: {
          category: 'security',
          severity: eventRecord.severity,
        },
      });
    }

    if (this.notificationManager) {
      this.notificationManager.broadcast({
        type: 'security_alert',
        title: `🛡️ セキュリティ警告: ${eventRecord.reason}`,
        message: `${eventRecord.ip} (${eventRecord.method} ${eventRecord.url})`,
        data: eventRecord,
      });
    }

    if (this.autoAnalysis && this.aiService) {
      this.triggerAnalysis(id).catch((e) => console.warn('[NMT-Security] Auto AI analysis error:', e.message));
    }

    return eventRecord;
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
      if (/(?:^|\n)\s*NMT_SECURITY_ESCALATE\s*:\s*true\s*(?:\n|$)/i.test(record.analysis.content || '')) {
        this._startSecurityResponse(record, {
          id: `access_${record.id}`,
          message: record.reason,
          stack: '',
          context: {
            source: 'security-analysis-escalation',
            method: record.method,
            url: record.url,
            ip: record.ip,
            userAgent: record.userAgent,
          },
          classification: { category: 'security', severity: record.severity },
        });
      }
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
