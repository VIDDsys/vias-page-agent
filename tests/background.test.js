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
  const pageMessages = [];
  const session = structuredClone(options.session || {});
  const removedSessionKeys = [];
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
    AbortController, TypeError, Date, Blob, btoa, TextEncoder,
    chrome: {
      sidePanel: { setPanelBehavior: async () => {} },
      ...(options.navigationSource ? { webNavigation: { onCreatedNavigationTarget: event() } } : {}),
      ...(options.session ? { windows: { onRemoved: event() } } : {}),
      storage: { ...(options.session ? { session: { remove: async (key) => { removedSessionKeys.push(key); delete session[key]; } } } : {}), local: {
        get: async (keys) => Array.isArray(keys)
          ? Object.fromEntries(keys.filter((key) => key in state).map((key) => [key, state[key]]))
          : { ...keys, ...state },
        set: async (patch) => Object.assign(state, patch), remove: async () => {},
      } },
      tabs: {
        onCreated: event(), onRemoved: event(), onUpdated: event(),
        get: options.getTab || (async () => ({ id: 1, status: 'complete', url: current?.url || 'http://127.0.0.1:1/page' })),
        sendMessage: async (_id, message) => {
          pageMessages.push({ ...structuredClone(message), tabId: _id });
          if (message.type === 'EXTRACT') {
            extracts.push(structuredClone(message));
            return options.extract ? options.extract({ message, tabId: _id, snapshot, extracts, executions }) : snapshot(executions.length ? `Page ${executions.length}` : 'INITIAL_SNAPSHOT');
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
            return options.execute ? options.execute({ message, snapshot, executions }) : { results: message.actions.map(() => ({ ok: true, msg: 'Action applied' })), page: snapshot() };
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
    context, run, calls, executions, emitted, extracts, pageMessages, nativeRequestModel, state, session, removedSessionKeys,
    start: (question = 'Complete the task', extra = {}) => context.agentLoop(run, question, { allowActions: true, ...extra }),
  };
}

function targetSnapshot(snapshot, text, targets) {
  const page = snapshot(text);
  page.targets = {};
  page.targetMeta = {};
  for (const { ref, identity, description, ...meta } of targets) {
    page.targets[ref] = `[${ref}] ${description}`;
    page.targetMeta[ref] = { identity, submitsForm: false, ...meta };
  }
  return page;
}

function imageParts(messages) {
  return Array.from(messages).flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((part) => part.type === 'image_url');
}

for (const extra of [{}, { maxSteps: 1000 }]) {
  test(`执行上限默认100且超大请求仍钳制到100：${JSON.stringify(extra)}`, async () => {
    const h = harness({ reply: () => ({ actions: [{ action: 'click', ref: 1 }] }) });
    assert.equal((await h.start('持续推进到执行上限', extra)).outcome, 'limit');
    assert.equal(h.calls.length, 100);
    assert.equal(h.executions.length, 100);
  });
}

test('正常有进展的任务超过50次操作后仍可自行完成', async () => {
  const h = harness({ reply: (n) => n <= 60 ? { actions: [{ action: 'click', ref: 1 }] } : { say: '已完成', done: true, actions: [] } });
  assert.equal((await h.start('继续完成较长任务')).outcome, 'completed');
  assert.equal(h.executions.length, 60);
  assert.equal(h.calls.length, 61);
});

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
        if (n === 1) return { vias_read: { kind: 'images', snapshotId: 'document:1', ids: [2], reason: '题目图中的几何条件未包含在正文中，需要识别后作答' } };
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
    const request = { vias_read: { kind: 'images', snapshotId: reason === 'stale' ? 'old' : 'document:1', ids: [reason === 'unknown' ? 9 : 2], reason: '需要读取题目图中的角度，正文未提供该条件' } };
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

test('图片读取有独立8次预算，失败也计次且同一观察点失败仍可重试', async () => {
  const h = harness({ vision: true,
    extract: ({ snapshot }) => Object.assign(snapshot(), { imageCandidates: [{ id: 1 }] }),
    reply: () => ({ vias_read: { kind: 'images', snapshotId: 'document:1', ids: [1], reason: '题目图片中的坐标没有正文替代，需要读取坐标才能回答' } }),
  });
  assert.equal((await h.start('读取', { allowActions: false, maxSteps: 1 })).outcome, 'limit');
  assert.equal(h.calls.length, 9); assert.equal(h.executions.length, 0);
  assert.equal(h.pageMessages.filter((message) => message.type === 'READ_IMAGES').length, 8);
  assert.equal(h.emitted.filter((event) => event.t === 'result' && event.code === 'INVALID_IMAGE').length, 8);
});

for (const allowActions of [false, true]) {
  for (const correctReason of [false, true]) {
    test(`${allowActions ? '执行' : '问答'}缺少图片reason不读图，模型可${correctReason ? '补具体原因后读取' : '改用已有文字完成'}`, async () => {
      const request = { kind: 'images', snapshotId: 'document:1', ids: [2] };
      const answer = correctReason ? '已结合题目图作答' : '正文已写明答案为37，无需图片';
      const h = harness({
        vision: true,
        extract: ({ snapshot }) => Object.assign(snapshot('答案为37；另有题目图'), { imageCandidates: [{ id: 2, alt: '题目图' }] }),
        readImages: () => ({ results: [{ id: 2, ok: true, dataUrl: 'data:image/jpeg;base64,YQ==' }] }),
        reply: (n, { messages }) => {
          assert.equal(imageParts(messages).length, correctReason && n === 3 ? 1 : 0);
          if (n === 1) return { vias_read: request };
          if (n === 2) {
            assert.match(JSON.stringify(messages), /IMAGE_REASON_REQUIRED/);
            assert.equal(h.pageMessages.filter((message) => ['READ_IMAGES', 'VERIFY_IMAGES'].includes(message.type)).length, 0);
            if (correctReason) return { vias_read: { ...request, reason: '正文未说明题目图中的夹角，需要识别夹角以核对答案' } };
          }
          return allowActions ? { say: answer, actions: [], done: true } : answer;
        },
      });
      assert.equal((await h.start('回答当前题目', { allowActions, maxSteps: 1 })).outcome, 'completed');
      assert.equal(h.calls.length, correctReason ? 3 : 2);
      assert.equal(h.pageMessages.filter((message) => message.type === 'READ_IMAGES').length, correctReason ? 1 : 0);
      assert.equal(h.executions.length, 0);
      const results = h.emitted.filter((event) => event.t === 'result');
      assert.equal(results[0].ok, false); assert.equal(results[0].code, 'IMAGE_REASON_REQUIRED');
      assert.equal(results.length, correctReason ? 2 : 1);
      if (correctReason) { assert.equal(results[1].ok, true); assert.equal(results[1].state, '已读取'); }
      assert.equal(h.emitted.filter((event) => event.t === 'say').at(-1).text, answer);
    });
  }

  test(`${allowActions ? '执行' : '问答'}纯文字足够时不自动读取候选图片或发送已有快照像素`, async () => {
    const h = harness({
      vision: true,
      extract: ({ snapshot }) => Object.assign(snapshot('截止日期为周五；点击Next可继续。'), {
        imageCandidates: [{ id: 1, alt: '网站logo', decorative: true }, { id: 2, alt: '活动海报' }],
      }),
      readImages: () => { throw new Error('纯文字任务不应读取图片'); },
      reply: (n, { messages }) => {
        assert.equal(imageParts(messages).length, 0);
        assert.ok(!JSON.stringify(messages).includes('data:image/'));
        return allowActions ? n === 1 ? { say: '截止日期为周五，继续下一步', ...click } : done : '截止日期为周五';
      },
    });
    assert.equal((await h.start('根据正文指出截止日，并在允许操作时点Next', { allowActions, maxSteps: 2 })).outcome, 'completed');
    assert.equal(h.calls.length, allowActions ? 2 : 1);
    assert.equal(h.executions.length, allowActions ? 1 : 0);
    assert.equal(h.pageMessages.filter((message) => ['READ_IMAGES', 'VERIFY_IMAGES'].includes(message.type)).length, 0);
    assert.equal(h.emitted.filter((event) => event.t === 'actions' && event.title === '图片分析').length, 0);
  });

  test(`${allowActions ? '执行' : '问答'}成功图片相同trim观察点不重读，新的观察点仍可读取`, async () => {
    const reason = '读取题目图中三角形的夹角，正文未提供该条件';
    const nextReason = '改看同一题目图中边AB的长度，补充解题所需另一条件';
    const h = harness({
      vision: true,
      extract: ({ snapshot }) => Object.assign(snapshot('三角形题目'), { imageCandidates: [{ id: 2, alt: '几何图' }] }),
      readImages: () => ({ results: [{ id: 2, ok: true, dataUrl: 'data:image/jpeg;base64,YQ==' }] }),
      reply: (n, { messages }) => {
        assert.equal(imageParts(messages).length, n === 2 || n === 4 ? 1 : 0);
        if (n === 1) return { vias_read: { kind: 'images', snapshotId: 'document:1', ids: [2], reason: `  ${reason}  ` } };
        if (n === 2) return { vias_read: { kind: 'images', snapshotId: 'document:1', ids: [2], reason } };
        if (n === 3) {
          assert.match(JSON.stringify(messages), /IMAGE_ALREADY_READ/);
          assert.equal(h.pageMessages.filter((message) => message.type === 'READ_IMAGES').length, 1);
          return { vias_read: { kind: 'images', snapshotId: 'document:1', ids: [2], reason: nextReason } };
        }
        return allowActions ? done : '依据夹角与边长完成解答';
      },
    });
    assert.equal((await h.start('解答这道几何题', { allowActions, maxSteps: 1 })).outcome, 'completed');
    assert.equal(h.calls.length, 4); assert.equal(h.executions.length, 0);
    assert.equal(h.pageMessages.filter((message) => message.type === 'READ_IMAGES').length, 2);
    assert.deepEqual(h.emitted.filter((event) => event.t === 'result').map(({ ok, code, state }) => ({ ok, code, state })), [
      { ok: true, code: 'IMAGE_READ', state: '已读取' },
      { ok: false, code: 'IMAGE_ALREADY_READ', state: '' },
      { ok: true, code: 'IMAGE_READ', state: '已读取' },
    ]);
    assert.deepEqual(h.emitted.filter((event) => event.t === 'actions').map((event) => event.actions[0].detail), [
      `图片 #2 · ${reason}`, `图片 #2 · ${reason}`, `图片 #2 · ${nextReason}`,
    ]);
  });
}

for (const denial of ['IMAGE_REASON_REQUIRED', 'IMAGE_ALREADY_READ']) {
  test(`${denial}也计入每任务8次图片请求上限，超限不留待结算slot`, async () => {
    const h = harness({
      vision: true,
      extract: ({ snapshot }) => Object.assign(snapshot(), { imageCandidates: [{ id: 2 }] }),
      readImages: () => ({ results: [{ id: 2, ok: true, dataUrl: 'data:image/jpeg;base64,YQ==' }] }),
      reply: () => ({ vias_read: {
        kind: 'images', snapshotId: 'document:1', ids: [2],
        ...(denial === 'IMAGE_ALREADY_READ' ? { reason: '读取图表中2024年的销售额，正文没有该数值' } : {}),
      } }),
    });
    assert.equal((await h.start('读取图表数值', { allowActions: false, maxSteps: 1 })).outcome, 'limit');
    assert.equal(h.calls.length, 9); assert.equal(h.executions.length, 0);
    assert.equal(h.pageMessages.filter((message) => message.type === 'READ_IMAGES').length, denial === 'IMAGE_ALREADY_READ' ? 1 : 0);
    const actions = h.emitted.filter((event) => event.t === 'actions');
    const results = h.emitted.filter((event) => event.t === 'result');
    assert.equal(actions.length, 8); assert.equal(results.length, 8);
    assert.equal(new Set(actions.map((event) => event.operationId)).size, 8);
    actions.forEach((action, index) => {
      assert.ok(action.operationId);
      assert.equal(results[index].operationId, action.operationId);
      assert.equal(results[index].index, 0);
      assert.equal(results[index].code, denial === 'IMAGE_ALREADY_READ' && index === 0 ? 'IMAGE_READ' : denial);
    });
  });
}

test('同一动作轮中两次图片读取与普通动作各有独立operationId，事件按say到最终say顺序结算', async () => {
  const reasons = ['识别第一张题目图中没有正文的角度', '识别第二张题目图中没有正文的边长'];
  const h = harness({
    vision: true,
    extract: ({ snapshot }) => Object.assign(snapshot('按两张图的条件填写答案'), { imageCandidates: [{ id: 3 }, { id: 7 }] }),
    readImages: (message) => ({ results: message.ids.map((id) => ({ id, ok: true, dataUrl: id === 3 ? 'data:image/jpeg;base64,YQ==' : 'data:image/jpeg;base64,Yg==' })) }),
    reply: (n, { messages }) => {
      const pixels = imageParts(messages).map((part) => part.image_url.url);
      assert.deepEqual(pixels, n === 3 ? ['data:image/jpeg;base64,YQ=='] : n === 4 ? ['data:image/jpeg;base64,Yg=='] : []);
      if (n === 1) return { say: '先核对两张题目图，再填写答案', actions: [] };
      if (n === 2 || n === 3) return { vias_read: { kind: 'images', snapshotId: 'document:1', ids: [n === 2 ? 3 : 7], reason: reasons[n - 2] } };
      if (n === 4) return { actions: [{ action: 'fill', ref: 1, value: '答案37' }] };
      return { say: '答案已填写', actions: [], done: true };
    },
  });
  assert.equal((await h.start('根据两张题目图填写答案', { maxSteps: 3 })).outcome, 'completed');
  assert.equal(h.calls.length, 5); assert.equal(h.executions.length, 1);
  assert.deepEqual(h.executions[0].actions, [{ action: 'fill', ref: 1, value: '答案37' }]);
  const events = h.emitted.filter((event) => ['say', 'actions', 'result'].includes(event.t));
  assert.deepEqual(events.map((event) => event.t), ['say', 'actions', 'result', 'actions', 'result', 'actions', 'result', 'say']);
  assert.equal(events[0].text, '先核对两张题目图，再填写答案');
  assert.equal(events.at(-1).text, '答案已填写');
  const batches = [events[1], events[3], events[5]];
  assert.equal(new Set(batches.map((event) => event.operationId)).size, 3);
  batches.forEach((batch, index) => {
    assert.ok(batch.operationId);
    assert.equal(batch.round, 2, '两次读取不消耗普通动作轮数');
    const result = events[index * 2 + 2];
    assert.equal(result.operationId, batch.operationId);
    assert.equal(result.round, batch.round); assert.equal(result.index, 0); assert.equal(result.ok, true);
    if (index < 2) {
      assert.equal(batch.title, '图片分析');
      assert.deepEqual(batch.actions, [{ action: 'image analyze', detail: `图片 #${index === 0 ? 3 : 7} · ${reasons[index]}` }]);
      assert.equal(result.state, '已读取');
    }
  });
  assert.equal(events[5].operationId, h.executions[0].operationId);
});

test('多图片响应顺序打乱时失败原因仍按候选id结算，仅成功图片送给模型', async () => {
  const h = harness({
    vision: true,
    extract: ({ snapshot }) => Object.assign(snapshot('比较三张图'), { imageCandidates: [{ id: 7 }, { id: 2 }, { id: 9 }] }),
    readImages: () => ({ results: [
      { id: 9, ok: false, code: 'STALE_IMAGE', msg: '图9的源已变化' },
      { id: 7, ok: true, dataUrl: 'data:image/jpeg;base64,Yw==' },
      { id: 2, ok: false, code: 'IMAGE_NOT_LOADED', msg: '图2尚未加载' },
    ] }),
    reply: (n, { messages }) => {
      if (n === 1) return { vias_read: { kind: 'images', snapshotId: 'document:1', ids: [7, 2, 9], reason: '比较三张题目图中的几何条件，正文没有这些条件' } };
      assert.deepEqual(imageParts(messages).map((part) => part.image_url.url), ['data:image/jpeg;base64,Yw==']);
      const feedback = JSON.stringify(messages.at(-1));
      assert.ok(feedback.includes('图9的源已变化')); assert.ok(feedback.includes('图2尚未加载'));
      return '只能识别图7，图2未加载、图9已变化，无法完成三图比较';
    },
  });
  assert.equal((await h.start('比较三张题目图', { allowActions: false })).outcome, 'completed');
  const batch = h.emitted.find((event) => event.t === 'actions');
  assert.deepEqual(batch.actions.map((action) => action.detail.split(' · ')[0]), ['图片 #7', '图片 #2', '图片 #9']);
  const results = h.emitted.filter((event) => event.t === 'result');
  assert.deepEqual(results.map(({ index, ok, code, state }) => ({ index, ok, code, state })), [
    { index: 0, ok: true, code: 'IMAGE_READ', state: '已读取' },
    { index: 1, ok: false, code: 'IMAGE_NOT_LOADED', state: '' },
    { index: 2, ok: false, code: 'STALE_IMAGE', state: '' },
  ]);
  results.forEach((result) => assert.equal(result.operationId, batch.operationId));
  assert.equal(h.calls.length, 2); assert.equal(h.executions.length, 0);
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
const userDsml = '<｜DSML｜ calls> <｜DSML｜ invoke name="vias_read"> <｜DSML｜ parameter name="kind" string="false">"images"</｜DSML｜ parameter> <｜DSML｜ parameter name="snapshotId" string="true">"b2bf1a58-db1f-4d9e-8ab8-8a0357ffaf73:3:29"</｜DSML｜ parameter> <｜DSML｜ parameter name="ids" string="false">[4]</｜DSML｜ parameter> </｜DSML｜ invoke> </｜DSML｜ calls>';

for (const allowActions of [false, true]) {
  for (const embedded of [false, true]) {
    test(`${allowActions ? '执行' : '问答'}用户原例DSML${embedded ? '嵌入say' : '裸回复'}不显示、不存历史、不读图或执行，纠正后正常工作`, async () => {
      const bad = embedded ? { say: `DSML_LEAK_MARKER ${userDsml}`, actions: [{ action: 'fill', ref: 1, value: '禁止执行的夹带值' }] } : userDsml;
      const h = harness({
        vision: true,
        extract: ({ snapshot }) => Object.assign(snapshot(), { imageCandidates: [{ id: 4 }] }),
        readImages: () => { throw new Error('内部DSML不得读取图片'); },
        reply: (n) => {
          if (n === 1) return bad;
          if (n === 2) {
            assert.equal(h.executions.length, 0);
            assert.equal(h.pageMessages.filter((message) => ['READ_IMAGES', 'VERIFY_IMAGES'].includes(message.type)).length, 0);
            return allowActions ? { say: '按当前快照填写答案', actions: [{ action: 'fill', ref: 1, value: '正常答案37' }] } : '正常文字回答37';
          }
          return done;
        },
      });
      assert.equal(h.context.ViasCore.isInternalToolText(typeof bad === 'string' ? bad : JSON.stringify(bad)), true);
      assert.equal((await h.start('回答或填写当前题目', { allowActions, maxSteps: 4 })).outcome, 'completed');
      assert.equal(h.calls.length, allowActions ? 3 : 2);
      assert.equal(h.executions.length, allowActions ? 1 : 0);
      if (allowActions) assert.deepEqual(h.executions[0].actions, [{ action: 'fill', ref: 1, value: '正常答案37' }]);
      const observed = JSON.stringify([h.calls, h.emitted, h.executions]);
      assert.equal(h.context.ViasCore.isInternalToolText(observed), false, '原始内部调用不能进入模型历史、界面事件或执行参数');
      assert.ok(!observed.includes('DSML_LEAK_MARKER')); assert.ok(!observed.includes('禁止执行的夹带值'));
      assert.equal(h.pageMessages.filter((message) => ['READ_IMAGES', 'VERIFY_IMAGES'].includes(message.type)).length, 0);
      assert.ok(h.emitted.some((event) => event.t === 'say' && event.text === (allowActions ? '按当前快照填写答案' : '正常文字回答37')));
    });

    test(`${allowActions ? '执行' : '问答'}用户原例DSML${embedded ? '嵌入say' : '裸回复'}连续三次有界停止且所有slot均未执行`, async () => {
      const h = harness({
        vision: true,
        extract: ({ snapshot }) => Object.assign(snapshot(), { imageCandidates: [{ id: 4 }] }),
        reply: () => embedded ? { say: `DSML_REPEATED_MARKER ${userDsml}`, ...click } : userDsml,
      });
      assert.equal((await h.start('识别题目图片', { allowActions, maxSteps: allowActions ? 10 : 1 })).outcome, 'stalled');
      assert.equal(h.calls.length, 3); assert.equal(h.executions.length, 0); assert.equal(h.extracts.length, 1);
      assert.equal(h.pageMessages.filter((message) => ['READ_IMAGES', 'VERIFY_IMAGES'].includes(message.type)).length, 0);
      assert.equal(h.emitted.filter((event) => ['actions', 'result'].includes(event.t)).length, 0);
      const observed = JSON.stringify([h.calls, h.emitted]);
      assert.equal(h.context.ViasCore.isInternalToolText(observed), false);
      assert.ok(!observed.includes('DSML_REPEATED_MARKER'));
      assert.ok(h.emitted.some((event) => event.t === 'say' && /无法解析/.test(event.text)));
    });
  }

  test(`${allowActions ? '执行' : '问答'}旧assistant内部DSML被过滤，用户原文和正常代码仍完整保留`, async () => {
    const userHistory = `用户提供的原文供分析：${userDsml}`;
    const normalCode = '```js\nconst tool_calls = { done: false };\nconsole.log("DSML只是格式名称");\n```\n普通JSON字段：{"tool_calls":[],"actions":[]}';
    const question = `请保留并解释当前用户原文：${userDsml}`;
    const h = harness({ reply: () => allowActions ? done : '已解释用户原文，普通代码也已保留' });
    const history = [
      { role: 'user', content: userHistory },
      { role: 'assistant', content: `OLD_DSML_MARKER ${userDsml}` },
      { role: 'assistant', content: JSON.stringify({ say: `OLD_SAY_DSML_MARKER ${userDsml}`, ...click }) },
      { role: 'assistant', content: `OLD_LONG_DSML_MARKER ${'普通前缀'.repeat(6000)}${userDsml}` },
      { role: 'assistant', content: normalCode },
    ];
    assert.equal((await h.start(question, { allowActions, history })).outcome, 'completed');
    assert.equal(h.calls.length, 1); assert.equal(h.executions.length, 0);
    const messages = h.calls[0];
    const body = JSON.stringify(messages);
    for (const marker of ['OLD_DSML_MARKER', 'OLD_SAY_DSML_MARKER', 'OLD_LONG_DSML_MARKER']) assert.ok(!body.includes(marker));
    assert.ok(messages.some((message) => message.role === 'user' && message.content.includes(userHistory)));
    assert.ok(messages.some((message) => message.role === 'user' && message.content.includes(question)));
    assert.ok(messages.some((message) => message.role === 'assistant' && message.content === normalCode));
    assert.equal(h.context.ViasCore.isInternalToolText(normalCode), false);
    assert.equal(h.context.ViasCore.isInternalToolText(JSON.stringify(h.emitted)), false);
  });

  test(`${allowActions ? '执行' : '问答'}UNSUPPORTED_TOOL_PROTOCOL返回上层纠正，保留同一页面且不泄露错误原文`, async () => {
    const h = harness({
      reply: (n) => {
        if (n === 1) throw Object.assign(new Error(`UNSUPPORTED_ERROR_MARKER ${userDsml}`), { code: 'UNSUPPORTED_TOOL_PROTOCOL' });
        if (n === 2) return allowActions ? { say: '重新按协议点击', ...click } : '纠正后的正常回答';
        return done;
      },
    });
    assert.equal((await h.start('完成当前任务', { allowActions, maxSteps: 4 })).outcome, 'completed');
    assert.equal(h.calls.length, allowActions ? 3 : 2);
    assert.equal(h.extracts.length, 1, '协议纠正应保留任务快照');
    assert.equal(h.executions.length, allowActions ? 1 : 0);
    if (allowActions) assert.equal(h.executions[0].snapshotId, 'document:1');
    const observed = JSON.stringify([h.calls, h.emitted, h.executions]);
    assert.equal(h.context.ViasCore.isInternalToolText(observed), false);
    assert.ok(!observed.includes('UNSUPPORTED_ERROR_MARKER'));
    assert.match(JSON.stringify(h.calls[1]), /格式错误|协议|内部调用/);
  });

  test(`${allowActions ? '执行' : '问答'}UNSUPPORTED_TOOL_PROTOCOL连续三次有界停止，不重新提取或盲执行`, async () => {
    const h = harness({ reply: () => { throw Object.assign(new Error(`REPEATED_ERROR_MARKER ${userDsml}`), { code: 'UNSUPPORTED_TOOL_PROTOCOL' }); } });
    assert.equal((await h.start('完成当前任务', { allowActions, maxSteps: allowActions ? 10 : 1 })).outcome, 'stalled');
    assert.equal(h.calls.length, 3); assert.equal(h.extracts.length, 1); assert.equal(h.executions.length, 0);
    assert.equal(h.emitted.filter((event) => ['actions', 'result'].includes(event.t)).length, 0);
    const observed = JSON.stringify([h.calls, h.emitted]);
    assert.equal(h.context.ViasCore.isInternalToolText(observed), false);
    assert.ok(!observed.includes('REPEATED_ERROR_MARKER'));
  });
}

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
  assert.equal((await h.start()).outcome, 'unverified');
  assert.equal(h.executions.length, 1, '读取后不能绕过零成功后的提交硬闸，也不能把重读当作失败已恢复');
  assert.equal(h.extracts.length, 2);
  assert.match(h.calls.at(-1).at(-1).content, /已拦下这一次提交并重新读取页面/);
});

test('损坏协议不展示、不执行、不进入后续消息，修复后继续执行', async () => {
  const bad = '{"say":"LEAK_MARKER","actions":[{"action":"click","ref":1}],}';
  const embedded = { say: '进行中 {"actions":[{"action":"click","value":"EMBEDDED_MARKER"}]}', ...click };
  const h = harness({ reply: (n) => n === 1 ? bad : n === 2 ? embedded : n === 3 ? { say: '进行中', ...click } : done });
  const outcome = await h.start();
  assert.equal(outcome.outcome, 'completed');
  // say 内嵌指令整条拒绝：同条 click 不执行，只有修复后的第 3 轮才执行。
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
    const page = (snapshot, text, refs) => targetSnapshot(snapshot, text, refs.map((ref, index) => ({
      ref, identity: `document:target:option-${index}`, choiceIdentity: `document:choice:option-${index}`, tag: 'input', type: 'checkbox', description: `选项「Option ${index}」 类型:复选 未选`,
    })));
    const h = harness({
      extract: ({ snapshot }) => page(snapshot, 'INITIAL_SNAPSHOT', [1, 2]),
      reply: (n) => n === 1 ? { actions: [{ action: 'check', ref: 1 }, { action: 'check', ref: 2 }] }
        : n === 2 ? { actions: [{ action: 'check', ref: 7 }, ...(!mixed ? [{ action: 'check', ref: 8 }] : [])] } : done,
      execute: ({ message, snapshot, executions }) => {
        if (executions.length === 2) {
          assert.equal(message.snapshotId, 'document:2');
          assert.equal(message.actions[0].ref, 7);
          return { results: message.actions.map(() => ({ ok: true })), page: page(snapshot, 'FINISHED', [9, 10]) };
        }
        return { results: [{ ok: false, code: 'STALE_TARGET', msg: 'changed first' },
          mixed ? { ok: true, state: '已选中' } : { ok: false, code: 'STALE_TARGET', msg: 'changed second' }], page: page(snapshot, 'EXECUTOR_FRESH [7] Updated option', [7, 8]) };
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
    reply: (n) => n === 1 ? click : done,
    getTab: async (id) => ({ id, status: 'complete', url: `http://127.0.0.1:1/${id === 2 ? 'new-tab' : 'page'}` }),
    extract: ({ snapshot, extracts }) => {
      const page = snapshot(extracts.length === 1 ? 'INITIAL' : 'NEW_TAB_FRESH');
      if (extracts.length > 1) { page.snapshotId = 'new-document:1'; page.url = 'http://127.0.0.1:1/new-tab'; }
      return page;
    },
    execute: ({ snapshot }) => {
      h.context.chrome.tabs.onCreated.dispatch({ id: 2, openerTabId: 1, url: 'http://127.0.0.1:1/new-tab' });
      return { results: [{ ok: false, code: 'STALE_TARGET' }], page: snapshot('OLD_TAB_FRESH') };
    },
  });
  assert.equal((await h.start()).outcome, 'unverified');
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
    assert.equal((await h.start()).outcome, 'unverified');
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

test('相同动作连续三次页面无进展后在下一批执行前停止', async () => {
  const h = harness({ reply: () => click, extract: ({ snapshot }) => snapshot('Unchanged'), execute: ({ snapshot }) => ({ results: [{ ok: true }], page: snapshot('Unchanged') }) });
  assert.equal((await h.start()).outcome, 'stalled');
  assert.equal(h.executions.length, 3);
  assert.equal(h.calls.length, 4);
});

test('交替操作连续四次无变化后熔断，前三次给模型自行纠正的机会', async () => {
  const first = { action: 'click', ref: 1 };
  const second = { action: 'click', ref: 2 };
  const h = harness({
    reply: (n) => ({ actions: [n % 2 ? first : second] }),
    extract: ({ snapshot }) => snapshot('Unchanged'),
    execute: ({ snapshot }) => ({ results: [{ ok: true }], page: snapshot('Unchanged') }),
  });
  assert.equal((await h.start()).outcome, 'stalled');
  assert.equal(h.executions.length, 4);
  assert.equal(h.calls.length, 4);
});

test('上一任务的执行记录注入系统提示且有界，不影响用户问题原文', async () => {
  const h = harness({ reply: () => done });
  assert.equal((await h.start('继续处理', { priorRun: '上一任务因无进展停止。\n1. click @1：失败（找不到目标，请重新读取页面后重试。）' })).outcome, 'completed');
  const system = h.calls[0].find((message) => message.role === 'system').content;
  assert.match(system, /上一任务的执行记录/);
  assert.match(system, /click @1：失败/);
  const after = harness({ reply: () => done });
  await after.start('继续处理', { priorRun: 'x'.repeat(5000) });
  assert.equal(after.calls[0].find((message) => message.role === 'system').content.includes('x'.repeat(2001)), false);
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

test('失败后的提交拦一次并重读，核对后可提交但不能覆盖未解决的另一目标', async () => {
  const h = harness({
    reply: (n) => n === 1 ? click : n < 4 ? { actions: [{ action: 'submitForm', ref: 2 }] } : done,
    execute: ({ snapshot, executions }) => ({ results: executions.length === 1 ? [{ ok: false, code: 'TARGET_NOT_FOUND' }] : [{ ok: true }], page: snapshot() }),
  });
  assert.equal((await h.start()).outcome, 'unverified');
  assert.equal(h.executions.length, 2);
  assert.equal(h.extracts.length, 2);
  assert.equal(h.calls.length, 4);
  assert.match(JSON.stringify(h.calls[2]), /已拦下这一次提交并重新读取页面/);
});

test('没有执行失败的初始done仍正常completed并保留最终say', async () => {
  const h = harness({ reply: () => done });
  const outcome = await h.start();
  assert.equal(outcome.outcome, 'completed'); assert.equal(outcome.finalSay, 'Finished');
  assert.equal(h.calls.length, 1); assert.equal(h.executions.length, 0);
});

for (const communication of [false, true]) {
  test(`${communication ? '通信不确定' : '实际动作零成功'}后模型直接done只能unverified，保留say而不误报完成`, async () => {
    const answer = '已尝试操作，需要核对失败结果';
    const h = harness({
      reply: (n) => n === 1 ? click : { say: answer, actions: [], done: true },
      execute: ({ snapshot }) => {
        if (communication) throw new Error('Disconnected after dispatch');
        return { results: [{ ok: false, code: 'TARGET_NOT_FOUND', msg: '目标不存在' }], page: snapshot('目标尚未操作成功') };
      },
    });
    const outcome = await h.start();
    assert.equal(outcome.outcome, 'unverified'); assert.equal(outcome.finalSay, answer);
    assert.equal(h.calls.length, 2);
    assert.equal(h.emitted.filter((event) => event.t === 'actions').length, 1);
    assert.equal(h.emitted.find((event) => event.t === 'result').ok, false);
    assert.ok(h.emitted.some((event) => event.t === 'say' && event.text === answer));
  });
}

for (const followup of ['wait', 'NO_CHANGE', 'segment']) {
  test(`失败后${followup}不清除未确认状态，done仍为unverified`, async () => {
    const h = harness({
      read: ({ current }) => ({ ...current, index: 0, text: '重新读取仍没有成功操作的证据' }),
      reply: (n) => n === 1 ? click : n === 2
        ? followup === 'segment' ? { vias_read: { kind: 'segment', snapshotId: 'document:2', index: 0 } }
          : { actions: [followup === 'wait' ? { action: 'wait', value: 0 } : { action: 'navigate', value: 'http://127.0.0.1:1/page' }] }
        : done,
      execute: ({ snapshot, executions }) => ({
        results: executions.length === 1 ? [{ ok: false, code: 'TARGET_NOT_FOUND' }]
          : [{ ok: true, ...(followup === 'NO_CHANGE' ? { code: 'NO_CHANGE' } : {}), msg: '没有执行目标操作' }],
        page: snapshot(),
      }),
    });
    assert.equal((await h.start()).outcome, 'unverified');
    assert.equal(h.calls.length, 3);
    assert.equal(h.executions.length, followup === 'segment' ? 1 : 2);
  });
}

for (const followup of ['other-fill', 'other-hover', 'other-click', 'other-scroll', 'same-hover', 'same-click', 'wrong-value', 'NO_CHANGE', 'wait']) {
  test(`填写失败后${followup}成功不冒充原目标恢复`, async () => {
    let answer = '';
    let other = '';
    const desired = '答案37';
    const page = (snapshot, rounds) => targetSnapshot(snapshot, `答案=${answer}；备注=${other}；观察${rounds}`, [
      { ref: rounds * 2 + 1, identity: 'document:target:answer', tag: 'input', type: 'text', description: `输入框(text) 标签:答案 ${answer ? `当前值="${answer}"` : '当前为空'}` },
      { ref: rounds * 2 + 2, identity: 'document:target:other', tag: 'input', type: 'text', description: `输入框(text) 标签:备注 ${other ? `当前值="${other}"` : '当前为空'}` },
    ]);
    const h = harness({
      extract: ({ snapshot, executions }) => page(snapshot, executions.length),
      reply: (n) => {
        if (n === 1) return { actions: [{ action: 'fill', ref: 1, value: desired }] };
        if (n > 2) return done;
        const action = followup === 'wait' ? { action: 'wait', value: 0 }
          : followup === 'NO_CHANGE' ? { action: 'fill', ref: 3, value: desired }
            : followup === 'wrong-value' ? { action: 'fill', ref: 3, value: '答案38' }
              : { action: followup.split('-')[1], ref: followup.startsWith('other') ? 4 : 3, ...(followup.endsWith('fill') ? { value: desired } : followup.endsWith('scroll') ? { value: 400 } : {}) };
        return { actions: [action] };
      },
      execute: ({ snapshot, message, executions }) => {
        if (executions.length === 1) return { results: [{ ok: false, code: 'VALUE_NOT_APPLIED' }], page: page(snapshot, 1) };
        const action = message.actions[0];
        if (followup === 'other-fill') other = action.value;
        if (followup === 'wrong-value') answer = action.value;
        return { results: [{ ok: true, code: followup === 'NO_CHANGE' ? 'NO_CHANGE' : action.action === 'fill' ? 'FILLED' : '', state: answer || '当前为空' }], page: page(snapshot, 2) };
      },
    });
    assert.equal((await h.start()).outcome, 'unverified');
    assert.equal(h.calls.length, 3); assert.equal(h.executions.length, 2);
    assert.equal(answer, followup === 'wrong-value' ? '答案38' : '');
    assert.equal(other, followup === 'other-fill' ? desired : '');
    assert.match(h.calls.at(-1).at(-1).content, /仍有操作未获成功确认/);
  });
}

for (const reuseNodeIdentity of [false, true]) {
  test(`同ref跨快照改指${reuseNodeIdentity ? '同节点的新含义' : '另一个节点'}不能恢复原失败`, async () => {
    const page = (snapshot, changed) => targetSnapshot(snapshot, changed ? 'ref1现在是备注，原答案仍未填写' : '答案待填写', [
      { ref: 1, identity: reuseNodeIdentity || !changed ? 'document:target:answer' : 'document:target:other', tag: 'input', type: 'text', description: `输入框(text) 标签:${changed ? '备注' : '答案'} 当前为空` },
    ]);
    const h = harness({
      extract: ({ snapshot }) => page(snapshot, false),
      reply: (n) => n <= 2 ? { actions: [{ action: 'fill', ref: 1, value: '答案37' }] } : done,
      execute: ({ snapshot, executions }) => ({ results: [{ ok: executions.length > 1, code: executions.length === 1 ? 'VALUE_NOT_APPLIED' : 'FILLED' }], page: page(snapshot, true) }),
    });
    assert.equal((await h.start()).outcome, 'unverified');
    assert.equal(h.executions.length, 2);
  });
}

for (const semanticToken of [false, true]) {
  for (const sameValue of [false, true]) {
    test(`选项同节点跨ref重试${semanticToken ? '有语义token' : '缺少语义token'}且业务value${sameValue ? '相同' : '改变'}，仅可证明同选项才恢复`, async () => {
      let value = 'a';
      let selectedValue = '';
      const page = (snapshot, rounds) => targetSnapshot(snapshot, `固定选项文字；观察${rounds}`, [{
        ref: rounds + 1, identity: 'document:target:choice', ...(semanticToken ? { choiceIdentity: value === 'a' ? 'document:choice:1' : 'document:choice:2' } : {}),
        tag: 'input', type: 'checkbox', description: `选项「选项A」 类型:复选 ${selectedValue ? '已选中' : '未选'}`,
      }]);
      const h = harness({
        extract: ({ snapshot }) => page(snapshot, 0),
        reply: (n) => n <= 2 ? { actions: [{ action: 'check', ref: n }] } : done,
        execute: ({ snapshot, executions }) => {
          if (executions.length === 1) {
            if (!sameValue) value = 'b';
            return { results: [{ ok: false, code: 'STALE_TARGET' }], page: page(snapshot, 1) };
          }
          selectedValue = value;
          return { results: [{ ok: true, state: '已选中' }], page: page(snapshot, 2) };
        },
      });
      assert.equal((await h.start('选中业务值a对应选项')).outcome, semanticToken && sameValue ? 'completed' : 'unverified');
      assert.equal(selectedValue, sameValue ? 'a' : 'b');
      assert.deepEqual(h.executions.map((execution) => execution.actions[0].ref), [1, 2]);
    });
  }
}

for (const communication of [false, true]) {
  test(`${communication ? '通信不确定' : '填写失败'}后同目标跨ref明确成功可恢复completed，state变化不改变身份`, async () => {
    let filled = '';
    let writes = 0;
    const desired = '恢复后的答案37';
    const page = (snapshot, executions) => targetSnapshot(snapshot, `答案=${filled || '空'}；观察${executions}`, [
      { ref: executions * 2 + 1, identity: 'document:target:answer', tag: 'input', type: 'text', description: `输入框(text) 标签:答案 ${filled ? `当前值="${filled}"` : '当前为空'}` },
    ]);
    const h = harness({
      extract: ({ snapshot, executions }) => page(snapshot, executions.length ? 1 : 0),
      reply: (n) => n <= 2 ? { actions: [{ action: 'fill', ref: n === 1 ? 1 : 3, value: desired }] } : done,
      execute: ({ snapshot, executions, message }) => {
        if (message.operationId === executions[0].operationId) {
          filled = '页面残留前缀';
          // 回执丢失不再重发到（可能已重建的）文档：本批按“已派发但未知”结算。
          if (communication) throw new Error('Disconnected after dispatch');
          return { results: [{ ok: false, code: 'VALUE_NOT_APPLIED' }], page: page(snapshot, 1) };
        }
        filled = message.actions[0].value; writes++;
        return { results: [{ ok: true, code: 'FILLED', state: `当前值="${filled}"` }], page: page(snapshot, 2) };
      },
    });
    assert.equal((await h.start()).outcome, 'completed');
    assert.equal(h.calls.length, 3); assert.equal(h.executions.length, 2);
    assert.equal(new Set(h.executions.map((execution) => execution.operationId)).size, 2);
    assert.deepEqual(h.executions.map((execution) => execution.actions[0].ref), [1, 3]);
    assert.equal(filled, desired); assert.equal(writes, 1);
  });
}

for (const followup of ['other-fill', 'NO_CHANGE', 'same-click']) {
  test(`通信不确定后${followup}不清除原填写意图`, async () => {
    const page = (snapshot, rounds) => targetSnapshot(snapshot, `通信后的观察${rounds}`, [
      { ref: rounds * 2 + 1, identity: 'document:target:answer', tag: 'input', type: 'text', description: '输入框(text) 标签:答案 当前为空' },
      { ref: rounds * 2 + 2, identity: 'document:target:other', tag: 'input', type: 'text', description: '输入框(text) 标签:备注 当前为空' },
    ]);
    const h = harness({
      extract: ({ snapshot, executions }) => page(snapshot, executions.length ? 1 : 0),
      reply: (n) => n === 1 ? { actions: [{ action: 'fill', ref: 1, value: '答案37' }] }
        : n === 2 ? { actions: [{ action: followup === 'same-click' ? 'click' : 'fill', ref: followup === 'other-fill' ? 4 : 3, ...(followup === 'same-click' ? {} : { value: '答案37' }) }] } : done,
      execute: ({ snapshot, executions, message }) => {
        if (message.operationId === executions[0].operationId) throw new Error('Disconnected after dispatch');
        return { results: [{ ok: true, code: followup === 'NO_CHANGE' ? 'NO_CHANGE' : 'FILLED' }], page: page(snapshot, 2) };
      },
    });
    assert.equal((await h.start()).outcome, 'unverified');
    assert.equal(h.executions.length, 2);
    assert.equal(new Set(h.executions.map((execution) => execution.operationId)).size, 2);
  });
}

for (const repairBoth of [false, true]) {
  test(`多目标失败及跳过项逐项消解，修复${repairBoth ? '全部目标可完成' : '一个目标仍未确认'}`, async () => {
    const values = ['', ''];
    const page = (snapshot, rounds) => targetSnapshot(snapshot, `观察${rounds}；${values.join('|')}`, values.map((value, index) => ({
      ref: rounds * 2 + index + 1, identity: `document:target:${index}`, tag: 'input', type: 'text', description: `输入框(text) 标签:字段${index} ${value ? `当前值="${value}"` : '当前为空'}`,
    })));
    const h = harness({
      extract: ({ snapshot }) => page(snapshot, 0),
      reply: (n) => n === 1 ? { actions: [{ action: 'fill', ref: 1, value: 'A' }, { action: 'fill', ref: 2, value: 'B' }] }
        : n === 2 ? { actions: [{ action: 'fill', ref: 3, value: 'A' }] }
          : n === 3 && repairBoth ? { actions: [{ action: 'fill', ref: 6, value: 'B' }] } : done,
      execute: ({ snapshot, executions }) => {
        if (executions.length === 1) return { results: [{ ok: false, code: 'VALUE_NOT_APPLIED' }, { ok: false, code: 'SKIPPED_AFTER_FAILURE' }], page: page(snapshot, 1) };
        values[executions.length - 2] = executions.length === 2 ? 'A' : 'B';
        return { results: [{ ok: true, code: 'FILLED' }], page: page(snapshot, executions.length) };
      },
    });
    assert.equal((await h.start()).outcome, repairBoth ? 'completed' : 'unverified');
    assert.deepEqual(values, repairBoth ? ['A', 'B'] : ['A', '']);
  });
}

for (const sameValue of [false, true]) {
  test(`长填写值仅末尾${sameValue ? '相同才消解失败' : '不同仍保留失败'}，不按value预览匹配`, async () => {
    const value = '长答案'.repeat(4000) + 'A';
    const page = (snapshot, rounds) => targetSnapshot(snapshot, `长填写观察${rounds}`, [
      { ref: rounds + 1, identity: 'document:target:answer', tag: 'textarea', description: '文本域 标签:答案 当前为空' },
    ]);
    const h = harness({
      extract: ({ snapshot }) => page(snapshot, 0),
      reply: (n) => n <= 2 ? { actions: [{ action: 'fill', ref: n, value: n === 1 || sameValue ? value : value.slice(0, -1) + 'B' }] } : done,
      execute: ({ snapshot, executions }) => ({ results: [{ ok: executions.length > 1, code: executions.length === 1 ? 'VALUE_NOT_APPLIED' : 'FILLED' }], page: page(snapshot, executions.length) }),
    });
    assert.equal((await h.start()).outcome, sameValue ? 'completed' : 'unverified');
    assert.equal(h.executions.length, 2);
  });
}

test('未解决证据超出上限后保留不完整标记，不淘汰失败并被后续成功误报完成', async () => {
  const page = (snapshot, rounds) => targetSnapshot(snapshot, `批量目标观察${rounds}`, Array.from({ length: 133 }, (_, index) => ({
    ref: rounds * 200 + index + 1, identity: `document:target:field-${index}`, tag: 'input', type: 'text', description: `输入框(text) 标签:字段${index} 当前为空`,
  })));
  const h = harness({
    extract: ({ snapshot }) => page(snapshot, 0),
    reply: (n) => n > 14 ? done : { actions: [
      ...Array.from({ length: 19 }, (_, index) => ({ action: 'fill', ref: (n - 1) * 200 + ((n - 1) % 7) * 19 + index + 1, value: '答案37' })),
      { action: 'wait', value: 0 },
    ] },
    execute: ({ snapshot, executions, message }) => ({ results: message.actions.map((action) => action.action === 'wait' || executions.length > 7 ? { ok: true, code: action.action === 'fill' ? 'FILLED' : '' } : { ok: false, code: 'TARGET_HIDDEN' }), page: page(snapshot, executions.length) }),
  });
  assert.equal((await h.start('逐项修复133个目标', { maxSteps: 16 })).outcome, 'unverified');
  assert.equal(h.calls.length, 15); assert.equal(h.executions.length, 14);
});

for (const missingIdentity of [false, true]) {
  test(`${missingIdentity ? '缺少稳定identity的ref' : 'selector-only'}跨快照重试不能凭相同定位串消解失败`, async () => {
    const action = { action: 'fill', ...(missingIdentity ? { ref: 1 } : { selector: '#answer' }), value: '答案37' };
    const h = harness({
      reply: (n) => n <= 2 ? { actions: [action] } : done,
      execute: ({ snapshot, executions }) => ({ results: [{ ok: executions.length > 1, code: executions.length === 1 ? 'VALUE_NOT_APPLIED' : 'FILLED' }], page: snapshot() }),
    });
    assert.equal((await h.start()).outcome, 'unverified');
    assert.equal(h.executions.length, 2);
  });
}

test('repeat部分成功按children和1-based索引回灌，模型仅修复失败项而不重放已成功副作用', async () => {
  let healthySelections = 0;
  let repairedSelections = 0;
  const repeat = { action: 'repeat', times: 3, value: 0, actions: [{ action: 'check', ref: 1 }, { action: 'check', ref: 2 }] };
  const page = (snapshot, text, refs) => targetSnapshot(snapshot, text, refs.map((ref, index) => ({
    ref, identity: `document:target:choice-${index}`, choiceIdentity: `document:choice:option-${index}`, tag: 'input', type: 'checkbox', description: `选项「选项${index}」 类型:复选 ${index === 1 && healthySelections ? '已选中' : '未选'}`,
  })));
  const h = harness({
    extract: ({ snapshot }) => page(snapshot, '两个选项未选', [1, 2]),
    reply: (n, { messages }) => {
      if (n === 1) return { actions: [repeat] };
      if (n === 2) {
        const feedback = messages.at(-1).content;
        assert.ok(feedback.includes('"children"'));
        assert.ok(feedback.includes('HEALTHY_OPTION_APPLIED'));
        assert.ok(feedback.includes('STALE_TARGET'));
        for (const expected of ['"iteration":1', '"subIndex":1', '"subIndex":2', '"successCount":1', '"failureCount":1', '"skippedCount":4']) assert.ok(feedback.includes(expected), expected);
        assert.match(feedback, /重放|重复执行|整批/);
        assert.equal(healthySelections, 1); assert.equal(repairedSelections, 0);
        return { actions: [{ action: 'check', ref: 3 }] };
      }
      return done;
    },
    execute: ({ message, snapshot }) => {
      if (message.actions[0].action === 'repeat') {
        healthySelections++;
        return { results: [{
          ok: false, code: 'STALE_TARGET', msg: '循环第1轮部分成功，请核对失败项',
          results: [
            { action: 'check', iteration: 1, subIndex: 1, ok: false, code: 'STALE_TARGET', msg: '失效项需要重新定位' },
            { action: 'check', iteration: 1, subIndex: 2, ok: true, code: '', msg: 'HEALTHY_OPTION_APPLIED' },
          ],
          repeatSummary: { plannedIterations: 3, completedIterations: 1, iteration: 1, subIndex: 2, successCount: 1, failureCount: 1, skippedCount: 4, omittedCount: 0 },
        }], page: page(snapshot, '健康选项已选中，失效项待修复', [3, 4]) };
      }
      assert.equal(message.actions[0].ref, 3);
      repairedSelections++;
      return { results: [{ ok: true, state: '已选中' }], page: page(snapshot, '两项都已选中', [5, 6]) };
    },
  });
  assert.equal((await h.start('选中两项并修复失效目标', { maxSteps: 4 })).outcome, 'completed');
  assert.equal(h.calls.length, 3); assert.equal(h.executions.length, 2);
  assert.equal(healthySelections, 1); assert.equal(repairedSelections, 1);
  assert.deepEqual(h.executions[1].actions, [{ action: 'check', ref: 3 }]);
});

for (const followup of ['unrelated-action', 'unrelated-repeat', 'missing-index', 'omitted-failure']) {
  test(`repeat部分失败后${followup}不能清除尚未确认的子目标`, async () => {
    const page = (snapshot, rounds) => targetSnapshot(snapshot, `选项观察${rounds}`, [0, 1].map((index) => ({
      ref: rounds * 2 + index + 1, identity: `document:target:choice-${index}`, choiceIdentity: `document:choice:option-${index}`, tag: 'input', type: 'checkbox', description: `选项「选项${index}」 类型:复选 未选`,
    })));
    const h = harness({
      extract: ({ snapshot }) => page(snapshot, 0),
      reply: (n) => {
        if (n === 1) return { actions: [{ action: 'repeat', times: 3, value: 0, actions: [{ action: 'check', ref: 1 }, { action: 'check', ref: 2 }] }] };
        if (n > 2) return done;
        const action = { action: 'check', ref: followup.startsWith('unrelated') ? 4 : 3 };
        return { actions: [followup === 'unrelated-repeat' ? { action: 'repeat', times: 1, value: 0, actions: [action] } : action] };
      },
      execute: ({ snapshot, executions, message }) => {
        if (executions.length === 1) return { results: [{
          ok: false, code: 'STALE_TARGET', results: [
            { action: 'check', iteration: 1, ...(followup === 'missing-index' ? {} : { subIndex: 1 }), ok: false, code: 'STALE_TARGET' },
            { action: 'check', iteration: 1, subIndex: 2, ok: true },
          ], repeatSummary: { plannedIterations: 3, completedIterations: 1, successCount: 1, failureCount: followup === 'omitted-failure' ? 2 : 1, skippedCount: 4, omittedCount: followup === 'omitted-failure' ? 1 : 0 },
        }], page: page(snapshot, 1) };
        return { results: [{ ok: true, ...(message.actions[0].action === 'repeat' ? {
          results: [{ action: 'check', iteration: 1, subIndex: 1, ok: true }], repeatSummary: { successCount: 1, failureCount: 0 },
        } : {}) }], page: page(snapshot, 2) };
      },
    });
    assert.equal((await h.start()).outcome, 'unverified');
    assert.equal(h.calls.length, 3); assert.equal(h.executions.length, 2);
  });
}

for (const repeat of [false, true]) {
  for (const repair of [false, true]) {
    test(`${repeat ? 'repeat子批次' : '普通批次'}隐藏点击失败后wait重现并按原计划点击成功，${repair ? '另轮补足才可完成' : '次数不足仍未确认'}`, async () => {
      let visible = false;
      let clicks = 0;
      const page = (snapshot, rounds) => targetSnapshot(snapshot, `点击次数=${clicks}；观察${rounds}`, [
        { ref: rounds + 1, identity: 'document:target:button', tag: 'button', type: 'button', description: '按钮「累加」' },
      ]);
      const h = harness({
        extract: ({ snapshot }) => page(snapshot, 0),
        reply: (n) => {
          if (n === 1) {
            const actions = [{ action: 'click', ref: 1 }, { action: 'wait', value: 100 }, { action: 'click', ref: 1 }];
            return { actions: repeat ? [{ action: 'repeat', times: 1, value: 0, actions }] : actions };
          }
          if (n === 2 && repair) return { actions: [{ action: 'click', ref: 2 }] };
          return done;
        },
        execute: ({ snapshot, message, executions }) => {
          const actions = message.actions[0].action === 'repeat' ? message.actions[0].actions : message.actions;
          const children = actions.map((action, index) => {
            if (action.action === 'wait') visible = true;
            const ok = action.action === 'wait' || visible;
            if (ok && action.action === 'click') clicks++;
            return { action: action.action, iteration: 1, subIndex: index + 1, ok, ...(ok ? {} : { code: 'TARGET_HIDDEN' }) };
          });
          return { results: repeat && executions.length === 1 ? [{ ok: false, code: 'TARGET_HIDDEN', results: children, repeatSummary: { successCount: 2, failureCount: 1, skippedCount: 0 } }] : children, page: page(snapshot, executions.length) };
        },
      });
      assert.equal((await h.start('点击累加两次')).outcome, repair ? 'completed' : 'unverified');
      assert.equal(clicks, repair ? 2 : 1);
      assert.equal(h.executions.length, repair ? 2 : 1);
    });
  }
}

for (const repairBoth of [false, true]) {
  test(`同意图两次非幂等失败保留次数，另轮补${repairBoth ? '两次可完成' : '一次仍不足'}`, async () => {
    let visible = false;
    let clicks = 0;
    const page = (snapshot, rounds) => targetSnapshot(snapshot, `点击次数=${clicks}；观察${rounds}`, [
      { ref: rounds + 1, identity: 'document:target:button', tag: 'button', type: 'button', description: '按钮「累加」' },
    ]);
    const h = harness({
      extract: ({ snapshot }) => page(snapshot, 0),
      reply: (n) => n === 1 ? { actions: [{ action: 'click', ref: 1 }, { action: 'click', ref: 1 }, { action: 'wait', value: 0 }] }
        : n === 2 || (n === 3 && repairBoth) ? { actions: [{ action: 'click', ref: n }] } : done,
      execute: ({ snapshot, message, executions }) => ({ results: message.actions.map((action) => {
        if (action.action === 'wait') { visible = true; return { ok: true }; }
        if (!visible) return { ok: false, code: 'TARGET_HIDDEN' };
        clicks++; return { ok: true };
      }), page: page(snapshot, executions.length) }),
    });
    assert.equal((await h.start('点击累加两次')).outcome, repairBoth ? 'completed' : 'unverified');
    assert.equal(clicks, repairBoth ? 2 : 1);
  });
}

test('兼容旧repeat.results的真实子成功，partial后直接done仍为unverified', async () => {
  let selections = 0;
  const h = harness({
    reply: (n, { messages }) => {
      if (n === 1) return { actions: [{ action: 'repeat', times: 2, actions: [{ action: 'check', ref: 1 }, { action: 'check', ref: 2 }] }] };
      const feedback = messages.at(-1).content;
      assert.ok(feedback.includes('"children"')); assert.ok(feedback.includes('LEGACY_CHILD_APPLIED'));
      return { say: '一项已执行，另一项仍失败，等待用户核对', done: true, actions: [] };
    },
    execute: ({ snapshot }) => {
      selections++;
      return { results: [{ ok: false, code: 'STALE_TARGET', msg: '部分目标失败', results: [
        { ok: false, code: 'STALE_TARGET', msg: '旧目标失效' },
        { ok: true, msg: 'LEGACY_CHILD_APPLIED' },
      ] }], page: snapshot('一项已选中') };
    },
  });
  const outcome = await h.start();
  assert.equal(outcome.outcome, 'unverified');
  assert.equal(outcome.finalSay, '一项已执行，另一项仍失败，等待用户核对');
  assert.equal(selections, 1); assert.equal(h.calls.length, 2);
});

test('repeat累计成功不被末项失败抹掉，长children反馈有界且三轮partial不误触零成功熔断', async () => {
  let applied = 0;
  const leaves = Array.from({ length: 100 }, (_unused, index) => ({
    action: 'check', iteration: Math.floor((99 + index) / 2) + 1, subIndex: (99 + index) % 2 + 1,
    ok: index < 99, code: index < 99 ? '' : 'TARGET_NOT_FOUND',
    msg: `${index < 99 ? 'APPLIED_LEAF' : 'FAILED_LAST_LEAF'}_${index}_${'x'.repeat(2000)}`,
  }));
  const h = harness({
    reply: (n, { messages }) => {
      if (n > 1) {
        const feedback = messages.at(-1).content;
        assert.ok(feedback.length < 20000, '长子结果不能撑大下一次模型请求');
        assert.ok(feedback.includes('"children"')); assert.ok(feedback.includes('"successCount":198'));
        assert.ok(feedback.includes('"failureCount":1')); assert.ok(feedback.includes('"skippedCount":1'));
        const omitted = /"omittedCount":(\d+)/.exec(feedback);
        assert.ok(omitted && Number(omitted[1]) >= 159, '后台裁剪的子结果也应计入省略数量');
      }
      return n <= 3 ? { actions: [{ action: 'repeat', times: 100, value: 0, actions: [{ action: 'check', ref: 1 }, { action: 'check', ref: 2 }] }] } : done;
    },
    execute: ({ snapshot }) => {
      applied += 198;
      return { results: [{
        ok: false, code: 'TARGET_NOT_FOUND', msg: '在第100轮首项失败，此前99轮已执行', results: leaves,
        repeatSummary: { plannedIterations: 100, completedIterations: 99, iteration: 100, subIndex: 1, successCount: 198, failureCount: 1, skippedCount: 1, omittedCount: 99 },
      }], page: snapshot(`已应用${applied}次选择，末项失败待核对`) };
    },
  });
  assert.equal((await h.start('完成循环选择，保留成功进度', { maxSteps: 5 })).outcome, 'unverified');
  assert.equal(h.calls.length, 4); assert.equal(h.executions.length, 3); assert.equal(applied, 594);
});

test('模型请求期间晚到的关联popup丢弃旧回复，先提取新页再请求模型并操作新快照', async () => {
  const effects = [];
  const h = harness({
    getTab: async (id) => ({ id, status: 'complete', url: `http://127.0.0.1:1/${id === 2 ? 'popup' : 'page'}` }),
    extract: ({ snapshot, tabId }) => {
      const page = snapshot(tabId === 2 ? 'POPUP_FRESH_CONTENT' : 'OLD_PAGE_CONTENT');
      if (tabId === 2) { page.snapshotId = 'popup-document:1'; page.url = 'http://127.0.0.1:1/popup'; }
      return page;
    },
    execute: ({ message, snapshot }) => {
      effects.push(message.actions[0].value || 'opened popup');
      const page = snapshot(effects.length === 1 ? 'OLD_PAGE_AFTER_CLICK' : 'POPUP_ANSWER_FILLED');
      if (effects.length > 1) { page.snapshotId = 'popup-document:2'; page.url = 'http://127.0.0.1:1/popup'; }
      return { results: [{ ok: true }], page };
    },
    reply: (n, { messages }) => {
      if (n === 1) return click;
      if (n === 2) {
        h.context.chrome.tabs.onCreated.dispatch({ id: 2, openerTabId: 1, url: 'http://127.0.0.1:1/popup' });
        return { say: 'DISCARDED_OLD_REPLY', actions: [{ action: 'fill', ref: 1, value: 'DISCARDED_OLD_SIDE_EFFECT' }] };
      }
      if (n === 3) {
        assert.match(JSON.stringify(messages.at(-1)), /POPUP_FRESH_CONTENT/);
        assert.ok(!JSON.stringify(messages).includes('DISCARDED_OLD_REPLY'));
        assert.ok(!JSON.stringify(messages).includes('DISCARDED_OLD_SIDE_EFFECT'));
        return { actions: [{ action: 'fill', ref: 1, value: 'NEW_POPUP_ANSWER' }] };
      }
      return done;
    },
  });
  assert.equal((await h.start('打开新页后在新页填写答案', { maxSteps: 4 })).outcome, 'completed');
  assert.equal(h.run.activeTabId, 2); assert.equal(h.calls.length, 4);
  assert.deepEqual(effects, ['opened popup', 'NEW_POPUP_ANSWER']);
  assert.deepEqual(h.pageMessages.filter((message) => message.type === 'EXECUTE').map((message) => message.tabId), [1, 2]);
  assert.deepEqual(h.pageMessages.filter((message) => message.type === 'EXTRACT').map((message) => message.tabId), [1, 2]);
  assert.equal(h.executions[1].snapshotId, 'popup-document:1');
  assert.ok(!JSON.stringify(h.emitted).includes('DISCARDED_OLD_REPLY'));
  for (const name of ['onCreated', 'onRemoved', 'onUpdated']) assert.equal(h.context.chrome.tabs[name].size, 0);
});

test('导航来源可确认后台任务的新页，即使Edge的opener元数据指向活动页', async () => {
  const h = harness({
    navigationSource: true,
    getTab: async (id) => ({ id, status: 'complete', url: `http://127.0.0.1:1/${id === 2 ? 'popup' : 'page'}` }),
    extract: ({ snapshot, tabId }) => {
      const page = snapshot(tabId === 2 ? 'VERIFIED_TASK_POPUP' : 'ORIGINAL_TASK_PAGE');
      if (tabId === 2) { page.snapshotId = 'popup-document:1'; page.url = 'http://127.0.0.1:1/popup'; }
      return page;
    },
    reply: (n, { messages }) => {
      if (n === 1) return click;
      if (n === 2) {
        h.context.chrome.tabs.onCreated.dispatch({ id: 2, openerTabId: 99 });
        h.context.chrome.webNavigation.onCreatedNavigationTarget.dispatch({ tabId: 2, sourceTabId: 1 });
        return { say: 'DISCARDED_WRONG_PAGE_REPLY', actions: [{ action: 'fill', ref: 1, value: 'MUST_NOT_EXECUTE' }] };
      }
      assert.match(JSON.stringify(messages.at(-1)), /VERIFIED_TASK_POPUP/);
      assert.ok(!JSON.stringify(messages).includes('DISCARDED_WRONG_PAGE_REPLY'));
      return done;
    },
  });
  assert.equal((await h.start('继续任务自己打开的新页')).outcome, 'completed');
  assert.equal(h.run.activeTabId, 2);
  assert.equal(h.calls.length, 3);
  assert.equal(h.executions.length, 1);
  assert.deepEqual(h.pageMessages.filter((item) => item.type === 'EXTRACT').map((item) => item.tabId), [1, 2]);
  assert.ok(!JSON.stringify(h.emitted).includes('DISCARDED_WRONG_PAGE_REPLY'));
  assert.equal(h.context.chrome.webNavigation.onCreatedNavigationTarget.size, 0);
});

for (const kind of ['foreign-source', 'no-operation', 'expired', 'non-http', 'cancelled']) {
  test(`可靠导航来源 ${kind} 不接管无关标签并清理监听`, async () => {
    let now = Date.now();
    const h = harness({
      navigationSource: true,
      getTab: async (id) => ({ id, status: 'complete', url: id === 2 && kind === 'non-http' ? 'chrome://settings/' : `http://127.0.0.1:1/${id === 2 ? 'popup' : 'page'}` }),
      reply: async (n) => {
        if (n === 1 && kind !== 'no-operation') return click;
        if (kind === 'expired') now += 5000;
        h.context.chrome.tabs.onCreated.dispatch({ id: 2, openerTabId: 1 });
        h.context.chrome.webNavigation.onCreatedNavigationTarget.dispatch({ tabId: 2, sourceTabId: kind === 'foreign-source' ? 99 : 1 });
        if (kind === 'cancelled') await h.context.cancelRun(h.run);
        return done;
      },
    });
    h.context.Date = class extends Date { static now() { return now; } };
    assert.equal((await h.start('保持任务页绑定')).outcome, kind === 'cancelled' ? 'cancelled' : 'completed');
    assert.equal(h.run.activeTabId, 1);
    assert.equal(h.extracts.length, 1);
    assert.equal(h.executions.length, kind === 'no-operation' ? 0 : 1);
    assert.equal(h.context.chrome.webNavigation.onCreatedNavigationTarget.size, 0);
    for (const name of ['onCreated', 'onRemoved', 'onUpdated']) assert.equal(h.context.chrome.tabs[name].size, 0);
  });
}

for (const kind of ['no-operation', 'wrong-opener', 'expired', 'closed', 'non-http', 'cancelled']) {
  test(`popup ${kind}不会让任务抢占新标签页或执行旧模型回复`, async () => {
    let now = Date.now();
    const h = harness({
      getTab: async (id) => ({ id, status: 'complete', url: id === 2 && kind === 'non-http' ? 'chrome://settings/' : `http://127.0.0.1:1/${id === 2 ? 'popup' : 'page'}` }),
      reply: async (n) => {
        if (n === 1 && kind !== 'no-operation') return click;
        if (kind === 'expired') now += 5000;
        h.context.chrome.tabs.onCreated.dispatch({ id: 2, openerTabId: kind === 'wrong-opener' ? 99 : 1, url: kind === 'non-http' ? 'chrome://settings/' : 'http://127.0.0.1:1/popup' });
        if (kind === 'closed') h.context.chrome.tabs.onRemoved.dispatch(2);
        if (kind === 'cancelled') await h.context.cancelRun(h.run);
        return done;
      },
    });
    h.context.Date = class extends Date { static now() { return now; } };
    assert.equal((await h.start('在当前任务页继续', { maxSteps: 4 })).outcome, kind === 'cancelled' ? 'cancelled' : 'completed');
    assert.equal(h.run.activeTabId, 1);
    assert.equal(h.calls.length, kind === 'no-operation' ? 1 : 2);
    assert.equal(h.executions.length, kind === 'no-operation' ? 0 : 1);
    assert.equal(h.extracts.length, 1);
    for (const name of ['onCreated', 'onRemoved', 'onUpdated']) assert.equal(h.context.chrome.tabs[name].size, 0);
  });
}

test('派发结果未知按operationId逐slot结算且计入预算，替换旧观察后不空转五十轮', async () => {
  const actions = [{ action: 'click', ref: 1 }, { action: 'fill', ref: 1, value: '答案37' }, { action: 'check', ref: 1 }];
  const h = harness({ reply: () => ({ actions }), execute: () => { throw new Error('Disconnected'); } });
  assert.equal((await h.start()).outcome, 'stalled');
  assert.equal(h.calls.length, 3);
  assert.equal(h.extracts.length, 4);
  assert.ok(!JSON.stringify(h.calls[1]).includes('INITIAL_SNAPSHOT'));
  const batches = h.emitted.filter((event) => event.t === 'actions');
  const results = h.emitted.filter((event) => event.t === 'result');
  assert.equal(batches.length, 3); assert.equal(results.length, 9);
  assert.equal(new Set(batches.map((event) => event.operationId)).size, 3);
  batches.forEach((batch, index) => {
    assert.ok(batch.operationId); assert.equal(batch.round, index + 1);
    const settled = results.filter((result) => result.operationId === batch.operationId);
    assert.deepEqual(settled.map(({ index, ok, code }) => ({ index, ok, code })), [
      { index: 0, ok: false, code: 'DISPATCH_UNCONFIRMED' },
      { index: 1, ok: false, code: 'DISPATCH_UNCONFIRMED' },
      { index: 2, ok: false, code: 'DISPATCH_UNCONFIRMED' },
    ]);
    settled.forEach((result) => {
      assert.equal(result.round, batch.round);
      assert.ok(h.emitted.indexOf(result) > h.emitted.indexOf(batch));
      if (batches[index + 1]) assert.ok(h.emitted.indexOf(result) < h.emitted.indexOf(batches[index + 1]));
    });
  });
  h.executions.forEach((execution) => {
    assert.ok(batches.some((batch) => batch.operationId === execution.operationId));
    assert.deepEqual(execution.actions, actions);
  });
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

test('EXECUTE点击导航丢回执不重放旧快照，读取新文档并按已派发但未知结算', async () => {
  let arrived = false;
  const h = harness({
    reply: (n) => n === 1 ? { actions: [{ action: 'click', ref: 1 }] } : done,
    getTab: async () => arrived
      ? { id: 1, url: 'http://127.0.0.1:1/search?q=test', status: 'complete' }
      : { id: 1, url: 'http://127.0.0.1:1/page', status: 'complete' },
    extract: ({ snapshot, extracts }) => {
      const page = snapshot(extracts.length === 1 ? 'INITIAL_SNAPSHOT' : 'SEARCH_RESULTS_FOUND');
      if (extracts.length > 1) { page.snapshotId = 'new-document:1'; page.url = 'http://127.0.0.1:1/search?q=test'; }
      return page;
    },
    execute: () => {
      if (arrived) {
        // 最小复现实测形态：旧代码会把携带旧 snapshotId 的 EXECUTE 重发到已经重建的文档，
        // 新文档只能回批次级 STALE_SNAPSHOT，用户看到“页面已变化/未执行”。
        return { results: [{ ok: false, code: 'STALE_SNAPSHOT', msg: '页面已跳转或快照已重建，请重新读取页面' }] };
      }
      // 真实浏览器：点击导致文档卸载，消息端口随之关闭，回执永远收不到。
      arrived = true;
      h.context.chrome.tabs.onUpdated.dispatch(1, { status: 'loading' });
      throw new Error('The message port closed before a response was received');
    },
  });
  const outcome = await h.start('在搜索框输入并点击搜索');
  // 旧行为正是在这里重发旧快照并收到 STALE_SNAPSHOT，界面因此提示“页面已变化/未执行”。
  assert.ok(!h.emitted.some((event) => event.code === 'STALE_SNAPSHOT'));
  // 只派发一次：旧 snapshotId 绝不重发到新文档。
  assert.equal(h.executions.length, 1);
  assert.equal(h.pageMessages.filter((message) => message.type === 'EXECUTE').length, 1);
  assert.equal(h.executions[0].snapshotId, 'document:1');
  const firstRound = h.emitted.filter((event) => event.t === 'result' && event.round === 1);
  assert.deepEqual(firstRound.map(({ index, ok, code }) => ({ index, ok, code })), [{ index: 0, ok: false, code: 'DISPATCH_UNCONFIRMED' }]);
  assert.deepEqual(firstRound.map((event) => event.notDispatched), [false]);
  assert.ok(firstRound.every((event) => /没有收到执行回执/u.test(event.msg)));
  assert.equal(firstRound[0].navigationUrl, 'http://127.0.0.1:1/search?q=test');
  // 新页面被如实读取并交给模型核对，而不是把旧页面或“未执行”当结果。
  assert.equal(h.extracts.length, 2);
  assert.match(JSON.stringify(h.calls[1]), /SEARCH_RESULTS_FOUND/);
  assert.doesNotMatch(JSON.stringify(h.calls[1]), /INITIAL_SNAPSHOT/);
  assert.match(h.calls[1].at(-1).content, /没有收到执行回执/u);
  assert.match(h.calls[1].at(-1).content, /不能视为成功/u);
  // 未确认的点击不能被后续 done 冒充成功。
  assert.equal(outcome.outcome, 'unverified');
  assert.equal(h.calls.length, 2);
});

test('连续三轮导航丢回执不占失败预算，不被误判为“未能执行任何操作”', async () => {
  let round = 0;
  const h = harness({
    reply: (n) => n <= 3 ? { actions: [{ action: 'click', ref: 1 }] } : done,
    getTab: async () => ({ id: 1, url: `http://127.0.0.1:1/step${round}`, status: 'complete' }),
    extract: ({ snapshot, extracts }) => {
      const page = snapshot(`STEP_${extracts.length}`);
      page.snapshotId = `document-${extracts.length}:1`;
      page.url = `http://127.0.0.1:1/step${extracts.length}`;
      return page;
    },
    execute: () => {
      round += 1;
      h.context.chrome.tabs.onUpdated.dispatch(1, { status: 'loading' });
      throw new Error('The message port closed before a response was received');
    },
  });
  const outcome = await h.start('连续点击跳转');
  assert.equal(h.calls.length, 4);
  assert.equal(h.executions.length, 3);
  assert.equal(h.extracts.length, 4);
  assert.ok(!h.emitted.some((event) => event.t === 'say' && /未能执行任何操作|没有变化/u.test(event.text)));
  assert.equal(outcome.outcome, 'unverified');
});

test('批次级快照拒绝整批标记未派发，不留永久未确认证据，重读后可完成', async () => {
  const h = harness({
    reply: (n) => n === 1
      ? { actions: [{ action: 'fill', ref: 1, value: '答案37' }, { action: 'click', ref: 2 }] }
      : n === 2 ? { actions: [{ action: 'fill', ref: 1, value: '答案37' }] } : done,
    execute: ({ snapshot, message, executions }) => executions.length === 1
      ? { results: [{ ok: false, code: 'STALE_SNAPSHOT', msg: '页面已跳转或快照已重建，请重新读取页面' }] }
      : { results: message.actions.map(() => ({ ok: true, code: 'FILLED' })), page: snapshot() },
  });
  const outcome = await h.start('填写答案');
  assert.equal(h.extracts.length, 2);
  const firstRound = h.emitted.filter((event) => event.t === 'result' && event.round === 1);
  // 批次级拒绝发生在任何动作之前：第一个是拒绝原因，其余明确为未派发，不能变成 INVALID_RESPONSE。
  assert.deepEqual(firstRound.map(({ index, ok, code }) => ({ index, ok, code })), [
    { index: 0, ok: false, code: 'STALE_SNAPSHOT' },
    { index: 1, ok: false, code: 'NOT_DISPATCHED' },
  ]);
  // 侧栏据此显示“未执行”，不能把首项 STALE_SNAPSHOT 当成执行失败。
  assert.deepEqual(firstRound.map((event) => event.notDispatched), [true, true]);
  assert.match(JSON.stringify(h.calls[1]), /NOT_DISPATCHED/);
  assert.doesNotMatch(JSON.stringify(h.calls[1]), /INVALID_RESPONSE/);
  // 重读后的真实成功即算完成：未派发的批次不欠确认。
  assert.equal(outcome.outcome, 'completed');
  assert.equal(h.calls.length, 3);
});

test('整批拒绝含repeat动作时未派发槽位不欠确认，重读真实成功后仍可完成', async () => {
  const h = harness({
    reply: (n) => n === 1
      ? { actions: [{ action: 'repeat', times: 2, actions: [{ action: 'click', ref: 1 }] }] }
      : n === 2 ? { actions: [{ action: 'click', ref: 1 }] } : done,
    execute: ({ snapshot, message, executions }) => executions.length === 1
      ? { results: [{ ok: false, code: 'STALE_SNAPSHOT', msg: '页面已跳转或快照已重建，请重新读取页面' }] }
      : { results: message.actions.map(() => ({ ok: true })), page: snapshot() },
  });
  const outcome = await h.start('循环点击两次');
  const firstRound = h.emitted.filter((event) => event.t === 'result' && event.round === 1);
  // repeat 槽位同样是整批拒绝，没有任何子动作派发过。
  assert.deepEqual(firstRound.map(({ index, ok, code, notDispatched }) => ({ index, ok, code, notDispatched })),
    [{ index: 0, ok: false, code: 'STALE_SNAPSHOT', notDispatched: true }]);
  assert.equal(h.extracts.length, 2);
  // repeat 分支不能因为没有 children 就把 incomplete 永久钉死。
  assert.doesNotMatch(JSON.stringify(h.calls[1]), /仍有操作未获成功确认/u);
  assert.equal(outcome.outcome, 'completed');
  assert.equal(h.calls.length, 3);
});

test('多动作批次整批拒绝时补齐槽位的repeat不新增未确认证据', async () => {
  const h = harness({
    reply: (n) => n === 1
      ? { actions: [{ action: 'click', ref: 1 }, { action: 'repeat', times: 2, actions: [{ action: 'click', ref: 1 }] }] }
      : n === 2 ? { actions: [{ action: 'click', ref: 1 }] } : done,
    execute: ({ snapshot, message, executions }) => executions.length === 1
      ? { results: [{ ok: false, code: 'STALE_SNAPSHOT', msg: '页面已跳转或快照已重建，请重新读取页面' }] }
      : { results: message.actions.map(() => ({ ok: true })), page: snapshot() },
  });
  const outcome = await h.start('点击并循环点击');
  const firstRound = h.emitted.filter((event) => event.t === 'result' && event.round === 1);
  assert.deepEqual(firstRound.map(({ index, code, notDispatched }) => ({ index, code, notDispatched })), [
    { index: 0, code: 'STALE_SNAPSHOT', notDispatched: true },
    { index: 1, code: 'NOT_DISPATCHED', notDispatched: true },
  ]);
  assert.doesNotMatch(JSON.stringify(h.calls[1]), /仍有操作未获成功确认/u);
  assert.equal(outcome.outcome, 'completed');
  assert.equal(h.calls.length, 3);
});

test('批次级拒绝后零确认提交仍被硬闸拦下一次并重读', async () => {
  const h = harness({
    reply: (n) => n === 1 ? { actions: [{ action: 'submitForm', ref: 2 }] } : n === 2 ? { actions: [{ action: 'submitForm', ref: 2 }] } : done,
    execute: ({ snapshot, message, executions }) => executions.length === 1
      ? { results: [{ ok: false, code: 'STALE_SNAPSHOT' }] }
      : { results: message.actions.map(() => ({ ok: true })), page: snapshot() },
  });
  await h.start('提交表单');
  // 第二轮提交被硬闸拦下，只重读页面未执行；未派发的批次不能替代这道闸。
  assert.equal(h.executions.length, 1);
  assert.equal(h.extracts.length, 3);
  assert.match(JSON.stringify(h.calls[2]), /已拦下这一次提交并重新读取页面/);
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

// P1 回归：repeat[click, wait, fill] times=3，第 2 轮 fill 失败导致第 3 轮未启动。
// 未启动的 wait 没有副作用，且 wait 的成功从不结算证据，不能计欠；只有 click 这类真实副作用欠账要补。
function repeatWaitFixture(catchUpActions) {
  const page = (snapshot, round) => targetSnapshot(snapshot, `repeat等待观察${round}`, [
    { ref: 1, identity: 'document:target:answer', tag: 'input', type: 'text', description: '输入框(text) 标签:答案 当前为空' },
  ]);
  const children = [
    { action: 'click', iteration: 1, subIndex: 1, ok: true },
    { action: 'wait', iteration: 1, subIndex: 2, ok: true },
    { action: 'fill', iteration: 1, subIndex: 3, ok: true },
    { action: 'click', iteration: 2, subIndex: 1, ok: true },
    { action: 'wait', iteration: 2, subIndex: 2, ok: true },
    { action: 'fill', iteration: 2, subIndex: 3, ok: false, code: 'VALUE_NOT_APPLIED', msg: '字段未保留' },
  ];
  return harness({
    extract: ({ snapshot, executions }) => page(snapshot, executions.length),
    reply: (n) => n === 1
      ? { actions: [{ action: 'repeat', times: 3, value: 0, actions: [
        { action: 'click', ref: 1 }, { action: 'wait', value: 50 }, { action: 'fill', ref: 1, value: 'x' },
      ] }] }
      : n === 2 ? { actions: catchUpActions } : done,
    execute: ({ snapshot, message, executions }) => {
      if (executions.length === 1) {
        return { results: [{
          ok: false, code: 'VALUE_NOT_APPLIED', msg: '循环在第 2 轮停止', results: children,
          repeatSummary: { plannedIterations: 3, completedIterations: 1, iteration: 2, subIndex: 3, successCount: 5, failureCount: 1, skippedCount: 3, omittedCount: 0 },
        }], page: page(snapshot, 1) };
      }
      return { results: message.actions.map(() => ({ ok: true })), page: page(snapshot, 2) };
    },
  });
}

test('repeat未启动的wait不计欠：click与fill补齐后completed', async () => {
  const h = repeatWaitFixture([
    { action: 'click', ref: 1 }, { action: 'wait', value: 50 }, { action: 'fill', ref: 1, value: 'x' },
  ]);
  assert.equal((await h.start('重复点击并填写三次')).outcome, 'completed');
  assert.equal(h.executions.length, 2);
  // 未启动的 wait 不再进入欠账列表（fill 幂等、click 由本轮 click 结算）。
  const observation = h.calls.at(-1).at(-1).content;
  assert.doesNotMatch(observation, /仍有操作未获成功确认/u);
});

test('repeat未启动的wait不计欠不等于放行真实副作用：click次数不足仍unverified', async () => {
  const h = repeatWaitFixture([
    { action: 'wait', value: 50 }, { action: 'fill', ref: 1, value: 'x' },
  ]);
  assert.equal((await h.start('重复点击并填写三次')).outcome, 'unverified');
  assert.equal(h.executions.length, 2);
  assert.match(h.calls.at(-1).at(-1).content, /仍有操作未获成功确认/u);
});

for (const repairCount of [1, 3]) {
  test(`repeat未枚举的后续非幂等次数补做${repairCount}次${repairCount === 3 ? '足额恢复' : '仍未确认'}`, async () => {
    let clicks = 0;
    const page = (snapshot, round) => targetSnapshot(snapshot, `实际点击${clicks}次；观察${round}`, [{
      ref: round + 1, identity: 'document:target:counter', tag: 'button', type: 'button', description: '按钮「累加」',
    }]);
    const h = harness({
      extract: ({ snapshot }) => page(snapshot, 0),
      reply: (n) => n === 1 ? { actions: [{ action: 'repeat', times: 3, value: 0, actions: [{ action: 'click', ref: 1 }] }] }
        : n === 2 ? { actions: Array.from({ length: repairCount }, () => ({ action: 'click', ref: 2 })) } : done,
      execute: ({ snapshot, executions, message }) => {
        if (executions.length === 1) return { results: [{
          ok: false, code: 'TARGET_HIDDEN', results: [{ action: 'click', iteration: 1, subIndex: 1, ok: false, code: 'TARGET_HIDDEN' }],
          repeatSummary: { plannedIterations: 3, completedIterations: 1, iteration: 1, subIndex: 1, successCount: 0, failureCount: 1, skippedCount: 2, omittedCount: 0 },
        }], page: page(snapshot, 1) };
        clicks += message.actions.length;
        return { results: message.actions.map(() => ({ ok: true })), page: page(snapshot, 2) };
      },
    });
    assert.equal((await h.start('点击累加三次')).outcome, repairCount === 3 ? 'completed' : 'unverified');
    assert.equal(clicks, repairCount);
    assert.equal(h.executions.length, 2);
    assert.equal(/仍有操作未获成功确认/.test(h.calls.at(-1).at(-1).content), repairCount !== 3);
  });
}

for (const repairBoth of [false, true]) {
  test(`repeat已枚举的失败与跳过项补做${repairBoth ? '足够可恢复完成' : '不足仍未确认'}`, async () => {
    let clicks = 0;
    const page = (snapshot, round) => targetSnapshot(snapshot, `实际点击${clicks}次；观察${round}`, [{
      ref: round + 1, identity: 'document:target:counter', tag: 'button', type: 'button', description: '按钮「累加」',
    }]);
    const h = harness({
      extract: ({ snapshot }) => page(snapshot, 0),
      reply: (n) => n === 1 ? { actions: [{ action: 'repeat', times: 1, value: 0, actions: [{ action: 'click', ref: 1 }, { action: 'click', ref: 1 }] }] }
        : n === 2 ? { actions: Array.from({ length: repairBoth ? 2 : 1 }, () => ({ action: 'click', ref: 2 })) } : done,
      execute: ({ snapshot, executions, message }) => {
        if (executions.length === 1) return { results: [{
          ok: false, code: 'ACTION_ERROR', results: [
            { action: 'click', iteration: 1, subIndex: 1, ok: false, code: 'ACTION_ERROR' },
            { action: 'click', iteration: 1, subIndex: 2, ok: false, code: 'SKIPPED_AFTER_FAILURE' },
          ], repeatSummary: { plannedIterations: 1, completedIterations: 0, iteration: 1, subIndex: 1, successCount: 0, failureCount: 1, skippedCount: 1, omittedCount: 0 },
        }], page: page(snapshot, 1) };
        clicks += message.actions.length;
        return { results: message.actions.map(() => ({ ok: true })), page: page(snapshot, 2) };
      },
    });
    assert.equal((await h.start('点击累加两次')).outcome, repairBoth ? 'completed' : 'unverified');
    assert.equal(clicks, repairBoth ? 2 : 1);
  });
}

for (const code of ['NAVIGATING', 'NAVIGATED', 'SKIPPED_AFTER_NAVIGATION']) {
  test(`repeat导航跳过${code}不新增未枚举失败`, async () => {
    const h = harness({ reply: () => done });
    const actions = [{ action: 'repeat', times: 3, value: 0, actions: [{ action: 'click', ref: 1 }] }];
    const ok = code !== 'SKIPPED_AFTER_NAVIGATION';
    const raw = [{ ok, code, results: [{ action: 'click', iteration: 1, subIndex: 1, ok, code }],
      repeatSummary: { plannedIterations: 3, completedIterations: 0, iteration: 1, subIndex: 1, successCount: ok ? 1 : 0, failureCount: 0, skippedCount: ok ? 2 : 3, omittedCount: 0 } }];
    const unresolved = { pending: new Map(), incomplete: false };
    await h.context.executionEvidence(h.context.summarizeResults(raw), actions, raw, {}, 1, unresolved);
    assert.equal(unresolved.pending.size, 0);
    assert.equal(unresolved.incomplete, false);
  });
}

for (const state of ['cancelled', 'finished']) {
  for (const stage of ['入口', '注入前', '注入后']) {
    test(`csSend在${stage}阻断${state}任务，不重发页面消息`, async () => {
      const h = harness({ reply: () => done });
      let sends = 0;
      let injections = 0;
      if (stage === '入口') h.run[state] = true;
      h.context.chrome.tabs.sendMessage = async () => {
        sends++;
        if (stage === '入口') return { ok: true };
        if (stage === '注入前') h.run[state] = true;
        throw new Error('Receiving end does not exist');
      };
      h.context.chrome.scripting.executeScript = async () => { injections++; if (stage === '注入后') h.run[state] = true; };
      await assert.rejects(h.context.csSend(1, { type: 'EXTRACT', runId: h.run.runId }, h.run), (error) => error.code === 'CANCELLED');
      assert.equal(sends, stage === '入口' ? 0 : 1);
      assert.equal(injections, stage === '注入后' ? 1 : 0);
    });
  }
}

test('csSend对只读消息仍注入后重发一次', async () => {
  const h = harness({ reply: () => done });
  const sent = [];
  let injections = 0;
  h.context.chrome.tabs.sendMessage = async (_id, message) => {
    sent.push(structuredClone(message));
    if (sent.length === 1) throw new Error('Receiving end does not exist');
    return { snapshotId: 'document:1' };
  };
  h.context.chrome.scripting.executeScript = async () => { injections++; };
  const message = { type: 'EXTRACT', runId: h.run.runId };
  assert.equal((await h.context.csSend(1, message, h.run)).snapshotId, 'document:1');
  assert.equal(injections, 1);
  assert.deepEqual(sent, [message, message]);
});

test('EXECUTE回执丢失不注入也不重发，交后台按已派发但未知结算', async () => {
  const h = harness({ reply: () => done });
  const sent = [];
  let injections = 0;
  h.context.chrome.tabs.sendMessage = async (_id, message) => {
    sent.push(structuredClone(message));
    throw new Error('The message port closed before a response was received');
  };
  h.context.chrome.scripting.executeScript = async () => { injections++; };
  const message = { type: 'EXECUTE', runId: h.run.runId, operationId: 'same-operation', snapshotId: 'document:1', actions: [{ action: 'click', ref: 1 }] };
  await assert.rejects(h.context.csSend(1, message, h.run), (error) => error.code === 'DELIVERY_UNCONFIRMED' && error.deliveryUnconfirmed === true);
  assert.equal(injections, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].snapshotId, 'document:1');
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function connectAgent(context) {
  const messages = [];
  const port = {
    name: 'agent', sender: { id: 'mock', url: 'chrome-extension://mock/sidepanel.html' },
    onMessage: event(), onDisconnect: event(), postMessage: (message) => messages.push(structuredClone(message)),
  };
  context.chrome.runtime.onConnect.dispatch(port);
  return { port, messages };
}

test('取消注入按先旧后新完成时旧EXTRACT不抢占新run快照', async () => {
  const h = harness({ reply: () => done });
  h.context.requestModel = h.nativeRequestModel;
  const firstStarted = deferred();
  const secondStarted = deferred();
  const injections = [deferred(), deferred()];
  const oldExtraction = deferred();
  const originalSend = h.context.chrome.tabs.sendMessage;
  const extractedRuns = [];
  let injectionCount = 0;
  let installed = false;
  let extracting = false;
  h.context.chrome.scripting.executeScript = async () => {
    const index = injectionCount++;
    (index === 0 ? firstStarted : secondStarted).resolve();
    await injections[index].promise;
    installed = true;
  };
  h.context.chrome.tabs.sendMessage = async (tabId, message) => {
    if (!installed) throw new Error('Receiving end does not exist');
    if (message.type !== 'EXTRACT') return originalSend(tabId, message);
    extractedRuns.push(message.runId);
    if (extracting) return { code: 'BUSY', error: '页面正在处理另一项请求' };
    extracting = true;
    try {
      if (message.runId === 'cancelled-old') await oldExtraction.promise;
      return await originalSend(tabId, message);
    } finally { extracting = false; }
  };
  const old = connectAgent(h.context);
  let next;
  try {
    old.port.onMessage.dispatch({ t: 'RUN', runId: 'cancelled-old', tabId: 1, question: '旧任务', allowActions: true });
    await firstStarted.promise;
    old.port.onDisconnect.dispatch();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(vm.runInContext('activeRun', h.context), null);
    next = connectAgent(h.context);
    next.port.onMessage.dispatch({ t: 'RUN', runId: 'new-run', tabId: 1, question: '新任务', allowActions: true });
    await secondStarted.promise;
    injections[0].resolve();
    await new Promise((resolve) => setImmediate(resolve));
    injections[1].resolve();
    for (let n = 0; n < 20 && !next.messages.some((message) => ['model_request', 'done'].includes(message.t)); n++) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(extractedRuns, ['new-run'], '已取消的旧任务不得在注入后重发EXTRACT');
    const request = next.messages.find((message) => message.t === 'model_request');
    assert.ok(request, '新任务必须正常读取并请求模型，不能因旧任务的BUSY中断');
    next.port.onMessage.dispatch({ t: 'model_response', runId: 'new-run', requestId: request.requestId, text: JSON.stringify(done) });
    for (let n = 0; n < 20 && !next.messages.some((message) => message.t === 'done'); n++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(next.messages.find((message) => message.t === 'done')?.outcome, 'completed');
  } finally {
    injections.forEach((gate) => gate.resolve());
    oldExtraction.resolve();
    next?.port.onDisconnect.dispatch();
    old.port.onDisconnect.dispatch();
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test('关闭窗口只回收对应chat键，仍存在窗口及其他会话设置全部保留', async () => {
  const session = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`chat:${index + 1}`, [{ role: 'user', content: `窗口${index + 1}历史` }]]));
  session['chat:100'] = [{ role: 'assistant', content: '不同窗口，不能按前缀删除' }];
  session.mode = 'agent';
  const h = harness({ reply: () => done, session });
  h.context.chrome.windows.onRemoved.dispatch(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.removedSessionKeys, ['chat:1']);
  const { 'chat:1': removed, ...remaining } = session;
  assert.ok(removed);
  assert.deepEqual(h.session, remaining);
});

test('侧栏断开和普通标签关闭不删除窗口聊天历史', async () => {
  const session = { 'chat:1': [{ role: 'user', content: '关闭侧栏后还需恢复' }], 'chat:2': [{ role: 'user', content: '另一个仍存在窗口' }] };
  const h = harness({ reply: () => done, session });
  const panel = connectAgent(h.context);
  panel.port.onDisconnect.dispatch();
  h.context.chrome.tabs.onRemoved.dispatch(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.removedSessionKeys, []);
  assert.deepEqual(h.session, session);
});

for (const hasBoundary of [true, false]) {
  test(`repeat截断成功历史后补足剩余次数${hasBoundary ? '可完成且不重计旧成功' : '缺少迭代边界保持未确认'}`, async () => {
    const counts = [0, 0];
    const page = (snapshot, round) => targetSnapshot(snapshot, `实际点击${counts.join('/')}次；观察${round}`, counts.map((_count, index) => ({
      ref: round * 2 + index + 1, identity: `document:target:counter-${index}`, tag: 'button', type: 'button', description: `按钮「累加${index}」`,
    })));
    const history = Array.from({ length: 116 }, (_unused, index) => ({
      action: 'click', iteration: Math.floor(index / 2) + 1, subIndex: index % 2 + 1,
      ok: index !== 114, ...(index === 114 ? { code: 'TARGET_HIDDEN' } : {}),
    }));
    const h = harness({
      extract: ({ snapshot }) => page(snapshot, 0),
      reply: (n) => n === 1 ? { actions: [{ action: 'repeat', times: 60, value: 0, actions: [{ action: 'click', ref: 1 }, { action: 'click', ref: 2 }] }] }
        : n === 2 ? { actions: [...Array.from({ length: 3 }, () => ({ action: 'click', ref: 3 })), ...Array.from({ length: 2 }, () => ({ action: 'click', ref: 4 }))] } : done,
      execute: ({ snapshot, executions, message }) => {
        if (executions.length === 1) {
          counts[0] = 57; counts[1] = 58;
          return { results: [{ ok: false, code: 'TARGET_HIDDEN', results: history.slice(-100), repeatSummary: {
            plannedIterations: 60, completedIterations: 58, ...(hasBoundary ? { iteration: 58 } : {}), subIndex: 2,
            successCount: 115, failureCount: 1, skippedCount: 4, omittedCount: 16,
          } }], page: page(snapshot, 1) };
        }
        for (const action of message.actions) counts[action.ref - 3]++;
        return { results: message.actions.map(() => ({ ok: true })), page: page(snapshot, 2) };
      },
    });
    assert.equal((await h.start('两个计数器各点击60次')).outcome, hasBoundary ? 'completed' : 'unverified');
    assert.deepEqual(counts, [60, 60]);
    assert.equal(h.executions.length, 2);
  });
}

test('repeat未来跳过项已枚举时补足三次即可恢复，不重复记债', async () => {
  let clicks = 0;
  const page = (snapshot, round) => targetSnapshot(snapshot, `实际点击${clicks}次；观察${round}`, [{
    ref: round + 1, identity: 'document:target:counter', tag: 'button', type: 'button', description: '按钮「累加」',
  }]);
  const h = harness({
    extract: ({ snapshot }) => page(snapshot, 0),
    reply: (n) => n === 1 ? { actions: [{ action: 'repeat', times: 3, value: 0, actions: [{ action: 'click', ref: 1 }] }] }
      : n === 2 ? { actions: Array.from({ length: 3 }, () => ({ action: 'click', ref: 2 })) } : done,
    execute: ({ snapshot, executions, message }) => {
      if (executions.length === 1) return { results: [{ ok: false, code: 'ACTION_ERROR', results: [1, 2, 3].map((iteration) => ({
        action: 'click', iteration, subIndex: 1, ok: false, code: iteration === 1 ? 'ACTION_ERROR' : 'SKIPPED_AFTER_FAILURE',
      })), repeatSummary: { plannedIterations: 3, completedIterations: 0, iteration: 1, subIndex: 1, successCount: 0, failureCount: 1, skippedCount: 2, omittedCount: 0 } }], page: page(snapshot, 1) };
      clicks += message.actions.length;
      return { results: message.actions.map(() => ({ ok: true })), page: page(snapshot, 2) };
    },
  });
  assert.equal((await h.start('点击累加三次')).outcome, 'completed');
  assert.equal(clicks, 3);
});

for (const code of ['NAVIGATING', 'NAVIGATED']) {
  test(`仅批级导航${code}仍等待新文档，保留填写失败与submit跳过`, async () => {
    const arrivedUrl = 'http://127.0.0.1:1/arrived';
    const internalMessage = 'BATCH_NAVIGATION_INTERNAL_MESSAGE';
    let tabChecks = 0;
    const h = harness({
      reply: (n) => n === 1 ? { actions: [{ action: 'fill', ref: 1, value: 'answer' }, { action: 'submitForm', ref: 2 }] } : done,
      getTab: async () => ++tabChecks === 1 ? { id: 1, status: 'loading', url: 'http://127.0.0.1:1/page' }
        : { id: 1, status: 'complete', url: arrivedUrl },
      extract: ({ snapshot, extracts }) => {
        const page = targetSnapshot(snapshot, extracts.length === 1 ? 'SOURCE_FORM' : 'ARRIVED_NEW_DOCUMENT', [
          { ref: 1, identity: 'document:target:answer', tag: 'input', type: 'text', description: '输入框(text) 标签:答案 当前为空' },
          { ref: 2, identity: 'document:target:submit', tag: 'button', type: 'submit', submitsForm: true, description: '按钮「提交」',
          },
        ]);
        if (extracts.length > 1) { page.snapshotId = 'arrived-document:1'; page.url = arrivedUrl; }
        return page;
      },
      execute: ({ snapshot }) => ({
        results: [{ ok: false, code: 'VALUE_NOT_APPLIED' }, { ok: false, code: 'SKIPPED_AFTER_FAILURE' }],
        navigation: { ok: true, code, navigationUrl: arrivedUrl, msg: internalMessage },
        page: snapshot('OLD_EXECUTOR_PAGE'),
      }),
    });
    assert.equal((await h.start('填写成功后再提交')).outcome, 'unverified');
    assert.equal(tabChecks, 2, '没有loading事件或动作导航code兜底，也必须等待批级导航');
    assert.equal(h.extracts.length, 2);
    const results = h.emitted.filter((event) => event.t === 'result');
    assert.deepEqual(results.map(({ ok, code }) => ({ ok, code })), [
      { ok: false, code: 'VALUE_NOT_APPLIED' }, { ok: false, code: 'SKIPPED_AFTER_FAILURE' },
    ]);
    assert.ok(h.emitted.some((event) => event.t === 'status' && event.text === '等待页面跳转完成…'));
    const latest = h.calls[1].at(-1).content;
    assert.match(latest, /ARRIVED_NEW_DOCUMENT/);
    assert.doesNotMatch(latest, /OLD_EXECUTOR_PAGE/);
    assert.match(latest, /VALUE_NOT_APPLIED/);
    assert.match(latest, /SKIPPED_AFTER_FAILURE/);
    assert.ok(!JSON.stringify(h.calls).includes(internalMessage), '批级导航原文不得进入模型历史');
  });
}

for (const navigation of [{ ok: false, code: 'NAVIGATING' }, { ok: true, code: 'UNKNOWN' }]) {
  test(`无效批级导航${JSON.stringify(navigation)}不触发导航等待`, async () => {
    const h = harness({
      reply: (n) => n === 1 ? { actions: [{ action: 'fill', ref: 1, value: 'answer' }] } : done,
      getTab: async () => { throw new Error('无效批级导航不应查询标签状态'); },
      execute: ({ snapshot }) => ({ results: [{ ok: false, code: 'VALUE_NOT_APPLIED' }], navigation, page: snapshot('FRESH_SAME_DOCUMENT') }),
    });
    assert.equal((await h.start()).outcome, 'unverified');
    assert.equal(h.extracts.length, 1);
    assert.ok(!h.emitted.some((event) => event.t === 'status' && event.text === '等待页面跳转完成…'));
  });
}
