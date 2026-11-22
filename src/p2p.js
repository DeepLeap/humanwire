import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { NostrRelaySwarm, DEFAULT_NOSTR_RELAYS } from './transport-relay.js';
import { createHyperswarm } from './transport-p2p.js';
import { encryptRelayPacket, decryptRelayPacket } from './nostr-crypto.js';
import {
  scanIncomingMessage,
  wrapUntrustedMessage,
  wrapUntrustedMetadata,
  sanitizeUntrustedField,
} from './safety.js';
import {
  DEFAULT_DIFFICULTY,
  solvePoWAsync,
  verifyPoW,
  isPoWExpiringSoon,
} from './pow.js';
import {
  EphemeralImageVault,
  detectSafeImageMime,
  stripImageMetadata,
} from './media.js';
import { VouchManager, DEFAULT_VOUCH_POW_BITS } from './vouch.js';
import {
  loadIdentityState,
  saveIdentityState,
  deleteIdentityState,
} from './identity.js';

export const PROTOCOL_PREFIX = 'humanwire:v0.5';
export const MAX_LINE_BYTES = 5 * 1024 * 1024; // 5MB 帧上限：完美容纳 2MB 图片在群聊双层 Base64 加密后的膨胀体积
const MAX_RAW_READ_BYTES = 4 * 1024 * 1024;
const MAX_RELAY_IMAGE_BYTES = 400 * 1024; // 免费公共中继模式去元数据后上限 400KB
const MAX_P2P_IMAGE_BYTES = 2 * 1024 * 1024; // P2P 直连模式去元数据后上限 2MB
const MAX_TEXT_CHARS = 2000;
const MAX_INBOX_EVENTS = 200;
const RATE_WINDOW_MS = 3000;
const RATE_MAX_MSGS = 5;
const LOCK_TIMEOUT_MS = 5000;
const AUTH_TIMEOUT_MS = 5000;
const MAX_PENDING_AUTH_PEERS = 16;
const DISCOVERY_FLUSH_TIMEOUT_MS = 8000;
const POW_REFRESH_INTERVAL_MS = 3.5 * 60 * 1000;
const DEFAULT_MAX_GROUP_PEERS = 8;

const VALID_TRANSPORTS = new Set(['relay', 'p2p']);

const WEAK_ROOM_CODES = new Set([
  '12345678',
  '87654321',
  '123456789',
  '1234567890',
  '00000000',
  'password',
  'password1',
  'qwertyui',
  'qwerty123',
  'abcdefgh',
  'admin123',
]);

const ROOM_ADJECTIVES = [
  'nebula', 'orbit', 'prism', 'cobalt', 'amber', 'velvet', 'arctic', 'solar',
  'quartz', 'cipher', 'zenith', 'lunar', 'silver', 'copper', 'silent', 'vivid',
];

const ROOM_NOUNS = [
  'falcon', 'beacon', 'nexus', 'photon', 'harbor', 'vertex', 'compass', 'spark',
  'anchor', 'horizon', 'matrix', 'bridge', 'echo', 'lantern', 'signal', 'atlas',
];

/**
 * 生成高熵且方便口头/聊天软件分享的随机房间码（例如 nebula-falcon-8k4m）
 */
export function generateRoomCode() {
  const adj = ROOM_ADJECTIVES[crypto.randomInt(ROOM_ADJECTIVES.length)];
  const noun = ROOM_NOUNS[crypto.randomInt(ROOM_NOUNS.length)];
  const suffixChars = '23456789abcdefghjkmnpqrstuvwxyz';
  let suffix = '';
  for (let i = 0; i < 4; i += 1) {
    suffix += suffixChars[crypto.randomInt(suffixChars.length)];
  }
  return `${adj}-${noun}-${suffix}`;
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest();
}

function normalizeTransport(transport, fallback = 'relay') {
  const val = String(transport || fallback).trim().toLowerCase();
  if (!VALID_TRANSPORTS.has(val)) {
    throw new Error(`不支持的传输引擎 "${transport}"，请使用 "relay"（默认零依赖多中继）或 "p2p"（可选 Hyperswarm 直连）。`);
  }
  return val;
}

function validateRoomCode(roomCode) {
  const normalized = String(roomCode ?? '').trim();
  if (normalized.length < 8) {
    throw new Error('为了防止陌生人爆破闯入，房间码长度至少需要 8 位。');
  }
  if (/^(.)\1+$/.test(normalized) || WEAK_ROOM_CODES.has(normalized.toLowerCase())) {
    throw new Error('房间码过于简单，存在被爆破风险，请使用更高熵的组合（如 proj-rust-8x9k）。');
  }
  let charClasses = 0;
  if (/[a-z]/.test(normalized)) charClasses += 1;
  if (/[A-Z]/.test(normalized)) charClasses += 1;
  if (/[0-9]/.test(normalized)) charClasses += 1;
  if (/[^a-zA-Z0-9]/.test(normalized)) charClasses += 1;
  if (charClasses < 2 && normalized.length < 12) {
    throw new Error('8–11 位房间码需至少包含两类字符（字母/数字/符号），或使用 12 位以上短语。');
  }
  return normalized;
}

function deriveRoomKey(roomCode) {
  return crypto.scryptSync(roomCode, `${PROTOCOL_PREFIX}:room-salt`, 32);
}

function deriveRoomTopic(roomKey) {
  return sha256(Buffer.concat([Buffer.from(`${PROTOCOL_PREFIX}:room-topic:`, 'utf8'), roomKey]));
}

function encryptGroupPayload(key, obj, aadStr) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aadStr) {
    cipher.setAAD(Buffer.from(aadStr, 'utf8'));
  }
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64'),
  };
}

