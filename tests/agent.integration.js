'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const edgePath = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
let context;
let profile;
let webServer;
let modelServer;
let webUrl;
let modelUrl;
let extensionId;
let reply;
let requests = [];
let oldPageClicks = 0;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

const fixture = '<!doctype html><meta charset="utf-8"><title>Agent Integration</title><button id="work">Do work</button><form id="form"><button id="submit">Submit</button></form><p id="result">INITIAL_PAGE_MARKER</p><script>window.clicks=0;window.submits=0;work.onclick=()=>{clicks++;result.textContent="PAGE_"+clicks};form.onsubmit=e=>{e.preventDefault();submits++;result.textContent="SUBMITTED"};</script>';

test.before(async () => {
  assert.ok(fs.existsSync(edgePath), `Edge 不存在: ${edgePath}`);
  webServer = http.createServer((request, response) => {
    const route = request.url.split('?')[0];
    if (route === '/no-document') { response.writeHead(204); response.end(); return; }
    if (route === '/redirect-back') { response.writeHead(302, { location: '/navigate' }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (route === '/old-click') { oldPageClicks++; response.end('recorded'); return; }
    if (route === '/slow') { setTimeout(() => response.end('<!doctype html><title>Arrived</title><p>ARRIVED_NEW_PAGE</p>'), 1500); return; }
    if (route === '/navigate') { response.end('<!doctype html><button id="old" onclick="fetch(\'/old-click\')">Old action</button><p>OLD_DOCUMENT</p>'); return; }
    if (route === '/navigate-link') { response.end('<!doctype html><a href="/slow">Start navigation</a><button id="old" onclick="fetch(\'/old-click\')">Old action</button>'); return; }
    if (route === '/navigate-form') { response.end('<!doctype html><form action="/slow"><input name="note"><button type="submit">Submit</button></form><button id="old" onclick="fetch(\'/old-click\')">Old action</button>'); return; }
    response.end(fixture);
  });
  modelServer = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push(body);
        const instruction = await reply(requests.length, body);
        if (response.destroyed) return;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: typeof instruction === 'string' ? instruction : JSON.stringify(instruction) } }] }));
      } catch (error) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(error.message);
      }
    });
  });
  webUrl = `http://127.0.0.1:${await listen(webServer)}`;
  modelUrl = `http://127.0.0.1:${await listen(modelServer)}/v1`;
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vias-agent-integration-'));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: edgePath, headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  extensionId = worker.url().match(/^chrome-extension:\/\/([^/]+)\//)?.[1];
  assert.ok(extensionId);
  const config = await context.newPage();
  await config.goto(`chrome-extension://${extensionId}/options.html`);
  await config.evaluate((baseUrl) => chrome.storage.local.set({
    models: [{ id: 'integration', name: 'Integration', baseUrl, apiKey: '', model: 'mock', vision: false }],
    activeModelId: 'integration', settingsRevision: 1,
  }), modelUrl);
  await config.close();
});

