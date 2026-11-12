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
    AbortController, TypeError, Date, Blob, btoa,
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
            return options.extract ? options.extract({ message, snapshot, extracts, executions }) : snapshot(executions.length ? `Page ${executions.length}` : 'INITIAL_SNAPSHOT');
          }
          if (message.type === 'READ_SEGMENT') {
            return options.read ? options.read({ message, current, snapshot, executions }) : { code: 'INVALID_SEGMENT' };
          }
          if (message.type === 'READ_IMAGES') return options.readImages ? options.readImages(message) : { code: 'INVALID_IMAGE' };
          if (message.type === 'VERIFY_IMAGES') return options.verifyImages ? options.verifyImages(message) : { results: message.ids.map((id) => ({ id, ok: true })) };
          if (message.type === 'CANCEL_IMAGES') return { ok: true };
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
    context, run, calls, executions, emitted, extracts, nativeRequestModel, state,
    start: (question = 'Complete the task', extra = {}) => context.agentLoop(run, question, { allowActions: true, ...extra }),
  };
}

test('同快照跨段总结保留首段事实，重复读取去重且超预算须先提交累计notes', async () => {
  const first = '首段关键事实：项目预算37万元。' + 'a'.repeat(31960);
  const second = '第二段关键事实：截止周五。' + 'b'.repeat(31960);
  const third = '第三段关键事实：负责人林。' + 'c'.repeat(31960);
  const h = harness({
    extract: ({ snapshot }) => Object.assign(snapshot(first), { index: 0, segmentCount: 3, signature: 'stable' }),
    read: ({ current, message }) => ({ ...current, index: message.index, text: message.index === 1 ? second : third }),
    reply: (n, { messages }) => {
      const body = JSON.stringify(messages);
      if (n === 1 || n === 2) return { vias_read: { kind: 'segment', snapshotId: 'document:1', index: 1 } };
      if (n === 3) {
        assert.equal(body.split('首段关键事实').length - 1, 1);
        assert.equal(body.split('第二段关键事实').length - 1, 1);
        return { vias_read: { kind: 'segment', snapshotId: 'document:1', index: 2 } };
      }
      if (n === 4) {
        assert.match(body, /READING_NOTES_REQUIRED/);
        assert.match(body, /预算37万元/);
        return { vias_read: { kind: 'segment', snapshotId: 'document:1', index: 2, notes: '首段预算37万元；第二段截止周五；用户要求汇总三段。' } };
      }
      assert.match(body, /预算37万元/); assert.match(body, /截止周五/); assert.match(body, /负责人林/);
      assert.match(body, /原文已省略的已读分段：0/);
      assert.ok(body.length < 90000);
      return '预算37万元，周五截止，负责人林。';
    },
  });
  assert.equal((await h.start('汇总三段，不遗漏首段预算', { allowActions: false, maxSteps: 1 })).outcome, 'completed');
  assert.equal(h.calls.length, 5); assert.equal(h.executions.length, 0);
});

for (const allowActions of [false, true]) {
  test(`${allowActions ? '执行' : '问答'}仅明确选择已展示图片才发图，后续分段/动作不重复保留`, async () => {
    let imageRequests = 0;
    const h = harness({
      vision: true,
      extract: ({ snapshot }) => Object.assign(snapshot('文字事实'), { imageCandidates: [{ id: 2, alt: '题目图' }], index: 0, segmentCount: 2 }),
      read: ({ current }) => ({ ...current, index: 1, text: '后续事实' }),
      readImages: (message) => {
        imageRequests++; assert.deepEqual([...message.ids], [2]);
        return { results: [{ id: 2, ok: true, dataUrl: 'data:image/jpeg;base64,YQ==' }] };
      },
      reply: (n, { messages }) => {
        const images = messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((p) => p.type === 'image_url');
        assert.equal(images.length, n === 2 ? 1 : 0);
        if (n === 1) return { vias_read: { kind: 'images', snapshotId: 'document:1', ids: [2] } };
        if (n === 2) return { vias_read: { kind: 'segment', snapshotId: 'document:1', index: 1 } };
        return allowActions ? { say: '完成', actions: [], done: true } : '图片与正文总结';
      },
    });
    assert.equal((await h.start('识别题目图', { allowActions, maxSteps: 1 })).outcome, 'completed');
    assert.equal(imageRequests, 1); assert.equal(h.calls.length, 3);
  });
}

