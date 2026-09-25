'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const contentScript = path.join(root, 'content.js');
const fixtureHtml = fs.readFileSync(path.join(__dirname, 'content-fixture.html'), 'utf8');
const edgePath = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let browser;
let fixtureServer;
let fixtureUrl;
const pendingNavigations = new Map();
const navigationWaiters = new Map();

test.before(async () => {
  assert.ok(fs.existsSync(edgePath), `Edge 不存在: ${edgePath}`);
  fixtureServer = http.createServer((request, response) => {
    // 测试主动释放 HTTP 响应，保证 assign 后旧 URL/文档仍在，且无需固定长等待。
    if (request.url.startsWith('/slow-navigation')) {
      pendingNavigations.set(request.url, response);
      navigationWaiters.get(request.url)?.();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fixtureHtml);
  });
  await new Promise((resolve, reject) => {
    fixtureServer.once('error', reject);
    fixtureServer.listen(0, '127.0.0.1', resolve);
  });
  const address = fixtureServer.address();
  fixtureUrl = `http://127.0.0.1:${address.port}/fixture`;
  browser = await chromium.launch({ executablePath: edgePath, headless: true });
});

test.after(async () => {
  await browser?.close();
  if (fixtureServer?.listening) {
    await new Promise((resolve, reject) => fixtureServer.close((error) => error ? reject(error) : resolve()));
  }
});

async function openFixture() {
  const page = await browser.newPage();
  await page.goto(fixtureUrl, { waitUntil: 'load' });
  await page.evaluate(() => {
    const onMessage = {
      addListener(listener) {
        globalThis.__viasContentListener = listener;
      },
    };
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: { runtime: { onMessage } },
    });
  });
  await page.addScriptTag({ path: contentScript });
  await page.waitForFunction(() => typeof globalThis.__viasContentListener === 'function');
  return page;
}

async function withFixture(run) {
  const page = await openFixture();
  try {
    return await run(page);
  } finally {
    await page.close();
  }
}

async function dispatch(page, message, expectResponse = true) {
  return page.evaluate(({ payload, waitsForResponse }) => new Promise((resolve, reject) => {
    const listener = globalThis.__viasContentListener;
    if (typeof listener !== 'function') return reject(new Error('content listener 未注册'));

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error(`消息响应超时: ${payload.type}`));
    }, 20000);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    let asynchronous;
    try {
      asynchronous = listener(payload, {}, finish);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    if (!waitsForResponse) finish(undefined);
    else if (asynchronous !== true) queueMicrotask(() => finish(undefined));
  }), { payload: message, waitsForResponse: expectResponse });
}

function refMatching(extraction, pattern) {
  const line = String(extraction.text || '').split('\n').find((item) => pattern.test(item));
  const match = line?.match(/^\[(\d+)\]/);
  assert.ok(match, `未找到匹配 ref: ${pattern}`);
  return Number(match[1]);
}

function snapshotIdOf(extraction) {
  return extraction.snapshotId || '__missing_snapshot__';
}

async function extract(page, overrides = {}) {
  return dispatch(page, { type: 'EXTRACT', runId: 'run-e2e', maxLen: 30000, ...overrides });
}

async function execute(page, extraction, operationId, actions, approved = true) {
  return dispatch(page, {
    type: 'EXECUTE',
    runId: 'run-e2e',
    operationId,
    snapshotId: snapshotIdOf(extraction),
    approved,
    actions,
  });
}

test('EXTRACT 返回 snapshotId，并让 ref 可执行', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const extraction = await extract(page);
    assert.equal(typeof extraction.snapshotId, 'string');
    assert.ok(extraction.snapshotId.length >= 8);

    const ref = refMatching(extraction, /按钮「Count once」/);
    const response = await execute(page, extraction, 'op-extract-ref', [{ action: 'click', ref }]);
    assert.equal(response.results[0].ok, true);
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 1);
  });
});

test('EXECUTE 拒绝旧 snapshotId，且不触碰页面', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const oldExtraction = await extract(page);
    const ref = refMatching(oldExtraction, /按钮「Count once」/);
    await page.evaluate(() => {
      const marker = document.createElement('p');
      marker.textContent = 'snapshot changed';
      document.body.prepend(marker);
    });
    const currentExtraction = await extract(page);
    if (oldExtraction.snapshotId && currentExtraction.snapshotId) {
      assert.notEqual(oldExtraction.snapshotId, currentExtraction.snapshotId);
    }

    const response = await dispatch(page, {
      type: 'EXECUTE',
      runId: 'run-e2e',
      operationId: 'op-stale-snapshot',
      snapshotId: oldExtraction.snapshotId || '__definitely_stale__',
      actions: [{ action: 'click', ref }],
    });
    const first = response?.results?.[0] || response;
    assert.equal(first?.ok, false);
    assert.match(`${first?.code || ''} ${first?.msg || first?.error || ''}`, /STALE|快照|过期|旧/i);
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 0);
  });
});

test('DOM 在快照后变化时拒绝执行旧 ref', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const extraction = await extract(page);
    const ref = refMatching(extraction, /按钮「Count once」/);
    await page.evaluate(() => {
      document.querySelector('#counter').textContent = 'Changed after snapshot';
    });
    await page.waitForTimeout(0);
    const response = await execute(page, extraction, 'op-dom-stale', [{ action: 'click', ref }]);
    assert.equal(response.results[0].ok, false);
    assert.equal(response.results[0].code, 'STALE_TARGET');
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 0);
  });
});

