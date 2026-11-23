import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { P2PMatchManager } from '../src/p2p.js';
import { deriveSecp256k1PrivKey, getPublicKey } from '../src/nostr-crypto.js';

function makeManager(options = {}) {
  const swarmFactory = ({ seed }) => Object.assign(new EventEmitter(), {
    keyPair: { publicKey: crypto.createHash('sha256').update(seed).digest() },
    destroy: async () => {},
  });
  return new P2PMatchManager({ swarmFactory, powBits: 8, ...options });
}

test('blocklist requires a full key and survives restart only with a persistent identity', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'humanwire-block-'));
  const stateFilePath = path.join(folder, 'profile.json');
  const first = makeManager({ stateFilePath });
  const target = 'ab'.repeat(32);
  try {
    await first.ensureSwarm();
    await assert.rejects(first.blockPeer(target.slice(0, 12)), /完整/);
    await assert.rejects(first.blockPeer(first.myPubkeyHex), /自己/);
    assert.deepEqual(await first.blockPeer(target.toUpperCase()), { ok: true, added: true, blockedCount: 1 });
    assert.deepEqual(await first.blockPeer(target), { ok: true, added: false, blockedCount: 1 });
    assert.deepEqual(await first.listBlockedPeers(), { peers: [target], blockedCount: 1 });
    const second = makeManager({ stateFilePath });
    try {
      assert.deepEqual(await second.listBlockedPeers(), { peers: [target], blockedCount: 1 });
      assert.deepEqual(await second.unblockPeer(target), { ok: true, removed: true, blockedCount: 0 });
      assert.deepEqual(await second.unblockPeer(target), { ok: true, removed: false, blockedCount: 0 });
    } finally {
      await second.destroy();
    }
    const third = makeManager({ stateFilePath });
    try {
      assert.equal((await third.listBlockedPeers()).blockedCount, 0);
    } finally {
      await third.destroy();
    }
  } finally {
    await first.destroy();
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('blocking a connected peer ends that session and clearing media keeps its text', async () => {
  const manager = makeManager({ displayOnly: true });
  const peerId = 'cd'.repeat(32);
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    destroy() {
      this.destroyed = true;
      this.emit('close');
    },
  });
  try {
    await manager.ensureSwarm();
    manager.mode = 'CONNECTED_1V1';
    manager.sessionId = 'test-session';
    manager.matchState = 'connected';
    const record = { socket, nickname: '网站同好' };
    manager.peers.set(peerId, record);
    manager._attachSocketLifecycle(peerId, record);
    manager.imageVault.items.set('img1', { imageId: 'img1' });
    manager._pushSystemEvent('聊聊网站设计');
    assert.deepEqual(manager.clearMediaVault(), { ok: true, cleared: 1 });
    assert.equal(manager.imageVault.items.size, 0);
    assert.equal(manager.displayEvents.at(-1).text, '聊聊网站设计');
    await manager.blockPeer(peerId);
    assert.equal(socket.destroyed, true);
    assert.equal(manager.mode, 'IDLE');
    assert.equal(manager.matchState, 'ended');
  } finally {
    await manager.destroy();
  }
});

test('a failed blocklist save leaves the in-memory list unchanged', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'humanwire-block-fail-'));
  const manager = makeManager({ stateFilePath: folder });
  try {
    await assert.rejects(manager.blockPeer('ef'.repeat(32)));
    assert.deepEqual(await manager.listBlockedPeers(), { peers: [], blockedCount: 0 });
  } finally {
    await manager.destroy();
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('parallel blocklist edits serialize and survive restart', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'humanwire-block-parallel-'));
  const stateFilePath = path.join(folder, 'profile.json');
  const manager = makeManager({ stateFilePath });
  const first = '11'.repeat(32);
  const second = '22'.repeat(32);
  const third = '33'.repeat(32);
  try {
    await Promise.all([manager.blockPeer(first), manager.blockPeer(second)]);
    assert.deepEqual((await manager.listBlockedPeers()).peers, [first, second]);
    await Promise.all([manager.unblockPeer(first), manager.blockPeer(third)]);
    assert.deepEqual((await manager.listBlockedPeers()).peers, [second, third]);
    await assert.rejects(manager.blockPeer('short'), /完整/);
    assert.equal((await manager.blockPeer(first)).added, true);
    const reopened = makeManager({ stateFilePath });
    try {
      assert.deepEqual((await reopened.listBlockedPeers()).peers, [first, second, third]);
    } finally {
      await reopened.destroy();
    }
  } finally {
    await manager.destroy();
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('self-block is rejected before the swarm is explicitly initialized', async () => {
  const manager = new P2PMatchManager();
  try {
    await manager.preloadState();
    const ownId = getPublicKey(deriveSecp256k1PrivKey(Buffer.from(manager.swarmSeedHex, 'hex'))).toString('hex');
    assert.equal(manager.swarm, null);
    await assert.rejects(manager.blockPeer(ownId), /自己/);
    assert.equal(manager.swarm, null);
    assert.equal((await manager.listBlockedPeers()).blockedCount, 0);
  } finally {
    await manager.destroy();
  }
});

test('leave with blocking composes with a concurrent blocklist edit', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'humanwire-block-leave-'));
  const manager = makeManager({ stateFilePath: path.join(folder, 'profile.json') });
  const connected = '44'.repeat(32);
  const other = '55'.repeat(32);
  try {
    await manager.ensureSwarm();
    manager.mode = 'CONNECTED_1V1';
    manager.peers.set(connected, { socket: { destroy() {} } });
    await Promise.all([manager.leaveChat({ blockPeer: true }), manager.blockPeer(other)]);
    assert.deepEqual((await manager.listBlockedPeers()).peers, [connected, other]);
    const reopened = makeManager({ stateFilePath: manager.stateFilePath });
    try {
      assert.deepEqual((await reopened.listBlockedPeers()).peers, [connected, other]);
    } finally {
      await reopened.destroy();
    }
  } finally {
    await manager.destroy();
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('offline P2P blocklist management does not initialize optional transport', async () => {
  const manager = new P2PMatchManager({ defaultTransport: 'p2p' });
  try {
    const target = '66'.repeat(32);
    assert.equal((await manager.blockPeer(target)).added, true);
    assert.equal(manager.swarm, null);
    assert.deepEqual((await manager.listBlockedPeers()).peers, [target]);
  } finally {
    await manager.destroy();
  }
});

test('explicit identity reset reports a failed persistent save', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'humanwire-reset-fail-'));
  const manager = makeManager({ stateFilePath: folder });
  try {
    await assert.rejects(manager.resetIdentity());
  } finally {
    await manager.destroy();
    await fs.rm(folder, { recursive: true, force: true });
  }
});