test('能力关闭、过期快照与未展示图片不会调用页面读图；伪装JSON示例不读取', async () => {
  for (const reason of ['disabled', 'stale', 'unknown', 'example']) {
    let reads = 0;
    const request = { vias_read: { kind: 'images', snapshotId: reason === 'stale' ? 'old' : 'document:1', ids: [reason === 'unknown' ? 9 : 2] } };
    const h = harness({ vision: reason !== 'disabled',
      extract: ({ snapshot }) => Object.assign(snapshot(), { imageCandidates: [{ id: 2 }] }),
      readImages: () => { reads++; throw new Error('不应调用'); },
      reply: (n) => n === 1 ? reason === 'example' ? `示例\n\`\`\`json\n${JSON.stringify(request)}\n\`\`\`` : request : '回答',
    });
    assert.equal((await h.start('说明', { allowActions: false })).outcome, 'completed');
    assert.equal(reads, 0);
    assert.equal(h.calls.length, reason === 'example' ? 1 : 2);
    assert.ok(!JSON.stringify(h.calls).includes('data:image/'));
  }
});

test('图片读取有独立8次预算，失败也计次且不执行页面动作', async () => {
  const h = harness({ vision: true,
    extract: ({ snapshot }) => Object.assign(snapshot(), { imageCandidates: [{ id: 1 }] }),
    reply: () => ({ vias_read: { kind: 'images', snapshotId: 'document:1', ids: [1] } }),
  });
  assert.equal((await h.start('读取', { allowActions: false, maxSteps: 1 })).outcome, 'limit');
  assert.equal(h.calls.length, 9); assert.equal(h.executions.length, 0);
});

test('问答裸读取信封损坏时有限修复且不显示原始JSON，代码块示例仍原样', async () => {
  const bad = '{"vias_read":{"kind":"images","snapshotId":"document:1","ids":[1,]}}';
  const h = harness({ reply: (n) => n === 1 ? bad : '修复后回答' });
  assert.equal((await h.start('问答', { allowActions: false, maxSteps: 1 })).outcome, 'completed');
  assert.equal(h.calls.length, 2);
  assert.ok(!JSON.stringify(h.emitted).includes(bad));
  const stalled = harness({ reply: () => bad });
  assert.equal((await stalled.start('问答', { allowActions: false })).outcome, 'stalled');
  assert.equal(stalled.calls.length, 3);
});

function pngHeader(width, height) {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x89504e47); view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(16, width); view.setUint32(20, height);
  return bytes;
}

test('后台所选下载响应头/流式体积/解码前像素/编码后大小有界，跨域无凭据', async () => {
  const h = harness({ reply: () => 'unused' });
  let decodes = 0;
  let closed = 0;
  h.context.createImageBitmap = async () => { decodes++; return { width: 32, height: 32, close: () => closed++ }; };
  h.context.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return { drawImage() {} }; }
    async convertToBlob() { return new Blob(['encoded'], { type: 'image/jpeg' }); }
  };
  for (const kind of ['header', 'stream', 'pixels', 'encoding', 'valid']) {
    h.context.fetch = async (url, options) => {
      assert.equal(url, 'https://cdn.example.test/selected.png');
      assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'follow');
      if (kind === 'header') return new Response('x', { headers: { 'content-type': 'image/png', 'content-length': '4194305' } });
      if (kind === 'stream') return new Response(new Uint8Array(4194305), { headers: { 'content-type': 'image/png' } });
      return new Response(pngHeader(kind === 'pixels' ? 5000 : 32, kind === 'pixels' ? 4000 : 32), { headers: { 'content-type': 'image/png' } });
    };
    if (kind === 'encoding') h.context.OffscreenCanvas.prototype.convertToBlob = async () => new Blob([new Uint8Array(400000)], { type: 'image/jpeg' });
    if (kind === 'valid') h.context.OffscreenCanvas.prototype.convertToBlob = async () => new Blob(['ok'], { type: 'image/jpeg' });
    const read = h.context.fetchSelectedImage('https://cdn.example.test/selected.png', new AbortController().signal, { bytes: 0 });
    if (kind === 'valid') assert.match(await read, /^data:image\/jpeg;base64,/);
    else await assert.rejects(read, (error) => error.code === ({ header: 'DOWNLOAD_LIMIT', stream: 'DOWNLOAD_LIMIT', pixels: 'PIXEL_LIMIT', encoding: 'ENCODED_LIMIT' })[kind]);
    if (['header', 'stream', 'pixels'].includes(kind)) assert.equal(decodes, 0, '解码前必须拒绝超体积或超像素源');
  }
  assert.equal(decodes, 2); assert.equal(closed, 2);
});

