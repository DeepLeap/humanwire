/**
 * 零外部依赖 MCP (Model Context Protocol) JSON-RPC 2.0 Stdio 服务端
 * 替代笨重的 SDK 与校验库（省去 ~12MB 依赖），完整支持 initialize / ping / tools/list / tools/call。
 */

const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

export function validateArgs(schema, rawArgs) {
  const input = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('工具参数必须为 JSON 对象。');
  }

  const properties = schema?.properties || {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const result = {};

  for (const [key, prop] of Object.entries(properties)) {
    let val = input[key];
    if (val === undefined) {
      if (Object.prototype.hasOwnProperty.call(prop, 'default')) {
        val = prop.default;
      } else if (required.has(key)) {
        throw new Error(`缺少必填参数：${key}`);
      } else {
        continue;
      }
    }

    if (prop.type === 'string') {
      if (typeof val !== 'string') throw new Error(`参数 ${key} 必须为字符串`);
      if (typeof prop.minLength === 'number' && val.length < prop.minLength) {
        throw new Error(`参数 ${key} 长度不能少于 ${prop.minLength} 个字符`);
      }
      if (typeof prop.maxLength === 'number' && val.length > prop.maxLength) {
        throw new Error(`参数 ${key} 长度不能超过 ${prop.maxLength} 个字符`);
      }
    } else if (prop.type === 'integer') {
      if (typeof val !== 'number' || !Number.isInteger(val)) {
        throw new Error(`参数 ${key} 必须为整数`);
      }
      if (typeof prop.minimum === 'number' && val < prop.minimum) {
        throw new Error(`参数 ${key} 不能小于 ${prop.minimum}`);
      }
      if (typeof prop.maximum === 'number' && val > prop.maximum) {
        throw new Error(`参数 ${key} 不能大于 ${prop.maximum}`);
      }
    } else if (prop.type === 'number') {
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        throw new Error(`参数 ${key} 必须为有效数字`);
      }
      if (typeof prop.minimum === 'number' && val < prop.minimum) {
        throw new Error(`参数 ${key} 不能小于 ${prop.minimum}`);
      }
      if (typeof prop.maximum === 'number' && val > prop.maximum) {
        throw new Error(`参数 ${key} 不能大于 ${prop.maximum}`);
      }
    } else if (prop.type === 'boolean') {
      if (typeof val !== 'boolean') throw new Error(`参数 ${key} 必须为布尔值`);
    }

    if (Array.isArray(prop.enum) && !prop.enum.includes(val)) {
      throw new Error(`参数 ${key} 必须是以下取值之一：${prop.enum.join(' / ')}`);
    }

    result[key] = val;
  }

  return result;
}

export class SimpleMcpServer {
  constructor({ name, version }) {
    this.name = name;
    this.version = version;
    this.tools = new Map();
  }

  registerTool({ name, description, inputSchema, handler }) {
    this.tools.set(name, {
      name,
      description,
      inputSchema: inputSchema || { type: 'object', properties: {} },
      handler,
    });
  }

  start({ input = process.stdin, output = process.stdout, onClose = null } = {}) {
    let rawBuf = Buffer.alloc(0);
    let closed = false;

    const triggerClose = () => {
      if (closed) return;
      closed = true;
      if (typeof onClose === 'function') {
        Promise.resolve(onClose()).catch(() => {});
      }
    };

    const sendJson = (obj) => {
      if (output.destroyed || !output.writable) return;
      output.write(`${JSON.stringify(obj)}\n`);
    };

    const handleRequest = async (msg) => {
      if (!msg || typeof msg !== 'object') {
        sendJson({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid Request' },
        });
        return;
      }

      const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined;
      const { id, method, params } = msg;

      if (typeof method !== 'string') {
        if (hasId) {
          sendJson({
            jsonrpc: '2.0',
            id,
            error: { code: -32600, message: 'Invalid Request' },
          });
        }
        return;
      }

      if (method.startsWith('notifications/')) {
        return;
      }

      if (method === 'initialize') {
        const clientVersion =
          typeof params?.protocolVersion === 'string' && params.protocolVersion
            ? params.protocolVersion
            : DEFAULT_PROTOCOL_VERSION;
        if (hasId) {
          sendJson({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: clientVersion,
              capabilities: { tools: {} },
              serverInfo: {
                name: this.name,
                version: this.version,
              },
            },
          });
        }
        return;
      }

      if (method === 'ping') {
        if (hasId) sendJson({ jsonrpc: '2.0', id, result: {} });
        return;
      }

      if (method === 'tools/list') {
        if (hasId) {
          sendJson({
            jsonrpc: '2.0',
            id,
            result: {
              tools: Array.from(this.tools.values()).map(({ name, description, inputSchema }) => ({
                name,
                description,
                inputSchema,
              })),
            },
          });
        }
        return;
      }

      if (method === 'tools/call') {
        const toolName = params?.name;
        const tool = this.tools.get(toolName);
        if (!tool) {
          if (hasId) {
            sendJson({
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: `未知工具：${toolName}` },
            });
          }
          return;
        }

        let validatedArgs;
        try {
          validatedArgs = validateArgs(tool.inputSchema, params?.arguments);
        } catch (err) {
          if (hasId) {
            sendJson({
              jsonrpc: '2.0',
              id,
              result: {
                isError: true,
                content: [{ type: 'text', text: `参数校验失败：${err.message}` }],
              },
            });
          }
          return;
        }

        try {
          const toolResult = await tool.handler(validatedArgs);
          if (hasId) {
            sendJson({
              jsonrpc: '2.0',
              id,
              result: toolResult,
            });
          }
        } catch (err) {
          if (hasId) {
            sendJson({
              jsonrpc: '2.0',
              id,
              result: {
                isError: true,
                content: [{ type: 'text', text: `操作失败：${err?.message || String(err)}` }],
              },
            });
          }
        }
        return;
      }

      if (hasId) {
        sendJson({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
      }
    };

    input.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      rawBuf = rawBuf.length === 0 ? buf : Buffer.concat([rawBuf, buf]);

      let idx;
      while ((idx = rawBuf.indexOf(0x0a)) !== -1) {
        const lineBuf = rawBuf.subarray(0, idx);
        rawBuf = rawBuf.subarray(idx + 1);
        const line = lineBuf.toString('utf8').trim();
        if (!line) continue;

        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          sendJson({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'JSON 解析错误' },
          });
          continue;
        }

        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            handleRequest(item);
          }
        } else {
          handleRequest(parsed);
        }
      }
    });

    input.on('end', triggerClose);
    input.on('close', triggerClose);

    return {
      stop: triggerClose,
    };
  }
}
