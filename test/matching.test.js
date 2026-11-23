import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { P2PMatchManager } from '../src/p2p.js';

function makeManager(options = {}) {
  const swarmFactory = ({ seed }) => Object.assign(new EventEmitter(), {
    keyPair: { publicKey: crypto.createHash('sha256').update(seed).digest() },
    join: () => ({ flushed: async () => {} }),
    leave: async () => {},
    destroy: async () => {},
  });
  return new P2PMatchManager({ swarmFactory, powBits: 8, displayOnly: true, ...options });
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待匹配状态超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('matching timeout, retry, and leaving preserve or clear the right display session', async () => {
  const manager = makeManager({ matchTimeoutMs: 20 });
  try {
    const first = await manager.startMatching({ keywords: 'personal websites', nickname: '北岚' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(manager.getStatus().matching.state, 'timed_out');
    assert.equal(manager.getStatus().mode, 'IDLE');
    const expired = await manager.readDisplayMessages({ sessionId: first.sessionId });
    assert.match(expired.events.at(-1).text, /暂未找到/);
    const next = await manager.retryMatching();
    assert.notEqual(next.sessionId, first.sessionId);
    assert.equal(manager.getStatus().matching.state, 'waiting');
    const replay = await manager.readDisplayMessages({ sessionId: first.sessionId, after: expired.cursor });
    assert.equal(replay.reset, true);
    assert.deepEqual(replay.events, []);
    await manager.leaveChat();
    assert.equal(manager.getStatus().matching, null);
    await assert.rejects(manager.retryMatching(), /没有可以重新匹配/);
  } finally {
    await manager.destroy();
  }
});

test('display replay is bounded and independent from legacy inbox', async () => {
  const manager = makeManager();
  try {
    const { sessionId } = await manager.startMatching({ keywords: 'frontend' });
    manager._pushSystemEvent('已连接');
    const first = await manager.readDisplayMessages({ sessionId, after: 0 });
    const second = await manager.readDisplayMessages({ sessionId, after: 0 });
    assert.deepEqual(first.events, second.events);
    assert.equal(first.events.at(-1).type, 'state');
    assert.equal((await manager.pollMessages(0)).events.at(-1).message, '已连接');
    assert.deepEqual((await manager.readDisplayMessages({ sessionId, after: first.cursor })).events, []);
    for (let index = 0; index < 205; index += 1) manager._pushSystemEvent(`消息 ${index}`);
    const bounded = await manager.readDisplayMessages({ sessionId, after: 0 });
    assert.equal(bounded.events.length, 200);
    assert.equal(bounded.events.at(-1).text, '消息 204');
    assert.equal((await manager.readDisplayMessages({ sessionId, after: first.cursor })).reset, true);
    assert.equal((await manager.readDisplayMessages({ sessionId, after: bounded.cursor + 1 })).reset, true);

    const pending = manager.readDisplayMessages({ sessionId, after: bounded.cursor, waitSeconds: 10 });
    await waitFor(() => manager.inboxWaiters.length === 1);
    await manager.leaveChat();
    const switched = await pending;
    assert.equal(switched.reset, true);
    assert.deepEqual(switched.events, []);
    assert.equal(manager.inboxWaiters.length, 0);
  } finally {
    await manager.destroy();
  }
});

test('aborted display wait releases its waiter', async () => {
  const manager = makeManager();
  try {
    const { sessionId } = await manager.startMatching({ keywords: 'css' });
    const controller = new AbortController();
    const pending = manager.readDisplayMessages({ sessionId, after: 0, waitSeconds: 10, signal: controller.signal });
    await waitFor(() => manager.inboxWaiters.length === 1);
    controller.abort();
    assert.deepEqual((await pending).events, []);
    assert.equal(manager.inboxWaiters.length, 0);
  } finally {
    await manager.destroy();
  }
});

function deferredDiscovery() {
  let resolveFlush;
  let joined = false;
  const flushed = new Promise((resolve) => { resolveFlush = resolve; });
  const swarmFactory = ({ seed }) => Object.assign(new EventEmitter(), {
    keyPair: { publicKey: crypto.createHash('sha256').update(seed).digest() },
    join() {
      joined = true;
      return { flushed: () => flushed };
    },
    leave: async () => {},
    destroy: async () => {},
  });
  return { swarmFactory, resolveFlush: () => resolveFlush(), isJoined: () => joined };
}

test('cancelling during discovery cannot restart a stale match', async () => {
  const discovery = deferredDiscovery();
  const manager = makeManager({ swarmFactory: discovery.swarmFactory });
  try {
    const pending = manager.startMatching({ keywords: 'frontend' });
    await waitFor(discovery.isJoined);
    await manager.leaveChat();
    discovery.resolveFlush();
    await assert.rejects(pending, /匹配已取消/);
    assert.equal(manager.getStatus().mode, 'IDLE');
    assert.equal(manager.matchTimer, null);
  } finally {
    await manager.destroy();
  }
});

test('a match locked during discovery is returned as connected', async () => {
  const discovery = deferredDiscovery();
  const manager = makeManager({ swarmFactory: discovery.swarmFactory });
  try {
    const pending = manager.startMatching({ keywords: 'frontend' });
    await waitFor(discovery.isJoined);
    manager.mode = 'CONNECTED_1V1';
    manager.matchState = 'connected';
    discovery.resolveFlush();
    const result = await pending;
    assert.equal(result.mode, 'CONNECTED_1V1');
    assert.equal(manager.matchTimer, null);
  } finally {
    await manager.destroy();
  }
});