test('非成功图片响应立即取消未使用流，不等待挂起的cancel清理', async () => {
  const h = harness({ reply: () => 'unused' });
  let cancelled = 0;
  h.context.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }), { status: 403 });
  const result = h.context.fetchSelectedImage('https://cdn.example.test/selected.png', new AbortController().signal, { bytes: 0 });
  await assert.rejects(result, (error) => error.code === 'IMAGE_UNREADABLE');
  assert.equal(cancelled, 1);
});

test('图片下载总字节预算累加，任务取消/总时限会结算挂起读取并清理迟到bitmap', async () => {
  const h = harness({ reply: () => 'unused' });
  h.context.fetch = async () => new Response(pngHeader(32, 32), { headers: { 'content-type': 'image/png', 'content-length': '24' } });
  await assert.rejects(h.context.fetchSelectedImage('https://cdn.example.test/selected.png', new AbortController().signal, { bytes: 8388600 }), (error) => error.code === 'DOWNLOAD_LIMIT');
  let resolveLate;
  let closed = 0;
  const late = new Promise((resolve) => { resolveLate = resolve; });
  const ctrl = new AbortController();
  const pending = h.context.imageWait(late, ctrl.signal, (value) => value.close());
  ctrl.abort('CANCELLED');
  await assert.rejects(pending, (error) => error.code === 'CANCELLED');
  resolveLate({ close: () => closed++ }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 1);
  h.context.chrome.tabs.sendMessage = async () => new Promise(() => {});
  h.context.setTimeout = (callback, ms) => setTimeout(callback, ms === 8000 ? 1 : ms);
  const result = await h.context.selectedImages(h.run, { snapshotId: 'document:1', ids: [1] });
  assert.equal(result.images.length, 0); assert.equal(result.results[0].code, 'TIMEOUT');
  assert.equal(h.run.imageController, null);
});

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

test('只读问答可有界读取分段，普通 JSON 和代码块按原文显示且永不执行', async () => {
  const answer = '```json\n{"actions":[{"action":"click","ref":1}]}\n```';
  const h = harness({
    extract: ({ snapshot }) => Object.assign(snapshot('FIRST_SECRET'), { segmentCount: 2, index: 0, signature: 'same' }),
    read: ({ current }) => ({ ...current, index: 1, text: 'LATER_FACT', targets: {}, targetMeta: {} }),
    reply: (n) => n === 1 ? { vias_read: { kind: 'segment', snapshotId: 'document:1', index: 1 } } : answer,
  });
  assert.equal((await h.start('原始问题', { allowActions: false, maxSteps: 1 })).outcome, 'completed');
  assert.equal(h.calls.length, 2);
  assert.equal(h.executions.length, 0);
  assert.equal(h.emitted.find((item) => item.t === 'say').text, answer);
  assert.match(JSON.stringify(h.calls[1]), /LATER_FACT/);
  assert.match(JSON.stringify(h.calls[1]), /原始问题/);
  assert.match(JSON.stringify(h.calls[1]), /FIRST_SECRET/, '同一快照的首段事实必须在最终回答请求中保留');
  for (const text of ['{"vias_read":{"kind":"segment","snapshotId":"document:1","index":1},"note":"普通数据"}', '```json\n{"vias_read":{"kind":"segment","snapshotId":"document:1","index":1}}\n```', '{"actions":[{"action":"click","ref":1}]}']) {
    const other = harness({ reply: () => text });
    assert.equal((await other.start('解释', { allowActions: false, maxSteps: 1 })).outcome, 'completed');
    assert.equal(other.calls.length, 1);
    assert.equal(other.executions.length, 0);
    assert.equal(other.emitted.find((item) => item.t === 'say').text, text);
  }
});

