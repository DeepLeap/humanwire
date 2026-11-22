import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 读取本地匿名身份档案（swarmSeedHex、好人卡密钥与收到的凭证、黑名单）
 * 不含任何真实个人信息；文件缺失或损坏时安全返回 null。
 */
export async function loadIdentityState(filePath) {
  if (!filePath) return null;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.swarmSeedHex !== 'string' || !/^[0-9a-f]{64}$/i.test(parsed.swarmSeedHex)) {
      return null;
    }
    return {
      version: parsed.version || 1,
      swarmSeedHex: parsed.swarmSeedHex.toLowerCase(),
      vouchState: parsed.vouchState && typeof parsed.vouchState === 'object' ? parsed.vouchState : null,
      blockedPubkeys: Array.isArray(parsed.blockedPubkeys)
        ? parsed.blockedPubkeys.filter((id) => typeof id === 'string')
        : [],
    };
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    return null;
  }
}

/**
 * 原子保存本地匿名身份档案（尽量收紧权限为 0o600，兼容 Windows 文件系统）
 */
export async function saveIdentityState(filePath, state) {
  if (!filePath || !state) return;
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const payload = JSON.stringify(
    {
      version: 1,
      swarmSeedHex: state.swarmSeedHex,
      vouchState: state.vouchState || null,
      blockedPubkeys: Array.isArray(state.blockedPubkeys) ? state.blockedPubkeys : [],
      updatedAt: new Date().toISOString(),
    },
    null,
    2
  );

  await fs.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmpPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => {});
}

/**
 * 删除本地匿名身份档案，用于一键重置身份
 */
export async function deleteIdentityState(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}
