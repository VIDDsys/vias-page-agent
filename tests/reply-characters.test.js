'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({ URL });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8'), context);
const core = context.ViasCore;
const command = '{"actions":[{"action":"click","ref":3}]}';

for (const input of [
  '{“actions”:[{“action”:“click”,“ref”:3}]}',
  '{"actions"：[{"action":"click","ref":3}]}',
  '｛＂actions＂：［｛＂action＂：＂click＂，＂ref＂：3｝］｝',
  '{"vias_read":{"kind":"images","snapshotId":"doc:1","ids":[1,]}}',
  '{"vias_read":{"kind":"images","snapshotId":"doc:1","ids":[]}}',
  `${command}\n{“actions”:[{“action”:“click”,“ref”:4}]}`,
]) {
  test(`损坏协议拒绝执行且不泄漏原文：${input.slice(0, 35)}`, () => {
    const parsed = core.parseReply(input);
    assert.equal(parsed.malformed, true);
    assert.equal(parsed.say, '');
    assert.equal(parsed.actions.length, 0);
    assert.equal(parsed.done, false);
  });
}

for (const prefix of ['示例代码：', '仅供参考的示例 JSON：', 'Example JSON:', 'Here is a code example:', '先展示数据格式，暂不操作：', '现在执行如下操作：']) {
  test(`带说明或示例的对象不当作实际指令：${prefix}`, () => {
    const parsed = core.parseReply(`${prefix}\n\x60\x60\x60json\n${command}\n\x60\x60\x60`);
    assert.equal(parsed.malformed, true);
    assert.equal(parsed.say, '');
    assert.equal(parsed.actions.length, 0);
  });
}

test('唯一完整对象/代码块与BOM可兼容，填写值中的非标准字符保持原意', () => {
  const value = '“原始内容”：｛全角｝ 😀 与 MySQL \\G';
  const reply = JSON.stringify({ say: '开始填写', actions: [{ action: 'fill', ref: 3, value }] });
  for (const input of [reply, `\ufeff${reply}`, `\x60\x60\x60json\n${reply}\n\x60\x60\x60`]) {
    const parsed = core.parseReply(input);
    assert.equal(parsed.actions[0].value, value);
    assert.equal(parsed.actions[0].ref, 3);
    assert.equal(parsed.say, '开始填写');
  }
});

test('普通叙述和完整JSON数据仍可展示，嵌套示例不会执行', () => {
  for (const input of ['正在检查页面。', JSON.stringify({ example: { actions: [{ action: 'click', ref: 3 }] } }), `[${command}]`]) {
    const parsed = core.parseReply(input);
    assert.equal(parsed.say, input);
    assert.equal(parsed.actions.length, 0);
    assert.notEqual(parsed.malformed, true);
  }
});

test('多个指令或未闭合围栏要求重试，不选择可能是示例的合法前缀', () => {
  for (const input of [`${command}\n${command}`, `\x60\x60\x60json\n${command}`, `说明\n${command}\n后记`]) {
    assert.equal(core.parseReply(input).malformed, true);
    assert.equal(core.parseReply(input).actions.length, 0);
  }
});

test('执行模式say内直接嵌入损坏指令或读取命令不会显示', () => {
  for (const say of ['内部数据 {“actions”:[{“action”:“click”,“ref”:3}]}', '读取命令 {"vias_read":{"kind":"images","snapshotId":"doc:1","ids":[1]}}']) {
    const parsed = core.parseReply(JSON.stringify({ say, done: true, actions: [] }));
    assert.equal(parsed.say, '');
    assert.equal(parsed.actions.length, 0);
  }
});
