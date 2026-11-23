#!/usr/bin/env node
import { startChatWindow } from './chat-window.js';
import { P2PMatchManager } from './p2p.js';

const relays = process.env.HUMANWIRE_RELAYS?.split(',').map((entry) => entry.trim()).filter(Boolean);
const proxyUrl = process.env.HUMANWIRE_PROXY || process.env.ALL_PROXY ||
  process.env.HTTPS_PROXY || process.env.https_proxy;
const manager = new P2PMatchManager({ displayOnly: true, relays, proxyUrl });
const window = await startChatWindow({ manager });
console.log(`在浏览器打开 HumanWire：\n${window.url}\n关闭服务：Ctrl+C`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await window.close();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
