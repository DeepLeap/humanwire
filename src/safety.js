import crypto from 'node:crypto';

/**
 * 净化来自不可信外部节点的文本字段（nickname、intentCard、caption、vouch.tag 等）
 * 去除控制字符与 Unicode 双向文字欺骗符，替换方括号与双引号以防边界标签属性逃逸。
 */
export function sanitizeUntrustedField(value, maxLen = 64) {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  if (!Number.isFinite(maxLen) || maxLen <= 0) return cleaned;
  return cleaned.slice(0, maxLen);
}

/**
 * 本地代码级硬规则扫描（零 Token 消耗）：中英双语反诈、引流、钓鱼、注入提示识别
 */
const SHORT_URL_RULE = {
  id: 'short_url',
  severity: 'HIGH',
  label: '疑似短链接或高风险钓鱼域（已折叠）',
  regex:
    /\bhttps?:\/\/(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|rebrand\.ly|dwz\.cn|suo\.im|url\.cn|cutt\.ly|rb\.gy|s\.id|wa\.me)\/\S+|\bhttps?:\/\/[^\s<>()]*xn--[^\s<>()]+/gi,
  redact: '[已折叠可疑短链接]',
};

const EXTERNAL_URL_RULE = {
  id: 'external_url',
  severity: 'MEDIUM',
  label: '包含外部链接（请谨慎核实）',
  regex: /\bhttps?:\/\/[^\s<>()]+/gi,
  redact: null,
};

const OTHER_RULES = [
  {
    id: 'executable_or_shell',
    severity: 'HIGH',
    label: '包含可执行文件或高危命令特征',
    regex:
      /(?:\.(?:exe|bat|cmd|sh|dmg|pkg|apk|msi|scr|ps1)\b|curl\s+[^|\n]+\|\s*(?:ba)?sh|wget\s+[^|\n]+\|\s*(?:ba)?sh|powershell\s+-e(?:nc)?)/gi,
    redact: null,
  },
  {
    id: 'crypto_wallet',
    severity: 'HIGH',
    label: '疑似加密货币钱包地址',
    regex: /(?:\b0x[a-fA-F0-9]{40}\b|\bbc1[a-zA-HJ-NP-Z0-9]{25,62}\b|\bT[A-Za-z1-9]{33}\b)/g,
    redact: '[已折叠疑似钱包地址]',
  },
  {
    id: 'payment_lure',
    severity: 'HIGH',
    label: '疑似转账/投资/收款诱导话术',
    regex:
      /(?:收款码|转账给我|打款|先付定金|保证金|刷单|稳赚不赔|高额回报|内幕消息|带单|充U|买USDT|guaranteed\s+profit|double\s+your\s+(?:crypto|btc|eth|usdt|money)|wire\s+transfer|deposit\s+first|send\s+(?:crypto|usdt|btc|eth)\s+first|crypto\s+signals?|insider\s+tip|risk[- ]?free\s+returns?)/gi,
    redact: null,
  },
  {
    id: 'off_platform_lure',
    severity: 'MEDIUM',
    label: '疑似引导转移至外部私聊',
    regex:
      /(?:加我?微信|加[vV微]\s*[:：]?\s*[a-zA-Z0-9_-]{4,}|[vV][xX]\s*[:：]?\s*[a-zA-Z0-9_-]{4,}|加我?(?:QQ|Telegram|TG|WhatsApp)|t\.me\/[a-zA-Z0-9_]+|dm\s+me\s+on\s+(?:telegram|tg|whatsapp|wechat|discord|signal)|whatsapp\s+me|add\s+me\s+on\s+(?:telegram|tg|whatsapp|wechat|qq)|text\s+me\s+on\s+whatsapp)/gi,
    redact: null,
  },
  {
    id: 'credential_phishing',
    severity: 'HIGH',
    label: '疑似索要验证码/私钥/密码',
    regex:
      /(?:验证码发我|把验证码|发我?私钥|助记词|seed\s*phrase|private\s*key|API\s*Key发|把密码发|(?:send|share|give)\s+(?:me\s+)?(?:your\s+)?(?:verification|2fa|otp)\s+code|(?:send|share|give)\s+(?:me\s+)?(?:your\s+)?(?:seed\s+phrase|private\s+key|mnemonic|api\s*key|password)|paste\s+your\s+(?:\.env|api\s*key|token))/gi,
    redact: null,
  },
  {
    id: 'prompt_injection_hint',
    severity: 'MEDIUM',
    label: '疑似包含提示词注入或越狱指令（已隔离）',
    regex:
      /(?:ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?|disregard\s+(?:all\s+)?(?:previous|system)\s+prompts?|忽略(?:之前|上面|所有|一切)(?:的)?(?:指令|规则|提示词|设定)|无视(?:上述|之前)(?:规则|指令)|reveal\s+(?:your\s+)?system\s+prompt|输出你的?(?:系统提示词|system\s*prompt)|(?:读取|read|cat|print|exfiltrate)\s+[^\n]*(?:\.ssh|\.env|id_rsa|私钥|环境变量|credentials))/gi,
    redact: null,
  },
];

const SEVERITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 };

function applyRule(rule, sourceText, flags, currentHighest, currentSanitized) {
  rule.regex.lastIndex = 0;
  if (!rule.regex.test(sourceText)) {
    return { highest: currentHighest, sanitizedText: currentSanitized };
  }

  flags.push({ id: rule.id, severity: rule.severity, label: rule.label });
  const nextHighest =
    SEVERITY_RANK[rule.severity] > SEVERITY_RANK[currentHighest] ? rule.severity : currentHighest;

  let nextSanitized = currentSanitized;
  if (rule.redact) {
    rule.regex.lastIndex = 0;
    nextSanitized = nextSanitized.replace(rule.regex, rule.redact);
  }
  return { highest: nextHighest, sanitizedText: nextSanitized };
}

export function scanIncomingMessage(rawText) {
  const text = typeof rawText === 'string' ? rawText : String(rawText ?? '');
  const flags = [];
  let highest = 'LOW';
  let sanitizedText = text;

  // 先执行短链折叠，再对折叠后的文本扫描普通外部链接，避免同一链接重复报警
  ({ highest, sanitizedText } = applyRule(SHORT_URL_RULE, text, flags, highest, sanitizedText));
  ({ highest, sanitizedText } = applyRule(
    EXTERNAL_URL_RULE,
    sanitizedText,
    flags,
    highest,
    sanitizedText
  ));

  for (const rule of OTHER_RULES) {
    ({ highest, sanitizedText } = applyRule(rule, text, flags, highest, sanitizedText));
  }

  return { riskLevel: highest, flags, sanitizedText };
}

/**
 * 第二层：防 Prompt 注入隔离封装（聊天正文）
 */
export function wrapUntrustedMessage({
  senderId,
  nickname,
  timestamp,
  rawText,
  riskLevel,
  flags,
  sanitizedText,
}) {
  const nonce = crypto.randomBytes(6).toString('hex');
  const tag = `UNTRUSTED_PEER_MSG_${nonce}`;
  const safeSender = sanitizeUntrustedField(String(senderId || '').slice(0, 12), 24);
  const safeNick = sanitizeUntrustedField(nickname || '匿名真人', 32) || '匿名真人';
  const safeTime = sanitizeUntrustedField(timestamp || '', 40);
  const safeRisk = sanitizeUntrustedField(riskLevel || 'LOW', 16);
  const flagSummary =
    Array.isArray(flags) && flags.length > 0
      ? sanitizeUntrustedField(flags.map((f) => `${f.id}:${f.label}`).join('; '), 240)
      : 'none';

  return [
    `[${tag} sender="${safeSender}" nickname="${safeNick}" time="${safeTime}" risk="${safeRisk}" flags="${flagSummary}"]`,
    sanitizedText ?? rawText,
    `[/${tag}]`,
  ].join('\n');
}

function sanitizeMetadataPayload(data) {
  if (typeof data === 'string') {
    return sanitizeUntrustedField(data, 240);
  }
  if (!data || typeof data !== 'object') {
    return {};
  }
  const safeObj = {};
  const entries = Object.entries(data).slice(0, 8);
  for (const [k, v] of entries) {
    const cleanKey = sanitizeUntrustedField(k, 24);
    if (!cleanKey) continue;
    safeObj[cleanKey] =
      typeof v === 'number' || typeof v === 'boolean' ? v : sanitizeUntrustedField(v, 120);
  }
  return safeObj;
}

/**
 * 隔离封装来自陌生人的元数据（intentCard、图片 caption 等），堵死侧门 Prompt 注入
 */