test('无关节点的持续抖动不再阻止对有效目标执行（回归：自动刷新页点击落不了地）', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const extraction = await extract(page);
    const ref = refMatching(extraction, /按钮「Count once」/);
    await page.evaluate(() => {
      // 模拟倒计时/自动保存：改无关节点的文字与属性，不动目标本身
      const h = document.querySelector('h1');
      h.textContent = `fixture-start-marker 12:${30 + Math.floor(Math.random() * 9)}`;
      h.dataset.tick = String(Date.now());
    });
    await page.waitForTimeout(0);
    const response = await execute(page, extraction, 'op-unrelated-churn', [{ action: 'click', ref }]);
    assert.equal(response.results[0].ok, true, JSON.stringify(response.results[0]));
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 1);
  });
});

test('fill 相同值重放不重复触发 input/change', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const firstExtraction = await extract(page);
    const nameRef = refMatching(firstExtraction, /输入框\(text\).*标签:Name/);
    await execute(page, firstExtraction, 'op-fill-1', [
      { action: 'fill', ref: nameRef, value: 'Alice' },
    ]);

    const secondExtraction = await extract(page);
    await execute(page, secondExtraction, 'op-fill-2', [
      { action: 'fill', selector: '#name', value: 'Alice' },
    ]);

    const state = await page.evaluate(() => ({
      value: document.querySelector('#name').value,
      counts: window.fixtureCounts,
    }));
    assert.equal(state.value, 'Alice');
    assert.equal(state.counts.nameInput, 1);
    assert.equal(state.counts.nameChange, 1);
  });
});

test('checkbox check 相同目标重放后仍保持选中', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const firstExtraction = await extract(page);
    const termsRef = refMatching(firstExtraction, /选项「Accept terms」/);
    await execute(page, firstExtraction, 'op-check-1', [{ action: 'check', ref: termsRef }]);

    const secondExtraction = await extract(page);
    await execute(page, secondExtraction, 'op-check-2', [{ action: 'check', selector: '#terms' }]);

    const state = await page.evaluate(() => ({
      checked: document.querySelector('#terms').checked,
      changes: window.fixtureCounts.termsChange,
    }));
    assert.equal(state.checked, true);
    assert.equal(state.changes, 1);
  });
});

test('operationId 是幂等键：不同 ID 执行，相同 ID 只执行一次', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const firstExtraction = await extract(page);
    const ref = refMatching(firstExtraction, /按钮「Count once」/);
    await execute(page, firstExtraction, 'op-button-a', [{ action: 'click', ref }]);

    const secondExtraction = await extract(page);
    const secondMessage = {
      type: 'EXECUTE',
      runId: 'run-e2e',
      operationId: 'op-button-b',
      snapshotId: snapshotIdOf(secondExtraction),
      approved: true,
      actions: [{ action: 'click', ref }],
    };
    await dispatch(page, secondMessage);
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 2, '不同 operationId 必须分别执行');

    await dispatch(page, secondMessage);
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 2, '相同 operationId 不得重演');
  });
});

test('ABORT 可中断正在执行的 repeat', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const extraction = await extract(page);
    const ref = refMatching(extraction, /按钮「Count once」/);
    const running = execute(page, extraction, 'op-repeat', [{
      action: 'repeat',
      times: 50,
      value: 500,
      actions: [{ action: 'click', ref }],
    }]);

    await page.waitForTimeout(250);
    await dispatch(page, { type: 'ABORT', runId: 'run-e2e' }, false);
    const response = await running;
    const repeatResult = response.results[0];
    const clicks = await page.evaluate(() => window.fixtureCounts.button);

    assert.equal(repeatResult.ok, false);
    assert.match(repeatResult.msg, /停止|取消/);
    assert.ok(clicks < 50, `repeat 未及时停止，点击次数=${clicks}`);
  });
});

test('EXTRACT 保留长文本并遍历 open shadow root', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const extraction = await extract(page, { maxLen: 30000 });

    assert.ok(extraction.text.length > 16000, `长文本被过早截断: ${extraction.text.length}`);
    assert.ok(extraction.text.includes('fixture-start-marker'), '长文本缺少开头标记');
    assert.ok(extraction.text.includes('fixture-end-marker'), '长文本缺少结尾标记');
    assert.ok(extraction.text.includes('Shadow action'), '未提取 open shadow root 中的按钮');
    assert.ok(extraction.text.includes('Shadow field'), '未提取 open shadow root 中的输入框');
  });
});

test('EXTRACT 对 password 当前值脱敏', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const extraction = await extract(page);
    assert.match(extraction.text, /输入框\(password\).*标签:Password/);
    assert.equal(extraction.text.includes('S3cr3t-fixture-value'), false, 'EXTRACT 泄露 password 当前值');
  });
});

test('password fill 的结果状态与新快照不回显密码', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const extraction = await extract(page);
    const passwordRef = refMatching(extraction, /输入框\(password\).*标签:Password/);
    const secret = 'Replacement-secret-123';
    const response = await execute(page, extraction, 'op-password-fill', [
      { action: 'fill', ref: passwordRef, value: secret },
    ]);

    assert.equal(response.results[0].ok, true);
    assert.equal(await page.$eval('#password', (element) => element.value), secret);
    assert.equal(JSON.stringify(response.results).includes(secret), false, '操作结果泄露 password 值');
    assert.equal(String(response.page?.text || '').includes(secret), false, '操作后快照泄露 password 值');
  });
});

