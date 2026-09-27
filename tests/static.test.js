'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { getEventListeners } = require('node:events');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

function loadCore(fetchImpl = async () => {
  throw new Error('unexpected fetch');
}, timers = {}) {
  const sandbox = {
    AbortController,
    Error,
    TypeError,
    URL,
    clearTimeout,
    fetch: fetchImpl,
    setTimeout,
    ...timers,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('core.js'), sandbox, { filename: 'core.js' });
  return sandbox.ViasCore;
}

// 请求、凭据、响应与时钟均为内存 mock，绝不连接模型服务。
const modelConfig = { baseUrl: 'https://gateway.example.test/v1', apiKey: 'sk-memory-test-only', model: 'demo' };
const modelMessages = [{ role: 'user', content: 'hello' }];
const actionReply = '{"say":"执行","actions":[{"action":"click","ref":3}]}';
const plain = (value) => JSON.parse(JSON.stringify(value));
const okResponse = (message = { content: 'ok' }, finishReason) => ({
  ok: true,
  headers: { get: () => null },
  json: async () => ({ choices: [{ message, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) }] }),
});
const errorResponse = (status, body = 'mock failure', retryAfter = null) => ({
  ok: false,
  status,
  headers: { get: (name) => name === 'retry-after' ? retryAfter : null },
  text: async () => body,
});

async function flushMicrotasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function mockClock() {
  let nextId = 0;
  const pending = new Map();
  const delays = [];
  return {
    pending,
    delays,
    timers: {
      setTimeout(callback, delay) {
        const id = ++nextId;
        pending.set(id, { callback, delay });
        delays.push(delay);
        return id;
      },
      clearTimeout(id) { pending.delete(id); },
    },
    async fire(delay) {
      await flushMicrotasks();
      const entry = [...pending].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `没有待执行的 ${delay}ms 计时器`);
      pending.delete(entry[0]);
      entry[1].callback();
      await flushMicrotasks();
    },
  };
}

function assertNoSecret(error, secret = modelConfig.apiKey) {
  for (const text of [error.message, error.stack, JSON.stringify(error)]) {
    assert.ok(!String(text).includes(secret), '错误出口泄漏测试凭据');
  }
  return true;
}

test('manifest 是最小可加载的 MV3 Edge 扩展', () => {
  const manifest = JSON.parse(read('manifest.json'));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background?.service_worker, 'background.js');
  assert.ok(Number(manifest.minimum_chrome_version) >= 114);
  assert.equal(manifest.side_panel?.default_path, 'sidepanel.html');
  assert.equal(manifest.options_page, 'options.html');
  assert.ok(manifest.permissions.includes('scripting'));
  assert.ok(manifest.permissions.includes('activeTab'));

  const forbidden = ['debugger', 'nativeMessaging', 'management', 'cookies', 'history', 'downloads'];
  assert.deepEqual(manifest.permissions.filter((permission) => forbidden.includes(permission)), []);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);

  const referencedFiles = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    manifest.options_page,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
  ];
  for (const relativePath of referencedFiles) {
    assert.ok(fs.existsSync(path.join(root, relativePath)), `manifest 引用不存在: ${relativePath}`);
  }
});

test('core 规范化并校验模型配置', () => {
  const core = loadCore();

  assert.ok(Object.isFrozen(core));
  assert.equal(core.normalizeBaseUrl(' https://api.example.test/v1/chat/completions/// '), 'https://api.example.test/v1');
  const model = core.validateModel({
    name: ' Demo ',
    baseUrl: 'https://api.example.test/v1/',
    apiKey: ' key ',
    model: ' model-x ',
    vision: 1,
  });
  assert.equal(model.name, 'Demo');
  assert.equal(model.baseUrl, 'https://api.example.test/v1');
  assert.equal(model.apiKey, 'key');
  assert.equal(model.model, 'model-x');
  assert.equal(model.vision, false);

  assert.throws(() => core.validateModel({ baseUrl: 'file:///tmp/model', model: 'x' }), /http\(s\)/);
  assert.throws(() => core.validateModel({ baseUrl: 'https://user:secret@example.test/v1', model: 'x' }), /账号或密码/);
  assert.throws(() => core.validateModel({ baseUrl: 'https://example.test/v1', model: '' }), /模型名/);
});