test('执行模式读取分段不消耗动作轮数，且此前分段目标仍可执行', async () => {
  const h = harness({
    extract: ({ snapshot }) => Object.assign(snapshot('FIRST'), { segmentCount: 2, index: 0, signature: 'same' }),
    read: ({ current }) => ({ ...current, index: 1, text: 'SECOND', targets: { 3: '[3] Later' }, targetMeta: { 3: { submitsForm: false } } }),
    reply: (n) => n === 1 ? { vias_read: { kind: 'segment', snapshotId: 'document:1', index: 1 } } : n === 2 ? click : done,
  });
  assert.equal((await h.start('执行任务', { maxSteps: 2 })).outcome, 'completed');
  assert.equal(h.executions.length, 1);
  assert.equal(h.executions[0].actions[0].ref, 1);
  assert.match(JSON.stringify(h.calls[1]), /SECOND/);
});

test('读取次数独立有界，超限后停止且不执行动作', async () => {
  const h = harness({
    read: ({ current }) => ({ ...current, index: 0 }),
    reply: () => ({ vias_read: { kind: 'segment', snapshotId: 'document:1', index: 0 } }),
  });
  assert.equal((await h.start('读取', { allowActions: false, maxSteps: 1 })).outcome, 'limit');
  assert.equal(h.calls.length, 81);
  assert.equal(h.executions.length, 0);
});

for (const allowActions of [false, true]) {
  test(`${allowActions ? '执行' : '问答'}续读生成新快照、保留问题并替换旧窗口，读取不消耗回答/动作轮数`, async () => {
    const h = harness({
      extract: ({ message, snapshot }) => Object.assign(snapshot(message.continueSnapshotId ? 'NEXT_WINDOW' : 'OLD_WINDOW_SECRET'), {
        segmentCount: 1, index: 0, canContinue: !message.continueSnapshotId, truncated: message.continueSnapshotId ? '' : '达到快照总量上限',
      }),
      reply: (n, { messages }) => {
        if (n === 1) return { vias_read: { kind: 'continue', snapshotId: 'document:1', notes: '此前关键事实与完整用户约束' } };
        if (n === 2) {
          assert.match(messages.at(-1).content, /document:2/);
          assert.match(messages.at(-1).content, /NEXT_WINDOW/);
          assert.doesNotMatch(JSON.stringify(messages), /OLD_WINDOW_SECRET/);
          assert.match(JSON.stringify(messages), /完整原始任务/);
          return allowActions ? click : '续读后的回答';
        }
        return done;
      },
    });
    assert.equal((await h.start('完整原始任务', { allowActions, maxSteps: allowActions ? 2 : 1 })).outcome, 'completed');
    assert.equal(h.extracts.length, 2);
    assert.equal(h.extracts[1].continueSnapshotId, 'document:1');
    assert.equal(h.executions.length, allowActions ? 1 : 0);
    if (allowActions) assert.equal(h.executions[0].snapshotId, 'document:2');
  });
}

test('读取至第80次后仍可操作并完成，再次读取则有界停止', async () => {
  for (const overflow of [false, true]) {
    let reads = 0;
    const h = harness({
      read: ({ current }) => { reads++; return { ...current, index: 0 }; },
      reply: (n) => n <= 80 || overflow ? { vias_read: { kind: 'segment', snapshotId: 'document:1', index: 0 } } : n === 81 ? click : done,
    });
    assert.equal((await h.start('读取后继续执行', { maxSteps: 2 })).outcome, overflow ? 'limit' : 'completed');
    assert.equal(reads, 80);
    assert.equal(h.executions.length, overflow ? 0 : 1);
    assert.equal(h.calls.length, overflow ? 81 : 82);
  }
});