test('ABORT(old) 后 EXTRACT(old) 同步取消不会锁死新 run', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await dispatch(page, { type: 'ABORT', runId: 'old-run' }, false);
    const cancelled = await extract(page, { runId: 'old-run' });
    assert.equal(cancelled.code, 'CANCELLED');
    const fresh = await extract(page, { runId: 'new-run' });
    assert.ok(fresh.snapshotId, JSON.stringify(fresh));
    const result = await dispatch(page, {
      type: 'EXECUTE', runId: 'new-run', operationId: 'op-after-cancel', snapshotId: fresh.snapshotId,
      actions: [{ action: 'click', ref: refMatching(fresh, /按钮「Count once」/) }],
    });
    assert.equal(result.results[0].ok, true);
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 1);
  });
});

test('进行中的 EXTRACT 取消后释放互斥锁', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const pending = extract(page, { runId: 'extract-to-cancel' });
    await page.waitForTimeout(50);
    const busy = await extract(page, { runId: 'parallel-run' });
    assert.equal(busy.code, 'BUSY');
    await dispatch(page, { type: 'ABORT', runId: 'extract-to-cancel' }, false);
    assert.equal((await pending).code, 'CANCELLED');
    assert.ok((await extract(page, { runId: 'fresh-run' })).snapshotId);
  });
});

test('链接文字不变但 href 变化返回 STALE_TARGET；等价规范化 href 仍可执行', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      const anchor = document.createElement('a');
      anchor.id = 'same-text-link';
      anchor.href = '/link-a';
      anchor.textContent = 'Local link';
      window.linkClicks = 0;
      anchor.addEventListener('click', (event) => { event.preventDefault(); window.linkClicks++; });
      document.body.prepend(anchor);
    });
    let snap = await extract(page);
    let ref = refMatching(snap, /链接「Local link」/);
    await page.$eval('#same-text-link', (el) => { el.href = '/link-b'; });
    const stale = await execute(page, snap, 'op-link-stale', [{ action: 'click', ref }]);
    assert.equal(stale.results[0].code, 'STALE_TARGET');
    assert.equal(await page.evaluate(() => window.linkClicks), 0);
    snap = await extract(page);
    ref = refMatching(snap, /链接「Local link」/);
    await page.$eval('#same-text-link', (el) => { el.setAttribute('href', `${location.origin}/./link-b`); });
    const same = await execute(page, snap, 'op-link-normalized', [{ action: 'click', ref }]);
    assert.equal(same.results[0].ok, true);
    assert.equal(await page.evaluate(() => window.linkClicks), 1);
  });
});

for (const nested of [false, true]) {
  test(`慢 HTTP 导航立即停止${nested ? ' repeat 及外层' : ''}批次，不点击旧按钮或生成旧快照`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      const pathname = `/slow-navigation-${nested ? 'repeat' : 'batch'}`;
      const requested = new Promise((resolve) => navigationWaiters.set(pathname, resolve));
      try {
        const snap = await extract(page);
        const click = { action: 'click', ref: refMatching(snap, /按钮「Count once」/) };
        const navigate = { action: 'navigate', value: `/unused/..${pathname}` };
        const first = nested ? { action: 'repeat', times: 3, value: 60000, actions: [navigate, click] } : navigate;
        // 在消息回调内读取旧文档计数；导航期间新发 page.evaluate 会等待新执行上下文。
        const { response, clicks } = await page.evaluate((message) => new Promise((resolve) => {
          globalThis.__viasContentListener(message, {}, (response) => resolve({ response, clicks: window.fixtureCounts.button }));
        }), { type: 'EXECUTE', runId: 'run-e2e', operationId: `op-slow-${nested}`, snapshotId: snap.snapshotId, actions: [first, click, click] });
        await requested;
        assert.equal(page.url(), fixtureUrl, '服务器尚未响应，必须仍为旧 URL');
        assert.equal(response.results[0].code, 'NAVIGATING');
        assert.equal(response.results[0].navigationUrl, new URL(pathname, fixtureUrl).href);
        assert.deepEqual(response.results.slice(1).map((result) => result.code), ['SKIPPED_AFTER_NAVIGATION', 'SKIPPED_AFTER_NAVIGATION']);
        if (nested) assert.equal(response.results[0].results[1].code, 'SKIPPED_AFTER_NAVIGATION');
        assert.equal(Object.hasOwn(response, 'page'), false, '不能把旧页快照当作导航结果');
        assert.equal(clicks, 0);
        pendingNavigations.get(pathname).end('<!doctype html><title>Local destination</title><p>Navigation complete</p>');
        await page.waitForURL(new URL(pathname, fixtureUrl).href);
      } finally {
        pendingNavigations.get(pathname)?.end();
        pendingNavigations.delete(pathname);
        navigationWaiters.delete(pathname);
      }
    });
  });
}