function decryptGroupPayload(key, payload, aadStr) {
  if (
    !payload ||
    typeof payload.iv !== 'string' ||
    typeof payload.tag !== 'string' ||
    typeof payload.data !== 'string'
  ) {
    throw new Error('密文帧结构无效');
  }
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const data = Buffer.from(payload.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aadStr) {
    decipher.setAAD(Buffer.from(aadStr, 'utf8'));
  }
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

function sanitizeIntentCard(rawCard) {
  if (!rawCard || typeof rawCard !== 'object') return null;
  const clean = {};
  for (const [k, v] of Object.entries(rawCard).slice(0, 8)) {
    const cleanKey = sanitizeUntrustedField(k, 24);
    if (!cleanKey) continue;
    clean[cleanKey] =
      typeof v === 'number' || typeof v === 'boolean' ? v : sanitizeUntrustedField(v, 120);
  }
  return clean;
}

/**
 * HumanWire (v0.4) 极简双引擎 P2P 核心管理器
 * - 默认 relay 引擎（0 依赖）：Nostr 多中继自动容灾 + X25519 前向保密 + 自动分片传图
 * - 可选 p2p 引擎（按需外挂 hyperswarm）：DHT 打洞直连 + 支持 2MB 原图直传
 * - 共用同一套强安全气闸：PoW 门禁与续期、密文群握手防重放、双语反诈、去 EXIF 与抗女巫 Ed25519 好人卡
 */
const P2P_PRIVACY_WARNING =
  '⚠️ 当前处于 P2P 直连模式，聊天对端与 DHT 节点可见你的公网 IP 地址，仅建议用于信任熟人或已挂 VPN 场景。';

export class P2PMatchManager {
  constructor({
    defaultTransport = 'relay',
    relays = DEFAULT_NOSTR_RELAYS,
    proxyUrl = null,
    allowIpExposure = false,
    swarmFactory = null,
    swarmFactories = null,
    webSocketFactory = null,
    stateFilePath = null,
    powBits = DEFAULT_DIFFICULTY,
    vouchPowBits = DEFAULT_VOUCH_POW_BITS,
    discoveryTimeoutMs = DISCOVERY_FLUSH_TIMEOUT_MS,
  } = {}) {
    this.defaultTransport = normalizeTransport(defaultTransport, 'relay');
    this.relays = relays;
    this.proxyUrl = proxyUrl ? String(proxyUrl).trim() : null;
    this.allowIpExposure = Boolean(allowIpExposure);
    this.swarmFactory = swarmFactory;
    this.swarmFactories = swarmFactories || {};
    this.webSocketFactory = webSocketFactory;
    this.stateFilePath = stateFilePath;
    this.powBits = powBits;
    this.vouchPowBits = vouchPowBits;
    this.discoveryTimeoutMs = discoveryTimeoutMs;

    this.swarm = null;
    this.activeTransport = null;
    this.swarmSeedHex = null;
    this._stateLoaded = false;
    this._initPromise = null;

    this.mode = 'IDLE'; // IDLE | MATCHING_1V1 | CONNECTED_1V1 | GROUP_ROOM | PLAZA_ROOM
    this.sessionId = null;
    this.channel = null;
    this.nickname = '匿名用户';
    this.intentCard = null;
    this.minVouchesRequired = 0;
    this.powProof = null;
    this.powRefreshTimer = null;

    this.lobbyTopic = null;
    this.roomTopic = null;
    this.roomKey = null;
    this.maxPeers = 1;
    this.plazaName = null;
    this.plazaBoardTag = null;
    this.plazaBoardKey = null;
    this._seenPlazaMsgIds = new Set();

    this.pendingLockPeer = null;
    this.pendingLockTimer = null;

    this.pendingPeers = new Map();
    this.peers = new Map();
    this.inbox = [];
    this.inboxWaiters = [];
    this.blockedPubkeys = new Set();

    this.imageVault = new EphemeralImageVault();
    this.vouchManager = new VouchManager({ vouchPowBits: this.vouchPowBits });
  }

  async preloadState() {
    if (this._stateLoaded) return;
    this._stateLoaded = true;
    const saved = this.stateFilePath ? await loadIdentityState(this.stateFilePath) : null;
    if (saved) {
      this.swarmSeedHex = saved.swarmSeedHex;
      this.blockedPubkeys = new Set(saved.blockedPubkeys);
      if (saved.vouchState?.privateKeyPem) {
        try {
          this.vouchManager = new VouchManager({
            ...saved.vouchState,
            vouchPowBits: this.vouchPowBits,
          });
          return;
        } catch {
          // 密钥损坏时安全重建
        }
      }
      this.vouchManager = new VouchManager({ vouchPowBits: this.vouchPowBits });
    } else {
      this.swarmSeedHex = crypto.randomBytes(32).toString('hex');
      this.vouchManager = new VouchManager({ vouchPowBits: this.vouchPowBits });
      if (this.stateFilePath) {
        await this._saveIdentityStateSafe();
      }
    }
  }

  async ensureSwarm(transport = this.defaultTransport) {
    const targetTransport = normalizeTransport(transport, this.defaultTransport);
    if (this.swarm && this.activeTransport === targetTransport) return;

    if (this._initPromise) {
      await this._initPromise;
      if (this.swarm && this.activeTransport === targetTransport) return;
    }

    this._initPromise = (async () => {
      if (this.swarm && this.activeTransport !== targetTransport) {
        await this.swarm.destroy().catch(() => {});
        this.swarm = null;
        this.activeTransport = null;
      }

      await this.preloadState();
      const seedBuf = Buffer.from(this.swarmSeedHex, 'hex');
      const factory = this._resolveSwarmFactory(targetTransport);
      const created = await factory({ seed: seedBuf });
      this.swarm = created;
      this.activeTransport = targetTransport;
      this.swarm.on('connection', (socket, peerInfo) => {
        this._handleConnection(socket, peerInfo);
      });
    })();

    try {
      await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  _resolveSwarmFactory(targetTransport) {
    if (typeof this.swarmFactories?.[targetTransport] === 'function') {
      return this.swarmFactories[targetTransport];
    }
    if (typeof this.swarmFactory === 'function') {
      return this.swarmFactory;
    }
    if (targetTransport === 'relay') {
      return ({ seed }) =>
        new NostrRelaySwarm({
          seed,
          relays: this.relays,
          proxyUrl: this.proxyUrl,
          webSocketFactory: this.webSocketFactory,
        });
    }
    return ({ seed }) => createHyperswarm({ seed });
  }

  _assertTransportPrivacy(targetTransport, allowIpExposure) {
    if (targetTransport === 'p2p' && !allowIpExposure && !this.allowIpExposure) {
      throw new Error(
        '隐私安全拦截：P2P 直连模式（transport="p2p"）会通过 UDP 打洞向聊天对端及 DHT 节点直接暴露你的真实公网 IP 地址。普通匿名沟通强烈建议保持默认 "relay" 模式；若你处于信任熟人环境或已开启 VPN 并确认接受暴露风险，请显式传入 allow_ip_exposure=true（或设置环境变量 HUMANWIRE_ALLOW_P2P=1）。'
      );
    }
  }

  get myPubkeyHex() {
    if (!this.swarm) return null;
    return this.swarm.keyPair.publicKey.toString('hex');
  }

  getStatus() {
    const validVouches = this.vouchManager.getValidVouches({
      minPowBits: this.vouchPowBits,
      expectedSubjectHex: this.myPubkeyHex || null,
    });
    const currentTransport = this.activeTransport || this.defaultTransport;
    const status = {
      mode: this.mode,
      transport: currentTransport,
      defaultTransport: this.defaultTransport,
      privacyProfile: currentTransport === 'p2p' ? 'direct-p2p-ip-visible' : 'anonymous-dead-drop',
      proxyEnabled: Boolean(this.proxyUrl),
      allowIpExposureDefault: this.allowIpExposure,
      sessionId: this.sessionId,
      channel: this.channel,
      myId: this.myPubkeyHex ? this.myPubkeyHex.slice(0, 12) : null,
      identityMode: this.stateFilePath ? 'persistent' : 'ephemeral',
      myValidVouches: validVouches.length,
      connectedPeers: Array.from(this.peers.entries()).map(([id, p]) => ({
        peerId: id.slice(0, 12),
        nickname: p.nickname,
        verifiedVouches: p.verifiedVouches || 0,
        intentCard: p.intentCard,
      })),
      unreadMessages: this.inbox.length,
      blockedCount: this.blockedPubkeys.size,
    };

    if (this.swarm && typeof this.swarm.getRelayStatus === 'function') {
      status.relayStatus = this.swarm.getRelayStatus();
    }
    return status;
  }

  async startMatching({
    channel = 'chat/casual',
    nickname = '匿名用户',
    intentCard = {},
    minVouches = 0,
    powBits = this.powBits,
    transport = this.defaultTransport,
    allowIpExposure = false,
  }) {
    const targetTransport = normalizeTransport(transport, this.defaultTransport);
    this._assertTransportPrivacy(targetTransport, allowIpExposure);
    await this.leaveChat({ blockPeer: false });
    await this.ensureSwarm(targetTransport);

    const safeChannel = sanitizeUntrustedField(channel || 'chat/casual', 64) || 'chat/casual';
    const safeNickname = sanitizeUntrustedField(nickname || '匿名用户', 32) || '匿名用户';
    const safeIntentCard = sanitizeIntentCard(intentCard) || {};

    this.mode = 'MATCHING_1V1';
    this.sessionId = `s1v1_${crypto.randomBytes(4).toString('hex')}`;
    this.channel = safeChannel;
    this.nickname = safeNickname;
    this.intentCard = safeIntentCard;
    this.minVouchesRequired = Math.max(0, minVouches);
    this.maxPeers = 1;
    this.powBits = powBits;

    await this._refreshPoW();
    this._startPoWRefreshTimer();

    this.lobbyTopic = sha256(`${PROTOCOL_PREFIX}:lobby:${this.channel}`);
    const discovery = this.swarm.join(this.lobbyTopic, { server: true, client: true });
    const discoveryWarning = await this._flushWithTimeout(discovery);

    const relayStatus =
      typeof this.swarm.getRelayStatus === 'function' ? this.swarm.getRelayStatus() : undefined;

    return {
      sessionId: this.sessionId,
      mode: this.mode,
      transport: this.activeTransport,
      channel: this.channel,
      powVerifiedBits: this.powProof.difficulty,
      ...(relayStatus ? { relayStatus } : {}),
      ...(this.activeTransport === 'p2p' ? { privacyWarning: P2P_PRIVACY_WARNING } : {}),
      ...(discoveryWarning ? { discoveryWarning } : {}),
      note: '已完成防广告 PoW 校验并加入公共大厅。请调用 poll_messages 轮询匹配状态。',
    };
  }

  async joinRoom({
    roomCode = '',
    nickname = '匿名用户',
    maxPeers = DEFAULT_MAX_GROUP_PEERS,
    transport = this.defaultTransport,
    allowIpExposure = false,
  } = {}) {
    const targetTransport = normalizeTransport(transport, this.defaultTransport);
    this._assertTransportPrivacy(targetTransport, allowIpExposure);
    const trimmedInput = String(roomCode ?? '').trim();
    const createdNewCode = !trimmedInput;
    const normalized = createdNewCode ? generateRoomCode() : validateRoomCode(trimmedInput);

    await this.leaveChat({ blockPeer: false });
    await this.ensureSwarm(targetTransport);

    const safeNickname = sanitizeUntrustedField(nickname || '匿名用户', 32) || '匿名用户';
    this.mode = 'GROUP_ROOM';
    this.sessionId = `sgrp_${crypto.randomBytes(4).toString('hex')}`;
    this.channel = `room:${sha256(normalized).toString('hex').slice(0, 8)}`;
    this.nickname = safeNickname;
    this.maxPeers = Math.min(Math.max(2, maxPeers), 16);
    this.roomKey = deriveRoomKey(normalized);
    this.roomTopic = deriveRoomTopic(this.roomKey);

    const discovery = this.swarm.join(this.roomTopic, { server: true, client: true });
    const discoveryWarning = await this._flushWithTimeout(discovery);

    const relayStatus =
      typeof this.swarm.getRelayStatus === 'function' ? this.swarm.getRelayStatus() : undefined;

    return {
      sessionId: this.sessionId,
      mode: this.mode,
      roomCode: normalized,
      createdNewCode,
      inviteText: `把下面这句话发给你的朋友或同事，让对方直接粘贴给自己的 AI 客户端即可加密联机：\n「请用 humanwire 加入加密房间 ${normalized}」`,
      transport: this.activeTransport,
      maxPeers: this.maxPeers,
      ...(relayStatus ? { relayStatus } : {}),
      ...(this.activeTransport === 'p2p' ? { privacyWarning: P2P_PRIVACY_WARNING } : {}),
      ...(discoveryWarning ? { discoveryWarning } : {}),
      note: '已进入加密房间码群聊，只有持有相同房间码的成员才能完成握手并解密消息与图片。',
    };
  }

  async joinPlaza({
    plaza = 'global',
    nickname = '匿名用户',
    maxPeers = 16,
    transport = this.defaultTransport,
    allowIpExposure = false,
  } = {}) {
    const targetTransport = normalizeTransport(transport, this.defaultTransport);
    this._assertTransportPrivacy(targetTransport, allowIpExposure);

    const plazaName = sanitizeUntrustedField(plaza || 'global', 32).toLowerCase() || 'global';

    await this.leaveChat({ blockPeer: false });
    await this.ensureSwarm(targetTransport);

    const safeNickname = sanitizeUntrustedField(nickname || '匿名用户', 32) || '匿名用户';
    this.mode = 'PLAZA_ROOM';
    this.sessionId = `splz_${crypto.randomBytes(4).toString('hex')}`;
    this.plazaName = plazaName;
    this.channel = `plaza/${plazaName}`;
    this.nickname = safeNickname;
    this.maxPeers = Math.min(Math.max(2, maxPeers), 24);
    this.roomKey = deriveRoomKey(`${PROTOCOL_PREFIX}:plaza-secret:${plazaName}`);
    this.roomTopic = deriveRoomTopic(this.roomKey);
    this.plazaBoardTag = sha256(`${PROTOCOL_PREFIX}:plaza-board:${plazaName}`).toString('hex').slice(0, 32);
    this.plazaBoardKey = sha256(`${PROTOCOL_PREFIX}:plaza-board-key:${plazaName}`);

    // 广场防刷 PoW（作用域为 plaza:<name>）
    this.powProof = await solvePoWAsync({
      pubkeyHex: this.myPubkeyHex,
      scope: `plaza:${plazaName}`,
      difficulty: this.powBits,
    });

    if (
      this.activeTransport === 'relay' &&
      typeof this.swarm.subscribePlazaBoard === 'function'
    ) {
      this.swarm.subscribePlazaBoard({
        boardTag: this.plazaBoardTag,
        sinceSeconds: 86400,
        limit: 15,
        onPost: (ev) => this._handlePlazaBoardPost(ev),
      });
    }

    const discovery = this.swarm.join(this.roomTopic, { server: true, client: true });
    const discoveryWarning = await this._flushWithTimeout(discovery);

    const relayStatus =
      typeof this.swarm.getRelayStatus === 'function' ? this.swarm.getRelayStatus() : undefined;

    return {
      sessionId: this.sessionId,
      mode: this.mode,
      plaza: plazaName,
      channel: this.channel,
      transport: this.activeTransport,
      maxPeers: this.maxPeers,
      historyEnabled: this.activeTransport === 'relay',
      ...(relayStatus ? { relayStatus } : {}),
      ...(this.activeTransport === 'p2p' ? { privacyWarning: P2P_PRIVACY_WARNING } : {}),
      ...(discoveryWarning ? { discoveryWarning } : {}),
      note:
        this.activeTransport === 'relay'
          ? `已进入公开广场「${plazaName}」。你可以先调用 poll_messages 查看最近 24 小时内的广场加密留言，也可直接发言与实时群聊。`
          : `已进入 P2P 公开广场「${plazaName}」（当前仅支持实时在线成员群聊，不含 24h 留言板回放）。`,
    };
  }

  sendMessage(text) {
    const allowEmptyPlaza =
      this.mode === 'PLAZA_ROOM' &&
      this.activeTransport === 'relay' &&
      typeof this.swarm?.publishPlazaPost === 'function';
    this._assertConnected({ allowEmptyPlaza });
    const content = String(text ?? '').trim();
    if (!content) throw new Error('消息内容不能为空。');
    if (content.length > MAX_TEXT_CHARS) {
      throw new Error(`单条消息超过 ${MAX_TEXT_CHARS} 字限制，请精简后发送。`);
    }

    const timestamp = new Date().toISOString();
    const msgId = crypto.randomBytes(6).toString('hex');
    const delivered = this._broadcast({
      type: 'CHAT',
      msgId,
      nickname: this.nickname,
      text: content,
      timestamp,
    });

    let publishedToBoard = false;
    if (allowEmptyPlaza && this.plazaBoardTag && this.plazaBoardKey) {
      this._recordPlazaMsgId(msgId);
      const aad = `${PROTOCOL_PREFIX}:plaza-board:${this.plazaName}`;
      const encryptedContent = encryptRelayPacket(
        this.plazaBoardKey,
        {
          type: 'PLAZA_POST',
          msgId,
          senderId: this.myPubkeyHex,
          nickname: this.nickname,
          text: content,
          timestamp,
          powProof: this.powProof,
        },
        aad,
        { pad: true }
      );
      this.swarm.publishPlazaPost({
        boardTag: this.plazaBoardTag,
        encryptedContent,
      });
      publishedToBoard = true;
    }

    return {
      delivered,
      ...(publishedToBoard ? { publishedToBoard: true } : {}),
      timestamp,
    };
  }

  async sendImageFile({ filePath, caption = '' }) {
    this._assertConnected();
    const rawBuf = await fs.readFile(filePath);
    if (rawBuf.length > MAX_RAW_READ_BYTES) {
      throw new Error('原始图片文件过大（超过 4MB），请压缩后再试。');
    }
    const mimeType = detectSafeImageMime(rawBuf);
    if (!mimeType) {
      throw new Error('仅支持发送合法的 PNG / JPEG / WebP 图片文件。');
    }

    // 出站自动剥离 EXIF / GPS / XMP / IPTC / 文本注释等敏感元数据
    const { buffer: cleanedBuf, strippedBytes } = stripImageMetadata(rawBuf, mimeType);
    const isRelay = this.activeTransport === 'relay';
    const maxAllowedBytes = isRelay ? MAX_RELAY_IMAGE_BYTES : MAX_P2P_IMAGE_BYTES;

    if (cleanedBuf.length > maxAllowedBytes) {
      if (isRelay) {
        throw new Error(
          `图片（去元数据后 ${Math.ceil(cleanedBuf.length / 1024)}KB）超过免费公共中继模式 400KB 上限，请先压缩或裁切截图；如需发送最大 2MB 原图，请改用 transport="p2p" 直连模式。`
        );
      }
      throw new Error('图片超过 2MB 上限，请压缩后再发送。');
    }

    const safeCaption = sanitizeUntrustedField(caption || '', 200);
    const timestamp = new Date().toISOString();
    const delivered = this._broadcast({
      type: 'IMAGE',
      nickname: this.nickname,
      caption: safeCaption,
      base64: cleanedBuf.toString('base64'),
      timestamp,
    });
    return {
      delivered,
      transport: this.activeTransport,
      mimeType,
      sizeBytes: cleanedBuf.length,
      strippedMetadataBytes: strippedBytes,
      timestamp,
    };
  }

  getImageForScreening(imageId) {
    return this.imageVault.get(imageId);
  }

  async issueVouchToPeers({ tag = 'helpful', peerId = null } = {}) {
    this._assertConnected();

    let targetEntry = null;
    if (peerId) {
      const prefix = String(peerId).trim().toLowerCase();
      const matches = Array.from(this.peers.entries()).filter(
        ([id]) => id.toLowerCase() === prefix || id.toLowerCase().startsWith(prefix)
      );
      if (matches.length === 0) {
        throw new Error(`未找到匹配的在线成员（peer_id=${peerId}）。`);
      }
      if (matches.length > 1) {
        throw new Error(`peer_id="${peerId}" 匹配到多个成员，请提供更长的前缀。`);
      }
      targetEntry = matches[0];
    } else if (this.peers.size === 1) {
      targetEntry = this.peers.entries().next().value;
    } else {
      throw new Error('群聊中有多名在线成员，请指定 peer_id 参数来向特定成员签发好人卡（可通过 get_status 查看）。');
    }

    const [targetPeerId, targetPeer] = targetEntry;
    const vouch = await this.vouchManager.issueVouch({
      issuerPeerId: this.myPubkeyHex,
      subjectPubkeyHex: targetPeerId,
      tag,
      powBits: this.vouchPowBits,
    });

    this._sendMaybeEncrypted(targetPeer, { type: 'VOUCH', vouch });
    return {
      issued: 1,
      targetPeerId: targetPeerId.slice(0, 12),
      nickname: targetPeer.nickname,
      tag: vouch.tag,
    };
  }

  async pollMessages(waitSeconds = 8) {
    const clampedMs = Math.min(Math.max(0, waitSeconds), 25) * 1000;
    if (this.inbox.length > 0 || clampedMs === 0) {
      return this._drainInbox();
    }

    await new Promise((resolve) => {
      let settled = false;
      const wake = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.inboxWaiters = this.inboxWaiters.filter((w) => w !== wake);
        resolve();
      };
      const timer = setTimeout(wake, clampedMs);
      timer.unref?.();
      this.inboxWaiters.push(wake);
    });
    return this._drainInbox();
  }

  async leaveChat({ blockPeer = false } = {}) {
    this._stopPoWRefreshTimer();

    if (this.pendingLockTimer) {
      clearTimeout(this.pendingLockTimer);
      this.pendingLockTimer = null;
    }
    this.pendingLockPeer = null;

    let blockListChanged = false;
    for (const [peerId, peer] of this.peers.entries()) {
      if (blockPeer && !this.blockedPubkeys.has(peerId)) {
        this.blockedPubkeys.add(peerId);
        blockListChanged = true;
      }
      this.peers.delete(peerId);
      try {
        peer.socket.destroy();
      } catch {
        // ignore
      }
    }

    for (const [peerId, pending] of this.pendingPeers.entries()) {
      if (pending.authTimer) clearTimeout(pending.authTimer);
      this.pendingPeers.delete(peerId);
      try {
        pending.socket.destroy();
      } catch {
        // ignore
      }
    }

    if (this.swarm) {
      if (this.lobbyTopic) await this.swarm.leave(this.lobbyTopic).catch(() => {});
      if (this.roomTopic) await this.swarm.leave(this.roomTopic).catch(() => {});
      if (this.plazaBoardTag && typeof this.swarm.unsubscribePlazaBoard === 'function') {
        this.swarm.unsubscribePlazaBoard(this.plazaBoardTag);
      }
    }

    this.mode = 'IDLE';
    this.sessionId = null;
    this.channel = null;
    this.intentCard = null;
    this.powProof = null;
    this.lobbyTopic = null;
    this.roomTopic = null;
    this.roomKey = null;
    this.plazaName = null;
    this.plazaBoardTag = null;
    this.plazaBoardKey = null;
    this._seenPlazaMsgIds.clear();
    this.inbox = []; // 阅后即焚
    this.imageVault.clear(); // 清空内存图片保险箱

    if (blockListChanged && this.stateFilePath) {
      await this._saveIdentityStateSafe();
    }

    this._notifyWaiters();

    return { ok: true, blockedCount: this.blockedPubkeys.size };
  }

  async resetIdentity() {
    const targetTransport = this.activeTransport || this.defaultTransport;
    await this.leaveChat({ blockPeer: false });
    if (this.swarm) {
      await this.swarm.destroy().catch(() => {});
      this.swarm = null;
      this.activeTransport = null;
    }
    this.swarmSeedHex = crypto.randomBytes(32).toString('hex');
    this._stateLoaded = true;
    this.blockedPubkeys.clear();
    this.vouchManager = new VouchManager({ vouchPowBits: this.vouchPowBits });

    if (this.stateFilePath) {
      await deleteIdentityState(this.stateFilePath).catch(() => {});
      await this._saveIdentityStateSafe();
    }
    await this.ensureSwarm(targetTransport);
    return {
      ok: true,
      transport: this.activeTransport,
      myId: this.myPubkeyHex ? this.myPubkeyHex.slice(0, 12) : null,
      identityMode: this.stateFilePath ? 'persistent' : 'ephemeral',
    };
  }

  async destroy() {
    await this.leaveChat({ blockPeer: false });
    if (this.swarm) {
      await this.swarm.destroy().catch(() => {});
      this.swarm = null;
      this.activeTransport = null;
    }
  }

  // ================= 内部协议与连接管理 =================

  async _saveIdentityStateSafe() {
    if (!this.stateFilePath || !this.swarmSeedHex) return;
    try {
      await saveIdentityState(this.stateFilePath, {
        swarmSeedHex: this.swarmSeedHex,
        vouchState: this.vouchManager.exportState(),
        blockedPubkeys: Array.from(this.blockedPubkeys),
      });
    } catch {
      // 忽略磁盘异常，保证主流程可用
    }
  }

  async _flushWithTimeout(discovery) {
    if (!discovery || typeof discovery.flushed !== 'function') return null;
    let timer = null;
    try {
      const outcome = await Promise.race([
        discovery.flushed().then(() => 'flushed'),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('timeout'), this.discoveryTimeoutMs);
          timer.unref?.();
        }),
      ]);
      if (outcome === 'timeout') {
        return `网络节点广播超过 ${this.discoveryTimeoutMs}ms 仍在后台继续，已先返回控制权。`;
      }
      return null;
    } catch (err) {
      return `网络广播异常：${err.message}`;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async _refreshPoW() {
    const channelScope = `lobby:${this.channel}`;
    const proof = await solvePoWAsync({
      pubkeyHex: this.myPubkeyHex,
      scope: channelScope,
      difficulty: this.powBits,
    });
    if (this.mode === 'MATCHING_1V1' && this.channel && `lobby:${this.channel}` === channelScope) {
      this.powProof = proof;
    }
  }

  _startPoWRefreshTimer() {
    this._stopPoWRefreshTimer();
    this.powRefreshTimer = setInterval(() => {
      if (this.mode === 'MATCHING_1V1') {
        this._refreshPoW().catch(() => {});
      }
    }, POW_REFRESH_INTERVAL_MS);
    this.powRefreshTimer.unref?.();
  }

  _stopPoWRefreshTimer() {
    if (this.powRefreshTimer) {
      clearInterval(this.powRefreshTimer);
      this.powRefreshTimer = null;
    }
  }

  _isMultiPeerMode() {
    return this.mode === 'GROUP_ROOM' || this.mode === 'PLAZA_ROOM';
  }

  _assertConnected({ allowEmptyPlaza = false } = {}) {
    if (this.mode !== 'CONNECTED_1V1' && !this._isMultiPeerMode()) {
      throw new Error(`当前状态为 ${this.mode}，尚未建立可对话的连接。`);
    }
    if (this.peers.size === 0 && !allowEmptyPlaza) {
      throw new Error('当前会话暂无其他在线成员。');
    }
  }

  _broadcast(payloadObj) {
    let delivered = 0;
    for (const [, peer] of this.peers.entries()) {
      this._sendMaybeEncrypted(peer, payloadObj);
      delivered += 1;
    }
    return delivered;
  }

  _sendMaybeEncrypted(peerRecord, payloadObj) {
    if (this._isMultiPeerMode()) {
      peerRecord.txSeq = (peerRecord.txSeq || 0) + 1;
      const envelope = { ...payloadObj, seq: peerRecord.txSeq };
      const aad = `${PROTOCOL_PREFIX}:${this.myPubkeyHex}`;
      this._sendFrame(peerRecord.socket, {
        type: 'GROUP_ENC',
        payload: encryptGroupPayload(this.roomKey, envelope, aad),
      });
    } else {
      this._sendFrame(peerRecord.socket, payloadObj);
    }
  }

  _handleConnection(socket, peerInfo) {
    const peerId = peerInfo?.publicKey?.toString('hex');
    if (!peerId || peerId === this.myPubkeyHex) {
      socket.destroy();
      return;
    }
    if (this.blockedPubkeys.has(peerId)) {
      socket.destroy();
      return;
    }
    if (this.mode === 'CONNECTED_1V1' || this.mode === 'IDLE') {
      socket.destroy();
      return;
    }

    if (this._isMultiPeerMode()) {
      this._handleIncomingGroupConnection(socket, peerId);
      return;
    }

    if (this.mode === 'MATCHING_1V1') {
      this._handleIncomingLobbyConnection(socket, peerId);
    }
  }

  _createPeerRecord(socket) {
    return {
      socket,
      nickname: '匿名真人',
      intentCard: null,
      verifiedVouches: 0,
      msgTimestamps: [],
      locked: false,
      helloVerified: false,
      lockRejected: false,
      txSeq: 0,
      lastRxSeq: 0,
      authTimer: null,
    };
  }

  _handleIncomingGroupConnection(socket, peerId) {
    if (this.peers.size >= this.maxPeers || this.pendingPeers.size >= MAX_PENDING_AUTH_PEERS) {
      socket.destroy();
      return;
    }
    if (this.peers.has(peerId)) {
      socket.destroy();
      return;
    }

    const oldPending = this.pendingPeers.get(peerId);
    if (oldPending) {
      if (oldPending.authTimer) clearTimeout(oldPending.authTimer);
      this.pendingPeers.delete(peerId);
      try {
        oldPending.socket.destroy();
      } catch {
        // ignore
      }
    }

    const peerRecord = this._createPeerRecord(socket);
    peerRecord.authTimer = setTimeout(() => {
      if (this.pendingPeers.get(peerId) === peerRecord) {
        this.pendingPeers.delete(peerId);
        socket.destroy();
      }
    }, AUTH_TIMEOUT_MS);
    peerRecord.authTimer.unref?.();

    this.pendingPeers.set(peerId, peerRecord);
    this._attachSocketLifecycle(peerId, peerRecord);

    // 群聊严禁发送明文 HELLO：先在密文通道内发出 GROUP_HELLO
    this._sendMaybeEncrypted(peerRecord, {
      type: 'GROUP_HELLO',
      nickname: this.nickname,
      vouches: this.vouchManager.getValidVouches({
        minPowBits: this.vouchPowBits,
        expectedSubjectHex: this.myPubkeyHex,
      }),
    });
  }

  _handleIncomingLobbyConnection(socket, peerId) {
    const existing = this.peers.get(peerId);
    if (existing) {
      if (existing.helloVerified || this.pendingLockPeer === peerId) {
        socket.destroy();
        return;
      }
      this.peers.delete(peerId);
      try {
        existing.socket.destroy();
      } catch {
        // ignore
      }
    }

    const peerRecord = this._createPeerRecord(socket);
    this.peers.set(peerId, peerRecord);
    this._attachSocketLifecycle(peerId, peerRecord);

    this._sendLobbyHello(peerRecord).catch(() => {
      if (!socket.destroyed) socket.destroy();
    });
  }

  async _sendLobbyHello(peerRecord) {
    if (isPoWExpiringSoon(this.powProof)) {
      await this._refreshPoW();
    }
    if (this.mode !== 'MATCHING_1V1' || peerRecord.socket.destroyed) return;

    this._sendFrame(peerRecord.socket, {
      type: 'HELLO',
      mode: this.mode,
      nickname: this.nickname,
      intentCard: this.intentCard,
      powProof: this.powProof,
      vouches: this.vouchManager.getValidVouches({
        minPowBits: this.vouchPowBits,
        expectedSubjectHex: this.myPubkeyHex,
      }),
    });
  }

  _attachSocketLifecycle(peerId, peerRecord) {
    const { socket } = peerRecord;
    let rawBuf = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      rawBuf = rawBuf.length === 0 ? bufChunk : Buffer.concat([rawBuf, bufChunk]);

      let newlineIdx;
      while ((newlineIdx = rawBuf.indexOf(0x0a)) !== -1) {
        if (newlineIdx > MAX_LINE_BYTES) {
          this._pushSystemEvent(`对端 ${peerId.slice(0, 12)} 发送超长异常帧，已自动断开。`);
          socket.destroy();
          return;
        }

        const lineBuf = rawBuf.subarray(0, newlineIdx);
        rawBuf = rawBuf.subarray(newlineIdx + 1);
        const line = lineBuf.toString('utf8').trim();
        if (!line) continue;

        try {
          const frame = JSON.parse(line);
          this._handleFrame(peerId, peerRecord, frame);
        } catch {
          socket.destroy();
          return;
        }
        if (socket.destroyed) return;
      }

      if (rawBuf.length > MAX_LINE_BYTES) {
        this._pushSystemEvent(`对端 ${peerId.slice(0, 12)} 发送超长异常帧，已自动断开。`);
        socket.destroy();
      }
    });

    const cleanup = () => {
      if (this.pendingPeers.get(peerId) === peerRecord) {
        if (peerRecord.authTimer) clearTimeout(peerRecord.authTimer);
        this.pendingPeers.delete(peerId);
        return;
      }

      if (this.peers.get(peerId) !== peerRecord) return;
      this.peers.delete(peerId);

      if (this.mode === 'MATCHING_1V1' && this.pendingLockPeer === peerId) {
        this.pendingLockPeer = null;
        if (this.pendingLockTimer) {
          clearTimeout(this.pendingLockTimer);
          this.pendingLockTimer = null;
        }
        this._tryLockNextCandidate();
      } else if (this.mode === 'CONNECTED_1V1') {
        this._pushSystemEvent(`对方（${peerRecord.nickname}）已断开连接，会话结束。`);
        this.mode = 'IDLE';
      } else if (this._isMultiPeerMode()) {
        this._pushSystemEvent(`成员 ${peerRecord.nickname}（ID: ${peerId.slice(0, 12)}）离开了房间。`);
      }
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  _countValidPeerVouches(rawVouches, peerId) {
    const issuers = new Set();
    const issuerPeers = new Set();
    let validCount = 0;

    if (Array.isArray(rawVouches)) {
      for (const v of rawVouches.slice(0, 50)) {
        if (
          v &&
          !issuers.has(v.issuer) &&
          !issuerPeers.has(v.issuerPeerId) &&
          VouchManager.verifyVouch(v, peerId, { minPowBits: this.vouchPowBits })
        ) {
          issuers.add(v.issuer);
          issuerPeers.add(v.issuerPeerId);
          validCount += 1;
        }
      }
    }
    return validCount;
  }

  _handleFrame(peerId, peerRecord, frame) {
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
      peerRecord.socket.destroy();
      return;
    }

    if (this._isMultiPeerMode()) {
      this._handleGroupFrame(peerId, peerRecord, frame);
      return;
    }

    if (this.mode === 'MATCHING_1V1') {
      this._handleLobbyFrame(peerId, peerRecord, frame);
      return;
    }

    if (this.mode === 'CONNECTED_1V1' && peerRecord.locked && this.peers.get(peerId) === peerRecord) {
      this._handleAppPayload(peerId, peerRecord, frame);
    }
  }

  _handleGroupFrame(peerId, peerRecord, frame) {
    if (frame.type !== 'GROUP_ENC') {
      peerRecord.socket.destroy();
      return;
    }

    let inner;
    try {
      const aad = `${PROTOCOL_PREFIX}:${peerId}`;
      inner = decryptGroupPayload(this.roomKey, frame.payload, aad);
    } catch {
      peerRecord.socket.destroy();
      return;
    }

    if (!inner || typeof inner !== 'object' || typeof inner.type !== 'string') {
      peerRecord.socket.destroy();
      return;
    }

    if (!Number.isInteger(inner.seq) || inner.seq <= peerRecord.lastRxSeq) {
      if (!peerRecord.helloVerified) {
        peerRecord.socket.destroy();
      } else {
        this._pushSystemEvent(
          `安全拦截：检测到来自成员 ${peerRecord.nickname}（ID: ${peerId.slice(0, 12)}）的重复/乱序密文帧，已丢弃。`
        );
      }
      return;
    }
    peerRecord.lastRxSeq = inner.seq;

    if (this.pendingPeers.get(peerId) === peerRecord) {
      if (inner.type !== 'GROUP_HELLO') {
        peerRecord.socket.destroy();
        return;
      }
      if (this.peers.size >= this.maxPeers) {
        peerRecord.socket.destroy();
        return;
      }

      if (peerRecord.authTimer) {
        clearTimeout(peerRecord.authTimer);
        peerRecord.authTimer = null;
      }
      this.pendingPeers.delete(peerId);
      peerRecord.nickname = sanitizeUntrustedField(inner.nickname || '匿名真人', 32) || '匿名真人';
      peerRecord.verifiedVouches = this._countValidPeerVouches(inner.vouches, peerId);
      peerRecord.locked = true;
      peerRecord.helloVerified = true;
      this.peers.set(peerId, peerRecord);

      this._pushSystemEvent(
        `成员 ${peerRecord.nickname}（ID: ${peerId.slice(0, 12)}，信誉凭证: ${peerRecord.verifiedVouches}）已通过加密握手加入房间。`
      );
      return;
    }

    if (this.peers.get(peerId) === peerRecord && peerRecord.helloVerified) {
      if (inner.type === 'GROUP_HELLO') return;
      this._handleAppPayload(peerId, peerRecord, inner);
    }
  }

  _handleLobbyFrame(peerId, peerRecord, frame) {
    if (this.peers.get(peerId) !== peerRecord) return;

    if (frame.type === 'HELLO') {
      if (peerRecord.helloVerified) return;

      const powCheck = verifyPoW({
        pubkeyHex: peerId,
        expectedScope: `lobby:${this.channel}`,
        proof: frame.powProof,
        minDifficulty: this.powBits,
      });
      if (!powCheck.valid) {
        peerRecord.socket.destroy();
        return;
      }

      const validCount = this._countValidPeerVouches(frame.vouches, peerId);
      if (validCount < this.minVouchesRequired) {
        peerRecord.socket.destroy();
        return;
      }

      peerRecord.nickname = sanitizeUntrustedField(frame.nickname || '匿名真人', 32) || '匿名真人';
      peerRecord.intentCard = sanitizeIntentCard(frame.intentCard);
      peerRecord.verifiedVouches = validCount;
      peerRecord.helloVerified = true;

      if (!this.pendingLockPeer && this.myPubkeyHex < peerId) {
        this._initiate1v1Lock(peerId, peerRecord);
      }
      return;
    }

    if (!peerRecord.helloVerified) {
      peerRecord.socket.destroy();
      return;
    }

    if (frame.type === 'LOCK_REQ') {
      if (!this.pendingLockPeer) {
        this._sendFrame(peerRecord.socket, { type: 'LOCK_ACK' });
        this._finalize1v1Lock(peerId, peerRecord);
        return;
      }

      if (this.pendingLockPeer === peerId && peerId < this.myPubkeyHex) {
        if (this.pendingLockTimer) {
          clearTimeout(this.pendingLockTimer);
          this.pendingLockTimer = null;
        }
        this.pendingLockPeer = null;
        this._sendFrame(peerRecord.socket, { type: 'LOCK_ACK' });
        this._finalize1v1Lock(peerId, peerRecord);
        return;
      }

      if (this.pendingLockPeer !== peerId) {
        this._sendFrame(peerRecord.socket, { type: 'LOCK_NACK', reason: 'busy' });
      }
      return;
    }

    if (frame.type === 'LOCK_ACK' && this.pendingLockPeer === peerId) {
      if (this.pendingLockTimer) {
        clearTimeout(this.pendingLockTimer);
        this.pendingLockTimer = null;
      }
      this.pendingLockPeer = null;
      this._finalize1v1Lock(peerId, peerRecord);
      return;
    }

    if (frame.type === 'LOCK_NACK' && this.pendingLockPeer === peerId) {
      if (this.pendingLockTimer) {
        clearTimeout(this.pendingLockTimer);
        this.pendingLockTimer = null;
      }
      this.pendingLockPeer = null;
      peerRecord.lockRejected = true;
      this._tryLockNextCandidate();
    }
  }

  _initiate1v1Lock(peerId, peerRecord) {
    if (this.mode !== 'MATCHING_1V1' || this.pendingLockPeer || peerRecord.socket.destroyed) return;
    this.pendingLockPeer = peerId;
    this._sendFrame(peerRecord.socket, { type: 'LOCK_REQ' });
    this.pendingLockTimer = setTimeout(() => {
      if (this.mode === 'MATCHING_1V1' && this.pendingLockPeer === peerId) {
        this.pendingLockPeer = null;
        this.pendingLockTimer = null;
        peerRecord.lockRejected = true;
        peerRecord.socket.destroy();
        this._tryLockNextCandidate();
      }
    }, LOCK_TIMEOUT_MS);
    this.pendingLockTimer.unref?.();
  }

  _tryLockNextCandidate() {
    if (this.mode !== 'MATCHING_1V1' || this.pendingLockPeer) return;
    const candidates = Array.from(this.peers.entries()).filter(
      ([, p]) => p.helloVerified && !p.lockRejected && !p.socket.destroyed
    );
    if (candidates.length === 0) return;

    const preferred = candidates.find(([id]) => this.myPubkeyHex < id) || candidates[0];
    this._initiate1v1Lock(preferred[0], preferred[1]);
  }

  _recordPlazaMsgId(msgId) {
    if (!msgId) return true;
    if (this._seenPlazaMsgIds.has(msgId)) return false;
    if (this._seenPlazaMsgIds.size >= 500) {
      const oldest = this._seenPlazaMsgIds.values().next().value;
      this._seenPlazaMsgIds.delete(oldest);
    }
    this._seenPlazaMsgIds.add(msgId);
    return true;
  }

  _handlePlazaBoardPost(event) {
    if (this.mode !== 'PLAZA_ROOM' || !this.plazaBoardKey || !this.plazaName) return;

    let post;
    try {
      const aad = `${PROTOCOL_PREFIX}:plaza-board:${this.plazaName}`;
      post = decryptRelayPacket(this.plazaBoardKey, event.content, aad);
    } catch {
      return;
    }

    if (!post || post.type !== 'PLAZA_POST' || typeof post.senderId !== 'string') return;
    if (post.senderId === this.myPubkeyHex || this.blockedPubkeys.has(post.senderId)) return;
    if (post.msgId && !this._recordPlazaMsgId(post.msgId)) return;

    const powCheck = verifyPoW({
      pubkeyHex: post.senderId,
      expectedScope: `plaza:${this.plazaName}`,
      proof: post.powProof,
      minDifficulty: this.powBits,
      maxAgeMs: 24 * 3600 * 1000,
    });
    if (!powCheck.valid) return;

    const text = String(post.text ?? '');
    if (!text.trim() || text.length > MAX_TEXT_CHARS) return;

    const safeNick = sanitizeUntrustedField(post.nickname || '匿名真人', 32) || '匿名真人';
    const scan = scanIncomingMessage(text);
    const wrapped = wrapUntrustedMessage({
      senderId: post.senderId,
      nickname: safeNick,
      timestamp: post.timestamp || new Date(event.created_at * 1000).toISOString(),
      rawText: text,
      riskLevel: scan.riskLevel,
      flags: scan.flags,
      sanitizedText: scan.sanitizedText,
    });

    this.inbox.push({
      kind: 'peer_message',
      isPlazaHistory: true,
      senderId: post.senderId.slice(0, 12),
      nickname: safeNick,
      riskLevel: scan.riskLevel,
      flags: scan.flags,
      wrappedContent: wrapped,
    });
    this._trimInbox();
    this._notifyWaiters();
  }

  _handleAppPayload(peerId, peerRecord, payload) {
    if (payload.type === 'CHAT') {
      if (this.mode === 'PLAZA_ROOM' && payload.msgId && !this._recordPlazaMsgId(payload.msgId)) {
        return;
      }
      this._ingestChatMessage(peerId, peerRecord, payload.text, payload.timestamp);
      return;
    }

    if (payload.type === 'IMAGE') {
      if (!this._checkRateLimit(peerRecord)) return;
      try {
        const stored = this.imageVault.storeIncoming({
          senderId: peerId,
          nickname: peerRecord.nickname,
          base64Data: payload.base64,
          caption: payload.caption,
        });
        const savedImg = this.imageVault.get(stored.imageId);
        const captionScan = scanIncomingMessage(savedImg.caption || '');
        const wrappedCaption = savedImg.caption
          ? wrapUntrustedMetadata({
              label: 'image_caption',
              senderId: peerId,
              nickname: peerRecord.nickname,
              data: captionScan.sanitizedText,
            })
          : '';

        this.inbox.push({
          kind: 'peer_image_pending',
          senderId: peerId.slice(0, 12),
          nickname: peerRecord.nickname,
          imageId: stored.imageId,
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          captionRiskLevel: captionScan.riskLevel,
          captionFlags: captionScan.flags,
          wrappedCaption,
          metadataWarnings: stored.metadataWarnings,
          instruction:
            '图片已存入内存保险箱且默认折叠。请调用 inspect_image(image_id) 由你自己的多模态视觉能力先审核（检查 NSFW/血腥/二维码/收款码/广告）并向用户文字汇报，切勿直接盲信。',
        });
        this._trimInbox();
        this._notifyWaiters();
      } catch (err) {
        this._pushSystemEvent(`拦截了 ${peerRecord.nickname} 发来的异常图片：${err.message}`);
      }
      return;
    }

    if (payload.type === 'VOUCH') {
      const ok = this.vouchManager.addReceivedVouch(payload.vouch, this.myPubkeyHex, {
        minPowBits: this.vouchPowBits,
      });
      if (ok) {
        const safeTag = sanitizeUntrustedField(payload.vouch?.tag || 'helpful', 32) || 'helpful';
        const validCount = this.vouchManager.getValidVouches({
          minPowBits: this.vouchPowBits,
          expectedSubjectHex: this.myPubkeyHex,
        }).length;
        this._pushSystemEvent(
          `收到来自 ${peerRecord.nickname} 的匿名好人卡（标签: ${safeTag}），当前有效凭证总数：${validCount}。`
        );
        this._saveIdentityStateSafe();
      }
    }
  }

  _finalize1v1Lock(lockedPeerId, lockedPeerRecord) {
    this._stopPoWRefreshTimer();
    this.mode = 'CONNECTED_1V1';
    lockedPeerRecord.locked = true;

    for (const [otherId, otherPeer] of this.peers.entries()) {
      if (otherId !== lockedPeerId) {
        this.peers.delete(otherId);
        try {
          otherPeer.socket.destroy();
        } catch {
          // ignore
        }
      }
    }

    if (this.swarm && this.lobbyTopic) {
      this.swarm.leave(this.lobbyTopic).catch(() => {});
      this.lobbyTopic = null;
    }

    const wrappedCard = wrapUntrustedMetadata({
      label: 'intent_card',
      senderId: lockedPeerId,
      nickname: lockedPeerRecord.nickname,
      data: lockedPeerRecord.intentCard || {},
    });

    this._pushSystemEvent(
      `已成功 1v1 锁定真人：${lockedPeerRecord.nickname}（ID: ${lockedPeerId.slice(0, 12)}，信誉好人卡: ${lockedPeerRecord.verifiedVouches}）。\n对方脱敏名片（已隔离不可信外部数据）：\n${wrappedCard}`
    );
  }

  _checkRateLimit(peerRecord) {
    const now = Date.now();
    peerRecord.msgTimestamps = peerRecord.msgTimestamps.filter((t) => now - t < RATE_WINDOW_MS);
    peerRecord.msgTimestamps.push(now);
    if (peerRecord.msgTimestamps.length > RATE_MAX_MSGS) {
      this._pushSystemEvent(`对端 ${peerRecord.nickname} 触发刷屏限流（3秒超5条），已自动断开。`);
      peerRecord.socket.destroy();
      return false;
    }
    return true;
  }

  _ingestChatMessage(peerId, peerRecord, rawText, timestamp) {
    if (!this._checkRateLimit(peerRecord)) return;

    const text = String(rawText ?? '');
    if (text.length > MAX_TEXT_CHARS) {
      this._pushSystemEvent(`对端 ${peerRecord.nickname} 发送超长消息（超过 ${MAX_TEXT_CHARS} 字），已丢弃。`);
      return;
    }

    const scan = scanIncomingMessage(text);
    const wrapped = wrapUntrustedMessage({
      senderId: peerId,
      nickname: peerRecord.nickname,
      timestamp: timestamp || new Date().toISOString(),
      rawText: text,
      riskLevel: scan.riskLevel,
      flags: scan.flags,
      sanitizedText: scan.sanitizedText,
    });

    this.inbox.push({
      kind: 'peer_message',
      senderId: peerId.slice(0, 12),
      nickname: peerRecord.nickname,
      riskLevel: scan.riskLevel,
      flags: scan.flags,
      wrappedContent: wrapped,
    });
    this._trimInbox();
    this._notifyWaiters();
  }

  _pushSystemEvent(message) {
    this.inbox.push({
      kind: 'system_event',
      timestamp: new Date().toISOString(),
      message,
    });
    this._trimInbox();
    this._notifyWaiters();
  }

  _trimInbox() {
    if (this.inbox.length > MAX_INBOX_EVENTS) {
      this.inbox.splice(0, this.inbox.length - MAX_INBOX_EVENTS);
    }
  }

  _notifyWaiters() {
    const waiters = this.inboxWaiters.splice(0);
    for (const wake of waiters) wake();
  }

  _drainInbox() {
    const events = this.inbox.splice(0);
    const res = {
      status: this.getStatus(),
      events,
    };
    if (this.mode === 'MATCHING_1V1' && events.length === 0 && this.peers.size === 0) {
      res.coldStartSuggestion =
        '当前细分频道暂未遇到同时在线的真人。你可以：① 调用 join_plaza 进入默认热闹的“全局公开广场”（可看 24 小时内大家的加密留言并实时群聊）；② 调用 join_room（无需填码即可自动生成暗号）直接邀请朋友或同事的 AI 跨端加密联机。';
    }
    return res;
  }

  _sendFrame(socket, obj) {
    if (!socket || socket.destroyed) return;
    socket.write(`${JSON.stringify(obj)}\n`);
  }
}
