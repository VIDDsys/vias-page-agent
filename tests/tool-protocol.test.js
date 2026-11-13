'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const coreSource = fs.readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8');
function loadCore(fetch = () => { throw new Error('offline tests must not access network'); }) {
  const context = vm.createContext({ URL, AbortController, TypeError, setTimeout, clearTimeout, fetch });
  vm.runInContext(coreSource, context);
  return context.ViasCore;
}
const core = loadCore();
const config = { baseUrl: 'http://127.0.0.1:1/v1', model: 'offline', apiKey: '' };
const messages = [{ role: 'user', content: 'Explain the page' }];
const original = '<｜DSML｜ calls> <｜DSML｜ invoke name="vias_read"> <｜DSML｜ parameter name="kind" string="false">"images"</｜DSML｜ parameter> <｜DSML｜ parameter name="snapshotId" string="true">"b2bf1a58-db1f-4d9e-8ab8-8a0357ffaf73:3:29"</｜DSML｜ parameter> <｜DSML｜ parameter name="ids" string="false">[4]</｜DSML｜ parameter> </｜DSML｜ invoke> </｜DSML｜ calls>';
const sampleMarkers = [
  original,
  original.replaceAll('｜', '|'),
  original.replaceAll('<', '＜').replaceAll('>', '＞'),
  original.replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  original.replaceAll('<', '&#60;').replaceAll('>', '&#x3e;'),
  '<|DSML|invoke name="vias_read">',
  '<｜DSML｜ invoke name="click">',
  '<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="vias_read"> <｜｜DSML｜｜ parameter name="kind" string="false">"segment"</｜｜DSML｜｜ parameter> </｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>',
  '<||DSML||<｜｜DSML｜｜parameter name="ids">[1]</｜｜DSML｜｜parameter>',
  '<｜｜DSML',
  '<｜DSML',
  original.slice(0, -80),
  '</｜DSML｜ calls>',
  '<tool_call>{"name":"vias_read","arguments":{"kind":"segment","index":1}}</tool_call>',
  '<tool_call',
  '</tool_call>',
  '<function_calls><invoke name="click">',
  '<function=click><parameter=ref>1</parameter></function>',
  '<invoke name="other_tool">',
  '<minimax:tool_call><invoke name="click">',
  '<antml:function_calls>',
  '[TOOL_CALLS] [{"name":"vias_read"}]',
  '[TOOL_RESULTS]',
  '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>',
  '<|tool_calls_begin|>',
  '<|tool_calls_beg',
  '<｜tool▁outputs▁end｜>',
  '<|python_tag|>',
  '<|im_start|>assistant to=functions.vias_read',
  '<|start|>assistant to=python<|channel|>analysis',
  '<|channel|>analysis to=python',
  '<|recipient|>functions.vias_read',
];

test('共享判别器拒绝实际工具标记、DSML变体和截断片段，围栏或说明不掩盖协议', () => {
  for (const marker of sampleMarkers) {
    for (const text of [marker, `正在读取\n${marker}`, `\x60\x60\x60xml\n${marker}\n\x60\x60\x60`]) {
      assert.equal(core.isInternalToolText(text), true, text);
      const parsed = core.parseReply(text);
      assert.equal(parsed.malformed, true, text);
      assert.equal(parsed.say, '', text);
      assert.equal(parsed.actions.length, 0, text);
      assert.equal(parsed.done, false, text);
      assert.equal(core.parseReadRequest(text), null, text);
    }
  }
});

test('合法JSON的say内嵌或Unicode转义工具协议时整条拒绝，不执行夹带的有效动作', () => {
  for (const marker of sampleMarkers) {
    for (const actions of [[], [{ action: 'click', ref: 1 }]]) {
      const text = JSON.stringify({ say: marker, done: true, actions });
      for (const encoded of [text, text.replaceAll('<', '\\u003c').replaceAll('｜', '\\uff5c')]) {
        assert.equal(core.isInternalToolText(encoded), true, encoded);
        const parsed = core.parseReply(encoded);
        assert.equal(parsed.malformed, true, encoded);
        assert.equal(parsed.say, '', encoded);
        assert.equal(parsed.actions.length, 0, encoded);
        assert.equal(parsed.done, false, encoded);
      }
    }
  }
});

