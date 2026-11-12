'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const context = vm.createContext({
  URL, crypto: webcrypto, console, setTimeout, clearTimeout, setInterval, clearInterval,
  chrome: { sidePanel: { setPanelBehavior: async () => {} }, storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } }, runtime: { onConnect: { addListener() {}, removeListener() {} }, onMessage: { addListener() {}, removeListener() {} }, id: 'mock', getURL: (file) => file }, tabs: { onCreated: { addListener() {}, removeListener() {} }, onRemoved: { addListener() {}, removeListener() {} }, onUpdated: { addListener() {}, removeListener() {} } } },
});
context.importScripts = () => vm.runInContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);

test('超预算时删除旧历史，但保留系统消息、原始任务和最新观察', () => {
  const task = { role: 'user', content: 'ORIGINAL_TASK' };
  const latest = { role: 'user', content: 'LATEST_PAGE' };
  const messages = [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'H'.repeat(50000) }, { role: 'assistant', content: 'A'.repeat(50000) }, task, { role: 'assistant', content: 'done' }, latest];
  context.trimMessages(messages, 1, latest, 90000, task);
  assert.equal(messages[0].content, 'SYSTEM');
  assert.ok(messages.includes(task));
  assert.ok(messages.includes(latest));
  assert.equal(messages.some((item) => String(item.content).includes('HHHH')), false);
  assert.ok(JSON.stringify(messages).length < 91000);
});
