import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import {
  deriveSecp256k1PrivKey,
  getPublicKey,
  generateEphemeralSecp256k1KeyPair,
  deriveDeadDropRouteTag,
  createSignedEvent,
  verifySignedEvent,
  generateX25519KeyPair,
  deriveRelaySharedKey,
  encryptRelayPacket,
  decryptRelayPacket,
} from './nostr-crypto.js';
import { createProxiedWebSocket, sanitizeProxyDisplay } from './proxy-ws.js';

export const DEFAULT_NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://nostr.bitcoiner.social',
];

export const KIND_PRESENCE = 21771;
export const KIND_DEADDROP = 21774;
export const KIND_PLAZA_POST = 4242;

const CHUNK_RAW_BYTES = 28 * 1024;
const MAX_REASSEMBLY_BYTES = 1.5 * 1024 * 1024;
const MAX_CHUNKS_PER_MSG = 64;
const MAX_INFLIGHT_REASSEMBLY = 16;
const REASSEMBLY_TTL_MS = 30 * 1000;
const MAX_SEEN_EVENT_IDS = 5000;
const MAX_PENDING_OUTBOX_FRAMES = 64;
const MAX_ROUTE_READY_RETRIES = 12;

function getTagValue(tags, key) {
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === key && typeof tag[1] === 'string') {
      return tag[1];
    }
  }
  return null;
}

async function wsPayloadToText(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  if (data && typeof data.text === 'function') {
    return await data.text();
  }
  return String(data ?? '');
}

function attachWsListener(ws, event, handler) {
  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener(event, handler);
  } else if (typeof ws.on === 'function') {
    ws.on(event, (arg) => handler(event === 'message' && !arg?.data ? { data: arg } : arg));
  }
}

class RelayPeerSocket extends Duplex {
  constructor({ swarm, peerPubkeyHex, peerX25519PubB64, topicHex }) {
    super();
    this.swarm = swarm;
    this.peerPubkeyHex = peerPubkeyHex;
    this.peerX25519PubB64 = peerX25519PubB64;
    this.topicHex = topicHex;

    this.sharedKey = deriveRelaySharedKey(swarm.x25519.privateKey, peerX25519PubB64, topicHex);
    this.txRouteTag = deriveDeadDropRouteTag(this.sharedKey, swarm.pubkeyHex, peerPubkeyHex);
    this.rxRouteTag = deriveDeadDropRouteTag(this.sharedKey, peerPubkeyHex, swarm.pubkeyHex);

    this._sendQueue = Promise.resolve();
    this._reassembly = new Map();
    this._closeNotified = false;

    this._peerRouteReady = false;
    this._repliedReadyAck = false;
    this._pendingFrames = [];
    this._routeRetryCount = 0;
    this._routeRetryTimer = null;
  }

  _read() {}

  startRouteHandshake() {
    this._sendRouteReadySignal();
    this._routeRetryTimer = setInterval(() => {
      if (this.destroyed || this.swarm.destroyed || this._peerRouteReady) {
        this._stopRouteHandshakeTimer();
        return;
      }
      this._routeRetryCount += 1;
      if (this._routeRetryCount >= MAX_ROUTE_READY_RETRIES) {
        this._stopRouteHandshakeTimer();
        return;
      }
      this._sendRouteReadySignal();
    }, this.swarm.routeReadyRetryMs);
    this._routeRetryTimer.unref?.();
  }

  _stopRouteHandshakeTimer() {
    if (this._routeRetryTimer) {
      clearInterval(this._routeRetryTimer);
      this._routeRetryTimer = null;
    }
  }

  _sendRouteReadySignal() {
    if (this.destroyed || this.swarm.destroyed) return;
    const aad = `humanwire:deaddrop:v2:${this.txRouteTag}`;
    const encrypted = encryptRelayPacket(this.sharedKey, { _ctrl: 'ROUTE_READY' }, aad, {
      pad: true,
    });
    this.swarm._publishDeadDrop(this.txRouteTag, encrypted);
  }