test('同文档 URL 变化保留 NAVIGATED，跳过后续动作且不重建旧快照', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => document.querySelector('#counter').addEventListener('click', () => history.pushState({}, '', '#moved')));
    const snap = await extract(page);
    const click = { action: 'click', ref: refMatching(snap, /按钮「Count once」/) };
    const response = await execute(page, snap, 'op-same-document-navigation', [{ action: 'repeat', times: 3, value: 0, actions: [click, click] }, click]);
    assert.equal(response.results[0].code, 'NAVIGATED');
    assert.equal(response.results[1].code, 'SKIPPED_AFTER_NAVIGATION');
    assert.equal(response.page, undefined);
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 1);
  });
});

test('navigate 到当前 URL 为 NO_CHANGE，不误跳过后续操作', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const snap = await extract(page);
    const response = await execute(page, snap, 'op-navigation-no-change', [
      { action: 'navigate', value: fixtureUrl },
      { action: 'click', ref: refMatching(snap, /按钮「Count once」/) },
    ]);
    assert.equal(response.results[0].code, 'NO_CHANGE');
    assert.equal(response.results[1].ok, true);
    assert.ok(response.page.snapshotId);
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 1);
  });
});

test('敏感 select 的选项文本和值在快照、父级描述、状态及结果中均脱敏', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = `<div role="button" aria-label="Sensitive container">
        ${['cc-name', 'one-time-code', 'current-password'].map((kind, index) => `<label>Secret choice ${index}<select id="s${index}" autocomplete="${kind}"><option value="fake-value-${index}-a">fake-text-${index}-a</option><option value="fake-value-${index}-b">fake-text-${index}-b</option></select></label>`).join('')}
        </div><label>Public choice<select id="public"><option value="public-value">Public option</option></select></label>`;
    });
    const snap = await extract(page);
    assert.doesNotMatch(JSON.stringify(snap), /fake-(?:value|text)/);
    assert.match(snap.text, /Public option\(value=public-value\)/);
    const sensitiveRefs = Object.entries(snap.targetMeta).filter(([, meta]) => meta.tag === 'select' && meta.sensitive).map(([ref]) => Number(ref));
    assert.equal(sensitiveRefs.length, 3);
    const response = await execute(page, snap, 'op-sensitive-select', sensitiveRefs.map((ref, index) => ({ action: 'select', ref, value: `fake-value-${index}-b` })));
    assert.ok(response.results.every((result) => result.code === 'SELECTED'));
    assert.doesNotMatch(JSON.stringify(response), /fake-(?:value|text)/);
    assert.deepEqual(await page.locator('select[autocomplete]').evaluateAll((elements) => elements.map((el) => el.value)), ['fake-value-0-b', 'fake-value-1-b', 'fake-value-2-b']);
    const unchanged = await execute(page, response.page, 'op-sensitive-no-change', [{ action: 'select', selector: '#s0', value: 'fake-value-0-b' }]);
    assert.equal(unchanged.results[0].code, 'NO_CHANGE');
    assert.doesNotMatch(JSON.stringify(unchanged), /fake-(?:value|text)/);
  });
});

test('交互容器继续枚举内部原生及 Shadow 控件，不重复普通内容', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<div role="button"><span>Container copy only once</span><section><input id="nested-field" aria-label="Nested field"><button id="nested-button" type="button">Nested action</button><div id="nested-shadow"></div></section></div>';
      document.querySelector('#nested-shadow').attachShadow({ mode: 'open' }).innerHTML = '<input aria-label="Nested shadow field">';
      window.nestedClicks = 0;
      document.querySelector('#nested-button').addEventListener('click', () => window.nestedClicks++);
    });
    const snap = await extract(page);
    assert.equal(Object.keys(snap.targets).length, 4);
    assert.equal(snap.text.split('Container copy only once').length - 1, 1);
    const response = await execute(page, snap, 'op-nested-controls', [
      { action: 'fill', ref: refMatching(snap, /输入框\(text\).*标签:Nested field/), value: 'nested value' },
      { action: 'click', ref: refMatching(snap, /按钮「Nested action」/) },
      { action: 'fill', ref: refMatching(snap, /输入框\(text\).*标签:Nested shadow field/), value: 'shadow value' },
    ]);
    assert.ok(response.results.every((result) => result.ok), JSON.stringify(response.results));
    assert.equal(await page.evaluate(() => window.nestedClicks), 1);
    assert.equal(await page.$eval('#nested-field', (el) => el.value), 'nested value');
    assert.equal(await page.locator('#nested-shadow input').inputValue(), 'shadow value');
  });
});

test('submitForm 保留原生校验，只有真实 submit/image 控件充当 submitter', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<form id="local-form"><input id="form-field" aria-label="Required field" required><button id="plain-button" type="button">Plain</button><input id="plain-input" type="button" value="Plain input"><button id="reset-button" type="reset">Reset</button><button id="submit-button" type="submit">Submit</button><input id="submit-input" type="submit"><input id="image-input" type="image" alt="Image submit" style="width:80px;height:40px"></form>';
      window.submitters = [];
      window.invalidCount = 0;
      document.querySelector('#form-field').addEventListener('invalid', () => window.invalidCount++);
      document.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); window.submitters.push(event.submitter?.id || null); });
    });
    const snap = await extract(page);
    const invalid = await execute(page, snap, 'op-invalid-form', [{ action: 'submitForm', selector: '#form-field' }], false);
    assert.equal(invalid.results[0].code, 'FORM_INVALID');
    assert.deepEqual(await page.evaluate(() => window.submitters), []);
    assert.ok(await page.evaluate(() => window.invalidCount > 0));
    const response = await execute(page, invalid.page, 'op-native-submitters', [
      { action: 'fill', selector: '#form-field', value: 'local valid value' },
      ...['form-field', 'plain-button', 'plain-input', 'reset-button', 'submit-button', 'submit-input', 'image-input'].map((id) => ({ action: 'submitForm', selector: `#${id}` })),
    ], false);
    assert.ok(response.results.every((result) => result.ok), JSON.stringify(response.results));
    assert.deepEqual(await page.evaluate(() => window.submitters), [null, null, null, null, 'submit-button', 'submit-input', 'image-input']);
  });
});