test('共享检测器只解码完整顶层say或JSON字符串，供问答与缓存入口复用', () => {
  const encode = (text) => text.replaceAll('<', '\\u003c').replaceAll('｜', '\\uff5c');
  const envelope = encode(JSON.stringify({ say: original, done: true, actions: [] }));
  for (const text of [envelope, encode(JSON.stringify(original)), `\x60\x60\x60json\n${envelope}\n\x60\x60\x60`, envelope.replace('calls>', 'calls> \\G')]) {
    assert.equal(core.isInternalToolText(text), true, text);
    assert.equal(core.parseReply(text).malformed, true, text);
  }
  for (const data of [JSON.stringify({ example: { say: original } }), JSON.stringify([original]), encode(JSON.stringify({ example: { say: original } }))]) {
    assert.equal(core.isInternalToolText(data), false, '不递归解释普通数据容器');
  }
  assert.equal(core.isInternalToolText('{"say":"\\u003c"'), false, '损坏JSON不猜测解码');
});

const normalAnswers = [
  'DSML 是一种工具调用协议；这里只解释概念。',
  '字段 tool_calls 和 function_call 分别代表新版与旧版函数调用；invoke 是动词。',
  'const DSML = "ordinary value";',
  '前言说明\n```json\n{"actions":[{"action":"click","ref":1}]}\n```\n结尾解释',
  '```json\n{"vias_read":{"kind":"images","snapshotId":"doc:1","ids":[1]}}\n```',
  '{"tool_calls":[{"name":"example","arguments":{}}]}',
  '<article>解释 HTML</article>\n<function_component>合法组件名</function_component>',
  '```js\nconst actions = [{ action: "click", ref: 1 }];\n```',
];

test('普通DSML概念、JSON字段、动作示例与代码仍通过共享判别器且callModel原文返回', async () => {
  assert.equal(core.isInternalToolText(null), false);
  for (const text of normalAnswers) {
    assert.equal(core.isInternalToolText(text), false, text);
    const model = loadCore(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }) }));
    assert.equal(await model.callModel(config, messages), text);
  }
});

test('完整指令的action.value作为数据保真，填写工具源码、反斜杠、全角与实体仍可执行', () => {
  for (const value of [
    '<tool_call>source example</tool_call>',
    '<function=example>',
    original,
    '＜｜ＤＳＭＬ｜ calls＞全角原文＜／｜ＤＳＭＬ｜ calls＞',
    '&lt;｜DSML｜ calls&gt; &#60;tool_call&#62;',
    '<tool_call>MySQL \\G; C:\\examples\\tools; "quotes"\n\tline</tool_call>',
  ]) {
    const instruction = { say: '正在填写源码', actions: [{ action: 'fill', ref: 1, value }] };
    const json = JSON.stringify(instruction);
    for (const text of [json, `\x60\x60\x60json\n${json}\n\x60\x60\x60`]) {
      assert.equal(core.isInternalToolText(text), false, text);
      const parsed = core.parseReply(text);
      assert.notEqual(parsed.malformed, true, text);
      assert.equal(parsed.say, instruction.say);
      assert.equal(parsed.actions.length, 1);
      assert.equal(parsed.actions[0].action, 'fill');
      assert.equal(parsed.actions[0].value, value, '不能规范化或剥除填写值');
    }
    const data = JSON.stringify({ example: { actions: instruction.actions } });
    assert.equal(core.isInternalToolText(data), false);
    assert.equal(core.parseReply(data).say, data);
    assert.equal(core.parseReply(data).actions.length, 0, '数据容器内的动作示例不执行');
  }
});

test('用户原例重复10次均判协议错误，segment/continue等非图片工具同样拒绝', () => {
  for (const text of [original, original.replace('"images"', '"segment"'), original.replace('"images"', '"continue"'), original.replace('name="vias_read"', 'name="other_tool"')]) {
    for (let i = 0; i < 10; i++) {
      assert.equal(core.parseReply(text).malformed, true);
      assert.equal(core.parseReply(text).say, '');
    }
  }
});

test('长畸形标记与普通文本不触发回溯放大或误判', () => {
  for (const text of ['<' + ' '.repeat(200000) + '>', '普通内容'.repeat(50000)]) {
    assert.equal(core.isInternalToolText(text), false);
    assert.equal(core.parseReply(text).malformed === true, false);
  }
});