  _markPeerReadyAndFlush() {
    if (this._peerRouteReady) return;
    this._peerRouteReady = true;
    this._stopRouteHandshakeTimer();

    if (this._pendingFrames.length > 0) {
      const queued = this._pendingFrames.splice(0);
      this._sendQueue = this._sendQueue.then(async () => {
        for (const buf of queued) {
          await this._sendBufferChunked(buf);
        }
      });
    }
  }

  refreshPeerX25519(newX25519PubB64, topicHex) {
    if (newX25519PubB64 && newX25519PubB64 !== this.peerX25519PubB64) {
      const oldRxRouteTag = this.rxRouteTag;
      this.peerX25519PubB64 = newX25519PubB64;
      this.topicHex = topicHex || this.topicHex;
      this.sharedKey = deriveRelaySharedKey(
        this.swarm.x25519.privateKey,
        newX25519PubB64,
        this.topicHex
      );
      this.txRouteTag = deriveDeadDropRouteTag(this.sharedKey, this.swarm.pubkeyHex, this.peerPubkeyHex);
      this.rxRouteTag = deriveDeadDropRouteTag(this.sharedKey, this.peerPubkeyHex, this.swarm.pubkeyHex);

      this.swarm._swapRouteSubscription(oldRxRouteTag, this.rxRouteTag, this);
      this._peerRouteReady = false;
      this._repliedReadyAck = false;
      this._routeRetryCount = 0;
      this._stopRouteHandshakeTimer();
      this.startRouteHandshake();
    }
  }

  _write(chunk, encoding, callback) {
    if (this.destroyed || this.swarm.destroyed) {
      callback();
      return;
    }
    const rawBuf = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, encoding || 'utf8');
    if (rawBuf.length === 0) {
      callback();
      return;
    }

    if (!this._peerRouteReady) {
      if (this._pendingFrames.length >= MAX_PENDING_OUTBOX_FRAMES) {
        callback(new Error('对端匿名死信箱尚未就绪且等待队列已满'));
        return;
      }
      this._pendingFrames.push(rawBuf);
      callback();
      return;
    }

