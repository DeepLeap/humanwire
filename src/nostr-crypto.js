import crypto from 'node:crypto';

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
const G_JACOBIAN = [GX, GY, 1n];
const INF_JACOBIAN = [0n, 1n, 0n];

function mod(a, m = P) {
  const res = a % m;
  return res >= 0n ? res : res + m;
}

function modPow(base, exp, m = P) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b, m);
    b = mod(b * b, m);
    e >>= 1n;
  }
  return result;
}

function modInv(a, m = P) {
  let t = 0n;
  let newT = 1n;
  let r = m;
  let newR = mod(a, m);
  if (newR === 0n) {
    throw new Error('模逆元不存在');
  }
  while (newR !== 0n) {
    const q = r / newR;
    [t, newT] = [newT, t - q * newT];
    [r, newR] = [newR, r - q * newR];
  }
  return mod(t, m);
}

function pointDouble([x1, y1, z1]) {
  if (z1 === 0n || y1 === 0n) return INF_JACOBIAN;
  const y1Sq = mod(y1 * y1);
  const s = mod(4n * x1 * y1Sq);
  const m = mod(3n * x1 * x1);
  const x3 = mod(m * m - 2n * s);
  const y1Four = mod(y1Sq * y1Sq);
  const y3 = mod(m * (s - x3) - 8n * y1Four);
  const z3 = mod(2n * y1 * z1);
  return [x3, y3, z3];
}

function pointAdd(p1, p2) {
  const [x1, y1, z1] = p1;
  const [x2, y2, z2] = p2;
  if (z1 === 0n) return p2;
  if (z2 === 0n) return p1;

  const z1Sq = mod(z1 * z1);
  const z2Sq = mod(z2 * z2);
  const u1 = mod(x1 * z2Sq);
  const u2 = mod(x2 * z1Sq);
  const s1 = mod(y1 * z2Sq * z2);
  const s2 = mod(y2 * z1Sq * z1);

  if (u1 === u2) {
    if (s1 !== s2) return INF_JACOBIAN;
    return pointDouble(p1);
  }

  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  const h2 = mod(h * h);
  const h3 = mod(h * h2);
  const u1h2 = mod(u1 * h2);

  const x3 = mod(r * r - h3 - 2n * u1h2);
  const y3 = mod(r * (u1h2 - x3) - s1 * h3);
  const z3 = mod(h * z1 * z2);
  return [x3, y3, z3];
}

function pointMul(k, pt = G_JACOBIAN) {
  let r = INF_JACOBIAN;
  let addend = pt;
  let scalar = k;
  while (scalar > 0n) {
    if (scalar & 1n) r = pointAdd(r, addend);
    addend = pointDouble(addend);
    scalar >>= 1n;
  }
  return r;
}

function toAffine([x, y, z]) {
  if (z === 0n) return null;
  const zInv = modInv(z, P);
  const zInv2 = mod(zInv * zInv);
  return {
    x: mod(x * zInv2),
    y: mod(y * zInv2 * zInv),
  };
}

function liftX(x) {
  if (x < 0n || x >= P) return null;
  const c = mod(x * x * x + 7n);
  const y = modPow(c, (P + 1n) / 4n, P);
  if (mod(y * y) !== c) return null;
  const evenY = (y & 1n) === 0n ? y : P - y;
  return [x, evenY, 1n];
}

function bytesToBigInt(buf) {
  return BigInt(`0x${buf.toString('hex')}`);
}