async function startClockBatch(page, snap, operationId, actions) {
  await page.evaluate((message) => {
    window.clockResponse = null;
    globalThis.__viasContentListener(message, {}, (response) => { window.clockResponse = response; });
  }, { type: 'EXECUTE', runId: 'run-e2e', snapshotId: snap.snapshotId, operationId, actions });
}

for (const cancel of [false, true]) {
  test(`repeat 60000ms 周期${cancel ? '可在长等待中取消' : '完整等待而非截成30000ms'}（虚拟时钟）`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      await page.evaluate(() => {
        window.clickTimes = [];
        document.querySelector('#counter').addEventListener('click', () => window.clickTimes.push(performance.now()));
      });
      const snap = await extract(page);
      await page.clock.install();
      await startClockBatch(page, snap, `op-long-repeat-${cancel}`, [{ action: 'repeat', times: 2, value: 60000, actions: [{ action: 'click', ref: refMatching(snap, /按钮「Count once」/) }] }]);
      await page.clock.runFor(31000);
      assert.equal(await page.evaluate(() => window.clickTimes.length), 1, '31000ms 时不能已开始第二轮');
      assert.equal(await page.evaluate(() => window.clockResponse), null);
      if (cancel) {
        await dispatch(page, { type: 'ABORT', runId: 'run-e2e' }, false);
        await page.clock.runFor(200);
        const result = await page.evaluate(() => window.clockResponse);
        assert.equal(result.results[0].code, 'CANCELLED');
        assert.equal(await page.evaluate(() => window.clickTimes.length), 1);
      } else {
        await page.clock.runFor(31000);
        const result = await page.evaluate(() => window.clockResponse);
        assert.equal(result.results[0].ok, true, JSON.stringify(result));
        const times = await page.evaluate(() => window.clickTimes);
        assert.equal(times.length, 2);
        // runFor 之间的浏览器通信仍消耗少量实时时间，但不能提前启动第二轮。
        assert.ok(times[1] - times[0] >= 60000 && times[1] - times[0] < 60250, `实际周期: ${times[1] - times[0]}`);
      }
    });
  });
}

test('wait 仍限制30000ms，repeat 拒绝超过60000ms（虚拟时钟）', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const snap = await extract(page);
    await page.clock.install();
    await startClockBatch(page, snap, 'op-wait-limit', [{ action: 'wait', value: 60000 }]);
    await page.clock.runFor(29900);
    assert.equal(await page.evaluate(() => window.clockResponse), null);
    await page.clock.runFor(1100);
    const waited = await page.evaluate(() => window.clockResponse);
    assert.equal(waited.results[0].msg, '已等待 30000ms');
    await startClockBatch(page, waited.page, 'op-repeat-limit', [{ action: 'repeat', times: 2, value: 60001, actions: [{ action: 'wait', value: 0 }] }]);
    await page.clock.runFor(500);
    assert.equal(await page.evaluate(() => window.clockResponse.results[0].code), 'INVALID_REPEAT');
  });
});

test('文本预算与 targets/targetMeta 一致，截短 select 详情仍可按 ref 执行', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = `<button id="budget-first">Visible first action</button><p>${'budget-copy-'.repeat(50)}</p><select aria-label="Budget select">${Array.from({ length: 100 }, (_, index) => `<option value="v${index}">Budget option ${index}</option>`).join('')}</select>${Array.from({ length: 3000 }, (_, index) => `<button>Budget action ${index}</button>`).join('')}<button>Page tail action</button>`;
      window.budgetClicks = 0;
      document.querySelector('#budget-first').addEventListener('click', () => window.budgetClicks++);
    });
    const full = await extract(page, { maxLen: 50000 });
    assert.ok(full.text.length <= 50000 && full.text.length > 49800);
    assert.equal(Object.values(full.targets).some((description) => description.includes('Page tail action')), false);
    for (const budget of [1000, 2500, 16000]) {
      const snap = await extract(page, budget === 16000 ? { maxLen: undefined } : { maxLen: budget });
      assert.ok(snap.text.length <= budget && snap.text.length > budget - 200, '保持默认预算，仅在完整标题边界截断');
      const declaredRefs = [...snap.text.matchAll(/^\[(\d+)\]/gm)].map((match) => match[1]);
      assert.deepEqual(Object.keys(snap.targets), declaredRefs, '文本宣告的每个编号都必须有目标');
      assert.deepEqual(Object.keys(snap.targetMeta), declaredRefs);
      for (const [ref, meta] of Object.entries(snap.targetMeta)) {
        assert.equal(Object.hasOwn(meta, 'description'), false, '描述仅在 targets 中保留一份');
        assert.ok(snap.text.includes(snap.targets[ref]), '元数据必须对应完整目标记录');
      }
      if (budget === 1000) {
        assert.match(snap.targets[2], /^\[2\] 下拉框 标签:Budget select/);
        assert.match(snap.targets[2], /省略/);
        assert.equal(snap.targetMeta[2].tag, 'select');
      }
      const value = `v${budget === 1000 ? 1 : budget === 2500 ? 2 : 3}`;
      const result = await execute(page, snap, `op-budget-${budget}`, [
        { action: 'click', ref: refMatching(snap, /按钮「Visible first action」/) },
        { action: 'select', ref: refMatching(snap, /下拉框 标签:Budget select/), value },
      ]);
      assert.ok(result.results.every((item) => item.ok), JSON.stringify(result.results));
      assert.equal(await page.locator('select').inputValue(), value, '截短详情不能让 select ref 无法执行');
    }
    assert.equal(await page.evaluate(() => window.budgetClicks), 3);
  });
});