    this._sendQueue = this._sendQueue
      .then(() => this._sendBufferChunked(rawBuf))
      .then(
        () => callback(),
        (err) => callback(err)
      );
  }

  async _sendBufferChunked(rawBuf) {
    if (this.destroyed || this.swarm.destroyed) return;
    const total = Math.max(1, Math.ceil(rawBuf.length / CHUNK_RAW_BYTES));
    const msgId = crypto.randomBytes(6).toString('hex');
    const aad = `humanwire:deaddrop:v2:${this.txRouteTag}`;

    for (let i = 0; i < total; i += 1) {
      if (this.destroyed || this.swarm.destroyed) return;
      const slice = rawBuf.subarray(i * CHUNK_RAW_BYTES, (i + 1) * CHUNK_RAW_BYTES);
      const encrypted = encryptRelayPacket(
        this.sharedKey,
        { m: msgId, i, n: total, b: slice.toString('base64') },
        aad,
        { pad: true }
      );
      this.swarm._publishDeadDrop(this.txRouteTag, encrypted);

      if (total > 1 && i < total - 1 && this.swarm.chunkDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.swarm.chunkDelayMs));
      }
    }
  }

  receiveDeadDropEvent(event) {
    if (this.destroyed) return;

    // 验密优先原则：先校验 AES-256-GCM 认证标签（微秒级），阻断对外部伪造帧执行昂贵 Schnorr 验签的 CPU DoS
    const aad = `humanwire:deaddrop:v2:${this.rxRouteTag}`;
    let packet;
    try {
      packet = decryptRelayPacket(this.sharedKey, event.content, aad);
    } catch {
      return;
    }

    if (!verifySignedEvent(event)) return;
    if (!this.swarm._markEventSeen(event.id)) return;

    if (packet?._ctrl === 'ROUTE_READY') {
      const firstReady = !this._peerRouteReady;
      this._markPeerReadyAndFlush();
      if (firstReady && !this._repliedReadyAck) {
        this._repliedReadyAck = true;
        this._sendRouteReadySignal();
      }
      return;
    }

    if (packet?._ctrl === 'CLOSE') {
      this._closeNotified = true;
      this.destroy();
      return;
    }

    // 收到合法业务帧也意味着对端死信箱早已就绪
    this._markPeerReadyAndFlush();

    if (
      !packet ||
      typeof packet.m !== 'string' ||
      !Number.isInteger(packet.i) ||
      !Number.isInteger(packet.n) ||
      typeof packet.b !== 'string' ||
      packet.n < 1 ||
      packet.n > MAX_CHUNKS_PER_MSG ||
      packet.i < 0 ||
      packet.i >= packet.n
    ) {
      return;
    }

    const chunkBuf = Buffer.from(packet.b, 'base64');
    if (packet.n === 1) {
      this.push(chunkBuf);
      return;
    }

    this._pruneExpiredReassembly();
    let entry = this._reassembly.get(packet.m);
    if (!entry) {
      if (this._reassembly.size >= MAX_INFLIGHT_REASSEMBLY) {
        const oldestKey = this._reassembly.keys().next().value;
        this._reassembly.delete(oldestKey);
      }
      entry = {
        total: packet.n,
        parts: new Array(packet.n).fill(null),
        receivedCount: 0,
        totalBytes: 0,
        createdAt: Date.now(),
      };
      this._reassembly.set(packet.m, entry);
    }

    if (entry.total !== packet.n || entry.parts[packet.i] !== null) return;
    if (entry.totalBytes + chunkBuf.length > MAX_REASSEMBLY_BYTES) {
      this._reassembly.delete(packet.m);
      return;
    }

    entry.parts[packet.i] = chunkBuf;
    entry.receivedCount += 1;
    entry.totalBytes += chunkBuf.length;

    if (entry.receivedCount === entry.total) {
      this._reassembly.delete(packet.m);
      this.push(Buffer.concat(entry.parts));
    }
  }

  _pruneExpiredReassembly() {
    const now = Date.now();
    for (const [id, entry] of this._reassembly.entries()) {
      if (now - entry.createdAt > REASSEMBLY_TTL_MS) {
        this._reassembly.delete(id);
      }
    }
  }

  _destroy(err, callback) {
    this._stopRouteHandshakeTimer();
    this._pendingFrames = [];
    this._reassembly.clear();

    if (!this._closeNotified && !this.swarm.destroyed) {
      this._closeNotified = true;
      try {
        const aad = `humanwire:deaddrop:v2:${this.txRouteTag}`;
        const encryptedClose = encryptRelayPacket(this.sharedKey, { _ctrl: 'CLOSE' }, aad, {
          pad: true,
        });
        this.swarm._publishDeadDrop(this.txRouteTag, encryptedClose);
      } catch {
        // ignore
      }
    }

    this.swarm._removePeerSocket(this.peerPubkeyHex, this);
    callback(err);
  }
}

/**
 * 零依赖 Nostr 多中继匿名死信箱传输引擎（v0.4.1 顶配隐私版）
 * - 通信阶段全程使用一次性假公钥 + 单向 HMAC 派生 routeTag + 固定分桶填充，隐匿社交图谱与消息长度
 * - 支持 HTTP CONNECT（Clash/v2ray）与 SOCKS5H（Tor 远程 DNS 解析）零依赖代理隧道
 */