test('core 模型请求不携带浏览器凭据且不把 API Key 写入正文', async () => {
  let request;
  const core = loadCore(async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    };
  });

  const result = await core.callModel(
    { baseUrl: 'https://api.example.test/v1', apiKey: 'top-secret', model: 'demo' },
    [{ role: 'user', content: 'hello' }],
    { timeoutMs: 1000 },
  );

  assert.equal(result, 'ok');
  assert.equal(request.url, 'https://api.example.test/v1/chat/completions');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.headers.Authorization, 'Bearer top-secret');
  assert.deepEqual(JSON.parse(request.options.body), {
    model: 'demo', messages: [{ role: 'user', content: 'hello' }], temperature: 0.2,
  }, '保持 OpenAI 兼容请求，不添加私有参数或强制 max_tokens');
});

test('core 拒绝伪成功响应并支持无鉴权服务', async () => {
  let authorizationPresent = true;
  const noAuthCore = loadCore(async (_url, options) => {
    authorizationPresent = Object.hasOwn(options.headers, 'Authorization');
    return { ok: true, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: 'ready' } }] }) };
  });
  assert.equal(await noAuthCore.callModel({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'local' }, [{ role: 'user', content: 'hi' }]), 'ready');
  assert.equal(authorizationPresent, false);

  const invalidCore = loadCore(async () => ({ ok: true, headers: { get: () => null }, json: async () => ({ status: 'ok' }) }));
  await assert.rejects(() => invalidCore.callModel({ baseUrl: 'https://api.example.test/v1', model: 'x' }, [{ role: 'user', content: 'hi' }]), /缺少 choices/);
});