export function wrapUntrustedMetadata({ label = 'metadata', senderId = '', nickname = '', data }) {
  const nonce = crypto.randomBytes(6).toString('hex');
  const tag = `UNTRUSTED_PEER_META_${nonce}`;
  const safeLabel = sanitizeUntrustedField(label, 32) || 'metadata';
  const safeSender = sanitizeUntrustedField(String(senderId || '').slice(0, 12), 24);
  const safeNick = sanitizeUntrustedField(nickname || '匿名真人', 32) || '匿名真人';
  const cleanPayload = sanitizeMetadataPayload(data);
  const body = typeof cleanPayload === 'string' ? cleanPayload : JSON.stringify(cleanPayload);

  return [
    `[${tag} label="${safeLabel}" sender="${safeSender}" nickname="${safeNick}"]`,
    body,
    `[/${tag}]`,
  ].join('\n');
}

/**
 * 出站密钥检测与脱敏共享正则表（确保检测与脱敏 100% 对齐）
 */
const PRIVATE_KEY_BLOCK_PATTERN = {
  source: '-----BEGIN (?:[A-Z0-9 ]+)?PRIVATE KEY-----[\\s\\S]*?-----END (?:[A-Z0-9 ]+)?PRIVATE KEY-----',
  flags: 'g',
  replacement: '[已脱敏私钥]',
};

const PRIVATE_KEY_HEADER_PATTERN = {
  source: '-----BEGIN (?:[A-Z0-9 ]+)?PRIVATE KEY-----',
  flags: 'g',
  replacement: '[已脱敏私钥]',
};

const SECRET_TOKEN_PATTERNS = [
  { source: '\\bsk-ant-[a-zA-Z0-9_-]{20,}\\b', flags: 'g', replacement: '[已脱敏密钥]' },
  {
    source: '\\bsk-(?:proj-|svcacct-|admin-)?[a-zA-Z0-9_-]{20,}\\b',
    flags: 'g',
    replacement: '[已脱敏密钥]',
  },
  { source: '\\b(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{30,}\\b', flags: 'g', replacement: '[已脱敏密钥]' },
  { source: '\\bgithub_pat_[a-zA-Z0-9_]{22,}\\b', flags: 'g', replacement: '[已脱敏密钥]' },
  { source: '\\bAIza[0-9A-Za-z_-]{35}\\b', flags: 'g', replacement: '[已脱敏密钥]' },
  { source: '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b', flags: 'g', replacement: '[已脱敏密钥]' },
  { source: '\\bxox[baprs]-[0-9a-zA-Z-]{10,}\\b', flags: 'g', replacement: '[已脱敏密钥]' },
  { source: '\\bsk_live_[0-9a-zA-Z]{24,}\\b', flags: 'g', replacement: '[已脱敏密钥]' },
  {
    source: '\\b[Bb]earer\\s+eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b',
    flags: 'g',
    replacement: 'Bearer [已脱敏密钥]',
  },
];

const OUTBOUND_DETECTION_PATTERNS = [PRIVATE_KEY_HEADER_PATTERN, ...SECRET_TOKEN_PATTERNS];

/**
 * 校验发出的消息是否包含本地高危敏感密钥或私钥
 */
export function detectOutboundSecretLeak(text) {
  const input = String(text ?? '');
  return OUTBOUND_DETECTION_PATTERNS.some(({ source, flags }) =>
    new RegExp(source, flags.replace('g', '')).test(input)
  );
}

/**
 * 一键脱敏上下文打包（互助发报错日志前自动抹除路径、密钥、邮箱、手机号、IPv4）
 */
export function sanitizeContextBrief(text) {
  let out = String(text ?? '');

  out = out.replace(
    new RegExp(PRIVATE_KEY_BLOCK_PATTERN.source, PRIVATE_KEY_BLOCK_PATTERN.flags),
    PRIVATE_KEY_BLOCK_PATTERN.replacement
  );
  out = out.replace(
    new RegExp(PRIVATE_KEY_HEADER_PATTERN.source, PRIVATE_KEY_HEADER_PATTERN.flags),
    PRIVATE_KEY_HEADER_PATTERN.replacement
  );

  for (const rule of SECRET_TOKEN_PATTERNS) {
    out = out.replace(new RegExp(rule.source, rule.flags), rule.replacement);
  }

  out = out.replace(/(?:\/Users\/|\/home\/)[^/\s"'<>]+/g, '/<USER_HOME>');
  out = out.replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+/g, 'C:\\Users\\<USER>');
  out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[已脱敏邮箱]');
  out = out.replace(/(?<![0-9])(?:\+?86[-\s]?)?1[3-9]\d{9}(?![0-9])/g, '[已脱敏手机号]');
  out = out.replace(
    /(?<![vV\d.])(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?![\d.])/g,
    '[已脱敏IP]'
  );
  return out;
}