for (const action of ['click', 'submitForm', 'press']) {
  for (const nested of [false, true]) {
    test(`真实慢 HTTP ${action}${nested ? ' / repeat' : ''}：beforeunload 截停旧文档动作`, { timeout: 30000 }, async () => {
      await withFixture(async (page) => {
        const pathname = `/slow-navigation-native-${action}-${nested}`;
        const requested = new Promise((resolve) => navigationWaiters.set(pathname, resolve));
        try {
          await page.evaluate((destination) => {
            document.body.insertAdjacentHTML('afterbegin', `<a id="slow-link" href="${destination}">Slow local link</a><form action="${destination}" method="post"><input id="slow-field" aria-label="Slow local field"><button id="slow-submit" type="submit">Slow local submit</button></form>`);
            window.unloadObserved = null;
            addEventListener('beforeunload', (event) => { window.unloadObserved = { trusted: event.isTrusted, prevented: event.defaultPrevented, returnValue: event.returnValue }; });
          }, pathname);
          const snap = await extract(page);
          const first = action === 'click' ? { action, ref: refMatching(snap, /链接「Slow local link」/) }
            : action === 'submitForm' ? { action, ref: refMatching(snap, /按钮「Slow local submit」/) }
            : { action, ref: refMatching(snap, /输入框\(text\).*标签:Slow local field/), value: 'Enter' };
          const oldClick = { action: 'click', ref: refMatching(snap, /按钮「Count once」/) };
          const { response, clicks, unload, url } = await page.evaluate((message) => new Promise((resolve) => {
            globalThis.__viasContentListener(message, {}, (response) => resolve({ response, clicks: window.fixtureCounts.button, unload: window.unloadObserved, url: location.href }));
          }), { type: 'EXECUTE', runId: 'run-e2e', operationId: `op-native-${action}-${nested}`, snapshotId: snap.snapshotId, actions: [nested ? { action: 'repeat', times: 3, value: 60000, actions: [first, oldClick] } : first, oldClick] });
          await requested;
          assert.equal(url, fixtureUrl, '响应未释放前 location 仍必须是旧页');
          assert.equal(response.results[0].code, 'NAVIGATING', JSON.stringify(response));
          assert.equal(response.results[0].ok, true);
          assert.equal(response.results[1].code, 'SKIPPED_AFTER_NAVIGATION');
          if (nested) assert.equal(response.results[0].results[1].code, 'SKIPPED_AFTER_NAVIGATION');
          assert.equal(Object.hasOwn(response, 'page'), false);
          assert.equal(clicks, 0);
          assert.deepEqual(unload, { trusted: true, prevented: false, returnValue: '' }, '监听不得阻断原生导航');
          pendingNavigations.get(pathname).end('<!doctype html><title>Native destination</title>');
          await page.waitForURL(new URL(pathname, fixtureUrl).href);
        } finally {
          pendingNavigations.get(pathname)?.end();
          pendingNavigations.delete(pathname);
          navigationWaiters.delete(pathname);
        }
      });
    });
  }
}

for (const action of ['click', 'dblclick', 'check']) {
  for (const mutation of ['reuse-on-scroll', 'href-during-paint', 'detach-during-paint', 'href-on-mousedown']) {
    test(`${action} 派发前重验固定 ref：${mutation}`, { timeout: 30000 }, async () => {
      await withFixture(async (page) => {
        await page.evaluate(() => {
          document.body.innerHTML = '<div style="height:2500px"></div><a id="race-target" href="/safe-link">Original race target</a>';
          window.raceEvents = [];
          const target = document.querySelector('#race-target');
          for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) target.addEventListener(type, (event) => {
            window.raceEvents.push(type);
            if (type === 'click') event.preventDefault();
          });
        });
        const snap = await extract(page);
        const ref = refMatching(snap, /链接「Original race target」/);
        await page.evaluate((kind) => {
          const target = document.querySelector('#race-target');
          window.raceMutationDone = false;
          const mutate = () => {
            if (kind === 'reuse-on-scroll') target.textContent = 'Reused virtual row';
            else if (kind === 'detach-during-paint') target.remove();
            else target.href = 'java\nscript:window.unsafeClicked=true';
            window.raceMutationDone = true;
          };
          if (kind === 'href-on-mousedown') target.addEventListener('mousedown', mutate, { once: true });
          else addEventListener('scroll', () => {
            if (kind === 'reuse-on-scroll') mutate();
            else setTimeout(mutate, 30);
          }, { once: true });
        }, mutation);
        const response = await execute(page, snap, `op-race-${action}-${mutation}`, [{ action, ref }]);
        assert.equal(response.results[0].code, 'STALE_TARGET', JSON.stringify(response));
        assert.equal(response.results[0].ok, false);
        const state = await page.evaluate(() => ({ mutated: window.raceMutationDone, events: window.raceEvents, unsafe: window.unsafeClicked }));
        assert.equal(state.mutated, true, '必须真实触发滚动或前置鼠标事件');
        assert.equal(state.events.includes('click'), false);
        assert.equal(state.events.includes('dblclick'), false);
        assert.equal(state.unsafe, undefined);
        if (mutation !== 'href-on-mousedown') assert.deepEqual(state.events, [], 'paint 后检查必须早于任何指针事件');
      });
    });
  }
}