test('过期读取不会发给页面，错误回灌后可改读当前分段', async () => {
  let reads = 0;
  const h = harness({
    read: ({ current }) => { reads++; return { ...current, index: 0, text: 'CURRENT_CONTENT' }; },
    reply: (n) => n <= 2 ? { vias_read: { kind: 'segment', snapshotId: n === 1 ? 'old-snapshot' : 'document:1', index: 0 } } : '正常回答',
  });
  assert.equal((await h.start('原始问题', { allowActions: false, maxSteps: 1 })).outcome, 'completed');
  assert.equal(reads, 1);
  assert.match(h.calls[1].at(-1).content, /STALE_SNAPSHOT/);
  assert.match(h.calls[2].at(-1).content, /CURRENT_CONTENT/);
  assert.equal(h.executions.length, 0);
});

test('续读遇 DOM 变化立即停止，不把旧内容当作已读完且清理监听器', async () => {
  const h = harness({
    extract: ({ message, snapshot }) => message.continueSnapshotId
      ? { code: 'STALE_CONTINUATION', error: '页面内容已变化' }
      : Object.assign(snapshot('FIRST'), { canContinue: true, truncated: '达到快照总量上限' }),
    reply: () => ({ vias_read: { kind: 'continue', snapshotId: 'document:1', notes: '此前关键事实与完整用户约束' } }),
  });
  await assert.rejects(h.start('读取全部网页', { allowActions: false }), /页面已变化.*剩余内容未知/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.executions.length, 0);
  assert.equal(h.extracts.length, 2);
  for (const name of ['onCreated', 'onRemoved', 'onUpdated']) assert.equal(h.context.chrome.tabs[name].size, 0);
});

test('分段读取保留前轮失败状态及已读目标提交属性，提交硬闸仍先重读核对', async () => {
  const h = harness({
    read: ({ current }) => ({ ...current, index: 1, text: '[5] Later submit', targets: { 5: '[5] Later submit' }, targetMeta: { 5: { submitsForm: true } } }),
    execute: ({ snapshot }) => ({ results: [{ ok: false, code: 'TARGET_NOT_FOUND' }], page: snapshot('AFTER_FAILURE') }),
    reply: (n) => n === 1 ? { actions: [{ action: 'click', ref: 999 }] }
      : n === 2 ? { vias_read: { kind: 'segment', snapshotId: 'document:2', index: 1 } }
        : n === 3 ? { actions: [{ action: 'click', ref: 5 }] } : done,
  });
  assert.equal((await h.start()).outcome, 'completed');
  assert.equal(h.executions.length, 1, '读取后不能绕过零成功后的提交硬闸');
  assert.equal(h.extracts.length, 2);
  assert.match(h.calls.at(-1).at(-1).content, /已拦下这一次提交并重新读取页面/);
});

test('损坏协议不展示、不执行、不进入后续消息，修复后继续执行', async () => {
  const bad = '{"say":"LEAK_MARKER","actions":[{"action":"click","ref":1}],}';
  const h = harness({ reply: (n) => n === 1 ? bad : n === 2 ? { say: '进行中 {"actions":[{"action":"click","value":"EMBEDDED_MARKER"}]}', ...click } : done });
  const outcome = await h.start();
  assert.equal(outcome.outcome, 'completed');
  assert.equal(h.executions.length, 1);
  assert.equal(h.executions[0].actions[0].ref, 1);
  assert.ok(!JSON.stringify(h.emitted).includes('LEAK_MARKER'));
  assert.ok(!JSON.stringify(h.calls).includes('LEAK_MARKER'));
  assert.ok(!JSON.stringify([h.calls, h.emitted]).includes('EMBEDDED_MARKER'));
  assert.ok(h.emitted.some((event) => event.t === 'say' && event.text === '进行中'));
});

test('连续损坏协议三轮后停止，且无动作和原文泄漏', async () => {
  const h = harness({ reply: () => '{"say":"BROKEN_MARKER","actions":[}' });
  assert.equal((await h.start()).outcome, 'stalled');
  assert.equal(h.calls.length, 3);
  assert.equal(h.executions.length, 0);
  assert.ok(!JSON.stringify([h.calls, h.emitted]).includes('BROKEN_MARKER'));
  assert.ok(h.emitted.some((event) => event.t === 'say' && /无法解析/.test(event.text)));
});

