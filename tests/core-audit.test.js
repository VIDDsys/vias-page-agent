'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const coreSource = fs.readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8');
const config = { baseUrl: 'https://provider.example.test/v1', model: 'offline', apiKey: 'OFFLINE_AUDIT/NOT_A_CREDENTIAL+123' };
const messages = [{ role: 'user', content: 'Offline regression fixture' }];
const plain = value => JSON.parse(JSON.stringify(value));
function loadCore(fetch = async () => { throw new Error('Unexpected network access'); }) {
  const context = vm.createContext({ URL, Error, TypeError, AbortController, TextDecoder, setTimeout, clearTimeout, fetch });
  vm.runInContext(coreSource, context, { filename: 'core.js' });
  return context.ViasCore;
}
const core = loadCore();
const malformed = { say: '', actions: [], done: false, malformed: true };
const completion = content => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
const unicode = value => [...value].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');

for (const [name, say] of [
  ['动作示例', 'Example {"actions":[{"action":"click","ref":1}]}'],
  ['损坏动作示例', 'Example {“actions”:[{“action”:“click”,“ref”:1}]}'],
  ['读取协议', '{"vias_read":{"kind":"segment","snapshotId":"doc:1","index":1}}'],
]) {
  test(`say内嵌${name}时整条拒绝，不能保留动作或done`, () => {
    for (const actions of [[], [{ action: 'click', ref: 2 }]]) {
      const json = JSON.stringify({ say, actions, done: true });
      for (const input of [json, `\x60\x60\x60json\n${json}\n\x60\x60\x60`]) {
        assert.deepEqual(plain(core.parseReply(input)), malformed);
      }
    }
  });
}

test('顶层读取与say/actions/done混排时整条拒绝，不降级成动作或完成', () => {
  const vias_read = { kind: 'segment', snapshotId: 'doc:1', index: 1 };
  for (const fields of [{ say: 'Read first' }, { actions: [] }, { actions: [{ action: 'click', ref: 2 }] }, { done: true }, { actions: [], done: true }]) {
    const json = JSON.stringify({ vias_read, ...fields });
    assert.equal(core.parseReadRequest(json), null);
    for (const input of [json, `\x60\x60\x60json\n${json}\n\x60\x60\x60`]) {
      assert.deepEqual(plain(core.parseReply(input)), malformed);
    }
  }
  assert.deepEqual(plain(core.parseReadRequest(JSON.stringify({ vias_read }))), vias_read);
});

test('拒绝带query/hash的API地址，包括空分隔符，且不发请求', async () => {
  let calls = 0;
  const model = loadCore(async () => { calls++; return completion('Unexpected request'); });
  for (const baseUrl of [
    'https://provider.example.test/v1?api-version=2024-10-21',
    'https://provider.example.test/v1#fragment',
    'https://provider.example.test/v1/chat/completions?api-version=2024-10-21',
    'https://provider.example.test/v1?',
    'https://provider.example.test/v1#',
  ]) {
    assert.throws(() => model.validateModel({ ...config, baseUrl }), /API 地址.*查询|API 地址.*片段/);
    await assert.rejects(model.callModel({ ...config, baseUrl }, messages), /API 地址.*查询|API 地址.*片段/);
  }
  assert.equal(calls, 0);
});

test('普通基础地址与完整chat/completions地址仍规范化到同一路由', async () => {
  const urls = [];
  const model = loadCore(async url => { urls.push(url); return completion('OK'); });
  for (const baseUrl of [' https://provider.example.test/v1/// ', 'https://provider.example.test/v1/chat/completions///']) {
    assert.equal(await model.callModel({ ...config, baseUrl }, messages), 'OK');
  }
  assert.deepEqual(urls, ['https://provider.example.test/v1/chat/completions', 'https://provider.example.test/v1/chat/completions']);
  assert.equal(model.validateModel({ ...config, baseUrl: 'https://provider.example.test/v1%3Fpart' }).baseUrl, 'https://provider.example.test/v1%3Fpart');
});