test.after(async () => {
  await context?.close();
  if (webServer?.listening) await new Promise((resolve) => webServer.close(resolve));
  if (modelServer?.listening) await new Promise((resolve) => modelServer.close(resolve));
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

async function withPanel(handler, route = '/') {
  requests = [];
  const panel = await context.newPage();
  const errors = [];
  panel.on('pageerror', (error) => errors.push(error.message));
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.waitForFunction(() => document.querySelector('#modelPill')?.textContent.includes('Integration') && !document.querySelector('#clear').disabled);
  await panel.locator('#clear').click();
  const target = await context.newPage();
  await target.goto(webUrl + route);
  await target.bringToFront();
  try {
    await handler(panel, target);
    assert.deepEqual(errors, []);
  } finally {
    await panel.close();
    await target.close();
  }
}

async function send(panel, question = 'Complete the local task') {
  await panel.locator('#input').fill(question);
  await panel.locator('#inputForm').evaluate((form) => form.requestSubmit());
}

async function finished(panel) {
  await panel.waitForFunction(() => !document.querySelector('#clear').disabled, null, { timeout: 30000 });
}

const complete = { say: '任务完成', done: true, actions: [] };

test('真实扩展完成模型→操作→新快照→done全链路，无审批和脚本错误', async () => {
  reply = (n) => n === 1 ? { say: '正在执行', actions: [{ action: 'click', selector: '#work' }] } : complete;
  await withPanel(async (panel, target) => {
    await send(panel, '点击 Do work 并汇报');
    await finished(panel);
    assert.equal(await target.locator('#result').textContent(), 'PAGE_1');
    assert.equal(requests.length, 2);
    await panel.getByText('任务完成', { exact: true }).waitFor();
    assert.equal(await panel.locator('.approval').count(), 0);
    assert.match(JSON.stringify(requests[1].messages), /操作结果/);
  });
});

test('问答模式完整展示含操作JSON的说明文章但不执行', async () => {
  reply = () => '解释前言\n```json\n{"actions":[{"action":"click","ref":1}]}\n```\n解释结尾';
  await withPanel(async (panel, target) => {
    await panel.locator('#modeAsk').click();
    await send(panel, '解释这段JSON');
    await finished(panel);
    assert.equal(requests.length, 1);
    assert.equal(await target.evaluate(() => window.clicks), 0);
    const text = await panel.locator('body').innerText();
    assert.match(text, /解释前言/);
    assert.match(text, /解释结尾/);
  });
});

test('有进展的连续同ref点击不误停，旧首屏不重复发送', async () => {
  reply = (n) => n <= 4 ? { actions: [{ action: 'click', ref: 1 }] } : complete;
  await withPanel(async (panel, target) => {
    await send(panel, '连续点击四次 Do work');
    await finished(panel);
    assert.equal(await target.evaluate(() => window.clicks), 4);
    assert.equal(requests.length, 5);
    assert.ok(JSON.stringify(requests[0].messages).includes('INITIAL_PAGE_MARKER'));
    for (const body of requests.slice(1)) assert.ok(!JSON.stringify(body.messages).includes('INITIAL_PAGE_MARKER'));
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('PAGE_4'));
  });
});

test('页面无进展的重复操作仍会熔断', async () => {
  reply = () => ({ actions: [{ action: 'click', ref: 1 }] });
  await withPanel(async (panel, target) => {
    await target.evaluate(() => { document.querySelector('#work').onclick = () => { window.clicks++; }; });
    await send(panel);
    await finished(panel);
    assert.equal(await target.evaluate(() => window.clicks), 2);
    assert.equal(requests.length, 3);
    assert.match(await panel.locator('body').innerText(), /无进展/);
  });
});

test('无效操作参数三轮熔断，不把超长坏回复反复带入请求', async () => {
  reply = () => ({ actions: [{ action: 'not-a-real-action' }], padding: 'x'.repeat(100000) });
  await withPanel(async (panel, target) => {
    await send(panel);
    await finished(panel);
    assert.equal(requests.length, 3);
    assert.equal(await target.evaluate(() => window.clicks), 0);
    assert.ok(requests.every((body) => JSON.stringify(body.messages).length < 20000));
    assert.match(await panel.locator('body').innerText(), /无效操作参数/);
  });
});

test('失败后的提交只拦一次，读取最新页面后能继续完成', async () => {
  reply = (n) => n === 1 ? { actions: [{ action: 'click', ref: 999 }] }
    : n < 4 ? { actions: [{ action: 'submitForm', ref: 2 }] } : complete;
  await withPanel(async (panel, target) => {
    await send(panel, '核对后提交本地测试表单');
    await finished(panel);
    assert.equal(await target.evaluate(() => window.submits), 1);
    assert.equal(requests.length, 4);
    assert.match(JSON.stringify(requests[2].messages), /已拦下这一次提交并重新读取页面/);
  });
});

test('慢导航截断旧页后续动作，等待新文档再交给模型', async () => {
  oldPageClicks = 0;
  reply = (n) => n === 1 ? { actions: [{ action: 'navigate', value: webUrl + '/slow' }, { action: 'click', ref: 1 }] } : complete;
  await withPanel(async (panel, target) => {
    await send(panel, '跳转到新页面并汇报');
    await finished(panel);
    assert.equal(oldPageClicks, 0);
    assert.equal(requests.length, 2);
    assert.equal(await target.locator('body').innerText(), 'ARRIVED_NEW_PAGE');
    assert.match(JSON.stringify(requests[1].messages), /ARRIVED_NEW_PAGE/);
    assert.ok(!JSON.stringify(requests[1].messages).includes('OLD_DOCUMENT'));
  }, '/navigate');
});

for (const scenario of [
  { name: '普通链接点击', route: '/navigate-link', action: { action: 'click', ref: 1 }, oldRef: 2 },
  { name: '原生表单提交', route: '/navigate-form', action: { action: 'submitForm', ref: 2 }, oldRef: 3 },
  { name: 'Enter提交表单', route: '/navigate-form', action: { action: 'press', ref: 1, value: 'Enter' }, oldRef: 3 },
]) {
  test(`${scenario.name}的慢导航同样停止旧页后续操作`, async () => {
    oldPageClicks = 0;
    reply = (n) => n === 1 ? { actions: [scenario.action, { action: 'click', ref: scenario.oldRef }] } : complete;
    await withPanel(async (panel, target) => {
      await send(panel, '打开下一页面并汇报');
      await finished(panel);
      assert.equal(oldPageClicks, 0);
      assert.equal(requests.length, 2);
      assert.equal(await target.locator('body').innerText(), 'ARRIVED_NEW_PAGE');
      assert.match(JSON.stringify(requests[1].messages), /ARRIVED_NEW_PAGE/);
    }, scenario.route);
  });
}

test('204无新文档响应不会被当成导航成功', async () => {
  oldPageClicks = 0;
  reply = (n) => n === 1 ? { actions: [{ action: 'navigate', value: webUrl + '/no-document' }, { action: 'click', ref: 1 }] } : complete;
  await withPanel(async (panel, target) => {
    await send(panel);
    await finished(panel);
    assert.equal(oldPageClicks, 0);
    assert.equal(requests.length, 1);
    assert.equal(target.url(), webUrl + '/navigate');
    assert.match(await panel.locator('body').innerText(), /跳转未产生新文档或 URL 变化|页面跳转未完成/);
  }, '/navigate');
});

test('重定向回原URL但已生成新文档时允许继续', async () => {
  reply = (n) => n === 1 ? { actions: [{ action: 'navigate', value: webUrl + '/redirect-back' }] } : complete;
  await withPanel(async (panel, target) => {
    await target.evaluate(() => { window.__oldDocument = true; });
    await send(panel);
    await finished(panel);
    assert.equal(requests.length, 2);
    assert.equal(target.url(), webUrl + '/navigate');
    assert.equal(await target.evaluate(() => window.__oldDocument), undefined);
    await panel.getByText('任务完成', { exact: true }).waitFor();
  }, '/navigate');
});

test('合法长回答仅把规范化操作写入后续模型历史', async () => {
  reply = (n) => n === 1 ? { actions: [{ action: 'click', ref: 1 }], padding: 'PAD'.repeat(100000) } : complete;
  await withPanel(async (panel, target) => {
    await send(panel);
    await finished(panel);
    assert.equal(requests.length, 2);
    assert.equal(await target.evaluate(() => window.clicks), 1);
    assert.ok(JSON.stringify(requests[1].messages).length < 10000);
    assert.ok(!JSON.stringify(requests[1].messages).includes('PADPAD'));
  });
});

test('模型请求等待中停止，旧响应不能污染下一任务', async () => {
  let started;
  let release;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  reply = async () => { started(); await hold; return { say: 'OLD_RESPONSE_MUST_NOT_APPEAR', done: true, actions: [] }; };
  await withPanel(async (panel, target) => {
    await send(panel, '任务一');
    await requestStarted;
    await panel.locator('#send').click();
    await finished(panel);
    assert.match(await panel.locator('body').innerText(), /任务已(?:停止|取消)/);
    assert.equal(requests.length, 1);
    release();
    reply = () => complete;
    await target.bringToFront();
    await send(panel, '任务二');
    await finished(panel);
    assert.equal(requests.length, 2);
    assert.ok(!(await panel.locator('body').innerText()).includes('OLD_RESPONSE_MUST_NOT_APPEAR'));
    await panel.getByText('任务完成', { exact: true }).waitFor();
  });
});
