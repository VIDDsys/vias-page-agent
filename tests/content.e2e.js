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

test.before(async () => {
  assert.ok(fs.existsSync(edgePath), `Edge 不存在: ${edgePath}`);
  fixtureServer = http.createServer((_request, response) => {
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
    assert.equal(response.results[0].code, 'STALE_SNAPSHOT');
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 0);
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
