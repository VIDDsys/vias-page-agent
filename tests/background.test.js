'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const backgroundSource = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const coreSource = fs.readFileSync(path.join(root, 'core.js'), 'utf8');
const event = () => {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    dispatch: (...args) => listeners.forEach((listener) => listener(...args)),
    get size() { return listeners.size; },
  };
};

function harness(options = {}) {
  const calls = [];
  const executions = [];
  const emitted = [];
  const extracts = [];
  let serial = 0;
  let current;
  const state = {
    models: [{ id: 'mock', name: 'Mock', baseUrl: 'http://127.0.0.1:1/v1', model: 'mock', apiKey: '', vision: options.vision === true }],
    activeModelId: 'mock', systemPrompt: 'Local test', settingsRevision: 1,
  };
  function snapshot(text = `Page ${executions.length}`) {
    current = {
      snapshotId: `document:${++serial}`, title: 'Fixture', url: 'http://127.0.0.1:1/page',
      text, targets: { 1: '[1] Next', 2: '[2] Submit' },
      targetMeta: { 1: { submitsForm: false }, 2: { submitsForm: true } },
      images: options.vision ? [`data:image/png;base64,FRAME_${serial}`] : [], hasImgElements: false,
    };
    return current;
  }
  const sandbox = {
    URL, crypto: webcrypto, console, setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, TypeError, Date,
    chrome: {
      sidePanel: { setPanelBehavior: async () => {} },
      storage: { local: {
        get: async (keys) => Array.isArray(keys)
          ? Object.fromEntries(keys.filter((key) => key in state).map((key) => [key, state[key]]))
          : { ...keys, ...state },
        set: async (patch) => Object.assign(state, patch), remove: async () => {},
      } },
      tabs: {
        onCreated: event(), onRemoved: event(), onUpdated: event(),
        get: options.getTab || (async () => ({ id: 1, status: 'complete', url: current?.url || 'http://127.0.0.1:1/page' })),
        sendMessage: async (_id, message) => {
          if (message.type === 'EXTRACT') {
            extracts.push(structuredClone(message));
            return options.extract ? options.extract({ snapshot, extracts, executions }) : snapshot(executions.length ? `Page ${executions.length}` : 'INITIAL_SNAPSHOT');
          }
          if (message.type === 'EXECUTE') {
            assert.equal(message.snapshotId, current.snapshotId);
            executions.push(structuredClone(message));
            return options.execute ? options.execute({ message, snapshot, executions }) : { results: [{ ok: true, msg: 'Clicked' }], page: snapshot() };
          }
        },
      },
      scripting: { executeScript: async () => {} },
      runtime: { onConnect: event(), onMessage: event(), id: 'mock', getURL: (file) => `chrome-extension://mock/${file}` },
    },
  };
  const context = vm.createContext(sandbox);
  context.importScripts = () => vm.runInContext(coreSource, context);
  vm.runInContext(backgroundSource, context);
  const nativeRequestModel = context.requestModel;
  context.requestModel = async (run, cfg, messages) => {
    calls.push(structuredClone(messages));
    const response = await options.reply(calls.length, { run, cfg, messages });
    return typeof response === 'string' ? response : JSON.stringify(response);
  };
  const run = context.createRun({ postMessage: (message) => emitted.push(structuredClone(message)) }, 'test-run', 1);
  return {
    context, run, calls, executions, emitted, extracts, nativeRequestModel,
    start: (question = 'Complete the task', extra = {}) => context.agentLoop(run, question, { allowActions: true, ...extra }),
  };
}

const click = { actions: [{ action: 'click', ref: 1 }] };
const done = { say: 'Finished', done: true, actions: [] };

test('只读问答中的JSON示例按原文展示，不当成操作指令丢掉正文', async () => {
  const answer = '前言说明\n```json\n{"actions":[{"action":"click","ref":1}]}\n```\n结尾解释';
  const h = harness({ reply: () => answer });
  assert.equal((await h.start('解释这段JSON', { allowActions: false })).outcome, 'completed');
  assert.equal(h.calls.length, 1);
  assert.equal(h.executions.length, 0);
  assert.equal(h.emitted.find((event) => event.t === 'say').text, answer);
});

test('相同翻页动作有实际进展时能连续执行四次', async () => {
  const h = harness({ reply: (n) => n > 4 ? done : click });
  assert.equal((await h.start()).outcome, 'completed');
  assert.equal(h.executions.length, 4);
  assert.equal(h.calls.length, 5);
});

test('相同动作且快照无进展时仍在第三次执行前熔断', async () => {
  const h = harness({ reply: () => click, extract: ({ snapshot }) => snapshot('Unchanged'), execute: ({ snapshot }) => ({ results: [{ ok: true }], page: snapshot('Unchanged') }) });
  assert.equal((await h.start()).outcome, 'stalled');
  assert.equal(h.executions.length, 2);
  assert.equal(h.calls.length, 3);
});