for (const action of ['fill', 'type', 'submitForm', 'press']) {
  for (const phase of action === 'press' ? ['focus'] : ['scroll', 'focus']) {
    test(`${action} 的 ${phase} 同步复用/替换目标不得写入或提交`, { timeout: 30000 }, async () => {
      await withFixture(async (page) => {
        await page.evaluate(() => {
          document.body.innerHTML = '<form><input id="race-field" aria-label="Original field" value="original"><button id="race-submit" type="submit">Submit local race</button></form>';
          window.raceWrites = 0;
          window.raceSubmits = 0;
          document.addEventListener('input', () => window.raceWrites++);
          document.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); window.raceSubmits++; });
        });
        const snap = await extract(page);
        await page.evaluate(({ action, phase }) => {
          const target = document.querySelector('#race-field');
          window.originalRaceField = target;
          const mutate = () => {
            target.setAttribute('aria-label', 'Reused field');
            const replacement = target.cloneNode(true);
            target.replaceWith(replacement);
          };
          // 只在测试目标实例模拟组件的同步滚动重渲染，不改全局页面 API。
          if (phase === 'scroll') target.scrollIntoView = mutate;
          else if (action === 'submitForm') {
            target.required = true;
            target.value = '';
            target.addEventListener('invalid', mutate, { once: true });
          } else target.addEventListener('focus', mutate, { once: true });
        }, { action, phase });
        const response = await execute(page, snap, `op-edit-race-${action}-${phase}`, [{ action, selector: '#race-field', value: action === 'press' ? 'Enter' : 'must not be written' }]);
        assert.equal(response.results[0].code, 'STALE_TARGET', JSON.stringify(response));
        const state = await page.evaluate(() => ({ writes: window.raceWrites, submits: window.raceSubmits, original: window.originalRaceField.value, replacement: document.querySelector('#race-field').value }));
        assert.equal(state.writes, 0);
        assert.equal(state.submits, 0);
        assert.notEqual(state.original, 'must not be written');
        assert.notEqual(state.replacement, 'must not be written');
      });
    });
  }
}

test('selector 固定首次定位节点，paint 期间替换为同描述节点也不能重找后点击', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<button id="selector-race" type="button">Same identity text</button>';
      window.selectorClicks = 0;
      document.addEventListener('click', () => window.selectorClicks++);
      const target = document.querySelector('#selector-race');
      target.scrollIntoView = () => setTimeout(() => target.replaceWith(target.cloneNode(true)), 30);
    });
    const snap = await extract(page);
    const response = await execute(page, snap, 'op-selector-fixed', [{ action: 'click', selector: '#selector-race' }]);
    assert.equal(response.results[0].code, 'STALE_TARGET');
    assert.equal(await page.evaluate(() => window.selectorClicks), 0);
  });
});

test('预算只剩半个标题时不输出残缺编号', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => { document.body.innerHTML = `<p>${'x'.repeat(995)}</p><button type="button">Complete target title</button>`; });
    const snap = await extract(page, { maxLen: 1000 });
    assert.equal(snap.text, 'x'.repeat(995));
    assert.deepEqual(snap.targets, {});
    assert.deepEqual(snap.targetMeta, {});
  });
});

for (const phase of ['paint', 'batch-wait', 'repeat-wait', 'wait', 'selector-wait', 'selector-resolution', 'snapshot']) {
  test(`真实导航在 ${phase} 期间启动时中断等待且不派发旧页动作`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      const pathname = `/slow-navigation-boundary-${phase}`;
      const requested = new Promise((resolve) => navigationWaiters.set(pathname, resolve));
      try {
        const snap = await extract(page);
        const click = { action: 'click', ref: refMatching(snap, /按钮「Count once」/) };
        const actions = phase === 'paint' ? [click, click]
          : phase === 'batch-wait' ? [{ action: 'wait', value: 0 }, click]
          : phase === 'repeat-wait' ? [{ action: 'repeat', times: 3, value: 60000, actions: [{ action: 'wait', value: 0 }] }, click]
          : phase === 'wait' ? [{ action: 'wait', value: 30000 }, click]
          : phase === 'selector-wait' ? [{ action: 'wait', selector: '#never-created', value: 30000 }, click]
          : phase === 'selector-resolution' ? [{ action: 'click', selector: '#never-created' }, click]
          : [{ action: 'wait', value: 0 }];
        const { response, clicks, elapsed } = await page.evaluate(({ message, destination }) => new Promise((resolve) => {
          const started = performance.now();
          setTimeout(() => location.assign(destination), 30);
          globalThis.__viasContentListener(message, {}, (response) => resolve({ response, clicks: window.fixtureCounts.button, elapsed: performance.now() - started }));
        }), { message: { type: 'EXECUTE', runId: 'run-e2e', operationId: `op-boundary-${phase}`, snapshotId: snap.snapshotId, actions }, destination: pathname });
        await requested;
        assert.equal(page.url(), fixtureUrl);
        assert.equal(response.results[0].code, 'NAVIGATING', JSON.stringify(response));
        assert.equal(response.results[0].ok, true);
        assert.ok(response.results.slice(1).every((result) => result.code === 'SKIPPED_AFTER_NAVIGATION'));
        assert.equal(Object.hasOwn(response, 'page'), false);
        assert.equal(clicks, 0);
        assert.ok(elapsed < 2000, `不能等满长等待，实际 ${elapsed}ms`);
        pendingNavigations.get(pathname).end('<!doctype html><title>Boundary destination</title>');
        await page.waitForURL(new URL(pathname, fixtureUrl).href);
      } finally {
        pendingNavigations.get(pathname)?.end();
        pendingNavigations.delete(pathname);
        navigationWaiters.delete(pathname);
      }
    });
  });
}