test('无效操作参数不泄漏指令或未经验证的 say', async () => {
  const h = harness({ reply: (n) => n === 1 ? { say: 'INVALID_MARKER', actions: [{ action: 'INVALID_MARKER' }] } : done });
  assert.equal((await h.start()).outcome, 'completed');
  assert.equal(h.executions.length, 0);
  assert.ok(!JSON.stringify([h.calls, h.emitted]).includes('INVALID_MARKER'));
});

test('check/checkRadio 的 true 与省略 value 等价，整批及 repeat 子动作可执行', async () => {
  const h = harness({
    reply: (n) => n === 1 ? { actions: [
      { action: 'check', ref: 1, value: true },
      { action: 'checkRadio', ref: 2, value: true },
      { action: 'repeat', times: 1, actions: [{ action: 'check', ref: 1, value: true }, { action: 'checkRadio', ref: 2 }] },
    ] } : done,
  });
  assert.equal((await h.start()).outcome, 'completed');
  assert.equal(h.executions.length, 1);
  const actions = h.executions[0].actions;
  assert.deepEqual(actions, [
    { action: 'check', ref: 1 }, { action: 'checkRadio', ref: 2 },
    { action: 'repeat', times: 1, actions: [{ action: 'check', ref: 1 }, { action: 'checkRadio', ref: 2 }] },
  ]);
  assert.throws(() => h.context.validateActions([{ action: 'fill', ref: 1, value: true }]), /字符串或数字 value/);
});

for (const action of ['check', 'checkRadio']) {
  test(`${action} 的 false 拒绝整批，准确回灌索引和取消限制后可修正`, async () => {
    const h = harness({ reply: (n) => n === 1 ? { actions: [
      { action: 'check', ref: 1 }, { action, ref: 2, value: false },
    ] } : n === 2 ? { actions: [{ action, ref: 2, value: true }] } : done });
    assert.equal((await h.start()).outcome, 'completed');
    const feedback = h.calls[1].at(-1).content;
    assert.match(feedback, /actions\[1\]/);
    assert.match(feedback, /索引从0开始/);
    assert.match(feedback, new RegExp(`${action} 不支持取消选中`));
    assert.equal(h.executions.length, 1, '坏批次中的第一项也不能执行');
    assert.deepEqual(h.executions[0].actions, [{ action, ref: 2 }]);
  });
}

test('repeat 子动作参数失败回灌完整索引路径，不执行整个批次', async () => {
  const h = harness({ reply: (n) => n === 1 ? { actions: [
    { action: 'check', ref: 1 },
    { action: 'repeat', times: 1, actions: [{ action: 'check', ref: 1 }, { action: 'checkRadio', ref: 2, value: false }] },
  ] } : done });
  assert.equal((await h.start()).outcome, 'completed');
  assert.equal(h.executions.length, 0);
  assert.match(h.calls[1].at(-1).content, /actions\[1\]\.actions\[1\].*checkRadio 不支持取消选中/);
});

test('明确校验原因有界且不回显 action、selector、ref、value、times 或密钥', async () => {
  const secret = 'sk-validation-private-marker';
  const cases = [
    { action: secret.repeat(10000), value: secret },
    { action: 'check', ref: secret, value: secret },
    { action: 'check', ref: 1, selector: secret.repeat(100), value: secret },
    { action: 'check', ref: 1, value: { token: secret } },
    { action: 'repeat', times: secret, value: secret, actions: [{ action: 'check', ref: 1 }] },
  ];
  for (const invalid of cases) {
    const h = harness({ reply: (n) => n === 1 ? { say: secret, actions: [{ action: 'check', ref: 1 }, invalid] } : done });
    h.state.models[0].apiKey = secret;
    assert.equal((await h.start()).outcome, 'completed');
    assert.equal(h.executions.length, 0);
    const feedback = h.calls[1].at(-1).content;
    assert.match(feedback, /actions\[1\]/);
    assert.match(feedback, /校验原因/);
    assert.ok(feedback.length < 600, '校验回灌必须有界');
    assert.ok(!JSON.stringify([h.calls, h.emitted]).includes(secret), '无效输入与密钥不得进入模型历史或界面事件');
  }
});

