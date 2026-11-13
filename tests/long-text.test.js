'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { getEventListeners } = require('node:events');
const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const config = { id: 'fixture', name: 'Fixture', baseUrl: 'https://model.example.test/v1', model: 'fixture', apiKey: '', vision: false };
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, removeListener(fn) { this.listeners = this.listeners.filter(item => item !== fn); } });
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function loadCore(fetch = async () => { throw new Error('Unexpected network access'); }, globals = {}) {
  const context = vm.createContext({ URL, AbortController, Error, TypeError, TextDecoder, TextEncoder, setTimeout, clearTimeout, fetch, ...globals });
  vm.runInContext(source('core.js'), context, { filename: 'core.js' });
  return context;
}
const limits = loadCore().ViasCore.TEXT_LIMITS;
const completion = content => ({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const coreReply = (content, options = {}) => {
  const context = loadCore(async () => new Response(JSON.stringify(completion(content))));
  return context.ViasCore.callModel(config, [{ role: 'user', content: 'Offline fixture' }], options);
};
function backgroundHarness(replies = [], history = []) {
  const state = { models: [config], activeModelId: config.id, systemPrompt: 'Fixture prompt', settingsRevision: 1, builtinProviderInitialized: true };
  const requests = [], executions = [], emitted = [];
  let sequence = 0, replyIndex = 0, settle;
  const result = new Promise(resolve => { settle = resolve; });
  const onConnect = event();
  const snapshot = () => ({ snapshotId: `document:${++sequence}`, title: 'Fixture', url: 'https://page.example.test/', text: `Page ${sequence}`,
    targets: { 1: '[1] textarea' }, targetMeta: { 1: { tag: 'textarea', identity: 'field1', submitsForm: false } } });
  const context = loadCore(async () => {
    const value = replies[replyIndex++] ?? { say: 'Finished', done: true, actions: [] };
    return new Response(JSON.stringify(completion(typeof value === 'string' ? value : JSON.stringify(value))));
  }, { console, crypto: webcrypto, setInterval, clearInterval,
    chrome: { sidePanel: { setPanelBehavior: async () => {} },
      storage: { local: { get: async keys => Array.isArray(keys) ? { ...state } : { ...keys, ...state }, set: async patch => Object.assign(state, patch), remove: async () => {} }, onChanged: event() },
      runtime: { id: 'mock', getURL: name => `chrome-extension://mock/${name}`, onConnect, onMessage: event() },
      webNavigation: { onCreatedNavigationTarget: event() },
      scripting: { executeScript: async () => {} },
      tabs: { onCreated: event(), onRemoved: event(), onUpdated: event(), get: async () => ({ id: 1, status: 'complete', url: 'https://page.example.test/' }),
        sendMessage: async (_id, message) => {
          if (message.type === 'EXTRACT') return snapshot();
          if (message.type === 'EXECUTE') { executions.push(plain(message)); return { results: message.actions.map(() => ({ ok: true, code: 'FILLED' })), page: snapshot() }; }
          return {};
        } } } });
  context.importScripts = () => {};
  vm.runInContext(source('background.js'), context, { filename: 'background.js' });
  const port = { name: 'agent', sender: { id: 'mock', url: 'chrome-extension://mock/sidepanel.html' }, onMessage: event(), onDisconnect: event(),
    postMessage(message) {
      emitted.push(message);
      if (message.t === 'model_request') {
        requests.push(plain(message));
        context.ViasCore.callModel(message.cfg, message.messages, { maxReplyLength: message.replyLimit }).then(
          text => port.onMessage.listeners[0]({ t: 'model_response', runId: message.runId, requestId: message.requestId, text }),
          error => port.onMessage.listeners[0]({ t: 'model_response', runId: message.runId, requestId: message.requestId, error: error.message }));
      }
      if (message.t === 'done' || message.t === 'error') settle(message);
    } };
  onConnect.listeners[0](port);
  return { context, state, requests, executions, emitted, async start(question = 'Fixture task', allowActions = true) {
    port.onMessage.listeners[0]({ t: 'RUN', runId: 'fixture-run', tabId: 1, question, history, allowActions });
    return result;
  } };
}
function sidebarHarness(initial = [], options = {}) {
  const storage = plain(options.storage || {}), displayed = [], sent = [];
  const session = { QUOTA_BYTES: options.quota || 10 * 1024 * 1024,
    get: async () => plain(storage),
    getBytesInUse: async key => options.bytes ? options.bytes(key) : Buffer.byteLength(JSON.stringify(key == null ? storage : { [key]: storage[key] }), 'utf8'),
    set: async patch => { if (options.set) await options.set(patch); Object.assign(storage, plain(patch)); },
    remove: async key => { delete storage[key]; } };
  const context = loadCore(undefined, { console, crypto: webcrypto, setInterval: () => 0, clearInterval() {},
    TEXT_LIMITS: limits, history: plain(initial), sessionKey: 'chat:1', historyOmissionShown: false, persistQueue: Promise.resolve(),
    activeRun: null, initialized: true, allowActions: true, modelRefreshId: 0, lastRunJournal: '',
    inputEl: { value: '' }, addMessage: (role, content) => displayed.push({ role, content }),
    toggleMenu() {}, setControlsRunning() {}, setStatus() {}, autosize() {}, scrollBottom() {}, finishRun(_context, _outcome, error) { throw new Error(error); },
    chrome: { storage: { session }, tabs: { query: async () => [{ id: 1, url: 'https://page.example.test/' }] },
      runtime: { connect: () => ({ onMessage: event(), onDisconnect: event(), postMessage: message => sent.push(message) }) } } });
  const text = source('sidepanel.js');
  vm.runInContext(text.slice(text.indexOf('function showHistoryOmission('), text.indexOf('\nfunction positionModelMenu(')), context);
  vm.runInContext(text.slice(text.indexOf('async function send('), text.indexOf('\nformEl.addEventListener(')), context);
  return { context, storage, displayed, sent, session };
}

test('UTF-8估算与真实编码一致，代理对和孤立代理不混同CU/码点/字节', () => {
  const core = loadCore().ViasCore;
  assert.ok(Object.isFrozen(core.TEXT_LIMITS));
  for (const text of ['', 'ASCII', '中文', '😀', '\ud800', '\udc00', '\x00\n\\"', 'a'.repeat(19999) + '😀尾']) {
    assert.equal(core.utf8ByteLength(text), Buffer.byteLength(text, 'utf8'));
  }
});

test('合法200k单value经最坏Unicode转义仍抵达执行器，尾部和特殊字符原义不变', async () => {
  for (const [token, char] of [['\\u0061', 'a'], ['\\u4e2d', '中'], ['\\ud83d\\ude00', '😀'], ['\\u0000', '\x00']]) {
    const value = char.repeat(limits.value / char.length);
    const reply = `{"say":"","actions":[{"action":"fill","ref":1,"value":"${token.repeat(limits.value / char.length)}"}],"done":false}`;
    assert.equal(reply.length, 1200072);
    const h = backgroundHarness([reply]);
    assert.equal((await h.start()).outcome, 'completed');
    assert.equal(h.executions.length, 1);
    assert.equal(h.executions[0].actions[0].value, value);
  }
});

test('400k批次边界覆盖最坏6x转义，400001须整批拒绝并提示拆批而非先执行前缀', async () => {
  const body = '\\u0061'.repeat(limits.value);
  const reply = `{"say":"","actions":[{"action":"fill","ref":1,"value":"${body}"},{"action":"fill","ref":1,"value":"${body}"}],"done":false}`;
  const accepted = backgroundHarness([reply]);
  assert.equal((await accepted.start()).outcome, 'completed');
  assert.equal(accepted.executions[0].actions.length, 2);
  const actions = [{ action: 'fill', ref: 1, value: 'a'.repeat(limits.value) }, { action: 'fill', ref: 1, value: 'b'.repeat(limits.value) }];
  const rejected = backgroundHarness([{ say: 'X', actions }, { say: 'Fixed', done: true, actions: [] }]);
  assert.equal((await rejected.start()).outcome, 'completed');
  assert.equal(rejected.executions.length, 0);
  assert.ok(JSON.stringify(rejected.requests[1].messages).includes('拆成多批'));
  assert.equal(rejected.emitted.some(item => item.t === 'say' && item.text === 'X'), false);
});

test('批次预算累计规范化selector、数值/数组项、所有repeat体，repeat不乘times', () => {
  const { context } = backgroundHarness();
  const fill = value => ({ action: 'fill', ref: 1, value });
  const full = 'v'.repeat(limits.value);
  assert.equal(context.validateActions([fill(full), fill(full)]).length, 2);
  assert.throws(() => context.validateActions([fill(full), { ...fill(full), selector: 'x' }]), /总文本.*400000.*拆成多批/);
  assert.throws(() => context.validateActions([fill(full), fill(full), fill(0)]), /总文本/);
  assert.equal(context.validateActions([{ action: 'select', ref: 1, value: Array(20).fill('v'.repeat(20000)) }]).length, 1);
  assert.throws(() => context.validateActions([{ action: 'select', ref: 1, value: Array(21).fill('v'.repeat(20000)) }]), /总文本/);
  assert.equal(context.validateActions([{ action: 'repeat', times: 100, actions: [fill(full), fill(full)] }]).length, 1);
  assert.throws(() => context.validateActions([{ action: 'repeat', times: 100, actions: [fill(full), fill(full)] }, fill('x')]), /总文本/);
  assert.throws(() => context.validateActions([fill('x'.repeat(limits.value + 1))]), /value.*200000/);
  assert.throws(() => context.validateActions([{ action: 'click', selector: 'x'.repeat(limits.selector + 1) }]), /selector.*1000/);
});

test('20个合法单value不再依赖信封偶然拦截，总文本超界时不执行也不回显原文', async () => {
  const actions = Array.from({ length: 20 }, () => ({ action: 'fill', ref: 1, value: 'x'.repeat(20001) }));
  const h = backgroundHarness([{ say: 'UNVERIFIED_SAY', actions }, { say: 'Finished', done: true, actions: [] }]);
  assert.equal((await h.start()).outcome, 'completed');
  assert.equal(h.executions.length, 0);
  assert.ok(JSON.stringify(h.requests[1].messages).includes('400000'));
  assert.equal(JSON.stringify(h.requests[1].messages).includes('UNVERIFIED_SAY'), false);
});

test('say完整保留200k，超限含done也不得显示截短前缀或宣布完成', async () => {
  const say = 's'.repeat(limits.say - 7) + '😀TAIL!';
  assert.equal(say.length, limits.say);
  const accepted = backgroundHarness([{ say, actions: [], done: true }]);
  assert.equal((await accepted.start()).outcome, 'completed');
  assert.equal(accepted.emitted.find(item => item.t === 'say').text, say);
  const rejected = backgroundHarness([{ say: say + 'X', actions: [], done: true }, { say: 'Fixed', actions: [], done: true }]);
  assert.equal((await rejected.start()).outcome, 'completed');
  assert.equal(rejected.requests.length, 2);
  assert.deepEqual(rejected.emitted.filter(item => item.t === 'say').map(item => item.text), ['Fixed']);
  const parsed = rejected.context.ViasCore.parseReply('p'.repeat(limits.say + 1));
  assert.match(parsed.limitError, /200000/);
  assert.equal(parsed.actions.length, 0);
});

test('RUN和后续轮完整保留200k原始任务，200001在EXTRACT/模型前明确拒绝', async () => {
  const tail = '😀KEEP_TAIL\n ';
  const question = ' \n' + 'q'.repeat(limits.question - tail.length - 2) + tail;
  const h = backgroundHarness([{ actions: [{ action: 'fill', ref: 1, value: 'answer' }] }]);
  assert.equal((await h.start(question)).outcome, 'completed');
  for (const request of h.requests) assert.ok(request.messages.some(item => typeof item.content === 'string' && item.content.includes(question)));
  const rejected = backgroundHarness();
  const result = await rejected.start(question + 'X');
  assert.equal(result.code, 'TEXT_LIMIT');
  assert.equal(rejected.requests.length, 0);
  assert.equal(rejected.executions.length, 0);
});

test('侧栏200k原样发送并存储，200001保留输入且不连后台、不查询页面', async () => {
  const h = sidebarHarness();
  const question = ' \n' + 'q'.repeat(limits.question - 10) + '😀TAIL\n ';
  assert.equal(question.length, limits.question);
  h.context.inputEl.value = question;
  await h.context.send();
  await h.context.persistQueue;
  assert.equal(h.sent.find(item => item.t === 'RUN').question, question);
  assert.equal(h.storage['chat:1'][0].content, question);
  const rejected = sidebarHarness();
  rejected.context.inputEl.value = question + 'X';
  await rejected.context.send();
  assert.equal(rejected.context.inputEl.value, question + 'X');
  assert.equal(rejected.sent.length, 0);
  assert.equal(rejected.context.activeRun, null);
  assert.match(rejected.displayed[0].content, /200000.*输入已保留/);
});

test('旧上下文保留79k完整近轮，按整条淘汰超90k旧消息，不切半emoji', () => {
  const { context } = backgroundHarness();
  const text = 'q'.repeat(19999) + '😀KEEP';
  const retained = context.historyMessages([{ role: 'user', content: text }]);
  assert.equal(retained[0].content, text);
  assert.equal(retained[0].content.isWellFormed(), true);
  const recent = [{ role: 'user', content: 'q'.repeat(24000) }, { role: 'assistant', content: 'a'.repeat(55000) }];
  assert.deepEqual(plain(context.historyMessages(recent)), recent);
  const omitted = context.historyMessages([{ role: 'assistant', content: 'q'.repeat(limits.history + 1) }]);
  assert.equal(omitted.length, 0);
  assert.equal(omitted.omitted, true);
});

test('实际RUN在90k可用窗口内继续发送完整24k问题和55k答案', async () => {
  const q = 'q'.repeat(23994) + 'Q_TAIL';
  const a = 'a'.repeat(54994) + 'A_TAIL';
  const h = backgroundHarness(['Followup answer'], [{ role: 'user', content: q }, { role: 'assistant', content: a }]);
  assert.equal((await h.start('Followup task', false)).outcome, 'completed');
  const messages = h.requests[0].messages;
  assert.ok(messages.reduce((sum, item) => sum + item.content.length, 0) <= limits.messages);
  assert.ok(messages.some(item => item.content === q));
  assert.ok(messages.some(item => item.content === a));
});

test('QA独立1M上限不随3M JSON信封放大，原生length仍拒绝', async () => {
  const text = '\x00'.repeat(limits.answer - 7) + '😀TAIL!';
  assert.equal(await coreReply(text, { maxReplyLength: limits.answer }), text);
  await assert.rejects(coreReply(text + 'X', { maxReplyLength: limits.answer }), /回复过长.*1000000/);
  const h = backgroundHarness([text]);
  assert.equal((await h.start('QA', false)).outcome, 'completed');
  assert.equal(h.requests[0].replyLimit, limits.answer);
  assert.equal(h.emitted.find(item => item.t === 'say').text, text);
  const invalid = loadCore(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"done":true}' } }] })));
  await assert.rejects(invalid.ViasCore.callModel(config, [{ role: 'user', content: 'x' }]), /长度限制.*未执行/);
  await assert.rejects(coreReply('x'.repeat(limits.reply + 1)), /回复过长.*3000000/);
});

test('200k问题+1M回复最坏转义约7.2MB可完整保存恢复，旧条目整条淘汰且只提示一次', async () => {
  const q = '\x00'.repeat(limits.question - 7) + '😀QTAIL';
  const a = '\x00'.repeat(limits.answer - 7) + '😀ATAIL';
  const latest = [{ role: 'user', content: q }, { role: 'assistant', content: a }];
  const initial = [...Array.from({ length: 4 }, () => ({ role: 'assistant', content: 'old'.repeat(500000) })), ...latest];
  const h = sidebarHarness(initial);
  await h.context.persist();
  assert.deepEqual(h.storage['chat:1'], latest);
  assert.ok(Buffer.byteLength(JSON.stringify(h.storage['chat:1']), 'utf8') < limits.sessionBytes);
  await h.context.persist();
  assert.equal(h.displayed.filter(item => item.content.includes('较早对话')).length, 1);
  await h.context.initializeHistory(1);
  assert.deepEqual(h.displayed.filter(item => ['user', 'ai'].includes(item.role)).map(item => item.content), [q, a]);
  assert.equal(h.displayed.some(item => item.content.includes('保存失败')), false);
});

test('session全局配额预检留余量，失败不写入、不删除其它窗口、不改变当前原文', async () => {
  const initial = [{ role: 'user', content: 'q'.repeat(limits.question) }];
  const other = [{ role: 'user', content: 'OTHER_WINDOW_MUST_KEEP' }];
  const h = sidebarHarness(initial, { storage: { 'chat:2': other }, bytes: key => key === null ? 10 * 1024 * 1024 - 300000 : 0 });
  await h.context.persist();
  assert.deepEqual(h.storage['chat:2'], other);
  assert.equal(h.storage['chat:1'], undefined);
  assert.equal(h.context.history[0].content, initial[0].content);
  assert.match(h.displayed.at(-1).content, /保存失败.*空间不足.*其它窗口的历史未删除/);
});

test('session替换自身历史扣除旧占用，存储层异常仍明确告知且队列可恢复', async () => {
  let fail = true;
  const h = sidebarHarness([{ role: 'user', content: 'CURRENT_FULL_TEXT' }], {
    storage: { 'chat:1': [{ role: 'user', content: 'OLD' }] },
    bytes: key => key == null ? 9 * 1024 * 1024 : 8 * 1024 * 1024,
    set: async () => { if (fail) throw new Error('fixture quota failure'); },
  });
  await h.context.persist();
  assert.match(h.displayed.at(-1).content, /保存失败.*fixture quota failure/);
  assert.equal(h.context.history[0].content, 'CURRENT_FULL_TEXT');
  fail = false;
  await h.context.persist();
  assert.equal(h.storage['chat:1'][0].content, 'CURRENT_FULL_TEXT');
});

test('persist与clear共用串行队列，迟到保存不能复活已清空对话', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = sidebarHarness([{ role: 'user', content: 'BEFORE_CLEAR' }], { set: () => pending });
  const writing = h.context.persist();
  await flush();
  h.context.history = [];
  const clearing = h.context.queueSessionWrite(() => h.session.remove('chat:1'));
  release();
  await Promise.all([writing, clearing]);
  assert.equal(h.storage['chat:1'], undefined);
  assert.equal(h.context.history.length, 0);
});

test('stream按真实UTF8字节限制并跨分块解码，32MiB外的成功/错误响应立即取消且不重试', async () => {
  const data = JSON.stringify(completion('中文😀\\"\n尾'));
  const encoded = Buffer.from(data, 'utf8');
  const valid = loadCore(async () => new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < encoded.length; i++) controller.enqueue(encoded.subarray(i, i + 1));
    controller.close();
  } })));
  assert.equal(await valid.ViasCore.callModel(config, [{ role: 'user', content: 'x' }]), '中文😀\\"\n尾');
  for (const status of [200, 401, 503]) {
    let calls = 0, cancelled = false, pulled = 0;
    const context = loadCore(async () => {
      calls++;
      return new Response(new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } }), { status });
    });
    await assert.rejects(context.ViasCore.callModel(config, [{ role: 'user', content: 'x' }], { retries: 3 }), error => {
      assert.match(error.message, /32 MiB/);
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
    assert.ok(pulled <= 34, '读取不应继续到全部正文');
  }
});