test('core 在错误正文规范化和截断前精确脱敏，401 不重试', async () => {
  for (const body of [
    `凭据 ${modelConfig.apiKey}\r\n重复 ${modelConfig.apiKey}`,
    `${'x'.repeat(490)}${modelConfig.apiKey} trailing`,
  ]) {
    let calls = 0;
    const core = loadCore(async () => { calls++; return errorResponse(401, body); });
    await assert.rejects(core.callModel(modelConfig, modelMessages, { retries: 3 }), (error) => {
      assertNoSecret(error);
      assert.ok(!error.message.includes('sk-memory'), '截断不能留下密钥前缀');
      assert.match(error.message, /^API 401:/);
      assert.doesNotMatch(error.message, /[\r\n\t]/);
      assert.ok(error.message.length <= 'API 401: '.length + 500);
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('core 支持凭据元字符及 JSON 转义，并仅屏蔽清晰 Authorization 格式', async () => {
  const apiKey = 'sk-test.$[x]+"\\q';
  const otherToken = 'another-test-token';
  const body = `凭据 ${apiKey}; ${JSON.stringify({ apiKey })}\n` +
    `Authorization: Bearer ${otherToken}\n{"authorization":"Basic bWVtb3J5"}; Bearer 普通说明`;
  const core = loadCore(async () => errorResponse(401, body));
  await assert.rejects(core.callModel({ ...modelConfig, apiKey }, modelMessages), (error) => {
    assertNoSecret(error, apiKey);
    assert.ok(!error.message.includes(JSON.stringify(apiKey).slice(1, -1)));
    assert.ok(!error.message.includes(otherToken));
    assert.ok(!error.message.includes('bWVtb3J5'));
    assert.match(error.message, /Bearer 普通说明/);
    return true;
  });
});

test('core 没有凭据时不会破坏普通错误文本', async () => {
  const body = 'monkey keyboard token 普通内容\nBearer example is documentation';
  for (const apiKey of [undefined, '', '   ']) {
    const core = loadCore(async () => errorResponse(400, body));
    await assert.rejects(core.callModel({ ...modelConfig, apiKey }, modelMessages), (error) => {
      assert.equal(error.message, `API 400: ${body.replace('\n', ' ')}`);
      return true;
    });
  }
});

test('core 网络、正文读取及 JSON 解码错误出口不泄漏凭据', async () => {
  const secret = modelConfig.apiKey;
  const upstream = Object.freeze(Object.assign(new Error(`network ${secret}`), { secret, cause: secret }));
  const fetches = [
    async () => { throw upstream; },
    async () => { throw new TypeError(`fetch ${secret}`); },
    async () => { throw `failure ${secret}`; },
    async () => ({ ...errorResponse(401), text: async () => { throw new TypeError(secret); } }),
    async () => ({ ...okResponse(), json: async () => { throw new SyntaxError(secret); } }),
  ];
  for (const fetchImpl of fetches) {
    const core = loadCore(fetchImpl);
    await assert.rejects(core.callModel(modelConfig, modelMessages), (error) => assertNoSecret(error));
  }
  assert.ok(upstream.message.includes(secret), '不能修改上游（可能已冻结的）错误对象');
});

test('core 401 正文读取失败也不重试', async () => {
  let calls = 0;
  const core = loadCore(async () => {
    calls++;
    return { ...errorResponse(401), text: async () => { throw new TypeError(modelConfig.apiKey); } };
  });
  await assert.rejects(core.callModel(modelConfig, modelMessages, { retries: 3 }), /API 401.*正文读取失败/);
  assert.equal(calls, 1);
});

test('core 401 正文读取超时仍不重试', async () => {
  const clock = mockClock();
  let calls = 0;
  const core = loadCore(async (_url, options) => {
    calls++;
    return {
      ...errorResponse(401),
      text: () => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error(modelConfig.apiKey)), { once: true });
      }),
    };
  }, clock.timers);
  const result = assert.rejects(core.callModel(modelConfig, modelMessages, { retries: 3, timeoutMs: 1000 }), (error) => {
    assert.equal(error.retryable, false);
    assert.match(error.message, /超时/);
    return assertNoSecret(error);
  });
  await clock.fire(1000);
  await result;
  assert.equal(calls, 1);
  assert.equal(clock.pending.size, 0);
});

test('core 仅返回最终 content，保留字符串签名和省略 finish_reason 的网关', async () => {
  for (const finishReason of [undefined, 'stop']) {
    const content = '  {"say":"最终回答","done":true}  ';
    const core = loadCore(async () => okResponse({ content, reasoning_content: actionReply }, finishReason));
    assert.equal(await core.callModel(modelConfig, modelMessages), content);
  }
});

test('core 最终 content 缺失或为空时绝不执行 reasoning_content', async () => {
  for (const content of [undefined, null, '', ' \n\t ', [], { text: actionReply }]) {
    let calls = 0;
    const core = loadCore(async () => {
      calls++;
      return okResponse({ content, reasoning_content: actionReply }, 'stop');
    });
    await assert.rejects(core.callModel(modelConfig, modelMessages, { retries: 3 }), /缺少 choices\[0\]\.message\.content.*推理内容不会执行/);
    assert.equal(calls, 1);
  }
});

test('core 拒绝 length/content_filter 等未完整输出，包括合法 JSON 前缀', async () => {
  const reasons = [
    ['length', /长度限制.*截断/],
    ['content_filter', /内容过滤/],
    ['tool_calls', /未正常结束|工具调用/],
    ['function_call', /未正常结束|工具调用/],
    [null, /未正常结束/],
    [`unknown-${modelConfig.apiKey}`, /未正常结束/],
  ];
  for (const [reason, expected] of reasons) {
    for (const content of [actionReply, '']) {
      let calls = 0;
      const core = loadCore(async () => {
        calls++;
        return okResponse({ content, reasoning_content: actionReply }, reason);
      });
      await assert.rejects(core.callModel(modelConfig, modelMessages, { retries: 3 }), (error) => {
        assert.match(error.message, expected);
        assert.match(error.message, /未执行任何操作/);
        assert.equal(error.retryable, false);
        return assertNoSecret(error);
      });
      assert.equal(calls, 1, '非完整输出不可自动重试造成无效费用');
    }
  }
});

test('core 408/429/5xx 默认不重试，只有显式预算才重试', async () => {
  for (const status of [408, 429, 500, 502, 503]) {
    let calls = 0;
    const core = loadCore(async () => { calls++; return errorResponse(status); });
    await assert.rejects(core.callModel(modelConfig, modelMessages), (error) => {
      assert.equal(error.retryable, true);
      assert.match(error.message, new RegExp(`API ${status}`));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('core 重试预算有显式上限，指数退避且释放请求计时器', async () => {
  for (const [retries, expectedCalls] of [[0, 1], [-1, 1], [1.9, 2], [2, 3], [99, 4]]) {
    const clock = mockClock();
    let calls = 0;
    const core = loadCore(async () => { calls++; return errorResponse(503); }, clock.timers);
    const result = assert.rejects(core.callModel(modelConfig, modelMessages, { retries }), /API 503/);
    for (let attempt = 0; attempt < expectedCalls - 1; attempt++) {
      await flushMicrotasks();
      assert.equal(clock.pending.size, 1, '退避前应移除上一请求的超时计时器');
      await clock.fire(500 * (2 ** attempt));
    }
    await result;
    assert.equal(calls, expectedCalls);
    assert.equal(clock.pending.size, 0);
  }
});

test('core Retry-After 支持秒数、日期、零延迟与上限，并可重试成功', async () => {
  for (const [header, expectedDelay] of [
    ['0', 0], ['2', 2000], ['120', 10000], ['-1', 0],
    [new Date(Date.now() + 60000).toUTCString(), 10000],
    ['Thu, 01 Jan 1970 00:00:00 GMT', 0], ['invalid', 500],
  ]) {
    const clock = mockClock();
    let calls = 0;
    const core = loadCore(async () => ++calls === 1 ? errorResponse(429, '限流', header) : okResponse(), clock.timers);
    const result = core.callModel(modelConfig, modelMessages, { retries: 1 });
    await clock.fire(expectedDelay);
    assert.equal(await result, 'ok');
    assert.equal(calls, 2);
    assert.equal(clock.pending.size, 0);
  }
});

test('core 429/5xx 退避期间可取消，不产生下一次付费请求', async () => {
  for (const status of [429, 500, 503]) {
    const clock = mockClock();
    const parent = new AbortController();
    let calls = 0;
    const core = loadCore(async () => { calls++; return errorResponse(status, 'busy', '10'); }, clock.timers);
    const result = assert.rejects(core.callModel(modelConfig, modelMessages, { retries: 3, signal: parent.signal }), (error) => {
      assert.equal(error.name, 'AbortError');
      return assertNoSecret(error);
    });
    await flushMicrotasks();
    assert.deepEqual([...clock.pending.values()].map((timer) => timer.delay), [10000]);
    parent.abort(modelConfig.apiKey);
    await result;
    assert.equal(calls, 1);
    assert.equal(clock.pending.size, 0);
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  }
});

test('core 已取消的请求不访问 fetch', async () => {
  const parent = new AbortController();
  parent.abort(modelConfig.apiKey);
  let calls = 0;
  const core = loadCore(async () => { calls++; return okResponse(); });
  await assert.rejects(core.callModel(modelConfig, modelMessages, { signal: parent.signal }), (error) => {
    assert.equal(error.name, 'AbortError');
    return assertNoSecret(error);
  });
  assert.equal(calls, 0);
});

test('core fetch 与 JSON 正文读取阶段均能取消并清理监听器', async () => {
  for (const phase of ['fetch', 'json']) {
    const clock = mockClock();
    const parent = new AbortController();
    let calls = 0;
    let requestSignal;
    const core = loadCore(async (_url, options) => {
      calls++;
      requestSignal = options.signal;
      const blocked = () => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error(modelConfig.apiKey)), { once: true });
      });
      return phase === 'fetch' ? blocked() : { ...okResponse(), json: blocked };
    }, clock.timers);
    const result = assert.rejects(core.callModel(modelConfig, modelMessages, { retries: 3, signal: parent.signal }), (error) => {
      assert.equal(error.name, 'AbortError');
      assert.doesNotMatch(error.message, /超时|有效 JSON/);
      return assertNoSecret(error);
    });
    await flushMicrotasks();
    parent.abort(modelConfig.apiKey);
    await result;
    assert.equal(requestSignal.aborted, true);
    assert.equal(calls, 1);
    assert.equal(clock.pending.size, 0);
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  }
});

test('core 取消与响应完成竞争时不会返回可执行内容', async () => {
  const parent = new AbortController();
  const core = loadCore(async () => ({
    ...okResponse(),
    json: async () => {
      parent.abort(modelConfig.apiKey);
      return { choices: [{ message: { content: actionReply }, finish_reason: 'stop' }] };
    },
  }));
  await assert.rejects(core.callModel(modelConfig, modelMessages, { signal: parent.signal }), { name: 'AbortError' });
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

test('core fetch/正文超时准确报告且仅按显式预算重试', async () => {
  for (const phase of ['fetch', 'json', 'text']) {
    for (const retries of [0, 1]) {
      const clock = mockClock();
      let calls = 0;
      const core = loadCore(async (_url, options) => {
        if (++calls > 1) return okResponse();
        const blocked = () => new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error(modelConfig.apiKey)), { once: true });
        });
        if (phase === 'fetch') return blocked();
        if (phase === 'text') return { ...errorResponse(503), text: blocked };
        return { ...okResponse(), json: blocked };
      }, clock.timers);
      const request = core.callModel(modelConfig, modelMessages, { timeoutMs: 1000, retries });
      const result = retries ? request : assert.rejects(request, (error) => {
        assert.match(error.message, /模型请求超时（1 秒）/);
        assert.doesNotMatch(error.message, /有效 JSON/);
        assert.equal(error.retryable, true);
        return assertNoSecret(error);
      });
      await clock.fire(1000);
      if (retries) {
        await clock.fire(500);
        assert.equal(await result, 'ok');
      } else await result;
      assert.equal(calls, retries + 1);
      assert.equal(clock.pending.size, 0);
    }
  }
});

