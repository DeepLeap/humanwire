import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_HTTP_HEADER_BYTES = 16 * 1024;
const MAX_WS_FRAME_BYTES = 2 * 1024 * 1024;

/**
 * 脱敏代理 URL 供日志与状态展示（抹除用户名与密码凭据）
 */
export function sanitizeProxyDisplay(proxyUrl) {
  try {
    const u = new URL(proxyUrl);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return 'invalid-proxy';
  }
}

class SocketByteReader {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.ended = false;
    this.error = null;
    this._waiter = null;

    this._onData = (chunk) => {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.buf = this.buf.length === 0 ? b : Buffer.concat([this.buf, b]);
      this._notify();
    };
    this._onEnd = () => {
      this.ended = true;
      this._notify();
    };
    this._onError = (err) => {
      this.error = err;
      this._notify();
    };

    socket.on('data', this._onData);
    socket.on('end', this._onEnd);
    socket.on('close', this._onEnd);
    socket.on('error', this._onError);
    socket.resume();
  }

  _notify() {
    if (this._waiter) {
      const w = this._waiter;
      this._waiter = null;
      w();
    }
  }

  async _waitMore() {
    if (this.error) throw this.error;
    if (this.ended) throw new Error('代理连接在握手完成前意外关闭');
    await new Promise((resolve) => {
      this._waiter = resolve;
    });
    if (this.error) throw this.error;
  }

  async readExact(n) {
    while (this.buf.length < n) {
      await this._waitMore();
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  async readUntil(delimiterBuf, maxBytes = MAX_HTTP_HEADER_BYTES) {
    while (true) {
      const idx = this.buf.indexOf(delimiterBuf);
      if (idx !== -1) {
        const end = idx + delimiterBuf.length;
        const out = this.buf.subarray(0, end);
        this.buf = this.buf.subarray(end);
        return out;
      }
      if (this.buf.length > maxBytes) {
        throw new Error('代理握手响应头超出最大限制');
      }
      await this._waitMore();
    }
  }

  detach({ unshift = false } = {}) {
    if (unshift) this.socket.pause();
    this.socket.off('data', this._onData);
    this.socket.off('end', this._onEnd);
    this.socket.off('close', this._onEnd);
    this.socket.off('error', this._onError);
    const leftover = this.buf;
    this.buf = Buffer.alloc(0);
    if (unshift && leftover.length > 0) {
      this.socket.unshift(leftover);
    }
    return leftover;
  }
}

async function openHttpConnectTunnel(proxy, targetHost, targetPort, timeoutMs) {
  const proxyHost = proxy.hostname;
  const proxyPort = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 8080));

  const baseSocket = await new Promise((resolve, reject) => {
    const sock =
      proxy.protocol === 'https:'
        ? tls.connect({ host: proxyHost, port: proxyPort, servername: proxyHost })
        : net.connect({ host: proxyHost, port: proxyPort });

    const timer = setTimeout(() => {
      sock.destroy(new Error('连接 HTTP 代理超时'));
    }, timeoutMs);
    timer.unref?.();

    const onReady = () => {
      clearTimeout(timer);
      sock.off('error', onErr);
      resolve(sock);
    };
    const onErr = (err) => {
      clearTimeout(timer);
      reject(err);
    };
    sock.once(proxy.protocol === 'https:' ? 'secureConnect' : 'connect', onReady);
    sock.once('error', onErr);
  });

  const reader = new SocketByteReader(baseSocket);
  const authority = `${targetHost}:${targetPort}`;
  const headers = [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    'Proxy-Connection: keep-alive',
  ];
  if (proxy.username || proxy.password) {
    const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
    headers.push(`Proxy-Authorization: Basic ${Buffer.from(cred, 'utf8').toString('base64')}`);
  }
  baseSocket.write(`${headers.join('\r\n')}\r\n\r\n`);

  const respBuf = await reader.readUntil(Buffer.from('\r\n\r\n'));
  const statusLine = respBuf.toString('latin1').split('\r\n')[0] || '';
  if (!/^HTTP\/1\.[01]\s+200\b/i.test(statusLine)) {
    baseSocket.destroy();
    throw new Error(`HTTP 代理拒绝隧道连接：${statusLine}`);
  }

  reader.detach({ unshift: true });
  return baseSocket;
}