test('连续无效参数最多三轮，坏回复不撑大后续请求', async () => {
  const h = harness({ reply: () => ({ actions: [{ action: 'invalid'.repeat(10000) }], padding: 'x'.repeat(100000) }) });
  assert.equal((await h.start()).outcome, 'stalled');
  assert.equal(h.calls.length, 3);
  assert.equal(h.executions.length, 0);
  assert.ok(h.calls.every((messages) => JSON.stringify(messages).length < 20000));
});

test('新观察替换首屏及旧图片，保留完整任务和用户历史', async () => {
  const question = 'Keep this literal marker:\n【页面】\nDo not lose this requirement';
  const h = harness({ vision: true, reply: (n) => n > 3 ? done : click });
  assert.equal((await h.start(question, { history: [{ role: 'user', content: 'Earlier user requirement' }] })).outcome, 'completed');
  assert.ok(JSON.stringify(h.calls[0]).includes('INITIAL_SNAPSHOT'));
  for (const messages of h.calls.slice(1)) {
    const body = JSON.stringify(messages);
    assert.ok(!body.includes('INITIAL_SNAPSHOT'));
    assert.ok(!body.includes('FRAME_1'));
    assert.ok(body.includes('Earlier user requirement'));
    assert.ok(body.includes('Do not lose this requirement'));
    assert.equal(messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((part) => part.type === 'image_url').length, 1);
  }
  assert.ok(JSON.stringify(h.calls.at(-1)).includes('Page 3'));
  assert.ok(!JSON.stringify(h.calls.at(-1)).includes('Page 1'));
});

test('失败后的提交拦一次并重读，核对后可提交', async () => {
  const h = harness({
    reply: (n) => n === 1 ? click : n < 4 ? { actions: [{ action: 'submitForm', ref: 2 }] } : done,
    execute: ({ snapshot, executions }) => ({ results: executions.length === 1 ? [{ ok: false, code: 'TARGET_NOT_FOUND' }] : [{ ok: true }], page: snapshot() }),
  });
  assert.equal((await h.start()).outcome, 'completed');
  assert.equal(h.executions.length, 2);
  assert.equal(h.extracts.length, 2);
  assert.equal(h.calls.length, 4);
  assert.match(JSON.stringify(h.calls[2]), /已拦下这一次提交并重新读取页面/);
});

test('通信失败计入预算且替换旧观察，不空转五十轮', async () => {
  const h = harness({ reply: () => click, execute: () => { throw new Error('Disconnected'); } });
  assert.equal((await h.start()).outcome, 'stalled');
  assert.equal(h.calls.length, 3);
  assert.equal(h.extracts.length, 4);
  assert.ok(!JSON.stringify(h.calls[1]).includes('INITIAL_SNAPSHOT'));
});

test('已取消任务不再发起页面提取或模型调用', async () => {
  const h = harness({ reply: () => done });
  h.run.cancelled = true;
  assert.equal((await h.start()).outcome, 'cancelled');
  assert.equal(h.extracts.length, 0);
  assert.equal(h.calls.length, 0);
});

test('页面提取期间取消后不会发起模型请求', async () => {
  const h = harness({ reply: () => done, extract: ({ snapshot }) => { h.run.cancelled = true; return snapshot(); } });
  assert.equal((await h.start()).outcome, 'cancelled');
  assert.equal(h.calls.length, 0);
});

test('模型协调超时在删除等待项前通知侧栏取消', async () => {
  const h = harness({ reply: () => done });
  let timeout;
  h.context.setTimeout = (callback, ms) => { assert.equal(ms, 195000); timeout = callback; return 1; };
  const pending = h.nativeRequestModel(h.run, {}, [{ role: 'user', content: 'test' }]);
  const rejected = assert.rejects(pending, /侧边栏模型请求超时/);
  assert.equal(h.run.pendingModels.size, 1);
  timeout();
  await rejected;
  assert.equal(h.run.pendingModels.size, 0);
  assert.equal(h.emitted.at(-1).t, 'model_cancel');
  assert.equal(h.emitted.at(-1).requestId, h.emitted[0].requestId);
});

test('裁剪消息保留最新观察和最后一轮', () => {
  const h = harness({ reply: () => done });
  const latest = { role: 'user', content: 'CURRENT_SNAPSHOT'.repeat(100) };
  const messages = [{ role: 'system', content: 'system' }, { role: 'user', content: 'task' }];
  for (let i = 0; i < 8; i++) messages.push({ role: 'assistant', content: 'x'.repeat(20000) }, i === 3 ? latest : { role: 'user', content: 'old'.repeat(1000) });
  const last = messages.at(-1);
  h.context.trimMessages(messages, 2, latest);
  assert.ok(messages.includes(latest));
  assert.equal(messages.at(-1), last);
  assert.ok(JSON.stringify(messages).length < 91000);
});