for (const mixed of [false, true]) {
  test(`stale ${mixed ? '混合成功' : '全失败'}结果采用执行器同文档新快照及 ref，不重复 EXTRACT`, async () => {
    const h = harness({
      reply: (n) => n === 1 ? { actions: [{ action: 'check', ref: 1 }, { action: 'check', ref: 2 }] }
        : n === 2 ? { actions: [{ action: 'check', ref: 7 }] } : done,
      execute: ({ message, snapshot, executions }) => {
        if (executions.length === 2) {
          assert.equal(message.snapshotId, 'document:2');
          assert.equal(message.actions[0].ref, 7);
          return { results: [{ ok: true }], page: snapshot('FINISHED') };
        }
        const page = Object.assign(snapshot('EXECUTOR_FRESH [7] Updated option'), {
          targets: { 7: '[7] Updated option' }, targetMeta: { 7: { submitsForm: false } },
        });
        return { results: [{ ok: false, code: 'STALE_TARGET', msg: 'changed first' },
          mixed ? { ok: true, state: '已选中' } : { ok: false, code: 'STALE_TARGET', msg: 'changed second' }], page };
      },
    });
    assert.equal((await h.start()).outcome, 'completed');
    assert.equal(h.extracts.length, 1, '只能有初始 EXTRACT');
    assert.equal(h.executions.length, 2);
    assert.match(h.calls[1].at(-1).content, /EXECUTOR_FRESH \[7\] Updated option/);
    assert.match(h.calls[1].at(-1).content, /STALE_TARGET/);
    assert.equal(h.emitted.filter((event) => event.t === 'result' && event.round === 1).length, 2);
  });
}

test('stale 批次跟随新标签页时丢弃原标签页有效快照并重新读取', async () => {
  const h = harness({
    reply: (n) => n === 1 ? { actions: [{ action: 'check', ref: 1 }] } : done,
    getTab: async (id) => ({ id, status: 'complete', url: `http://127.0.0.1:1/${id === 2 ? 'new-tab' : 'page'}` }),
    extract: ({ snapshot, extracts }) => {
      const page = snapshot(extracts.length === 1 ? 'INITIAL' : 'NEW_TAB_FRESH');
      if (extracts.length > 1) { page.snapshotId = 'new-document:1'; page.url = 'http://127.0.0.1:1/new-tab'; }
      return page;
    },
    execute: ({ snapshot }) => {
      h.run.candidateTabs.push({ id: 2 });
      return { results: [{ ok: false, code: 'STALE_TARGET' }], page: snapshot('OLD_TAB_FRESH') };
    },
  });
  assert.equal((await h.start()).outcome, 'completed');
  assert.equal(h.run.activeTabId, 2);
  assert.equal(h.extracts.length, 2);
  assert.match(h.calls[1].at(-1).content, /NEW_TAB_FRESH/);
  assert.ok(!h.calls[1].at(-1).content.includes('OLD_TAB_FRESH'));
});

for (const invalidPage of ['missing', 'empty-id', 'old-snapshot', 'different-document', 'different-url']) {
  test(`stale 返回 ${invalidPage} 快照时重新 EXTRACT`, async () => {
    const h = harness({
      reply: (n) => n === 1 ? { actions: [{ action: 'check', ref: 1 }] } : done,
      extract: ({ snapshot, extracts }) => snapshot(extracts.length === 1 ? 'INITIAL' : 'FALLBACK_FRESH'),
      execute: ({ message, snapshot }) => {
        const page = snapshot('UNUSABLE_EXEC_PAGE');
        if (invalidPage === 'empty-id') page.snapshotId = '';
        if (invalidPage === 'old-snapshot') page.snapshotId = message.snapshotId;
        if (invalidPage === 'different-document') page.snapshotId = 'other-document:1';
        if (invalidPage === 'different-url') page.url = 'http://127.0.0.1:1/other';
        return { results: [{ ok: false, code: 'STALE_TARGET' }], ...(invalidPage === 'missing' ? {} : { page }) };
      },
    });
    assert.equal((await h.start()).outcome, 'completed');
    assert.equal(h.extracts.length, 2);
    assert.match(h.calls[1].at(-1).content, /FALLBACK_FRESH/);
    assert.ok(!h.calls[1].at(-1).content.includes('UNUSABLE_EXEC_PAGE'));
  });
}

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
    assert.equal(messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((part) => part.type === 'image_url').length, 0, '仅启用能力不能自动附图');
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