async function openSocks5Tunnel(proxy, targetHost, targetPort, timeoutMs) {
  const proxyHost = proxy.hostname;
  const proxyPort = Number(proxy.port || 1080);

  const baseSocket = await new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxyHost, port: proxyPort });
    const timer = setTimeout(() => {
      sock.destroy(new Error('连接 SOCKS5 代理超时'));
    }, timeoutMs);
    timer.unref?.();

    sock.once('connect', () => {
      clearTimeout(timer);
      sock.off('error', onErr);
      resolve(sock);
    });
    const onErr = (err) => {
      clearTimeout(timer);
      reject(err);
    };
    sock.once('error', onErr);
  });

  const reader = new SocketByteReader(baseSocket);
  const hasAuth = Boolean(proxy.username || proxy.password);
  const methods = hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
  baseSocket.write(methods);

  const greeting = await reader.readExact(2);
  if (greeting[0] !== 0x05) {
    baseSocket.destroy();
    throw new Error('SOCKS5 代理协议版本无效');
  }
  if (greeting[1] === 0x02) {
    if (!hasAuth) {
      baseSocket.destroy();
      throw new Error('SOCKS5 代理要求用户名密码认证');
    }
    const uBuf = Buffer.from(decodeURIComponent(proxy.username), 'utf8');
    const pBuf = Buffer.from(decodeURIComponent(proxy.password), 'utf8');
    if (uBuf.length > 255 || pBuf.length > 255) {
      baseSocket.destroy();
      throw new Error('SOCKS5 认证凭据过长');
    }
    baseSocket.write(Buffer.concat([Buffer.from([0x01, uBuf.length]), uBuf, Buffer.from([pBuf.length]), pBuf]));
    const authResp = await reader.readExact(2);
    if (authResp[1] !== 0x00) {
      baseSocket.destroy();
      throw new Error('SOCKS5 代理认证失败');
    }
  } else if (greeting[1] !== 0x00) {
    baseSocket.destroy();
    throw new Error('SOCKS5 代理无可用认证方式');
  }

  // 固定采用 ATYP=0x03（远程域名解析），防止本地 DNS 查询泄露目标中继地址
  const hostBuf = Buffer.from(targetHost, 'utf8');
  if (hostBuf.length > 255) {
    baseSocket.destroy();
    throw new Error('目标主机名超过 SOCKS5 长度限制');
  }
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(targetPort, 0);
  baseSocket.write(
    Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, portBuf])
  );

  const replyHead = await reader.readExact(4);
  if (replyHead[0] !== 0x05 || replyHead[1] !== 0x00) {
    baseSocket.destroy();
    throw new Error(`SOCKS5 CONNECT 失败，错误码: ${replyHead[1]}`);
  }
  const atyp = replyHead[3];
  if (atyp === 0x01) {
    await reader.readExact(6);
  } else if (atyp === 0x04) {
    await reader.readExact(18);
  } else if (atyp === 0x03) {
    const dlen = (await reader.readExact(1))[0];
    await reader.readExact(dlen + 2);
  } else {
    baseSocket.destroy();
    throw new Error(`SOCKS5 未知地址类型: ${atyp}`);
  }

  reader.detach({ unshift: true });
  return baseSocket;
}

function encodeWsFrame(opcode, payloadBuf, fin = true) {
  const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(payloadBuf || '', 'utf8');
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);

  const maskKey = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) {
    masked[i] = payload[i] ^ maskKey[i & 3];
  }
  return Buffer.concat([header, maskKey, masked]);
}

/**
 * 零外部依赖 WebSocket over HTTP CONNECT / SOCKS5(H) 代理客户端
 * 完全兼容浏览器 / Node 22 原生 WebSocket 事件接口（addEventListener / send / close / readyState）
 */