test('core 网络 TypeError 可重试，但显式非 retryable 错误不重试', async () => {
  for (const retryable of [undefined, false]) {
    const clock = mockClock();
    let calls = 0;
    const core = loadCore(async () => {
      if (++calls > 1) return okResponse();
      const error = new TypeError(`network ${modelConfig.apiKey}`);
      if (retryable !== undefined) error.retryable = retryable;
      throw error;
    }, clock.timers);
    const request = core.callModel(modelConfig, modelMessages, { retries: 3 });
    if (retryable === false) await assert.rejects(request, (error) => assertNoSecret(error));
    else {
      await clock.fire(500);
      assert.equal(await request, 'ok');
    }
    assert.equal(calls, retryable === false ? 1 : 2);
    assert.equal(clock.pending.size, 0);
  }
});

test('core 非超时 AbortError 不误报超时或自动重试', async () => {
  let calls = 0;
  const core = loadCore(async () => {
    calls++;
    throw Object.assign(new Error(modelConfig.apiKey), { name: 'AbortError' });
  });
  await assert.rejects(core.callModel(modelConfig, modelMessages, { retries: 3 }), (error) => {
    assert.equal(error.name, 'AbortError');
    assert.doesNotMatch(error.message, /超时/);
    return assertNoSecret(error);
  });
  assert.equal(calls, 1);
});