function bigIntToBytes32(num) {
  return Buffer.from(num.toString(16).padStart(64, '0'), 'hex');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function taggedHash(tag, ...buffers) {
  const tagHash = sha256(Buffer.from(tag, 'utf8'));
  return sha256(Buffer.concat([tagHash, tagHash, ...buffers]));
}

/**
 * 从 32 字节身份种子确定性派生 secp256k1 私钥（用于 Nostr 事件签名）
 */
export function deriveSecp256k1PrivKey(seedBuf) {
  for (let counter = 0; counter < 256; counter += 1) {
    const suffix = counter === 0 ? Buffer.alloc(0) : Buffer.from([counter]);
    const candidate = sha256(
      Buffer.concat([Buffer.from('humanwire:nostr-priv:', 'utf8'), seedBuf, suffix])
    );
    const d = bytesToBigInt(candidate);
    if (d >= 1n && d < N) return candidate;
  }
  throw new Error('无法从种子派生合法的 secp256k1 私钥');
}

/**
 * 生成用于单包匿名死信箱签名的随机 secp256k1 临时密钥对
 */
export function generateEphemeralSecp256k1KeyPair() {
  while (true) {
    const privKey32 = crypto.randomBytes(32);
    const d = bytesToBigInt(privKey32);
    if (d >= 1n && d < N) {
      const pubkeyHex = getPublicKey(privKey32).toString('hex');
      return { privKey32, pubkeyHex };
    }
  }
}

/**
 * 派生单向隐匿死信箱路由标签（防中继关联双端通信图谱）
 */
export function deriveDeadDropRouteTag(sharedKey, senderPubHex, receiverPubHex) {
  return crypto
    .createHmac('sha256', sharedKey)
    .update(`humanwire:route:v2:${senderPubHex}->${receiverPubHex}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/**
 * 计算 BIP-340 32 字节 x-only 公钥
 */
export function getPublicKey(privKey32) {
  const buf = Buffer.isBuffer(privKey32) ? privKey32 : Buffer.from(privKey32, 'hex');
  if (buf.length !== 32) throw new Error('私钥必须为 32 字节');
  const d = bytesToBigInt(buf);
  if (d < 1n || d >= N) throw new Error('私钥超出有效标量范围');
  const pt = toAffine(pointMul(d));
  return bigIntToBytes32(pt.x);
}

/**
 * BIP-340 Schnorr 签名（零外部依赖纯原生 BigInt 实现）
 */
export function signSchnorr(msg32, privKey32, auxRand32 = crypto.randomBytes(32)) {
  const msg = Buffer.isBuffer(msg32) ? msg32 : Buffer.from(msg32, 'hex');
  const priv = Buffer.isBuffer(privKey32) ? privKey32 : Buffer.from(privKey32, 'hex');
  const aux = Buffer.isBuffer(auxRand32) ? auxRand32 : Buffer.from(auxRand32, 'hex');

  if (msg.length !== 32) throw new Error('待签名消息必须为 32 字节');
  if (priv.length !== 32) throw new Error('私钥必须为 32 字节');
  if (aux.length !== 32) throw new Error('auxRand32 必须为 32 字节');

  const d0 = bytesToBigInt(priv);
  if (d0 < 1n || d0 >= N) throw new Error('私钥超出有效范围');

  const pAffine = toAffine(pointMul(d0));
  const d = (pAffine.y & 1n) === 0n ? d0 : N - d0;
  const pBytes = bigIntToBytes32(pAffine.x);

  const t = d ^ bytesToBigInt(taggedHash('BIP0340/aux', aux));
  const rand = taggedHash('BIP0340/nonce', bigIntToBytes32(t), pBytes, msg);
  const k0 = bytesToBigInt(rand) % N;
  if (k0 === 0n) throw new Error('生成了全零随机数 k0');

  const rAffine = toAffine(pointMul(k0));
  const k = (rAffine.y & 1n) === 0n ? k0 : N - k0;
  const rBytes = bigIntToBytes32(rAffine.x);

  const e = bytesToBigInt(taggedHash('BIP0340/challenge', rBytes, pBytes, msg)) % N;
  const s = (k + e * d) % N;

  return Buffer.concat([rBytes, bigIntToBytes32(s)]);
}

/**
 * BIP-340 Schnorr 验签
 */
export function verifySchnorr(sig64, msg32, pubKey32) {
  try {
    const sig = Buffer.isBuffer(sig64) ? sig64 : Buffer.from(sig64, 'hex');
    const msg = Buffer.isBuffer(msg32) ? msg32 : Buffer.from(msg32, 'hex');
    const pub = Buffer.isBuffer(pubKey32) ? pubKey32 : Buffer.from(pubKey32, 'hex');
    if (sig.length !== 64 || msg.length !== 32 || pub.length !== 32) return false;

    const pJac = liftX(bytesToBigInt(pub));
    if (!pJac) return false;

    const r = bytesToBigInt(sig.subarray(0, 32));
    const s = bytesToBigInt(sig.subarray(32, 64));
    if (r >= P || s >= N) return false;

    const e = bytesToBigInt(taggedHash('BIP0340/challenge', sig.subarray(0, 32), pub, msg)) % N;
    const negE = mod(N - e, N);
    const rJac = pointAdd(pointMul(s, G_JACOBIAN), pointMul(negE, pJac));
    const rAff = toAffine(rJac);
    if (!rAff || (rAff.y & 1n) !== 0n || rAff.x !== r) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Nostr NIP-01 事件 ID 摘要计算
 */
export function computeEventId(event) {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return sha256(Buffer.from(serialized, 'utf8')).toString('hex');
}

/**
 * 生成已签名的 Nostr NIP-01 事件
 */
export function createSignedEvent({
  privKey32,
  pubkeyHex,
  kind,
  tags = [],
  content = '',
  createdAt = Math.floor(Date.now() / 1000),
}) {
  const pub = pubkeyHex || getPublicKey(privKey32).toString('hex');
  const event = {
    pubkey: pub,
    created_at: createdAt,
    kind,
    tags,
    content,
  };
  const id = computeEventId(event);
  const sig = signSchnorr(Buffer.from(id, 'hex'), privKey32).toString('hex');
  return { id, ...event, sig };
}

/**
 * 校验收到的 Nostr NIP-01 事件格式、时间窗口、ID 与 BIP-340 签名
 */
export function verifySignedEvent(
  event,
  { maxSkewSec = 120, nowSec = Math.floor(Date.now() / 1000) } = {}
) {
  if (!event || typeof event !== 'object') return false;
  if (typeof event.id !== 'string' || !/^[0-9a-f]{64}$/.test(event.id)) return false;
  if (typeof event.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(event.pubkey)) return false;
  if (typeof event.sig !== 'string' || !/^[0-9a-f]{128}$/.test(event.sig)) return false;
  if (!Number.isInteger(event.kind) || !Number.isInteger(event.created_at)) return false;
  if (typeof event.content !== 'string' || !Array.isArray(event.tags)) return false;
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || !tag.every((item) => typeof item === 'string')) return false;
  }
  if (maxSkewSec !== null && Math.abs(nowSec - event.created_at) > maxSkewSec) return false;

  if (computeEventId(event) !== event.id) return false;
  return verifySchnorr(
    Buffer.from(event.sig, 'hex'),
    Buffer.from(event.id, 'hex'),
    Buffer.from(event.pubkey, 'hex')
  );
}

/**
 * 生成临时 X25519 密钥对（用于 Relay 模式端到端前向保密）
 */
export function generateX25519KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { privateKey, publicKeyB64 };
}

/**
 * 基于 X25519 ECDH + HKDF-SHA256 派生 Relay 会话级 AES-256-GCM 密钥
 */
export function deriveRelaySharedKey(myX25519PrivKey, peerX25519PubB64, topicHex = '') {
  const peerPubKey = crypto.createPublicKey({
    key: Buffer.from(peerX25519PubB64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  if (peerPubKey.asymmetricKeyType !== 'x25519') {
    throw new Error('对端密钥不是有效的 X25519 公钥');
  }
  const sharedSecret = crypto.diffieHellman({
    privateKey: myX25519PrivKey,
    publicKey: peerPubKey,
  });
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      sharedSecret,
      Buffer.from(String(topicHex || ''), 'utf8'),
      Buffer.from('humanwire:relay:e2e:v1', 'utf8'),
      32
    )
  );
}

const PADDING_BUCKETS = [512, 1024, 2048, 4096, 8192, 16384, 32768, 40960];

function pickBucketSize(neededBytes) {
  for (const bucket of PADDING_BUCKETS) {
    if (neededBytes <= bucket) return bucket;
  }
  return Math.ceil(neededBytes / 4096) * 4096;
}

export function encryptRelayPacket(key, obj, aadStr, { pad = true } = {}) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aadStr) {
    cipher.setAAD(Buffer.from(aadStr, 'utf8'));
  }

  const jsonBuf = Buffer.from(JSON.stringify(obj), 'utf8');
  let plaintext = jsonBuf;
  let version = 1;

  if (pad) {
    version = 2;
    const needed = 4 + jsonBuf.length;
    const targetSize = pickBucketSize(needed);
    plaintext = Buffer.allocUnsafe(targetSize);
    plaintext.writeUInt32BE(jsonBuf.length, 0);
    jsonBuf.copy(plaintext, 4);
    if (targetSize > needed) {
      crypto.randomBytes(targetSize - needed).copy(plaintext, needed);
    }
  }

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: version,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64'),
  });
}

export function decryptRelayPacket(key, payloadStr, aadStr) {
  const parsed = JSON.parse(payloadStr);
  if (
    !parsed ||
    (parsed.v !== 1 && parsed.v !== 2) ||
    typeof parsed.iv !== 'string' ||
    typeof parsed.tag !== 'string' ||
    typeof parsed.data !== 'string'
  ) {
    throw new Error('Relay 密文封包格式无效');
  }
  const iv = Buffer.from(parsed.iv, 'base64');
  const tag = Buffer.from(parsed.tag, 'base64');
  const data = Buffer.from(parsed.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aadStr) {
    decipher.setAAD(Buffer.from(aadStr, 'utf8'));
  }
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);

  if (parsed.v === 1) {
    return JSON.parse(plaintext.toString('utf8'));
  }

  if (plaintext.length < 4) {
    throw new Error('填充密文长度非法');
  }
  const jsonLen = plaintext.readUInt32BE(0);
  if (4 + jsonLen > plaintext.length) {
    throw new Error('填充密文声明长度越界');
  }
  return JSON.parse(plaintext.subarray(4, 4 + jsonLen).toString('utf8'));
}
