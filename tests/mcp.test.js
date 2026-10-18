'use strict';

/**
 * MCP server protocol tests.
 *
 * Covers the JSON-RPC surface and the auth gate. Tool execution that needs
 * live Strava/KV is exercised by tests/mcp-live.js instead.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

process.env.MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || 'test-token';
const mcp = require('../api/mcp.js');
const { handleRpc, TOOLS } = mcp._internals;

/** Minimal res double */
function mockRes() {
  const r = { statusCode: null, body: undefined, headers: {}, ended: false };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.send = b => { r.body = b; return r; };
  r.end = () => { r.ended = true; return r; };
  return r;
}

describe('auth gate', () => {
  test('rejects a request with no bearer token', async () => {
    const res = mockRes();
    await mcp({ method: 'POST', headers: {}, body: { jsonrpc: '2.0', id: 1, method: 'ping' } }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error.code, -32001);
  });

  test('rejects a wrong token', async () => {
    const res = mockRes();
    await mcp({ method: 'POST', headers: { authorization: 'Bearer wrong' },
                body: { jsonrpc: '2.0', id: 1, method: 'ping' } }, res);
    assert.equal(res.statusCode, 401);
  });

  test('accepts the configured token', async () => {
    const res = mockRes();
    await mcp({ method: 'POST', headers: { authorization: 'Bearer test-token' },
                body: { jsonrpc: '2.0', id: 1, method: 'ping' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.result, {});
  });

  test('refuses everything when MCP_AUTH_TOKEN is unset rather than defaulting open', async () => {
    const saved = process.env.MCP_AUTH_TOKEN;
    delete process.env.MCP_AUTH_TOKEN;
    const res = mockRes();
    await mcp({ method: 'POST', headers: { authorization: 'Bearer anything' },
                body: { jsonrpc: '2.0', id: 1, method: 'ping' } }, res);
    assert.equal(res.statusCode, 500);
    process.env.MCP_AUTH_TOKEN = saved;
  });

  test('CORS preflight needs no auth', async () => {
    const res = mockRes();
    await mcp({ method: 'OPTIONS', headers: {} }, res);
    assert.equal(res.statusCode, 204);
  });
});

describe('JSON-RPC protocol', () => {
  test('initialize negotiates a supported protocol version', async () => {
    const r = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize',
                                params: { protocolVersion: '2025-06-18' } });
    assert.equal(r.result.protocolVersion, '2025-06-18');
    assert.equal(r.result.serverInfo.name, 'robby-training-intelligence');
    assert.ok(r.result.capabilities.tools);
  });

  test('initialize falls back when an unknown version is requested', async () => {
    const r = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize',
                                params: { protocolVersion: '1999-01-01' } });
    assert.equal(r.result.protocolVersion, '2025-06-18');
  });

  test('instructions tell the client not to recompute the numbers', async () => {
    const r = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.match(r.result.instructions, /never recompute/);
  });

  test('notifications produce no response', async () => {
    assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'notifications/cancelled' }), null);
  });

  test('tools/list returns every tool with a schema', async () => {
    const r = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(r.result.tools.length, 8);
    for (const t of r.result.tools) {
      assert.ok(t.name, 'tool needs a name');
      assert.ok(t.description && t.description.length > 40, `${t.name} needs a real description`);
      assert.equal(t.inputSchema.type, 'object');
    }
  });

  test('unknown method returns -32601', async () => {
    const r = await handleRpc({ jsonrpc: '2.0', id: 3, method: 'nope/nope' });
    assert.equal(r.error.code, -32601);
  });

  test('unknown tool returns -32602', async () => {
    const r = await handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call',
                                params: { name: 'does_not_exist', arguments: {} } });
    assert.equal(r.error.code, -32602);
  });

  test('resources and prompts list empty rather than erroring', async () => {
    assert.deepEqual((await handleRpc({ jsonrpc: '2.0', id: 5, method: 'resources/list' })).result, { resources: [] });
    assert.deepEqual((await handleRpc({ jsonrpc: '2.0', id: 6, method: 'prompts/list' })).result, { prompts: [] });
  });
});

describe('tool contract', () => {
  test('check_session exposes the rule fields the coach needs', () => {
    const t = TOOLS.find(x => x.name === 'check_session');
    assert.ok(t.inputSchema.properties.type.enum.includes('long'));
    assert.match(t.description, /maxCompliantDistanceMi/);
    assert.match(t.description, /never quietly adjusted away/);
  });

  test('analyze_run explains why absolute bands beat Strava zones', () => {
    const t = TOOLS.find(x => x.name === 'analyze_run');
    assert.match(t.description, /max HR is unresolved/);
    assert.match(t.description, /169 observed vs 181 assumed/);
  });

  test('recalibrate defaults to preview, not a silent write', () => {
    const t = TOOLS.find(x => x.name === 'recalibrate_from_race');
    assert.match(t.description, /preview/i);
    assert.ok(!t.inputSchema.required.includes('dryRun'));
  });

  test('load budget is framed as load, not prescription', () => {
    const t = TOOLS.find(x => x.name === 'get_load_budget');
    assert.match(t.description, /Prescribes load, not sessions/);
  });

  test('every tool name is unique', () => {
    const names = TOOLS.map(t => t.name);
    assert.equal(new Set(names).size, names.length);
  });
});
