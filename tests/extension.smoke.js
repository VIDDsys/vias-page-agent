'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const edgePath = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

(async () => {
  assert.ok(fs.existsSync(edgePath), `Edge 不存在: ${edgePath}`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vias-extension-smoke-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: edgePath,
      headless: true,
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
    });
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const match = worker.url().match(/^chrome-extension:\/\/([^/]+)\/background\.js$/);
    assert.ok(match, `未发现 Vias service worker: ${worker.url()}`);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`chrome-extension://${match[1]}/sidepanel.html`, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    assert.match(await page.locator('body').innerText(), /Vias/);
    assert.equal(pageErrors.length, 0, `侧边栏脚本错误: ${pageErrors.join(' | ')}`);
    await page.locator('#modelPill').filter({ hasText: 'VIDDsys API' }).waitFor();
    const settings = await context.newPage();
    settings.on('pageerror', (error) => pageErrors.push(error.message));
    await settings.goto(`chrome-extension://${match[1]}/options.html`);
    await settings.getByRole('button', { name: '填写密钥', exact: true }).click();
    assert.equal(await settings.locator('#fName').inputValue(), 'VIDDsys API');
    assert.equal(await settings.locator('#fBase').inputValue(), 'https://api.viddsys.xyz/v1');
    assert.equal(await settings.locator('#fModel').inputValue(), 'deepseek-v4.1-flash');
    assert.equal(await settings.locator('#fKey').inputValue(), '');
    assert.equal(await settings.locator('#fKey').evaluate((element) => element === document.activeElement), true);
    await settings.locator('#fKey').fill('local-smoke-only');
    await settings.locator('#btnSave').click();
    await settings.waitForFunction(() => !document.querySelector('#formWrap').classList.contains('show'));
    const saved = await settings.evaluate(async () => {
      const state = await chrome.storage.local.get(['models', 'activeModelId']);
      return { count: state.models.length, selected: state.models[0].id === state.activeModelId, hasExpectedKey: state.models[0].apiKey === 'local-smoke-only' };
    });
    assert.deepEqual(saved, { count: 1, selected: true, hasExpectedKey: true });
    await settings.getByRole('button', { name: '编辑', exact: true }).waitFor();
    assert.equal(pageErrors.length, 0, `扩展脚本错误: ${pageErrors.join(' | ')}`);
    console.log('Built-in provider onboarding passed: prefilled fields, key focus, key-only save');
    console.log(`Extension smoke passed: ${match[1]}`);
  } finally {
    await context?.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