test('core parseReply 自愈非法转义并识别 done 截止信号', () => {
  const core = loadCore();

  // 模型违约：前言写在围栏外 + say 含非法 JSON 转义 \g \G —— 须修复后解析，绝不吞掉 actions
  const messy = '我来逐题作答：\n```json\n{"say":"结束符 \\g 和 \\G","actions":[{"action":"check","ref":3}]}\n```';
  const p = core.parseReply(messy);
  assert.deepEqual(JSON.parse(JSON.stringify(p.actions)), [{ action: 'check', ref: 3 }]);
  assert.equal(p.done, false);
  assert.match(p.say, /结束符/);

  const done = core.parseReply('{"say":"全部完成","done":true,"actions":[]}');
  assert.equal(done.done, true);
  assert.equal(done.actions.length, 0);

  const onlySay = core.parseReply('{"say":"我打算这样选"}');
  assert.deepEqual(JSON.parse(JSON.stringify(onlySay.actions)), []);
  assert.equal(onlySay.done, false);

  const raw = core.parseReply('页面读取失败');
  assert.equal(raw.say, '页面读取失败');
  assert.deepEqual(JSON.parse(JSON.stringify(raw.actions)), []);
  assert.equal(raw.done, false);
});

test('core parseReply 按原文顺序选择最后合法指令，不执行前面的示例', () => {
  const core = loadCore();
  const example = actionReply;
  const final = '{"say":"最终结论","done":true,"actions":[]}';
  const fence = (text) => `\n\`\`\`json\n${text}\n\`\`\`\n`;
  for (const text of [
    `先给示例：${fence(example)}真正结果：${fence(final)}`,
    `示例：${fence(example)}最终答复：${final}`,
    `示例：${example}最终答复：${fence(final)}`,
    `前言 ${example} 解说 ${final} 尾注`,
    `未闭合的前言引号 " ${example} 最后 ${final}`,
    `前言中未配对 { ${fence(example)} 后续 ${fence(final)}`,
    `前言中未配对 { ${fence(example)} 围栏外最终结果 ${final}`,
    fence(`说明 ${example}\n真正结果 ${final}`),
    `示例 ${example} {not valid json} ${final} {"metadata":1}`,
    `${fence(example)}\n\`\`\`JSON\n${final}\n\`\`\``,
    `${fence(example)}\n\`\`\`\n${final}\n\`\`\``,
  ]) {
    assert.deepEqual(plain(core.parseReply(text)), { say: '最终结论', done: true, actions: [] }, text);
  }
  assert.deepEqual(plain(core.parseReply(`${fence(example)}最终只说明：{"say":"尚未操作"}`)), {
    say: '尚未操作', actions: [], done: false,
  });
  assert.deepEqual(plain(core.parseReply(`${fence(example)}${fence('{"actions":[{"action":"check","ref":9}]}')}`)), {
    say: '', actions: [{ action: 'check', ref: 9 }], done: false,
  });
});

