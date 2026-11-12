'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const config = { id: 'mock', baseUrl: 'https://model.example.test/v1', model: 'mock', apiKey: 'local-test-key', vision: true };
const messages = [{ role: 'user', content: 'Local test' }];
const response = (status, body = '') => ({ ok: false, status, headers: { get: () => null }, text: async () => body });
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function clock() {
  let time = 0;
  let serial = 0;
  const pending = new Map();
  return {
    pending,
    jump(value) { time = value; },
    globals: {
      performance: { now: () => time },
      setTimeout(callback, delay) { const id = ++serial; pending.set(id, { callback, at: time + delay }); return id; },
      clearTimeout(id) { pending.delete(id); },
    },
    async advance(duration) {
      const end = time + duration;
      await flush();
      while (true) {
        const next = [...pending].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at;
        pending.delete(next[0]);
        next[1].callback();
        await flush();
      }
      time = end;
      await flush();
    },
  };
}

function loadCore(fetch, timers) {
  const context = vm.createContext({ AbortController, URL, Error, TypeError, Date, setTimeout, clearTimeout, fetch, ...timers });
  vm.runInContext(source('core.js'), context);
  return context;
}

function untilAbort(signal) {
  return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
}

test('总时限限制慢请求和退避，第二次只获得剩余时间且不发出第三次', async () => {
  const time = clock();
  let calls = 0;
  const context = loadCore(async (_url, options) => { calls++; return untilAbort(options.signal); }, time.globals);
  const request = context.ViasCore.callModel(config, messages, { timeoutMs: 1000, totalTimeoutMs: 2500, retries: 2 });
  const rejected = assert.rejects(request, /总时限/);
  await time.advance(1000);
  assert.equal(calls, 1);
  await time.advance(500);
  assert.equal(calls, 2);
  await time.advance(1000);
  await rejected;
  assert.equal(calls, 2);
  assert.equal(time.pending.size, 0);
});

test('Retry-After 超过剩余总时限时不进入无用等待，也不再次请求', async () => {
  const time = clock();
  let calls = 0;
  const context = loadCore(async () => { calls++; return { ...response(429), headers: { get: () => '10' } }; }, time.globals);
  await assert.rejects(context.ViasCore.callModel(config, messages, { timeoutMs: 1000, totalTimeoutMs: 2000, retries: 2 }), /总时限/);
  assert.equal(calls, 1);
  assert.equal(time.pending.size, 0);
});

test('temperature 兼容重试同样受总时限约束', async () => {
  const time = clock();
  let calls = 0;
  const context = loadCore(async (_url, options) => {
    calls++;
    if (calls === 1) return { ...response(400), text: async () => { time.jump(800); return 'temperature unsupported'; } };
    assert.equal(Object.hasOwn(JSON.parse(options.body), 'temperature'), false);
    return untilAbort(options.signal);
  }, time.globals);
  const request = context.ViasCore.callModel(config, messages, { timeoutMs: 1000, totalTimeoutMs: 1000, retries: 0 });
  const rejected = assert.rejects(request, /总时限/);
  await flush();
  await time.advance(0);
  assert.equal(calls, 2);
  await time.advance(200);
  await rejected;
  assert.equal(time.pending.size, 0);
});

test('发送前能力检查始终不返回时，取消仍立即结算且不发请求', { timeout: 2000 }, async () => {
  let release;
  let calls = 0;
  const ready = new Promise((resolve) => { release = resolve; });
  const context = loadCore(async () => { calls++; return response(500); });
  const controller = new AbortController();
  const request = context.ViasCore.callModel(config, messages, { signal: controller.signal, beforeAttempt: () => ready });
  const rejected = assert.rejects(request, (error) => error.name === 'AbortError');
  await flush();
  controller.abort();
  await rejected;
  assert.equal(calls, 0);
  release();
  await flush();
  assert.equal(calls, 0);
});