export function createProxiedWebSocket(targetUrl, proxyUrl, { timeoutMs = 10000 } = {}) {
  const emitter = new EventEmitter();
  let stream = null;
  let readyState = 0; // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
  let closedByLocal = false;
  let rxBuf = Buffer.alloc(0);
  let fragOpcode = null;
  let fragChunks = [];

  const wsObj = {
    get readyState() {
      return readyState;
    },
    addEventListener(type, listener) {
      emitter.on(type, listener);
    },
    removeEventListener(type, listener) {
      emitter.off(type, listener);
    },
    send(data) {
      if (readyState !== 1 || !stream || stream.destroyed) {
        throw new Error('代理 WebSocket 尚未就绪或已关闭');
      }
      const isStr = typeof data === 'string';
      const frame = encodeWsFrame(isStr ? 0x01 : 0x02, isStr ? Buffer.from(data, 'utf8') : data, true);
      stream.write(frame);
    },
    close(code = 1000, reason = '') {
      if (readyState >= 2) return;
      closedByLocal = true;
      if (readyState === 1 && stream && !stream.destroyed) {
        readyState = 2;
        const reasonBuf = Buffer.from(String(reason || ''), 'utf8');
        const body = Buffer.alloc(2 + reasonBuf.length);
        body.writeUInt16BE(code, 0);
        reasonBuf.copy(body, 2);
        try {
          stream.write(encodeWsFrame(0x08, body, true));
        } catch {
          // ignore
        }
        stream.end();
        const closeTimer = setTimeout(() => {
          if (stream && !stream.destroyed) stream.destroy();
        }, 150);
        closeTimer.unref?.();
      } else {
        readyState = 3;
        stream?.destroy();
        emitter.emit('close', { code, reason });
      }
    },
  };

  const failAndClose = (err) => {
    if (readyState === 3) return;
    readyState = 3;
    if (stream && !stream.destroyed) stream.destroy();
    emitter.emit('error', err);
    emitter.emit('close', { code: 1006, reason: err?.message || 'error' });
  };

  const drainWsFrames = () => {
    while (rxBuf.length >= 2) {
      const b0 = rxBuf[0];
      const b1 = rxBuf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (rxBuf.length < 4) return;
        payloadLen = rxBuf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (rxBuf.length < 10) return;
        const bigLen = rxBuf.readBigUInt64BE(2);
        if (bigLen > BigInt(MAX_WS_FRAME_BYTES)) {
          failAndClose(new Error('WebSocket 帧超出最大限制'));
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > MAX_WS_FRAME_BYTES) {
        failAndClose(new Error('WebSocket 帧超出最大限制'));
        return;
      }

      const maskLen = masked ? 4 : 0;
      if (rxBuf.length < offset + maskLen + payloadLen) return;

      let payload = rxBuf.subarray(offset + maskLen, offset + maskLen + payloadLen);
      if (masked) {
        const maskKey = rxBuf.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i += 1) {
          unmasked[i] = payload[i] ^ maskKey[i & 3];
        }
        payload = unmasked;
      }

      rxBuf = rxBuf.subarray(offset + maskLen + payloadLen);

      if (opcode === 0x08) {
        const closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        const closeReason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (!closedByLocal && readyState === 1 && stream && !stream.destroyed) {
          try {
            stream.write(encodeWsFrame(0x08, payload.subarray(0, 2), true));
          } catch {
            // ignore
          }
        }
        readyState = 3;
        stream?.end();
        const closeTimer = setTimeout(() => {
          if (stream && !stream.destroyed) stream.destroy();
        }, 150);
        closeTimer.unref?.();
        emitter.emit('close', { code: closeCode, reason: closeReason });
        return;
      }

      if (opcode === 0x09) {
        if (readyState === 1 && stream && !stream.destroyed) {
          stream.write(encodeWsFrame(0x0a, payload, true));
        }
        continue;
      }

      if (opcode === 0x0a) continue;

      if (opcode === 0x01 || opcode === 0x02) {
        if (fin) {
          emitter.emit('message', {
            data: opcode === 0x01 ? payload.toString('utf8') : payload,
          });
        } else {
          fragOpcode = opcode;
          fragChunks = [payload];
        }
      } else if (opcode === 0x00 && fragOpcode !== null) {
        fragChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(fragChunks);
          const outOpcode = fragOpcode;
          fragOpcode = null;
          fragChunks = [];
          emitter.emit('message', {
            data: outOpcode === 0x01 ? full.toString('utf8') : full,
          });
        }
      }
    }
  };

  (async () => {
    const target = new URL(targetUrl);
    const proxy = new URL(proxyUrl);
    if (target.protocol !== 'ws:' && target.protocol !== 'wss:') {
      throw new Error(`不支持的目标 WebSocket 协议: ${target.protocol}`);
    }

    const targetHost = target.hostname;
    const targetPort = Number(target.port || (target.protocol === 'wss:' ? 443 : 80));
    const targetPath = `${target.pathname || '/'}${target.search || ''}`;

    let tunnelSock;
    if (proxy.protocol === 'http:' || proxy.protocol === 'https:') {
      tunnelSock = await openHttpConnectTunnel(proxy, targetHost, targetPort, timeoutMs);
    } else if (proxy.protocol === 'socks5:' || proxy.protocol === 'socks5h:') {
      tunnelSock = await openSocks5Tunnel(proxy, targetHost, targetPort, timeoutMs);
    } else {
      throw new Error(`不支持的代理协议 "${proxy.protocol}"，仅支持 http://、https://、socks5:// 或 socks5h://`);
    }

    if (closedByLocal) {
      tunnelSock.destroy();
      return;
    }

    if (target.protocol === 'wss:') {
      stream = await new Promise((resolve, reject) => {
        const tlsSock = tls.connect({
          socket: tunnelSock,
          servername: targetHost,
        });
        const timer = setTimeout(() => {
          tlsSock.destroy(new Error('代理隧道 TLS 握手超时'));
        }, timeoutMs);
        timer.unref?.();
        tlsSock.once('secureConnect', () => {
          clearTimeout(timer);
          tlsSock.off('error', onErr);
          resolve(tlsSock);
        });
        const onErr = (err) => {
          clearTimeout(timer);
          reject(err);
        };
        tlsSock.once('error', onErr);
      });
    } else {
      stream = tunnelSock;
    }

    if (closedByLocal) {
      stream.destroy();
      return;
    }

    const reader = new SocketByteReader(stream);
    const wsKey = crypto.randomBytes(16).toString('base64');
    const expectedAccept = crypto
      .createHash('sha1')
      .update(`${wsKey}${WS_GUID}`, 'utf8')
      .digest('base64');
    const hostHeader = target.port ? `${targetHost}:${target.port}` : targetHost;

    stream.write(
      [
        `GET ${targetPath} HTTP/1.1`,
        `Host: ${hostHeader}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${wsKey}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n')
    );

    const handshakeBuf = await reader.readUntil(Buffer.from('\r\n\r\n'));
    const headerText = handshakeBuf.toString('latin1');
    const lines = headerText.split('\r\n');
    const statusLine = lines[0] || '';
    if (!/^HTTP\/1\.1\s+101\b/i.test(statusLine)) {
      throw new Error(`WebSocket 握手失败: ${statusLine}`);
    }

    let acceptHeader = '';
    for (const line of lines.slice(1)) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0 && line.slice(0, colonIdx).trim().toLowerCase() === 'sec-websocket-accept') {
        acceptHeader = line.slice(colonIdx + 1).trim();
        break;
      }
    }
    if (acceptHeader !== expectedAccept) {
      throw new Error('WebSocket Sec-WebSocket-Accept 校验不匹配');
    }

    rxBuf = reader.detach({ unshift: false });
    readyState = 1;

    stream.on('data', (chunk) => {
      if (readyState === 3) return;
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      rxBuf = rxBuf.length === 0 ? b : Buffer.concat([rxBuf, b]);
      drainWsFrames();
    });
    stream.resume();

    stream.on('close', () => {
      if (readyState !== 3) {
        readyState = 3;
        emitter.emit('close', { code: 1000, reason: '' });
      }
    });

    stream.on('error', (err) => failAndClose(err));

    emitter.emit('open', {});
    if (rxBuf.length > 0) drainWsFrames();
  })().catch((err) => failAndClose(err));

  return wsObj;
}