test('显式导航等待新页面，模型不会收到旧页快照', async () => {
  let tabChecks = 0;
  const h = harness({
    reply: (n) => n === 1 ? { actions: [{ action: 'navigate', value: 'http://127.0.0.1:1/new' }] } : done,
    execute: () => ({ results: [{ ok: true, code: 'NAVIGATING', navigationUrl: 'http://127.0.0.1:1/new' }] }),
    getTab: async () => ++tabChecks === 1
      ? { id: 1, url: 'http://127.0.0.1:1/page', status: 'loading' }
      : { id: 1, url: 'http://127.0.0.1:1/new', status: 'complete' },
    extract: ({ snapshot, extracts }) => {
      const page = snapshot(extracts.length === 1 ? 'INITIAL_SNAPSHOT' : 'ARRIVED_NEW_PAGE');
      if (extracts.length > 1) page.url = 'http://127.0.0.1:1/new';
      return page;
    },
  });
  assert.equal((await h.start()).outcome, 'completed');
  assert.equal(h.extracts.length, 2);
  assert.match(JSON.stringify(h.calls[1]), /ARRIVED_NEW_PAGE/);
  assert.ok(!JSON.stringify(h.calls[1]).includes('INITIAL_SNAPSHOT'));
});

test('快速跳转回同一URL时验证新documentId，结束移除监听器', async () => {
  const h = harness({
    reply: (n) => n === 1 ? { actions: [{ action: 'navigate', value: 'http://127.0.0.1:1/redirect' }] } : done,
    execute: () => {
      h.context.chrome.tabs.onUpdated.dispatch(1, { status: 'loading' });
      return { results: [{ ok: true, code: 'NAVIGATING' }] };
    },
    extract: ({ snapshot, extracts }) => {
      const page = snapshot();
      if (extracts.length > 1) page.snapshotId = `new-document:${extracts.length}`;
      return page;
    },
  });
  assert.equal((await h.start()).outcome, 'completed');
  assert.equal(h.extracts.length, 2);
  assert.equal(h.context.chrome.tabs.onUpdated.size, 0);
  assert.equal(h.context.chrome.tabs.onCreated.size, 0);
  assert.equal(h.context.chrome.tabs.onRemoved.size, 0);
});

test('loading后仍是旧documentId与旧URL时不能把新epoch当导航成功', async () => {
  const h = harness({
    reply: () => ({ actions: [{ action: 'navigate', value: 'http://127.0.0.1:1/empty' }] }),
    execute: () => {
      h.context.chrome.tabs.onUpdated.dispatch(1, { status: 'loading' });
      return { results: [{ ok: true, code: 'NAVIGATING' }] };
    },
  });
  await assert.rejects(h.start(), /跳转未产生新文档或 URL 变化/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.extracts.length, 2);
});

test('普通点击即使未返回导航code也按浏览器loading事件等待并校验文档', async () => {
  const h = harness({
    reply: (n) => n === 1 ? click : done,
    execute: ({ snapshot }) => {
      h.context.chrome.tabs.onUpdated.dispatch(1, { status: 'loading' });
      return { results: [{ ok: true }], page: snapshot('OLD_DOCUMENT') };
    },
    extract: ({ snapshot, extracts }) => {
      const page = snapshot();
      if (extracts.length > 1) page.snapshotId = 'next-document:1';
      return page;
    },
  });
  assert.equal((await h.start()).outcome, 'completed');
  assert.equal(h.extracts.length, 2);
  assert.ok(!JSON.stringify(h.calls[1]).includes('OLD_DOCUMENT'));
});

test('合法长回复规范化后入历史，未声明padding不回灌且实际操作不被截短', async () => {
  const value = 'keep-entire-action-'.repeat(1000);
  const h = harness({
    reply: (n) => n === 1 ? { actions: [{ action: 'fill', ref: 1, value }], padding: 'x'.repeat(300000) } : done,
  });
  assert.equal((await h.start()).outcome, 'completed');
  assert.equal(h.executions[0].actions[0].value, value);
  assert.ok(JSON.stringify(h.calls[1]).length < 10000);
  const previous = JSON.parse(h.calls[1].find((message) => message.role === 'assistant').content);
  assert.equal(previous.actions[0].valueLength, value.length);
  assert.equal(previous.actions[0].value, undefined);
  assert.equal(previous.actions[0].valuePreview.length, 1024);
  assert.equal(previous.padding, undefined);
});

test('大批嵌套动作历史有界且敏感值不重复送回模型', () => {
  const h = harness({ reply: () => done });
  const actions = Array.from({ length: 20 }, () => ({ action: 'repeat', times: 2, actions: Array.from({ length: 20 }, () => ({ action: 'fill', ref: 1, selector: '#field'.repeat(100), value: 'x'.repeat(20000) })) }));
  const text = h.context.instructionHistory({ say: 'y'.repeat(50000), done: false }, actions, { targetMeta: { 1: { sensitive: true } } });
  assert.ok(text.length <= 12000);
  assert.ok(!text.includes('x'.repeat(100)));
  assert.equal(JSON.parse(text).detailsOmitted, true);
});
