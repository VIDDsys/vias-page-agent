'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const edgePath = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
let modelCalls = 0;
let secondMessages = [];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

(async () => {
  assert.ok(fs.existsSync(edgePath), `Edge 不存在: ${edgePath}`);
  const webServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>Agent Integration</title><button id="work">Do work</button><p id="result">idle</p><script>document.querySelector("#work").onclick=()=>{document.querySelector("#result").textContent="done"}</script>');
  });
  const modelServer = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      modelCalls++;
      if (modelCalls === 1) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: '```json\n{"say":"正在执行","actions":[{"action":"click","selector":"#work"}]}\n```' } }] }));
      } else {
        secondMessages = body.messages || [];
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: '```json\n{"say":"任务完成","actions":[]}\n```' } }] }));
      }
    });
  });
  const webPort = await listen(webServer);
  const modelPort = await listen(modelServer);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vias-agent-integration-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: edgePath,
      headless: true,
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
    });
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = worker.url().match(/^chrome-extension:\/\/([^/]+)\//)?.[1];
    assert.ok(extensionId);
    const configPage = await context.newPage();
    await configPage.goto(`chrome-extension://${extensionId}/options.html`);
    await configPage.evaluate(async ({ modelPort }) => {
      await chrome.storage.local.set({
        models: [{ id: 'integration', name: 'Integration', baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: '', model: 'mock', vision: false }],
        activeModelId: 'integration',
        settingsRevision: 1,
      });
    }, { modelPort });
    await configPage.close();

    const panel = await context.newPage();
    const errors = [];
    panel.on('pageerror', (error) => errors.push(error.message));
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.waitForFunction(() => document.querySelector('#modelPill')?.textContent.includes('Integration'));
    assert.equal(await panel.evaluate(() => typeof globalThis.ViasCore), 'object');
    const target = await context.newPage();
    await target.goto(`http://127.0.0.1:${webPort}/`);
    await target.bringToFront();
    await panel.locator('#input').fill('点击页面上的 Do work 按钮，并告诉我结果');
    await panel.locator('#inputForm').evaluate((form) => form.requestSubmit());
    // 完全访问权限：不再出现审批卡片，操作直接自动执行
    await panel.getByText('任务完成', { exact: true }).waitFor({ timeout: 30000 });
    assert.equal(await target.locator('#result').textContent(), 'done');
    assert.equal(modelCalls, 2);
    assert.equal(errors.length, 0, errors.join(' | '));
    const feedbackText = JSON.stringify(secondMessages);
    assert.match(feedbackText, /页面已更新|操作结果/);
    assert.match(feedbackText, /done/);
    console.log('Agent integration passed: model -> background -> content (auto-approved) -> feedback -> model');
  } finally {
    await context?.close();
    await new Promise((resolve) => webServer.close(resolve));
    await new Promise((resolve) => modelServer.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
