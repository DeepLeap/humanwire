import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { SimpleMcpServer } from '../src/mcp-stdio.js';

test('MCP tools/list preserves annotations and accepts unannotated tools', async () => {
  const server = new SimpleMcpServer({ name: 'metadata-test', version: '1' });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.registerTool({ name: 'status', annotations, handler: async () => ({ content: [] }) });
  server.registerTool({ name: 'legacy', handler: async () => ({ content: [] }) });
  const input = new PassThrough();
  const output = new PassThrough();
  const connection = server.start({ input, output });
  try {
    const received = once(output, 'data');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    const [chunk] = await received;
    const { result } = JSON.parse(chunk.toString());
    assert.deepEqual(result.tools[0].annotations, annotations);
    assert.equal(Object.hasOwn(result.tools[1], 'annotations'), false);
  } finally {
    connection.stop();
    input.destroy();
    output.destroy();
  }
});

async function listTools(args) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/index.js', import.meta.url)), ...args], {
    env: { ...process.env, HUMANWIRE_EPHEMERAL: '1' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buffer = '';
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP tool listing timed out')), 5000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`MCP exited early with ${code}`)); });
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(buffer.slice(0, newline)).result.tools); } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    });
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  }
}

test('native and companion entry points expose explicit behavior hints', async () => {
  for (const args of [[], ['--chat-window']]) {
    const tools = await listTools(args);
    for (const tool of tools) {
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        assert.equal(typeof tool.annotations?.[hint], 'boolean', `${tool.name}.${hint}`);
      }
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.get('get_status').annotations.readOnlyHint, true);
    assert.equal(byName.get('start_matching').annotations.destructiveHint, true);
    assert.equal(byName.get('manage_blocklist').annotations.readOnlyHint, false);
    if (args.length) {
      assert.equal(byName.has('poll_messages'), false);
      assert.equal(byName.has('send_to_peer'), false);
    } else {
      assert.equal(byName.get('poll_messages').annotations.readOnlyHint, false);
      assert.equal(byName.get('poll_messages').annotations.destructiveHint, true);
      assert.equal(byName.get('send_to_peer').annotations.idempotentHint, false);
    }
  }
});