for (const [name, encode] of [
  ['原文', value => value],
  ['斜杠转义', value => value.replaceAll('/', '\\/')],
  ['混合Unicode转义', value => value.replace('OFFLINE', '\\u004fFFLINE')],
  ['全部Unicode转义', value => value.replace(config.apiKey, unicode(config.apiKey))],
]) {
  test(`错误JSON中的本次凭据${name}在截断前脱敏，401不重试`, async () => {
    let calls = 0;
    const raw = JSON.stringify({ error: `Invalid key: ${config.apiKey}` });
    const model = loadCore(async () => { calls++; return new Response(encode(raw), { status: 401 }); });
    await assert.rejects(model.callModel(config, messages, { retries: 3 }), error => {
      assert.equal(error.retryable, false);
      assert.match(error.message, /^API 401:/);
      const body = JSON.parse(error.message.slice('API 401: '.length));
      assert.ok(!JSON.stringify(body).includes(config.apiKey));
      assert.match(error.message, /REDACTED/);
      assert.ok(!error.stack.includes(config.apiKey));
      return true;
    });
    assert.equal(calls, 1);
  });
}

test('编码凭据先于500字符截断处理，不能留下可还原的前缀', async () => {
  const body = JSON.stringify({ error: `${'x'.repeat(475)}${config.apiKey}` }).replaceAll('/', '\\/');
  const model = loadCore(async () => new Response(body, { status: 401 }));
  await assert.rejects(model.callModel(config, messages), error => {
    assert.ok(!error.message.includes('OFFLINE_AUDIT'));
    assert.ok(!error.message.includes('NOT_A_CREDENTIAL'));
    assert.ok(error.message.length <= 'API 401: '.length + 500);
    return true;
  });
});

test('异常出口同样脱敏JSON转义凭据，不复用上游错误对象', async () => {
  const upstream = Object.freeze(new Error(`network ${unicode(config.apiKey)}`));
  const model = loadCore(async () => { throw upstream; });
  await assert.rejects(model.callModel(config, messages), error => {
    assert.notEqual(error, upstream);
    assert.match(error.message, /REDACTED/);
    assert.ok(!error.message.includes(unicode(config.apiKey)));
    return true;
  });
});

for (const [name, content] of [
  ['纯文本', `Returned credential: ${config.apiKey}`],
  ['指令say', JSON.stringify({ say: config.apiKey, actions: [], done: true })],
  ['指令value', JSON.stringify({ say: 'Filling', actions: [{ action: 'fill', ref: 1, value: config.apiKey }] })],
  ['斜杠转义', JSON.stringify({ say: config.apiKey, actions: [], done: true }).replaceAll('/', '\\/')],
  ['Unicode转义', `{"say":"${unicode(config.apiKey)}","actions":[],"done":true}`],
  ['跨文本段', [{ type: 'text', text: config.apiKey.slice(0, 12) }, { type: 'text', text: config.apiKey.slice(12) }]],
]) {
  test(`成功正文${name}泄本次凭据时整条拒绝，不重试且不返回被改写的指令`, async () => {
    let calls = 0;
    const model = loadCore(async () => { calls++; return completion(content); });
    await assert.rejects(model.callModel(config, messages, { retries: 3 }), error => {
      assert.equal(error.retryable, false);
      assert.match(error.message, /凭据.*拒绝|凭据.*未执行/);
      assert.ok(!error.message.includes(config.apiKey));
      assert.ok(!error.stack.includes(config.apiKey));
      assert.ok(!error.message.includes(unicode(config.apiKey)));
      return true;
    });
    assert.equal(calls, 1);
  });
}

test('凭据检查只检查最终正文，reasoning_content继续隔离', async () => {
  const model = loadCore(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Safe final answer', reasoning_content: config.apiKey }, finish_reason: 'stop' }] })));
  assert.equal(await model.callModel(config, messages), 'Safe final answer');
});

test('普通填写值中的JSON、工具源码、反斜杠和全角保持原义，唯一闭合围栏与自愈仍可用', async () => {
  const value = '<tool_call>source</tool_call> {"done":true} “原文”：｛全角｝ 😀 C:\\temp\n\t MySQL \\G';
  const instruction = JSON.stringify({ say: 'Filling', actions: [{ action: 'fill', ref: 1, value }] });
  const repaired = String.raw`{"say":"Filling","actions":[{"action":"fill","ref":1,"value":"SQL\G; \uZZZZ; \n; C:\\temp"}]}`;
  for (const content of [instruction, `\x60\x60\x60json\n${instruction}\n\x60\x60\x60`, repaired]) {
    const model = loadCore(async () => completion(content));
    assert.equal(await model.callModel(config, messages), content);
    const parsed = model.parseReply(content);
    assert.notEqual(parsed.malformed, true);
    assert.equal(parsed.actions[0].value, content === repaired ? 'SQL\\G; \\uZZZZ; \n; C:\\temp' : value);
  }
});