test('core parseReply 非法转义自愈而合法 Unicode、换行与反斜杠保持原义', () => {
  const core = loadCore();
  const text = String.raw`前言 {"say":"样例","actions":[]} 最终 {"say":"结束符 \g \G \q，合法 \u4e2d\n路径 C:\\temp，非法 \uZZZZ","actions":[{"action":"fill","ref":1,"value":"SQL\G"}]}`;
  assert.deepEqual(plain(core.parseReply(text)), {
    say: '结束符 \\g \\G \\q，合法 中\n路径 C:\\temp，非法 \\uZZZZ',
    actions: [{ action: 'fill', ref: 1, value: 'SQL\\G' }],
    done: false,
  });
});

test('core parseReply 修复字符串内裸换行/制表等控制字符而不改变含义', () => {
  const core = loadCore();
  const text = '{"say":"第一行\n第二行","actions":[{"action":"fill","ref":2,"value":"a\tb\r\nc"}]}';
  assert.deepEqual(plain(core.parseReply(text)), {
    say: '第一行\n第二行',
    actions: [{ action: 'fill', ref: 2, value: 'a\tb\r\nc' }],
    done: false,
  });
  const fenced = '说明\n```json\n{"say":"多行\n回答","done":true,"actions":[]}\n```';
  assert.deepEqual(plain(core.parseReply(fenced)), { say: '多行\n回答', actions: [], done: true });
});

test('core parseReply 正确处理字符串内括号、转义引号和嵌套值', () => {
  const core = loadCore();
  const instruction = {
    say: '文本 { } [ ] "引号" 和 \\，示例 {"done":true}',
    actions: [{ action: 'fill', ref: 8, value: '字符串 } { \\"', data: { say: '嵌套不是指令', done: true } }],
  };
  for (const text of [JSON.stringify(instruction), `前言 ${JSON.stringify(instruction)} 后记`]) {
    assert.deepEqual(plain(core.parseReply(text)), { ...instruction, done: false });
  }
});

test('core parseReply done 仅接受布尔 true，其他字段按契约规范化', () => {
  const core = loadCore();
  for (const done of [true, false, 'true', 'false', 1, 0, null, [], {}]) {
    const parsed = core.parseReply(JSON.stringify({ say: '回答', actions: [], done }));
    assert.equal(parsed.done, done === true);
    assert.deepEqual(plain(parsed.actions), []);
  }
  assert.deepEqual(plain(core.parseReply('{"done":true}')), { say: '', actions: [], done: true });
  assert.deepEqual(plain(core.parseReply('{"say":42,"actions":[],"done":"true"}')), { say: '', actions: [], done: false });
  assert.deepEqual(plain(core.parseReply('{"say":"纯回答","actions":"click"}')), { say: '纯回答', actions: [], done: false });
});

test('core parseReply 不把数据容器中的嵌套示例或畸形 JSON 当指令', () => {
  const core = loadCore();
  const samples = [
    `[${actionReply}]`,
    `说明 [${actionReply}] 尾注`,
    `{"example":${actionReply}}`,
    `说明 {"example":${actionReply}} 尾注`,
    '{"actions":[{"action":"click","ref":3}]',
    '{"say":"未结束的字符串 { \\" actions',
    '{"actions":[{"action":"click"}],}',
    'null', 'undefined', '42', '', null, undefined,
  ];
  for (const text of samples) {
    const parsed = core.parseReply(text);
    assert.deepEqual(plain(parsed.actions), [], String(text));
    assert.equal(parsed.done, false, String(text));
    assert.equal(parsed.say, String(text));
  }
});