test('发送前能力检查不返回时，总时限结束仍会结算并清理侧栏控制器', { timeout: 2000 }, async () => {
  const time = clock();
  let calls = 0;
  const context = loadCore(async () => { calls++; return response(500); }, time.globals);
  const sent = [];
  const run = { modelLabel: 'Mock', finished: false, stopRequested: false, modelControllers: new Map(), runId: 'run', port: { postMessage: (item) => sent.push(item) } };
  context.activeRun = run;
  context.runtimeMessage = () => new Promise(() => {});
  const sidepanel = source('sidepanel.js');
  vm.runInContext(sidepanel.slice(sidepanel.indexOf('async function handleModelRequest('), sidepanel.indexOf('\nfunction stopRun(')), context);
  const request = context.handleModelRequest(run, { cfg: config, requestId: 'request', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,TEST' } }] }] });
  await time.advance(context.ViasCore.MODEL_REQUEST_POLICY.totalTimeoutMs);
  await request;
  assert.equal(calls, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].error, /总时限/);
  assert.equal(run.modelControllers.size, 0);
  assert.equal(time.pending.size, 0);
});

test('接口地址或模型名变更后，旧图片请求不再发送', async () => {
  let calls = 0;
  const context = loadCore(async () => { calls++; return response(500); });
  const sent = [];
  const run = { modelLabel: 'Mock', finished: false, stopRequested: false, modelControllers: new Map(), runId: 'run', port: { postMessage: (item) => sent.push(item) } };
  context.activeRun = run;
  context.runtimeMessage = async () => ({ ok: true, models: [{ id: config.id, vision: true, baseUrl: 'https://replacement.example.test/v1', model: 'replacement' }] });
  const sidepanel = source('sidepanel.js');
  vm.runInContext(sidepanel.slice(sidepanel.indexOf('async function handleModelRequest('), sidepanel.indexOf('\nfunction stopRun(')), context);
  await context.handleModelRequest(run, { cfg: config, requestId: 'request', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,TEST' } }] }] });
  assert.equal(calls, 0);
  assert.match(sent[0].error, /配置已变更/);
});

test('真实侧栏请求路径在重试前复核视觉授权，关闭后不发送第二次图片', async () => {
  const time = clock();
  let calls = 0;
  let allowed = true;
  const context = loadCore(async () => { calls++; allowed = false; return response(503); }, time.globals);
  const sent = [];
  const run = { modelLabel: 'Mock', finished: false, stopRequested: false, modelControllers: new Map(), runId: 'run', port: { postMessage: (item) => sent.push(item) } };
  context.activeRun = run;
  context.runtimeMessage = async () => ({ ok: true, models: [{ id: config.id, vision: allowed, baseUrl: config.baseUrl, model: config.model }] });
  const sidepanel = source('sidepanel.js');
  vm.runInContext(sidepanel.slice(sidepanel.indexOf('async function handleModelRequest('), sidepanel.indexOf('\nfunction stopRun(')), context);
  const request = context.handleModelRequest(run, { cfg: config, requestId: 'request', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,TEST' } }] }] });
  await flush();
  await time.advance(500);
  await request;
  assert.equal(calls, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].error, /未启用图片能力/);
  assert.ok(!JSON.stringify(sent).includes(config.apiKey));
  assert.equal(time.pending.size, 0);
  assert.equal(run.modelControllers.size, 0);
});

function backgroundHarness(reply) {
  let serial = 0;
  const executions = [];
  const extracts = [];
  const events = [];
  const state = { models: [{ ...config, vision: false }], activeModelId: config.id, systemPrompt: 'Local test', settingsRevision: 1 };
  const snapshot = () => ({ snapshotId: `document:${++serial}`, url: 'https://page.example.test/', title: 'Fixture', text: `Page ${serial}`, images: [], targets: { 1: '[1] Next', 2: '[2] Notes' }, targetMeta: { 1: { tag: 'button', submitsForm: false, inForm: false }, 2: { tag: 'textarea', inForm: true, submitsForm: false } } });
  const event = () => ({ addListener() {}, removeListener() {} });
  const context = vm.createContext({
    URL, crypto: webcrypto, console, AbortController, TypeError, Date, setTimeout, clearTimeout, setInterval, clearInterval,
    chrome: {
      sidePanel: { setPanelBehavior: async () => {} },
      storage: { local: { get: async (keys) => Array.isArray(keys) ? state : { ...keys, ...state }, set: async () => {}, remove: async () => {} } },
      tabs: {
        onCreated: event(), onRemoved: event(), onUpdated: event(), get: async () => ({ id: 1, status: 'complete', url: 'https://page.example.test/' }),
        sendMessage: async (_id, message) => {
          if (message.type === 'EXTRACT') { extracts.push(message); return snapshot(); }
          if (message.type === 'EXECUTE') { executions.push(message); return { results: [{ ok: executions.length > 1, msg: 'Local result' }], page: snapshot() }; }
        },
      },
      scripting: { executeScript: async () => {} },
      runtime: { onConnect: event(), onMessage: event(), id: 'mock', getURL: (file) => `chrome-extension://mock/${file}` },
    },
  });
  context.importScripts = () => vm.runInContext(source('core.js'), context);
  vm.runInContext(source('background.js'), context);
  let round = 0;
  context.requestModel = async () => JSON.stringify(reply(++round));
  const run = context.createRun({ postMessage: (item) => events.push(item) }, 'test-run', 1);
  return { context, executions, extracts, events, start: () => context.agentLoop(run, 'Complete local task', { allowActions: true }) };
}

test('长填写值和边界内 selector 原样保留，超限整批拒绝，数组和 repeat 同样检查', () => {
  const h = backgroundHarness(() => ({}));
  const value = '😀'.repeat(20000) + 'TAIL';
  assert.equal(h.context.validateAction({ action: 'click', ref: 100001 }).ref, 100001);
  assert.equal(h.context.validateAction({ action: 'click', ref: Number.MAX_SAFE_INTEGER }).ref, Number.MAX_SAFE_INTEGER);
  assert.throws(() => h.context.validateAction({ action: 'click', ref: Number.MAX_SAFE_INTEGER + 1 }), /ref/);
  assert.throws(() => h.context.validateActions([{ action: 'fill', ref: true, value: { text: 'expected' } }, { action: 'submitForm', ref: 2 }]), /ref/);
  assert.throws(() => h.context.validateAction({ action: 'fill', ref: 1 }), /value/);
  assert.throws(() => h.context.validateAction({ action: 'fill', ref: 1, value: { text: 'expected' } }), /value/);
  assert.equal(h.context.validateAction({ action: 'fill', ref: 1, value: '' }).value, '');
  assert.equal(h.context.validateAction({ action: 'fill', ref: 1, value }).value, value);
  assert.equal(h.context.validateAction({ action: 'fill', ref: 1, value: 'x'.repeat(200000) }).value.length, 200000);
  assert.equal(h.context.validateAction({ action: 'click', selector: 'a'.repeat(1000) }).selector.length, 1000);
  assert.throws(() => h.context.validateActions([{ action: 'click', ref: 1 }, { action: 'fill', ref: 1, value: 'x'.repeat(200001) }]), /value.*200000/);
  assert.throws(() => h.context.validateAction({ action: 'click', selector: 'a'.repeat(1001) }), /selector/);
  assert.throws(() => h.context.validateAction({ action: 'select', ref: 1, value: ['ok', 'x'.repeat(200001)] }), /value/);
  assert.throws(() => h.context.validateAction({ action: 'repeat', times: 2, actions: [{ action: 'fill', ref: 1, value: 'x'.repeat(200001) }] }), /value/);
});

for (const action of [
  { action: 'click', selector: '#submit' },
  { action: 'dblclick', selector: '#submit' },
  { action: 'press', value: ' Enter ' },
  { action: 'press', selector: '#field', value: ' Enter ' },
  { action: 'repeat', times: 2, actions: [{ action: 'click', selector: '#submit' }] },
  { action: 'repeat', times: 2, actions: [{ action: 'press', value: 'Enter' }] },
]) {
  test(`零成功后的 ${JSON.stringify(action)} 先重读一次，之后可继续执行`, async () => {
    const h = backgroundHarness((round) => round === 1 ? { actions: [{ action: 'click', ref: 1 }] }
      : round < 4 ? { actions: [action] } : { say: 'Finished', done: true, actions: [] });
    assert.equal((await h.start()).outcome, 'completed');
    assert.equal(h.executions.length, 2);
    assert.equal(h.extracts.length, 2);
    assert.ok(h.events.some((item) => item.t === 'status' && item.text.includes('提交前重新读取')));
  });
}

test('重复检测用稳定目标身份，ref刷新不绕过熔断且不同节点不合并', () => {
  const { context } = backgroundHarness(() => ({}));
  const before = { targetMeta: { 1: { identity: 'doc:target-1' } } };
  const after = { targetMeta: { 8: { identity: 'doc:target-1' }, 9: { identity: 'doc:target-2' } } };
  const key = context.operationKeyOf([{ action: 'click', ref: 1 }], before);
  assert.equal(context.operationKeyOf([{ action: 'click', ref: 8 }], after), key);
  assert.notEqual(context.operationKeyOf([{ action: 'click', ref: 9 }], after), key);
  assert.equal(context.operationKeyOf([{ action: 'repeat', times: 2, actions: [{ action: 'click', ref: 1 }] }], before),
    context.operationKeyOf([{ action: 'repeat', times: 2, actions: [{ action: 'click', ref: 8 }] }], after));
  assert.notEqual(context.operationKeyOf([{ action: 'click', ref: 1 }], {}), context.operationKeyOf([{ action: 'click', ref: 8 }], {}));
});

test('失败后的非提交控件和 textarea 换行不会被多余拦截', () => {
  const { context } = backgroundHarness(() => ({}));
  const page = { targetMeta: { 1: { tag: 'button', submitsForm: false, inForm: false }, 2: { tag: 'textarea', inForm: true } } };
  assert.equal(context.batchTouchesSubmit([{ action: 'click', ref: 1 }], page), false);
  assert.equal(context.batchTouchesSubmit([{ action: 'press', ref: 2, value: ' Enter ' }], page), false);
});
