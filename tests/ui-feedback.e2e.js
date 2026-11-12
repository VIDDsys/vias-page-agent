'use strict';

// Isolated extension integration test. All credentials and failures below are synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const artifacts = path.resolve(process.env.UI_ARTIFACT_DIR || path.join(os.homedir(), '.agents', 'temp', 'vias-page-agent', `ui-feedback-${Date.now()}`));
const edge = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const secret = 'synthetic-sensitive-value-12345';
const errors = [];
const missing = [];

(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vias-feedback-profile-'));
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `denied ${secret}` } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: edge, headless: true, viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-first-run'],
    });
    context.on('page', (page) => {
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('response', (response) => { if (response.status() >= 400 && !response.url().startsWith('http://127.0.0.1:')) missing.push(`${response.status()} ${response.url()}`); });
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await options.waitForFunction(() => latestPromptState !== null);
    await options.evaluate(async ({ port, secret }) => {
      const state = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      await chrome.storage.local.set({
        models: [
          { id: 'a', name: '测试模型 A', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: secret, model: 'test-model', vision: false },
          { id: 'b', name: '测试模型 B', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '', model: 'test-model', vision: false },
        ], activeModelId: 'a', settingsRevision: state.settingsRevision + 1,
      });
    }, { port: server.address().port, secret });
    await options.waitForFunction(() => models.length === 2);
    const first = options.locator('#modelList .card').first();
    await first.getByRole('button', { name: '测试', exact: true }).click();
    await first.locator('.model-status').filter({ hasText: '鉴权未通过' }).waitFor();
    assert.equal(await first.getByRole('button', { name: '测试', exact: true }).isEnabled(), true);
    await new Promise((resolve) => setTimeout(resolve, 4200));
    assert.equal(await first.locator('.model-status').isVisible(), true, '失败原因不能在四秒后消失');
    assert.equal((await options.locator('body').innerText()).includes(secret), false);
    assert.equal(await options.locator(`[title*="${secret}"]`).count(), 0);
    await options.screenshot({ path: path.join(artifacts, 'options-1280-light-error.png') });
    // A real second attempt proves that the failed button is immediately usable.
    await first.getByRole('button', { name: '测试', exact: true }).click();
    await first.locator('.model-status').filter({ hasText: '鉴权未通过' }).waitFor();

    const optionsB = await context.newPage();
    await optionsB.goto(`chrome-extension://${id}/options.html`);
    await optionsB.waitForFunction(() => models.length === 2);
    await options.evaluate(() => {
      window.__originalCore = globalThis.ViasCore;
      window.__connectionCalls = [];
      globalThis.ViasCore = { ...globalThis.ViasCore, callModel: () => new Promise((resolve, reject) => window.__connectionCalls.push({ resolve, reject })) };
    });
    const editOtherWindow = async (field, value) => {
      await optionsB.locator('#modelList .card').first().getByRole('button', { name: '编辑', exact: true }).click();
      if (field === '#fKey') await optionsB.waitForFunction(() => document.querySelector('#fKey').value !== '');
      await optionsB.locator(field).fill(value);
      await optionsB.locator('#btnSave').click();
      await optionsB.locator('#formWrap').waitFor({ state: 'hidden' });
    };

    // A finished success must disappear even when the only changed field is the secret.
    await first.getByRole('button', { name: '测试', exact: true }).click();
    await options.waitForFunction(() => window.__connectionCalls.length === 1);
    await options.evaluate(() => window.__connectionCalls[0].resolve('OK'));
    await first.locator('.model-status').filter({ hasText: '连接测试通过' }).waitFor();
    await editOtherWindow('#fKey', 'synthetic-new-key-67890');
    await options.waitForFunction(() => !document.querySelector('#modelList .card .model-status').textContent);
    assert.equal(await first.locator('.model-status').isHidden(), true, '仅更改密钥也必须清除旧测试结果');

    // An old success must neither overwrite nor finish a new attempt after a cross-window edit.
    await first.getByRole('button', { name: '测试', exact: true }).click();
    await options.waitForFunction(() => window.__connectionCalls.length === 2);
    await editOtherWindow('#fModel', 'new-test-model');
    await options.waitForFunction(() => models[0]?.model === 'new-test-model');
    assert.equal(await first.locator('.model-status').isHidden(), true);
    await first.getByRole('button', { name: '测试', exact: true }).click();
    await options.waitForFunction(() => window.__connectionCalls.length === 3);
    await options.evaluate(() => window.__connectionCalls[1].resolve('OK'));
    await options.waitForTimeout(100);
    assert.match(await first.locator('.model-status').innerText(), /正在测试/);
    assert.equal(await first.getByRole('button', { name: '测试中…', exact: true }).isDisabled(), true);
    await options.evaluate(() => window.__connectionCalls[2].resolve('OK'));
    await first.locator('.model-status').filter({ hasText: '连接测试通过' }).waitFor();

    // A late failure must also be discarded after a subsequent configuration change.
    await first.getByRole('button', { name: '测试', exact: true }).click();
    await options.waitForFunction(() => window.__connectionCalls.length === 4);
    await editOtherWindow('#fModel', 'newer-test-model');
    await options.waitForFunction(() => models[0]?.model === 'newer-test-model');
    await options.evaluate((secret) => window.__connectionCalls[3].reject(new Error(`API 401: ${secret}`)), secret);
    await options.waitForTimeout(100);
    assert.equal(await first.locator('.model-status').isHidden(), true);
    assert.equal(await first.getByRole('button', { name: '测试', exact: true }).isEnabled(), true);

    // Hold the storage-triggered refresh: the final revision read must detect the change itself.
    await first.getByRole('button', { name: '测试', exact: true }).click();
    await options.waitForFunction(() => window.__connectionCalls.length === 5);
    await options.evaluate(() => {
      window.__originalSend = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__holdOneSettingsRead = true;
      chrome.runtime.sendMessage = (message, callback) => {
        if (message.type === 'GET_SETTINGS' && window.__holdOneSettingsRead) {
          window.__holdOneSettingsRead = false;
          return window.__originalSend(message, (state) => { window.__releaseSettingsRead = () => callback(state); });
        }
        return window.__originalSend(message, callback);
      };
    });
    await editOtherWindow('#fModel', 'revision-before-event');
    await options.waitForFunction(() => typeof window.__releaseSettingsRead === 'function');
    assert.equal(await options.evaluate(() => models[0].model), 'newer-test-model');
    await options.evaluate(() => window.__connectionCalls[4].resolve('OK'));
    await options.waitForFunction(() => models[0]?.model === 'revision-before-event');
    assert.equal(await first.locator('.model-status').isHidden(), true, '版本不同时不得显示旧测试通过');
    await options.evaluate(() => { window.__releaseSettingsRead(); chrome.runtime.sendMessage = window.__originalSend; });
    assert.equal((await options.locator('body').innerText()).includes('synthetic-new-key-67890'), false);
    assert.equal((await options.locator('body').innerText()).includes(secret), false);
    assert.equal(await options.locator('[title*="synthetic-new-key-67890"]').count(), 0);
    await options.evaluate(() => { globalThis.ViasCore = window.__originalCore; });
    await optionsB.close();

    await options.evaluate((secret) => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (message, callback) => message.type === 'UPDATE_SETTINGS' && ['setActive', 'deleteModel'].includes(message.operation)
        ? callback({ ok: false, error: `unsafe ${secret}` }) : original(message, callback);
    }, secret);
    const second = options.locator('#modelList .card').nth(1);
    await second.getByRole('button', { name: '使用', exact: true }).click();
    await second.locator('.model-status').filter({ hasText: '切换模型失败' }).waitFor();
    options.once('dialog', (dialog) => dialog.accept());
    await second.getByRole('button', { name: '删除', exact: true }).click();
    await second.locator('.model-status').filter({ hasText: '删除模型失败' }).waitFor();
    assert.equal((await options.locator('body').innerText()).includes(secret), false);
    assert.equal(await options.locator('#promptStatus').innerText(), '');
    await options.emulateMedia({ colorScheme: 'dark' });
    await options.setViewportSize({ width: 390, height: 900 });
    await options.screenshot({ path: path.join(artifacts, 'options-390-dark-error.png') });

    const panel = await context.newPage();
    await panel.setViewportSize({ width: 320, height: 850 });
    await panel.emulateMedia({ colorScheme: 'dark' });
    await panel.goto(`chrome-extension://${id}/sidepanel.html`);
    await panel.waitForFunction(() => initialized);
    const geometry = await panel.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      buttons: [...document.querySelectorAll('#chips .chip')].map((el) => ({ text: el.textContent, ...el.getBoundingClientRect().toJSON() })),
      header: [...document.querySelectorAll('header button')].map((el) => ({ text: el.textContent, ...el.getBoundingClientRect().toJSON() })),
    }));
    assert.equal(geometry.overflow, false);
    assert.equal(geometry.buttons.length, 5);
    assert.ok(geometry.buttons.every((r) => r.left >= 0 && r.right <= 320 && r.height >= 44), JSON.stringify(geometry));
    assert.ok(geometry.header.every((r) => r.left >= 0 && r.right <= 320 && r.height >= 44), JSON.stringify(geometry));
    // Inject the same messages the worker sends to reproduce a page-action failure deterministically.
    await panel.evaluate((secret) => {
      chrome.tabs.query = async () => [{ id: 42, url: 'http://127.0.0.1/test' }];
      chrome.runtime.connect = () => {
        const listeners = [];
        return { onMessage: { addListener: (fn) => listeners.push(fn) }, onDisconnect: { addListener() {} }, disconnect() {},
          postMessage(message) {
            if (message.t !== 'RUN') return;
            queueMicrotask(() => {
              for (const fn of listeners) {
                fn({ runId: message.runId, t: 'actions', round: 1, actions: [{ action: 'click', ref: 1 }] });
                fn({ runId: message.runId, t: 'result', round: 1, index: 0, ok: false, code: 'TARGET_NOT_FOUND', msg: secret });
                fn({ runId: message.runId, t: 'done' });
              }
            });
          } };
      };
    }, secret);
    await panel.locator('#input').fill('测试操作');
    await panel.locator('#send').click();
    await panel.locator('.tool-reason').filter({ hasText: '找不到目标' }).waitFor();
    assert.equal((await panel.locator('body').innerText()).includes(secret), false);
    assert.equal(await panel.locator(`[title*="${secret}"]`).count(), 0);
    await panel.screenshot({ path: path.join(artifacts, 'panel-320-dark-error.png') });
    await panel.setViewportSize({ width: 390, height: 850 });
    await panel.screenshot({ path: path.join(artifacts, 'panel-390-dark-error.png') });
    const ratios = await panel.evaluate(() => {
      const lum = (color) => {
        const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((n) => { n /= 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; });
        return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
      };
      return ['.tool-reason', '.tool-detail', '.tool-name', '.tool-state', '.tools-head', '.chip'].map((selector) => {
        const el = document.querySelector(selector);
        const foreground = lum(getComputedStyle(el).color);
        let ancestor = el; let background;
        while (ancestor) { const color = getComputedStyle(ancestor).backgroundColor; if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') { background = lum(color); break; } ancestor = ancestor.parentElement; }
        return { selector, ratio: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) };
      });
    });
    assert.ok(ratios.every((item) => item.ratio >= 4.5), JSON.stringify(ratios));
    assert.deepEqual(errors, []);
    assert.deepEqual(missing, []);
    console.log('PASS model failures, immediate retry, redaction, sidepanel action failure, dark contrast, 320px layout');
    console.log('Geometry:', JSON.stringify(geometry));
    console.log('Dark contrast:', JSON.stringify(ratios));
    console.log('Screenshots:', artifacts);
  } finally {
    await context?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