const nativeCalls = { tool_calls: [{ id: 'offline-call', type: 'function', function: { name: 'vias_read', arguments: '{"kind":"images","snapshotId":"doc:1","ids":[1]}' } }] };
test('原生工具字段不受stop/null/缺省finish_reason掩盖，伴随内容绝不降级执行或显示', async () => {
  const nativeMessages = [
    nativeCalls,
    { function_call: { name: 'vias_read', arguments: '{}' } },
    { content: [{ type: 'text', text: '正在读取' }, { type: 'tool_use', id: 'offline', name: 'vias_read', input: {} }] },
    { content: [{ type: 'function_call', name: 'vias_read', arguments: '{}' }] },
    { content: { type: 'tool_call', name: 'vias_read' } },
  ];
  for (const finishReason of ['stop', null, undefined, 'tool_calls', 'function_call', 'tool_use']) {
    for (const nativeMessage of nativeMessages) {
      for (const content of [original, null, '{"say":"完成","done":true,"actions":[{"action":"click","ref":1}]}']) {
        let requests = 0;
        const model = loadCore(async () => {
          requests++;
          return { ok: true, json: async () => ({ choices: [{ message: { content, ...nativeMessage }, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) }] }) };
        });
        await assert.rejects(model.callModel(config, messages, { retries: 3 }), (error) => {
          assert.equal(error.code, 'UNSUPPORTED_TOOL_PROTOCOL');
          assert.equal(error.retryable, false);
          assert.match(error.message, /原生工具调用.*未执行任何操作/);
          assert.ok(!error.message.includes(original));
          assert.ok(!error.message.includes('offline-call'));
          return true;
        });
        assert.equal(requests, 1, '不重放未协商的原生调用；协议修复应走上层有界流程');
      }
    }
  }
});

test('明确原生工具结束原因即使没有调用字段也拒绝，空兼容字段仍可接收正常文本', async () => {
  for (const finishReason of ['tool_calls', 'function_call', 'tool_use']) {
    const model = loadCore(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '不能展示的伴随正文' }, finish_reason: finishReason }] }) }));
    await assert.rejects(model.callModel(config, messages), (error) => error.code === 'UNSUPPORTED_TOOL_PROTOCOL');
  }
  for (const nativeFields of [{ tool_calls: [], function_call: null }, { tool_calls: null, function_call: {} }, { tool_calls: undefined, function_call: '' }]) {
    const model = loadCore(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '正常回答', ...nativeFields }, finish_reason: 'stop' }] }) }));
    assert.equal(await model.callModel(config, messages), '正常回答');
  }
});

test('分段文本中的协议拼接后被拒绝，reasoning_content保持不执行也不展示', async () => {
  const model = loadCore(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: [{ type: 'text', text: original.slice(0, 20) }, { type: 'text', text: original.slice(20) }], reasoning_content: '不可执行的推理' }, finish_reason: 'stop' }] }) }));
  const text = await model.callModel(config, messages);
  assert.equal(core.isInternalToolText(text), true);
  assert.equal(core.parseReply(text).malformed, true);
  const reasoningOnly = loadCore(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '正常回答', reasoning_content: original }, finish_reason: 'stop' }] }) }));
  assert.equal(await reasoningOnly.callModel(config, messages), '正常回答');
});

function read(overrides = {}) {
  return JSON.stringify({ vias_read: { kind: 'images', snapshotId: 'doc:1', ids: [1], ...overrides } });
}
test('images兼容旧无reason读取，允许有界原因并保持notes契约', () => {
  assert.equal(core.parseReadRequest(read()).kind, 'images');
  assert.equal(Object.hasOwn(core.parseReadRequest(read()), 'reason'), false);
  const parsed = core.parseReadRequest(read({ reason: '  题目关键数据在图中  ', notes: '累计阅读记录' }));
  assert.equal(parsed.reason, '题目关键数据在图中');
  assert.equal(parsed.notes, '累计阅读记录');
  assert.equal(core.parseReadRequest(read({ reason: 'a'.repeat(300), notes: 'n'.repeat(12000) })).reason.length, 300);
  assert.equal(core.parseReadRequest(read({ reason: '读取题图', notes: 'n'.repeat(12001) })), null);
  assert.equal(core.parseReadRequest(read({ reason: '读取题图', notes: 1 })), null);
});

test('图片reason拒绝空白、错误类型、超长与额外字段，非images不允许reason', () => {
  for (const reason of ['', ' \n\t ', null, 1, false, [], {}, 'a'.repeat(301)]) assert.equal(core.parseReadRequest(read({ reason })), null);
  assert.equal(core.parseReadRequest(read({ reason: '读取图表', extra: true })), null);
  assert.equal(core.parseReadRequest(read({ reason: '读取图表', ids: [1, 1] })), null);
  for (const body of [
    { kind: 'segment', snapshotId: 'doc:1', index: 1, reason: '不该允许' },
    { kind: 'continue', snapshotId: 'doc:1', reason: '不该允许', notes: '累计事实' },
  ]) assert.equal(core.parseReadRequest(JSON.stringify({ vias_read: body })), null);
});