test('真实Response的Content-Length超界在读取前取消，错误脱敏仍早于截断且401不重试', async () => {
  let cancelled = false, calls = 0;
  const oversized = loadCore(async () => { calls++; return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(limits.responseBytes + 1) } }); });
  await assert.rejects(oversized.ViasCore.callModel(config, [{ role: 'user', content: 'x' }], { retries: 3 }), /32 MiB/);
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
  const key = 'sk-fixture.$[x]+"\\q';
  const raw = 'x'.repeat(490) + key + '\n' + JSON.stringify({ key });
  let errorCalls = 0;
  const redacted = loadCore(async () => { errorCalls++; return new Response(raw, { status: 401 }); });
  await assert.rejects(redacted.ViasCore.callModel({ ...config, apiKey: key }, [{ role: 'user', content: 'x' }], { retries: 3 }), error => {
    assert.match(error.message, /^API 401:/);
    assert.equal(error.message.includes('sk-fixture'), false);
    assert.equal(error.message.includes(key), false);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(errorCalls, 1);
});

test('真实Response挂起流可取消并释放父信号监听器，401挂起流超时不重试', async () => {
  for (const status of [200, 401]) {
    let cancelled = false, calls = 0, timeout;
    const parent = new AbortController();
    const context = loadCore(async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([123])); }, cancel() { cancelled = true; } }), { status });
    }, { setTimeout(callback) { timeout = callback; return 1; }, clearTimeout() {} });
    const request = context.ViasCore.callModel(config, [{ role: 'user', content: 'x' }], { signal: parent.signal, timeoutMs: 1000, retries: 0 });
    const rejected = assert.rejects(request, status === 401 ? /超时/ : { name: 'AbortError' });
    await flush();
    if (status === 401) timeout(); else parent.abort('fixture cancellation');
    await rejected;
    assert.equal(cancelled, true);
    assert.equal(calls, 1);
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  }
});