export class NostrRelaySwarm extends EventEmitter {
  constructor({
    seed,
    relays = DEFAULT_NOSTR_RELAYS,
    proxyUrl = null,
    webSocketFactory = null,
    connectTimeoutMs = 5000,
    presenceIntervalMs = 5000,
    chunkDelayMs = 15,
    routeReadyRetryMs = 250,
  } = {}) {
    super();
    const seedBuf = Buffer.isBuffer(seed) ? seed : crypto.randomBytes(32);
    this._privKey32 = deriveSecp256k1PrivKey(seedBuf);
    const pubBuf = getPublicKey(this._privKey32);
    this.keyPair = { publicKey: pubBuf };
    this.pubkeyHex = pubBuf.toString('hex');
    this.x25519 = generateX25519KeyPair();

    const cleanedRelays = (Array.isArray(relays) && relays.length > 0 ? relays : DEFAULT_NOSTR_RELAYS)
      .map((u) => String(u || '').trim())
      .filter((u) => u.startsWith('ws://') || u.startsWith('wss://'));

    this.relayUrls = cleanedRelays.length > 0 ? cleanedRelays : [...DEFAULT_NOSTR_RELAYS];
    this.proxyUrl = proxyUrl ? String(proxyUrl).trim() : null;
    this.webSocketFactory =
      webSocketFactory ||
      ((url) => {
        if (this.proxyUrl) {
          return createProxiedWebSocket(url, this.proxyUrl, { timeoutMs: connectTimeoutMs });
        }
        if (typeof globalThis.WebSocket !== 'function') {
          throw new Error('当前 Node.js 版本不支持全局 WebSocket，请升级至 Node.js >= 22。');
        }
        return new globalThis.WebSocket(url);
      });

    this.connectTimeoutMs = connectTimeoutMs;
    this.presenceIntervalMs = presenceIntervalMs;
    this.chunkDelayMs = chunkDelayMs;
    this.routeReadyRetryMs = routeReadyRetryMs;

    this.destroyed = false;
    this.relays = new Map();
    this.joinedTopics = new Map(); // topicHex -> { beaconTimer }
    this.peerSockets = new Map(); // peerPubkeyHex -> RelayPeerSocket
    this.routeSockets = new Map(); // rxRouteTag -> RelayPeerSocket
    this.plazaBoards = new Map(); // boardTag -> { sinceSeconds, limit, onPost }
    this.seenEventIds = new Set();
    this._connectWaiters = [];

    for (const url of this.relayUrls) {
      this._connectRelay(url, 0);
    }
  }

  getRelayStatus() {
    const relays = [];
    let connectedRelays = 0;
    for (const [url, rec] of this.relays.entries()) {
      if (rec.state === 'open') connectedRelays += 1;
      relays.push({ url, state: rec.state });
    }
    return {
      connectedRelays,
      totalRelays: this.relayUrls.length,
      proxy: this.proxyUrl ? sanitizeProxyDisplay(this.proxyUrl) : null,
      relays,
    };
  }

  join(topicBuf) {
    if (this.destroyed) {
      return { flushed: async () => {} };
    }
    const topicHex = Buffer.isBuffer(topicBuf) ? topicBuf.toString('hex') : String(topicBuf);

    if (!this.joinedTopics.has(topicHex)) {
      const wasEmpty = this.joinedTopics.size === 0;
      const subId = `hw_t_${topicHex.slice(0, 12)}`;
      const reqTopicMsg = JSON.stringify([
        'REQ',
        subId,
        {
          kinds: [KIND_PRESENCE],
          '#t': [topicHex],
          since: Math.floor(Date.now() / 1000) - 15,
        },
      ]);
      const reqDirectMsg = wasEmpty
        ? JSON.stringify([
            'REQ',
            'hw_direct',
            {
              kinds: [KIND_PRESENCE],
              '#p': [this.pubkeyHex],
              since: Math.floor(Date.now() / 1000) - 15,
            },
          ])
        : null;

      for (const rec of this.relays.values()) {
        if (rec.state === 'open') {
          if (reqDirectMsg) this._safeWsSend(rec.ws, reqDirectMsg);
          this._safeWsSend(rec.ws, reqTopicMsg);
        }
      }

      const broadcastPresence = () => {
        if (this.destroyed || !this.joinedTopics.has(topicHex)) return;
        this._publishPresence({
          tags: [
            ['t', topicHex],
            ['x', this.x25519.publicKeyB64],
          ],
        });
      };

      const beaconTimer = setInterval(broadcastPresence, this.presenceIntervalMs);
      beaconTimer.unref?.();
      this.joinedTopics.set(topicHex, { beaconTimer });

      if (this._hasOpenRelay()) {
        broadcastPresence();
      }
    }

    return {
      flushed: async () => {
        if (this.destroyed || this._hasOpenRelay()) return;
        await this._waitForAnyRelayOpen();
        if (!this.destroyed && this.joinedTopics.has(topicHex)) {
          this._publishPresence({
            tags: [
              ['t', topicHex],
              ['x', this.x25519.publicKeyB64],
            ],
          });
        }
      },
    };
  }