test('core parseReply 超长与深度畸形输入有界且不执行截断前缀', () => {
  const core = loadCore();
  const longSay = '长'.repeat(60000);
  const parsed = core.parseReply(JSON.stringify({ say: longSay, actions: [{ action: 'click', ref: 9 }] }));
  assert.equal(parsed.say.length, 50000);
  assert.deepEqual(plain(parsed.actions), [{ action: 'click', ref: 9 }]);

  const many = `${'{"say":"示例","actions":[]}\n'.repeat(5000)}{"say":"最终","done":true}`;
  assert.deepEqual(plain(core.parseReply(many)), { say: '最终', actions: [], done: true });

  for (const text of ['{'.repeat(100000), '['.repeat(50000) + ']'.repeat(50000), '无 JSON'.repeat(20000)]) {
    const result = core.parseReply(text);
    assert.deepEqual(plain(result.actions), []);
    assert.equal(result.done, false);
    assert.ok(result.say.length <= 50000);
  }
  const oversized = core.parseReply(`${actionReply}${' '.repeat(1000000)}{"done":true}`);
  assert.deepEqual(plain(oversized.actions), []);
  assert.equal(oversized.done, false);
  assert.match(oversized.say, /过长.*未解析或执行/);
});

test('后台使用集中式 core 解析器而非本地重复实现', () => {
  const background = read('background.js');
  assert.match(background, /ViasCore\.parseReply\(/);
  assert.doesNotMatch(background, /function parseAiReply\(/, '解析器应集中在 core.js，不在 background 里重复实现');
});

test('后台和内容脚本声明完整的快照、操作与取消协议', () => {
  const background = read('background.js');
  const content = read('content.js');

  assert.match(background, /\{\s*type:\s*'EXTRACT',\s*runId:/);
  assert.match(background, /if\s*\(!page\?\.snapshotId\)/);
  assert.match(background, /\{\s*type:\s*'EXECUTE',\s*runId:[\s\S]{0,160}operationId,\s*snapshotId:\s*page\.snapshotId,\s*approved,\s*actions/);
  assert.match(background, /\{\s*type:\s*'ABORT',\s*runId:\s*run\.runId\s*\}/);
  assert.match(content, /(?:msg|message)\.type\s*===\s*'EXTRACT'/);
  assert.match(content, /(?:msg|message)\.type\s*===\s*'EXECUTE'/);
  assert.match(content, /(?:msg|message)\.type\s*===\s*'ABORT'/);
});

test('侧边栏与设置页使用任务隔离、可取消请求和集中设置写入', () => {
  const sidepanel = read('sidepanel.js');
  const options = read('options.js');
  const sidepanelHtml = read('sidepanel.html');
  const optionsHtml = read('options.html');

  assert.match(sidepanel, /runId:\s*crypto\.randomUUID\(\)/);
  assert.match(sidepanel, /message\.t === 'model_request'/);
  assert.match(sidepanel, /ViasCore\.callModel/);
  assert.match(sidepanel, /controller\.abort\(/, '完全访问不依赖审批，但停止必须取消模型请求');
  assert.match(sidepanel, /FORBID_TAGS:[\s\S]*'img'/);
  assert.match(sidepanel, /`chat:\$\{windowId\}`/);
  assert.match(options, /type:\s*'UPDATE_SETTINGS'/);
  assert.match(options, /expectedRevision(?:\s*=\s*settingsRevision|,)/);
  assert.match(options, /formRevision\s*=\s*settingsRevision/);
  assert.match(options, /ViasCore\.callModel/);
  assert.ok(sidepanelHtml.indexOf('core.js') < sidepanelHtml.indexOf('sidepanel.js'));
  assert.ok(optionsHtml.indexOf('core.js') < optionsHtml.indexOf('options.js'));
});

test('侧边栏任务列表复选框用自绘 span 而非被净化的 input', () => {
  const sidepanel = read('sidepanel.js');
  const sidepanelHtml = read('sidepanel.html');

  assert.match(sidepanel, /checkbox\(checked\)\s*\{\s*return `<span class="task-checkbox\$\{checked \? ' checked' : ''\}" aria-hidden="true"><\/span>`;/);
  assert.match(sidepanelHtml, /\.md-content li:has\(> \.task-checkbox\)/);
  assert.doesNotMatch(sidepanelHtml, /input\[type="checkbox"\]/, '复选框样式应针对自绘 span，不再引用被 DOMPurify 剥掉的 input');
});

test('侧边栏无审批残留且具备基础无障碍与 CSP 边界', () => {
  const sidepanelHtml = read('sidepanel.html');
  const manifest = JSON.parse(read('manifest.json'));

  assert.doesNotMatch(sidepanelHtml, /\.approval/, '审批卡片已拆除，不应残留样式');
  assert.doesNotMatch(sidepanelHtml, /\.md-content img/, 'img 已被 DOMPurify 禁止，对应样式应删除');
  assert.doesNotMatch(sidepanelHtml, /scroll-behavior:\s*smooth/, '平滑滚动的中间滚动事件会误翻自动吸底状态');
  assert.match(sidepanelHtml, /<title>Vias 页面助手<\/title>/);
  assert.match(sidepanelHtml, /id="modeAsk" aria-pressed="false"/);
  assert.match(sidepanelHtml, /id="modeAgent" class="on" aria-pressed="true"/);
  assert.match(sidepanelHtml, /id="copyToast" role="status" aria-live="polite"/);
  assert.equal(manifest.content_security_policy?.extension_pages, "script-src 'self'; object-src 'self'; img-src 'self' data:");
  assert.doesNotMatch(manifest.description, /可确认/, '审批门已拆除，描述不应再声称可确认');
});

test('内容脚本健壮性：非安全上下文、快照原子性与边界 DOM', () => {
  const content = read('content.js');
  const background = read('background.js');

  assert.match(content, /crypto\.randomUUID\?\.\(\)/, '纯 http 页面无 randomUUID，documentId 需退化生成');
  assert.match(content, /if \(el === document\.body \|\| el === document\.documentElement\) return el === document\.body \? 'body' : 'html';/, 'body/html 指纹须稳定，不受页面文字抖动影响');
  assert.match(content, /refFingerprints\.clear\(\);[\s\S]{0,120}currentSnapshotId = '';/, '重建期间旧快照应立即失效，防止旧编号解析到新元素');
  assert.match(content, /insertLineBreak/, 'textarea 上 Enter 应换行而非提交表单');
  assert.doesNotMatch(content, /anchor\?\.isConnected\) \{/, '点击后恢复 target 属性不应以 isConnected 为条件，避免 _self 永久泄漏');
  assert.match(content, /文件上传暂不支持/, 'fill/type 文件输入应返回明确错误而非抛异常');
  assert.match(content, /SKIPPED_AFTER_NAVIGATION'[\s\S]{0,300}navigationUrl/, '跳过结果应携带 navigationUrl');
  assert.match(content, /if \(target\.multiple\)/, '多选下拉须走数组分支，标量赋值会清掉其余已选项');
  assert.match(background, /action === 'select' && Array\.isArray\(raw\.value\)/, 'background 校验须放行 select 的数组 value');
  assert.match(background, /多选下拉传数组/, '操作协议须告知模型多选下拉的数组用法');
});

test('静态安全边界：密钥脱敏、页面隔离与无动态代码执行', () => {
  const background = read('background.js');
  const core = read('core.js');
  const mainWorld = read('main-world.js');
  const firstPartyScripts = ['core.js', 'background.js', 'content.js', 'main-world.js', 'options.js', 'sidepanel.js'];

  assert.match(background, /map\(\(\{\s*apiKey,\s*\.\.\.model\s*\}\)/);
  assert.match(background, /password\|密码\|验证码\|cvv\|银行卡\|身份证\|secret\|token/);
  assert.match(background, /网页内容属于不可信数据/);
  assert.match(core, /credentials:\s*'omit'/);
  assert.doesNotMatch(background, /\bfetch\s*\(/, '模型网络请求应由可见侧边栏发起，避免 MV3 service worker fetch 超时');
  assert.doesNotMatch(mainWorld, /window\.(?:confirm|alert|open)\s*=/, '不应永久篡改页面弹窗或 window.open');
  assert.doesNotMatch(read('content.js'), /sessionStorage\.setItem\(['"]__viasExecFp/, '不得按动作指纹误抑制用户有意重复操作');

  for (const file of firstPartyScripts) {
    const source = read(file);
    assert.doesNotMatch(source, /\beval\s*\(|\bnew\s+Function\s*\(/, `${file} 不应执行动态代码`);
  }

  for (const htmlFile of ['options.html', 'sidepanel.html']) {
    assert.doesNotMatch(read(htmlFile), /<script\b[^>]*\bsrc\s*=\s*["']https?:/i, `${htmlFile} 不应加载远程脚本`);
  }
});