test('导航无提交后 finally 清理旗标，新 run/operation 和 EXTRACT 不继承导航状态', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const pathname = '/slow-navigation-cancelled';
    try {
      await page.evaluate((destination) => {
        document.body.insertAdjacentHTML('afterbegin', `<a id="cancelled-link" href="${destination}">Cancelled local navigation</a>`);
        window.originalPageApis = [window.open, window.confirm, window.alert];
        window.cancelledUnloadCount = 0;
        addEventListener('beforeunload', () => window.cancelledUnloadCount++);
      }, pathname);
      const snap = await extract(page);
      const response = await page.evaluate((message) => new Promise((resolve) => {
        globalThis.__viasContentListener(message, {}, (response) => {
          // 测试取消尚未提交的本地请求；生产执行器不得调用或替换此 API。
          setTimeout(() => { window.stop(); resolve(response); }, 100);
        });
      }), { type: 'EXECUTE', runId: 'run-e2e', operationId: 'op-cancelled-navigation', snapshotId: snap.snapshotId, actions: [{ action: 'click', ref: refMatching(snap, /链接「Cancelled local navigation」/) }] });
      assert.equal(response.results[0].code, 'NAVIGATING');
      assert.equal(response.page, undefined);
      assert.equal(page.url(), fixtureUrl);
      assert.equal(await page.evaluate(() => window.cancelledUnloadCount), 1);
      for (const runId of ['run-e2e', 'fresh-after-navigation']) {
        const fresh = await extract(page, { runId });
        assert.ok(fresh.snapshotId);
        assert.equal(fresh.snapshotId.split(':')[0], snap.snapshotId.split(':')[0], '取消导航后仍为旧 documentId，由后台负责拒绝误判成功');
        const result = await dispatch(page, { type: 'EXECUTE', runId, operationId: `op-fresh-${runId}`, snapshotId: fresh.snapshotId, actions: [{ action: 'click', ref: refMatching(fresh, /按钮「Count once」/) }] });
        assert.equal(result.results[0].ok, true);
        assert.equal(result.results[0].code, undefined);
        assert.ok(result.page.snapshotId);
      }
      // EXTRACT 期间无论收到何种卸载通知，都不应写入执行批的导航旗标。
      const extraction = await page.evaluate(() => new Promise((resolve) => {
        globalThis.__viasContentListener({ type: 'EXTRACT', runId: 'extract-only' }, {}, resolve);
        dispatchEvent(new Event('beforeunload'));
      }));
      assert.ok(extraction.snapshotId);
      assert.equal(await page.evaluate(() => window.fixtureCounts.button), 2);
      assert.equal(await page.evaluate(() => [window.open, window.confirm, window.alert].every((api, index) => api === window.originalPageApis[index])), true);
    } finally {
      pendingNavigations.get(pathname)?.end();
      pendingNavigations.delete(pathname);
    }
  });
});

test('同批原生输入与富文本值变化不使固定目标指纹失效', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => { document.body.innerHTML = '<input aria-label="Editable native"><div contenteditable="true" aria-label="Editable rich">Initial text</div>'; });
    const snap = await extract(page);
    const refs = [refMatching(snap, /输入框\(text\).*标签:Editable native/), refMatching(snap, /富文本输入区 标签:Editable rich/)];
    const response = await execute(page, snap, 'op-same-batch-values', refs.flatMap((ref) => [
      { action: 'fill', ref, value: 'first' }, { action: 'type', ref, value: 'second' }, { action: 'fill', ref, value: 'final' },
    ]));
    assert.ok(response.results.every((result) => result.ok), JSON.stringify(response));
    assert.equal(await page.locator('input').inputValue(), 'final');
    assert.equal(await page.locator('[contenteditable]').textContent(), 'final');
  });
});

test('选择器语法错误仍返回 INVALID_SELECTOR，不与导航/取消的字符串 code 混淆', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    let snap = await extract(page);
    for (const action of ['click', 'wait']) {
      const response = await execute(page, snap, `op-invalid-selector-${action}`, [{ action, selector: '[', value: 1000 }]);
      assert.equal(response.results[0].code, 'INVALID_SELECTOR');
      assert.equal(response.results[0].ok, false);
      snap = response.page;
      assert.ok(snap.snapshotId);
    }
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 0);
  });
});