  async leave(topicBuf) {
    const topicHex = Buffer.isBuffer(topicBuf) ? topicBuf.toString('hex') : String(topicBuf);
    const entry = this.joinedTopics.get(topicHex);
    if (!entry) return;

    if (entry.beaconTimer) clearInterval(entry.beaconTimer);
    this.joinedTopics.delete(topicHex);

    const closeTopicMsg = JSON.stringify(['CLOSE', `hw_t_${topicHex.slice(0, 12)}`]);
    const closeDirectMsg =
      this.joinedTopics.size === 0 ? JSON.stringify(['CLOSE', 'hw_direct']) : null;

    for (const rec of this.relays.values()) {
      if (rec.state === 'open') {
        this._safeWsSend(rec.ws, closeTopicMsg);
        if (closeDirectMsg) this._safeWsSend(rec.ws, closeDirectMsg);
      }
    }
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const entry of this.joinedTopics.values()) {
      if (entry.beaconTimer) clearInterval(entry.beaconTimer);
    }
    this.joinedTopics.clear();

    for (const sock of Array.from(this.peerSockets.values())) {
      sock._closeNotified = true;
      sock.destroy();
    }
    this.peerSockets.clear();
    this.routeSockets.clear();
    this.plazaBoards.clear();

    const waiters = this._connectWaiters.splice(0);
    for (const wake of waiters) wake();

