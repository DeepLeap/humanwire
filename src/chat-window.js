import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { detectOutboundSecretLeak } from './safety.js';

const LOCAL_HOST = '127.0.0.1';
const MAX_REQUEST_BYTES = 8192;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new RequestError(415, '请求需要使用 JSON。');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new RequestError(413, '请求内容过长。');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // Return the same validation response for any malformed input.
  }
  throw new RequestError(400, '请求格式有误。');
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function visibleStatus(status) {
  const peer = status.connectedPeers?.[0];
  return {
    sessionId: status.sessionId,
    mode: status.mode,
    connected: status.mode === 'CONNECTED_1V1' ||
      (status.mode === 'GROUP_ROOM' && status.connectedPeers.length > 0),
    relayCount: status.relayStatus?.connectedRelays ?? 0,
    matching: status.matching ?? null,
    publicProfile: status.publicProfile ?? null,
    peer: peer ? {
      nickname: peer.nickname,
      commonKeywords: peer.commonKeywords || [],
      purpose: peer.intentCard?.purpose || '',
      language: peer.intentCard?.language || '',
    } : null,
  };
}

export function createChatMutationGuard() {
  let busy = false;
  return async (change) => {
    if (busy) throw new RequestError(409, '请等当前操作结束。');
    busy = true;
    try {
      return await change();
    } finally {
      busy = false;
    }
  };
}

export async function startChatWindow({ manager, runMutation = createChatMutationGuard() }) {
  const html = await readFile(new URL('./chat-window.html', import.meta.url));
  const token = randomBytes(32).toString('base64url');

  async function changeSession(path, input) {
    if (path === '/api/join') {
      const nickname = typeof input.nickname === 'string' ? input.nickname : undefined;
      let result;
      if (input.mode === 'room') {
        result = await manager.joinRoom({
          nickname,
          roomCode: typeof input.roomCode === 'string' ? input.roomCode : '',
        });
      } else if (input.mode === 'match') {
        const keywords = typeof input.keyword === 'string' ? input.keyword.trim() : '';
        const purpose = typeof input.purpose === 'string' ? input.purpose.trim() : '';
        if (purpose.length > 120) throw new RequestError(400, '公开介绍最多 120 字。');
        if (detectOutboundSecretLeak(purpose)) throw new RequestError(400, '公开介绍似乎含有密钥，请先去掉再匹配。');
        result = await manager.startMatching({ nickname, ...(keywords ? { keywords } : {}),
          intentCard: purpose ? { purpose } : {},
        });
      } else {
        throw new RequestError(400, '请选择同好匹配或房间。');
      }
      return {
        ...visibleStatus(manager.getStatus()),
        channel: result.channel,
        ...(result.roomCode ? { roomCode: result.roomCode } : {}),
      };
    }

    if (path === '/api/leave') {
      if (input.sessionId !== undefined && input.sessionId !== manager.sessionId) {
        throw new RequestError(409, '会话已切换，请确认当前会话后再结束。');
      }
      await manager.leaveChat();
      return { ok: true };
    }

    if (path === '/api/retry') {
      if (typeof input.sessionId !== 'string' || input.sessionId !== manager.sessionId) {
        throw new RequestError(409, '会话已切换，请确认当前匹配后重试。');
      }
      const result = await manager.retryMatching();
      return { ...visibleStatus(manager.getStatus()), channel: result.channel };
    }

    if (typeof input.sessionId !== 'string' || input.sessionId !== manager.sessionId) {
      throw new RequestError(409, '会话已切换，请确认当前对方后重新输入。');
    }
    const message = typeof input.text === 'string' ? input.text.trim() : '';
    if (!message || message.length > 2000) throw new RequestError(400, '请输入 1–2000 字的消息。');
    if (detectOutboundSecretLeak(message)) {
      throw new RequestError(400, '消息似乎含有密钥，请先去掉再发送。');
    }
    const { delivered } = manager.sendMessage(message);
    if (!delivered) throw new RequestError(409, '对方已断开，请重新连接。');
    return { ok: true };
  }

  const server = createServer(async (request, response) => {
    const authority = `${LOCAL_HOST}:${server.address().port}`;
    const origin = `http://${authority}`;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (request.headers.host !== authority || (request.headers.origin && request.headers.origin !== origin)) {
      sendJson(response, 403, { error: '请从本地 HumanWire 窗口访问。' });
      return;
    }

    const [path, query] = request.url.split('?', 2);
    if (request.method === 'GET' && path === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    if (request.method === 'GET' && path === '/') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      });
      response.end(html);
      return;
    }

    if (request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, 401, { error: '请使用启动时生成的本地窗口链接。' });
      return;
    }

    try {
      if (request.method === 'GET' && path === '/api/poll') {
        const params = new URLSearchParams(query);
        const requested = Number(params.get('wait'));
        const wait = Number.isFinite(requested) ? Math.max(0, Math.min(requested, 20)) : 0;
        const after = Number(params.get('after') || 0);
        if (!Number.isSafeInteger(after) || after < 0) throw new RequestError(400, '消息位置无效。');
        const poll = new AbortController();
        response.once('close', () => poll.abort());
        const { status, events, cursor, reset } = await manager.readDisplayMessages({
          after, sessionId: params.get('sessionId'), waitSeconds: wait, signal: poll.signal,
        });
        if (poll.signal.aborted) return;
        sendJson(response, 200, {
          ...visibleStatus(status),
          cursor, reset,
          events,
        });
        return;
      }

      if (request.method !== 'POST' || !['/api/join', '/api/send', '/api/leave', '/api/retry'].includes(path)) {
        throw new RequestError(404, '找不到这个入口。');
      }
      const input = await readJson(request);
      sendJson(response, 200, await runMutation(() => changeSession(path, input)));
    } catch (error) {
      sendJson(response, error.status || 400, { error: error.message || '操作失败。' });
    }
  });
  server.requestTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOCAL_HOST, resolve);
  });
  return {
    url: `http://${LOCAL_HOST}:${server.address().port}/#${token}`,
    async close() {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
      await manager.destroy();
    },
  };
}
