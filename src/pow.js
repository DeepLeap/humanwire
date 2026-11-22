import crypto from 'node:crypto';

export const DEFAULT_DIFFICULTY = 16; // 16 bit 前导零（普通设备约 50-300ms，批量广告脚本成本剧增）
export const MAX_PROOF_AGE_MS = 5 * 60 * 1000; // 凭证 5 分钟有效，防止离线预挖复用
export const PROOF_REFRESH_THRESHOLD_MS = 4 * 60 * 1000; // 超过 4 分钟即提前自动续期

export function countLeadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
    } else {
      bits += Math.clz32(byte) - 24;
      break;
    }
  }
  return bits;
}

function computePoWDigest(pubkeyHex, scope, timestamp, nonce) {
  const input = `${pubkeyHex}:${scope}:${timestamp}:${nonce}`;
  return crypto.createHash('sha256').update(input, 'utf8').digest();
}

/**
 * 同步计算微型工作量证明（Hashcash PoW），适用于单测或极低难度场景。
 * 绑定发送方公钥、目标作用域与时间戳，无法被其他节点盗用。
 */
export function solvePoW({ pubkeyHex, scope, difficulty = DEFAULT_DIFFICULTY, timestamp = Date.now() }) {
  const normalizedDifficulty = Math.max(0, Math.min(256, Math.floor(difficulty)));
  let nonce = 0;
  while (true) {
    const digest = computePoWDigest(pubkeyHex, scope, timestamp, nonce);
    if (countLeadingZeroBits(digest) >= normalizedDifficulty) {
      return {
        scope,
        timestamp,
        difficulty: normalizedDifficulty,
        nonce,
        hash: digest.toString('hex'),
      };
    }
    nonce += 1;
  }
}

/**
 * 异步分片计算 Hashcash PoW，定期让出事件循环，避免阻塞 MCP stdio 服务响应。
 */
export async function solvePoWAsync({
  pubkeyHex,
  scope,
  difficulty = DEFAULT_DIFFICULTY,
  timestamp = Date.now(),
  chunkSize = 4096,
  signal,
}) {
  const normalizedDifficulty = Math.max(0, Math.min(256, Math.floor(difficulty)));
  const safeChunkSize = Math.max(256, Math.floor(chunkSize));
  let nonce = 0;

  while (true) {
    if (signal?.aborted) {
      const err = new Error('PoW 计算已取消');
      err.name = 'AbortError';
      throw err;
    }

    const end = nonce + safeChunkSize;
    for (; nonce < end; nonce += 1) {
      const digest = computePoWDigest(pubkeyHex, scope, timestamp, nonce);
      if (countLeadingZeroBits(digest) >= normalizedDifficulty) {
        return {
          scope,
          timestamp,
          difficulty: normalizedDifficulty,
          nonce,
          hash: digest.toString('hex'),
        };
      }
    }

    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * 判断大厅 PoW 是否接近过期，用于长时等待自动续期。
 */
export function isPoWExpiringSoon(proof, now = Date.now(), thresholdMs = PROOF_REFRESH_THRESHOLD_MS) {
  if (!proof || typeof proof.timestamp !== 'number' || !Number.isFinite(proof.timestamp)) {
    return true;
  }
  return Math.abs(now - proof.timestamp) >= thresholdMs;
}

/**
 * 校验对端提交的微型 PoW 凭证。
 * 当 maxAgeMs 为 null 时仅校验时间戳合法性而不检查过期（适用于长期有效的好人卡 PoW）。
 */
export function verifyPoW({
  pubkeyHex,
  expectedScope,
  proof,
  minDifficulty = DEFAULT_DIFFICULTY,
  now = Date.now(),
  maxAgeMs = MAX_PROOF_AGE_MS,
}) {
  if (!pubkeyHex || typeof pubkeyHex !== 'string') {
    return { valid: false, reason: '缺少节点公钥' };
  }
  if (!proof || typeof proof !== 'object') {
    return { valid: false, reason: '缺少工作量证明（PoW）' };
  }
  if (proof.scope !== expectedScope) {
    return { valid: false, reason: 'PoW 作用域与当前频道不匹配' };
  }
  if (typeof proof.timestamp !== 'number' || !Number.isFinite(proof.timestamp)) {
    return { valid: false, reason: 'PoW 时间戳格式无效' };
  }
  if (maxAgeMs !== null && maxAgeMs !== undefined && Math.abs(now - proof.timestamp) > maxAgeMs) {
    return { valid: false, reason: 'PoW 已过期或时间戳异常' };
  }
  if (typeof proof.difficulty !== 'number' || proof.difficulty < minDifficulty) {
    return { valid: false, reason: `PoW 难度不足（需要 >= ${minDifficulty} bits）` };
  }
  if (typeof proof.nonce !== 'number' || !Number.isInteger(proof.nonce) || proof.nonce < 0) {
    return { valid: false, reason: 'PoW nonce 格式无效' };
  }

  const digest = computePoWDigest(pubkeyHex, proof.scope, proof.timestamp, proof.nonce);
  if (countLeadingZeroBits(digest) < minDifficulty) {
    return { valid: false, reason: 'PoW 哈希校验未通过' };
  }
  if (typeof proof.hash === 'string' && proof.hash !== digest.toString('hex')) {
    return { valid: false, reason: 'PoW 哈希摘要不一致' };
  }
  return { valid: true };
}
