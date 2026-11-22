import crypto from 'node:crypto';
import { solvePoWAsync, verifyPoW } from './pow.js';
import { sanitizeUntrustedField } from './safety.js';

export const DEFAULT_VOUCH_POW_BITS = 16;
export const MAX_STORED_VOUCHES = 50;

function canonicalVouchString({ version, issuer, issuerPeerId, subject, tag, issuedAt }) {
  return JSON.stringify({ version, issuer, issuerPeerId, subject, tag, issuedAt });
}

/**
 * 去中心化“匿名好人卡”信誉模块（纯 Node.js 原生 Ed25519 + 抗女巫 PoW，零外部依赖）
 * - 支持密钥与已收凭证持久化导出/恢复
 * - 绑定签发方 nodeId 并强制附加 PoW，防止本地伪造密钥批量刷票与自签
 */
export class VouchManager {
  constructor({
    privateKeyPem,
    publicKeyDerB64,
    receivedVouches,
    vouchPowBits = DEFAULT_VOUCH_POW_BITS,
  } = {}) {
    this.vouchPowBits = vouchPowBits;

    if (privateKeyPem) {
      this.privateKey = crypto.createPrivateKey(privateKeyPem);
      this.publicKey = crypto.createPublicKey(this.privateKey);
      const derivedDerB64 = this.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
      if (publicKeyDerB64 && publicKeyDerB64 !== derivedDerB64) {
        throw new Error('好人卡密钥与公钥指纹不匹配');
      }
      this.publicKeyDerB64 = derivedDerB64;
    } else {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      this.publicKey = publicKey;
      this.privateKey = privateKey;
      this.publicKeyDerB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    }

    this.receivedVouches = Array.isArray(receivedVouches)
      ? receivedVouches.slice(0, MAX_STORED_VOUCHES)
      : [];
  }

  exportState() {
    return {
      privateKeyPem: this.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      publicKeyDerB64: this.publicKeyDerB64,
      receivedVouches: [...this.receivedVouches],
    };
  }

  /**
   * 为对端签发一张绑定节点身份与抗女巫 PoW 的匿名好人卡（v2）
   */
  async issueVouch({
    issuerPeerId,
    subjectPubkeyHex,
    tag = 'helpful',
    powBits = this.vouchPowBits,
  }) {
    if (!issuerPeerId || typeof issuerPeerId !== 'string' || issuerPeerId.length < 8) {
      throw new Error('缺少有效的签发者节点 ID');
    }
    if (!subjectPubkeyHex || typeof subjectPubkeyHex !== 'string' || subjectPubkeyHex.length < 8) {
      throw new Error('缺少有效的接收方公钥');
    }
    if (issuerPeerId === subjectPubkeyHex) {
      throw new Error('禁止给自己签发好人卡');
    }

    const cleanTag = sanitizeUntrustedField(tag || 'helpful', 32) || 'helpful';
    const payload = {
      version: 2,
      issuer: this.publicKeyDerB64,
      issuerPeerId,
      subject: subjectPubkeyHex,
      tag: cleanTag,
      issuedAt: new Date().toISOString(),
    };

    const canonical = canonicalVouchString(payload);
    const signature = crypto
      .sign(null, Buffer.from(canonical, 'utf8'), this.privateKey)
      .toString('base64');

    const pow = await solvePoWAsync({
      pubkeyHex: this.publicKeyDerB64,
      scope: `vouch:${subjectPubkeyHex}`,
      difficulty: powBits,
    });

    return { ...payload, signature, pow };
  }

  /**
   * 校验一张好人卡（v2）的格式、防自签、抗女巫 PoW 与 Ed25519 签名
   */
  static verifyVouch(vouch, expectedSubjectHex, { minPowBits = DEFAULT_VOUCH_POW_BITS } = {}) {
    if (!vouch || typeof vouch !== 'object' || vouch.version !== 2) return false;
    if (!vouch.issuer || typeof vouch.issuer !== 'string') return false;
    if (!vouch.subject || typeof vouch.subject !== 'string') return false;
    if (expectedSubjectHex && vouch.subject !== expectedSubjectHex) return false;
    if (typeof vouch.issuerPeerId !== 'string' || vouch.issuerPeerId.length < 8) return false;
    if (vouch.issuerPeerId === vouch.subject) return false;
    if (typeof vouch.tag !== 'string' || !vouch.issuedAt || typeof vouch.issuedAt !== 'string') {
      return false;
    }
    if (!vouch.signature || typeof vouch.signature !== 'string') return false;

    const powCheck = verifyPoW({
      pubkeyHex: vouch.issuer,
      expectedScope: `vouch:${vouch.subject}`,
      proof: vouch.pow,
      minDifficulty: minPowBits,
      maxAgeMs: null, // 凭证持续有效，但必须绑定签名方与接收方完成抗女巫 PoW
    });
    if (!powCheck.valid) return false;

    try {
      const pubKey = crypto.createPublicKey({
        key: Buffer.from(vouch.issuer, 'base64'),
        format: 'der',
        type: 'spki',
      });
      const canonical = canonicalVouchString({
        version: 2,
        issuer: vouch.issuer,
        issuerPeerId: vouch.issuerPeerId,
        subject: vouch.subject,
        tag: vouch.tag,
        issuedAt: vouch.issuedAt,
      });
      return crypto.verify(
        null,
        Buffer.from(canonical, 'utf8'),
        pubKey,
        Buffer.from(vouch.signature, 'base64')
      );
    } catch {
      return false;
    }
  }

  addReceivedVouch(vouch, mySubjectHex, options = {}) {
    if (!VouchManager.verifyVouch(vouch, mySubjectHex, options)) return false;
    if (this.receivedVouches.length >= MAX_STORED_VOUCHES) return false;

    // 按签发公钥与节点 ID 双重去重，防止同一节点换密钥重复刷票
    const duplicated = this.receivedVouches.some(
      (v) => v.issuer === vouch.issuer || v.issuerPeerId === vouch.issuerPeerId
    );
    if (duplicated) return false;

    this.receivedVouches.push(vouch);
    return true;
  }

  getValidVouches({ minPowBits = DEFAULT_VOUCH_POW_BITS, expectedSubjectHex = null } = {}) {
    return this.receivedVouches.filter((v) =>
      VouchManager.verifyVouch(v, expectedSubjectHex, { minPowBits })
    );
  }
}