    for (const rec of this.relays.values()) {
      if (rec.reconnectTimer) {
        clearTimeout(rec.reconnectTimer);
        rec.reconnectTimer = null;
      }
      rec.state = 'closed';
      try {
        rec.ws?.close();
      } catch {
        // ignore
      }
    }
    this.relays.clear();
  }

  // ================= 内部连接与死信箱路由 =================

  _hasOpenRelay() {
    for (const rec of this.relays.values()) {
      if (rec.state === 'open') return true;
    }
    return false;
  }

  _waitForAnyRelayOpen() {
    if (this._hasOpenRelay() || this.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._connectWaiters = this._connectWaiters.filter((w) => w !== done);
        resolve();
      };
      const timer = setTimeout(done, this.connectTimeoutMs);
      timer.unref?.();
      this._connectWaiters.push(done);
    });
  }

  _connectRelay(url, attempt) {
    if (this.destroyed) return;

    let ws;
    try {
      ws = this.webSocketFactory(url);
    } catch {
      this._scheduleReconnect(url, attempt + 1);
      return;
    }

    const rec = { url, ws, state: 'connecting', reconnectTimer: null, attempt };
    this.relays.set(url, rec);

    attachWsListener(ws, 'open', () => {
      if (this.destroyed || this.relays.get(url) !== rec) {
        try {
          ws.close();
        } catch {
          // ignore
        }
        return;
      }
      rec.state = 'open';
      rec.attempt = 0;

      // 恢复全部匿名死信箱订阅（外层仅包含无含义的 routeTag）
      for (const rxRouteTag of this.routeSockets.keys()) {
        this._sendRouteSub(ws, rxRouteTag);
      }

      // 恢复已订阅的公开广场 24 小时留言板
      for (const [boardTag, cfg] of this.plazaBoards.entries()) {
        this._sendPlazaBoardSub(ws, boardTag, cfg.sinceSeconds, cfg.limit);
      }

      // 仅在仍处于大厅/房间发现期时订阅定向发现信标
      if (this.joinedTopics.size > 0) {
        this._safeWsSend(
          ws,
          JSON.stringify([
            'REQ',
            'hw_direct',
            {
              kinds: [KIND_PRESENCE],
              '#p': [this.pubkeyHex],
              since: Math.floor(Date.now() / 1000) - 15,
            },
          ])
        );

        for (const topicHex of this.joinedTopics.keys()) {
          this._safeWsSend(
            ws,
            JSON.stringify([
              'REQ',
              `hw_t_${topicHex.slice(0, 12)}`,
              {
                kinds: [KIND_PRESENCE],
                '#t': [topicHex],
                since: Math.floor(Date.now() / 1000) - 15,
              },
            ])
          );
          const signed = createSignedEvent({
            privKey32: this._privKey32,
            pubkeyHex: this.pubkeyHex,
            kind: KIND_PRESENCE,
            tags: [
              ['t', topicHex],
              ['x', this.x25519.publicKeyB64],
            ],
            content: '',
          });
          this._safeWsSend(ws, JSON.stringify(['EVENT', signed]));
        }
      }

      const waiters = this._connectWaiters.splice(0);
      for (const wake of waiters) wake();
    });

    attachWsListener(ws, 'message', async (ev) => {
      if (this.destroyed || this.relays.get(url) !== rec) return;
      try {
        const text = await wsPayloadToText(ev?.data ?? ev);
        const msg = JSON.parse(text);
        if (Array.isArray(msg) && msg[0] === 'EVENT' && msg[2]) {
          this._handleIncomingEvent(msg[2]);
        }
      } catch {
        // 忽略非法 JSON 消息
      }
    });

    const handleDisconnect = () => {
      if (this.relays.get(url) !== rec) return;
      if (rec.state === 'closed') return;
      rec.state = 'closed';
      if (!this.destroyed) {
        this._scheduleReconnect(url, rec.attempt + 1);
      }
    };

    attachWsListener(ws, 'close', handleDisconnect);
    attachWsListener(ws, 'error', handleDisconnect);
  }

  _scheduleReconnect(url, attempt) {
    if (this.destroyed) return;
    const prev = this.relays.get(url);
    if (prev?.reconnectTimer) clearTimeout(prev.reconnectTimer);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 4));
    const timer = setTimeout(() => {
      if (!this.destroyed) this._connectRelay(url, attempt);
    }, delay);
    timer.unref?.();
    if (prev) prev.reconnectTimer = timer;
  }

  _safeWsSend(ws, payloadStr) {
    try {
      if (ws && (ws.readyState === undefined || ws.readyState === 1)) {
        ws.send(payloadStr);
      }
    } catch {
      // ignore
    }
  }

  publishPlazaPost({ boardTag, encryptedContent, ttlSeconds = 86400 }) {
    if (this.destroyed || !boardTag) return null;
    const eph = generateEphemeralSecp256k1KeyPair();
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const event = createSignedEvent({
      privKey32: eph.privKey32,
      pubkeyHex: eph.pubkeyHex,
      kind: KIND_PLAZA_POST,
      tags: [
        ['t', boardTag],
        ['expiration', String(exp)],
      ],
      content: encryptedContent,
    });
    // 自己刚发布的留言标记已读，避免经中继广播回放造成重复提示
    this._markEventSeen(event.id);
    const frame = JSON.stringify(['EVENT', event]);
    for (const rec of this.relays.values()) {
      if (rec.state === 'open') {
        this._safeWsSend(rec.ws, frame);
      }
    }
    return event.id;
  }

  subscribePlazaBoard({ boardTag, sinceSeconds = 86400, limit = 15, onPost }) {
    if (this.destroyed || !boardTag || typeof onPost !== 'function') return;
    this.plazaBoards.set(boardTag, { sinceSeconds, limit, onPost });
    for (const rec of this.relays.values()) {
      if (rec.state === 'open') {
        this._sendPlazaBoardSub(rec.ws, boardTag, sinceSeconds, limit);
      }
    }
  }

  unsubscribePlazaBoard(boardTag) {
    if (!boardTag || !this.plazaBoards.has(boardTag)) return;
    this.plazaBoards.delete(boardTag);
    const closeMsg = JSON.stringify(['CLOSE', `hw_pb_${boardTag.slice(0, 12)}`]);
    for (const rec of this.relays.values()) {
      if (rec.state === 'open') {
        this._safeWsSend(rec.ws, closeMsg);
      }
    }
  }

  _sendPlazaBoardSub(ws, boardTag, sinceSeconds, limit) {
    this._safeWsSend(
      ws,
      JSON.stringify([
        'REQ',
        `hw_pb_${boardTag.slice(0, 12)}`,
        {
          kinds: [KIND_PLAZA_POST],
          '#t': [boardTag],
          since: Math.floor(Date.now() / 1000) - sinceSeconds,
          limit,
        },
      ])
    );
  }

  _sendRouteSub(ws, routeTag) {
    this._safeWsSend(
      ws,
      JSON.stringify([
        'REQ',
        `hw_dd_${routeTag.slice(0, 12)}`,
        {
          kinds: [KIND_DEADDROP],
          '#t': [routeTag],
          since: Math.floor(Date.now() / 1000) - 15,
        },
      ])
    );
  }

  _closeRouteSub(ws, routeTag) {
    this._safeWsSend(ws, JSON.stringify(['CLOSE', `hw_dd_${routeTag.slice(0, 12)}`]));
  }

  _swapRouteSubscription(oldRouteTag, newRouteTag, socket) {
    if (oldRouteTag && this.routeSockets.get(oldRouteTag) === socket) {
      this.routeSockets.delete(oldRouteTag);
      for (const rec of this.relays.values()) {
        if (rec.state === 'open') this._closeRouteSub(rec.ws, oldRouteTag);
      }
    }
    this.routeSockets.set(newRouteTag, socket);
    for (const rec of this.relays.values()) {
      if (rec.state === 'open') this._sendRouteSub(rec.ws, newRouteTag);
    }
  }

  _publishPresence({ tags }) {
    if (this.destroyed) return;
    const event = createSignedEvent({
      privKey32: this._privKey32,
      pubkeyHex: this.pubkeyHex,
      kind: KIND_PRESENCE,
      tags,
      content: '',
    });
    const frame = JSON.stringify(['EVENT', event]);
    for (const rec of this.relays.values()) {
      if (rec.state === 'open') {
        this._safeWsSend(rec.ws, frame);
      }
    }
  }

  _publishDeadDrop(routeTag, encryptedContent) {
    if (this.destroyed) return;
    // 每包使用全新随机临时密钥签名，且外层仅保留单向隐匿 routeTag
    const eph = generateEphemeralSecp256k1KeyPair();
    const event = createSignedEvent({
      privKey32: eph.privKey32,
      pubkeyHex: eph.pubkeyHex,
      kind: KIND_DEADDROP,
      tags: [['t', routeTag]],
      content: encryptedContent,
    });
    const frame = JSON.stringify(['EVENT', event]);
    for (const rec of this.relays.values()) {
      if (rec.state === 'open') {
        this._safeWsSend(rec.ws, frame);
      }
    }
  }

  _markEventSeen(eventId) {
    if (this.seenEventIds.has(eventId)) return false;
    if (this.seenEventIds.size >= MAX_SEEN_EVENT_IDS) {
      const oldest = this.seenEventIds.values().next().value;
      this.seenEventIds.delete(oldest);
    }
    this.seenEventIds.add(eventId);
    return true;
  }

  _handleIncomingEvent(event) {
    if (!event || typeof event !== 'object' || typeof event.id !== 'string') return;
    if (this.seenEventIds.has(event.id)) return;

    if (event.kind === KIND_DEADDROP) {
      const routeTag = getTagValue(event.tags, 't');
      if (!routeTag) return;
      const sock = this.routeSockets.get(routeTag);
      if (!sock || sock.destroyed) return;
      // 验密优先（AES-GCM 认证后再验签名与去重），防止伪造包耗尽验签算力
      sock.receiveDeadDropEvent(event);
      return;
    }

    if (event.kind === KIND_PLAZA_POST) {
      const boardTag = getTagValue(event.tags, 't');
      if (!boardTag) return;
      const board = this.plazaBoards.get(boardTag);
      if (!board) return;
      if (!verifySignedEvent(event, { maxSkewSec: board.sinceSeconds + 300 })) return;
      if (!this._markEventSeen(event.id)) return;
      board.onPost(event);
      return;
    }

    if (event.kind === KIND_PRESENCE) {
      if (!verifySignedEvent(event)) return;
      if (event.pubkey === this.pubkeyHex) return;
      if (!this._markEventSeen(event.id)) return;

      const peerPub = event.pubkey;
      const topicHex = getTagValue(event.tags, 't');
      const targetP = getTagValue(event.tags, 'p');
      if (!topicHex || !this.joinedTopics.has(topicHex)) return;
      if (targetP && targetP !== this.pubkeyHex) return;

      const peerX25519 = getTagValue(event.tags, 'x');
      if (!peerX25519) return;

      const { created } = this._ensurePeerSocket(peerPub, peerX25519, topicHex);
      if (!targetP && created) {
        this._publishPresence({
          tags: [
            ['t', topicHex],
            ['x', this.x25519.publicKeyB64],
            ['p', peerPub],
          ],
        });
      }
    }
  }

  _ensurePeerSocket(peerPubkeyHex, peerX25519PubB64, topicHex) {
    const existing = this.peerSockets.get(peerPubkeyHex);
    if (existing && !existing.destroyed) {
      existing.refreshPeerX25519(peerX25519PubB64, topicHex);
      return { socket: existing, created: false };
    }

    let socket;
    try {
      socket = new RelayPeerSocket({
        swarm: this,
        peerPubkeyHex,
        peerX25519PubB64,
        topicHex,
      });
    } catch {
      return { socket: null, created: false };
    }

    this.peerSockets.set(peerPubkeyHex, socket);
    this.routeSockets.set(socket.rxRouteTag, socket);
    for (const rec of this.relays.values()) {
      if (rec.state === 'open') {
        this._sendRouteSub(rec.ws, socket.rxRouteTag);
      }
    }

    this.emit('connection', socket, {
      publicKey: Buffer.from(peerPubkeyHex, 'hex'),
    });
    socket.startRouteHandshake();
    return { socket, created: true };
  }

  _removePeerSocket(peerPubkeyHex, sock) {
    if (this.peerSockets.get(peerPubkeyHex) === sock) {
      this.peerSockets.delete(peerPubkeyHex);
    }
    if (sock?.rxRouteTag && this.routeSockets.get(sock.rxRouteTag) === sock) {
      this.routeSockets.delete(sock.rxRouteTag);
      for (const rec of this.relays.values()) {
        if (rec.state === 'open') {
          this._closeRouteSub(rec.ws, sock.rxRouteTag);
        }
      }
    }
  }
}
