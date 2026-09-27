'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const edgePath = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const artifacts = path.resolve(process.env.UI_ARTIFACT_DIR || path.join(os.homedir(), '.qoder', 'tmp', `vias-ui-${Date.now()}`));
const errors = [];
let passed = 0;

async function check(name, test) {
  await test();
  passed++;
  console.log(`PASS ${name}`);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function settings(page) {
  return page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }));
}

async function seed(page, models, active = models[0]?.id || '') {
  await page.evaluate(async ({ models, active }) => {
    const state = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    await chrome.storage.local.set({ models, activeModelId: active, settingsRevision: state.settingsRevision + 1 });
  }, { models, active });
}

async function savePrompt(page, text) {
  await page.locator('#systemPrompt').fill(text);
  await page.locator('#btnSavePrompt').click();
  await page.waitForFunction(() => !document.querySelector('#btnSavePrompt').disabled && !promptDirty);
}

async function readyPanel(page) {
  await page.waitForFunction(() => typeof initialized !== 'undefined' && initialized && !document.querySelector('#modelPill').disabled);
}

async function menuBounds(page) {
  await page.waitForFunction(() => {
    const menu = document.querySelector('#modelMenu').getBoundingClientRect();
    return menu.width > 0 && menu.left >= 7.5 && menu.top >= 7.5 && menu.right <= innerWidth - 7.5 && menu.bottom <= innerHeight - 7.5;
  });
  return page.evaluate(() => {
    const menu = document.querySelector('#modelMenu');
    return { menu: menu.getBoundingClientRect().toJSON(), pill: document.querySelector('#modelPill').getBoundingClientRect().toJSON(), scrollHeight: menu.scrollHeight, clientHeight: menu.clientHeight };
  });
}

async function focusedItemVisible(page) {
  assert.equal(await page.evaluate(() => {
    const menu = document.querySelector('#modelMenu');
    const rect = menu.getBoundingClientRect();
    const item = document.activeElement.getBoundingClientRect();
    return menu.contains(document.activeElement) && item.top >= rect.top && item.bottom <= rect.bottom;
  }), true, '键盘焦点项必须滚入可见区域');
}

async function screenshot(page, name) {
  await page.bringToFront();
  await page.screenshot({ path: path.join(artifacts, `${name}.png`), timeout: 10000 });
}

(async () => {
  assert.ok(fs.existsSync(edgePath), `Edge 不存在: ${edgePath}`);
  fs.mkdirSync(artifacts, { recursive: true });
  const profile = fs.mkdtempSync(path.join(artifacts, 'isolated-profile-'));
  const requests = [];
  const waiting = [];
  const held = [];
  let golden = false;
  let goldenStep = 0;
  const nextModel = () => held.length ? Promise.resolve(held.shift()) : new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('本地假模型在 15 秒内未收到请求')), 15000);
    waiting.push((entry) => { clearTimeout(timeout); resolve(entry); });
  });
  const webServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>UI regression target</title><button id="work">Do work</button><p id="result">idle</p><script>document.querySelector("#work").onclick=()=>document.querySelector("#result").textContent="done"</script>');
  });
  const modelServer = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      assert.equal(request.headers.authorization, undefined, '只允许测试 profile 的免鉴权假模型');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      const reply = (content) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }));
      };
      if (golden) {
        goldenStep++;
        reply(goldenStep === 1
          ? { say: '正在执行本地测试', actions: [{ action: 'click', selector: '#work' }] }
          : { say: '本地任务完成，==已验证==', done: true, actions: [] });
      } else {
        const entry = { body, reply };
        if (waiting.length) waiting.shift()(entry);
        else held.push(entry);
      }
    });
  });
  let context;
  try {
    const webPort = await listen(webServer);
    const modelPort = await listen(modelServer);
    context = await chromium.launchPersistentContext(profile, {
      executablePath: edgePath,
      headless: true,
      viewport: { width: 900, height: 850 },
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-first-run'],
    });
    context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    // Defense in depth: injected only into this disposable profile, never the user's browser.
    await context.addInitScript(() => {
      const fetchLocal = window.fetch.bind(window);
      window.fetch = (resource, options) => {
        const url = new URL(typeof resource === 'string' ? resource : resource.url, location.href);
        if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('UI regression blocks non-local model requests');
        return fetchLocal(resource, options);
      };
    });
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = worker.url().match(/^chrome-extension:\/\/([^/]+)\/background\.js$/)?.[1];
    assert.ok(extensionId, '必须加载真实 MV3 worker');
    const url = (file) => `chrome-extension://${extensionId}/${file}`;
    const optionsA = await context.newPage();
    await optionsA.goto(url('options.html'));
    await optionsA.waitForFunction(() => latestPromptState !== null);
    const models = (count, long = false) => Array.from({ length: count }, (_, index) => ({
      id: `ui-${index}`, name: long ? `模型 ${index + 1} · ${'LongName'.repeat(7)}` : `测试模型 ${index + 1}`,
      baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: '', model: `mock-${index}`, vision: false,
    }));
    await seed(optionsA, models(6));
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 360, height: 850 });
    await panel.goto(url('sidepanel.html'));
    await readyPanel(panel);

    await check('6 模型 / 850px 视口 / 点击选择与焦点还原', async () => {
      await panel.locator('#modelPill').click();
      const bounds = await menuBounds(panel);
      assert.ok(bounds.menu.bottom <= bounds.pill.top - 5, '底部菜单必须向上');
      assert.equal(await panel.locator('#modelMenu button').count(), 7);
      assert.equal(await panel.evaluate(() => [...document.querySelectorAll('#modelMenu button')].every((button) => {
        const item = button.getBoundingClientRect();
        return item.top >= 8 && item.bottom <= innerHeight - 8;
      })), true);
      await screenshot(panel, 'menu-six-360-light');
      await panel.locator('#modelMenu button').nth(4).click();
      await panel.waitForFunction(() => document.querySelector('#modelPill').textContent.includes('测试模型 5'));
      assert.equal(await panel.locator('#modelPill').getAttribute('aria-expanded'), 'false');
      assert.equal(await panel.evaluate(() => document.activeElement.id), 'modelPill');
    });

    await check('菜单方向键 / Home / End / Escape / Tab / 外部焦点', async () => {
      await panel.locator('#modelPill').press('ArrowDown');
      assert.equal(await panel.evaluate(() => document.activeElement.dataset.modelId), 'ui-0');
      await panel.keyboard.press('ArrowDown');
      assert.equal(await panel.evaluate(() => document.activeElement.dataset.modelId), 'ui-1');
      await panel.keyboard.press('End');
      assert.equal(await panel.evaluate(() => document.activeElement.textContent), '管理模型…');
      await panel.keyboard.press('ArrowUp');
      await panel.keyboard.press('Enter');
      await panel.waitForFunction(() => document.querySelector('#modelPill').textContent.includes('测试模型 6'));
      await panel.locator('#modelPill').press('ArrowUp');
      await panel.keyboard.press('Home');
      assert.equal(await panel.evaluate(() => document.activeElement.dataset.modelId), 'ui-0');
      await panel.keyboard.press('Escape');
      assert.equal(await panel.evaluate(() => document.activeElement.id), 'modelPill');
      await panel.locator('#modelPill').press('Space');
      await panel.keyboard.press('Tab');
      assert.equal(await panel.locator('#modelPill').getAttribute('aria-expanded'), 'false');
      assert.equal(await panel.evaluate(() => document.querySelector('#modelMenu').contains(document.activeElement)), false);
      await panel.locator('#modelPill').click();
      await panel.locator('#input').click();
      assert.equal(await panel.evaluate(() => document.activeElement.id), 'input');
      assert.equal(await panel.locator('#modelPill').getAttribute('aria-expanded'), 'false');
    });

    await check('48 长名称 / 320px 侧栏 / 限高滚动 / resize 与横向 scroll', async () => {
      await seed(optionsA, models(48, true));
      await panel.waitForFunction(() => document.querySelectorAll('#modelMenu button').length === 49);
      await panel.locator('#modelPill').click();
      let bounds = await menuBounds(panel);
      assert.ok(bounds.scrollHeight > bounds.clientHeight);
      await panel.keyboard.press('End');
      await focusedItemVisible(panel);
      await panel.keyboard.press('Home');
      await focusedItemVisible(panel);
      await panel.keyboard.press('ArrowUp');
      await focusedItemVisible(panel);
      await panel.setViewportSize({ width: 320, height: 420 });
      bounds = await menuBounds(panel);
      assert.ok(bounds.menu.width <= 240);
      await focusedItemVisible(panel);
      await panel.keyboard.press('Home');
      await focusedItemVisible(panel);
      await screenshot(panel, 'menu-many-320');
      await panel.locator('#modelMenu').hover();
      await panel.mouse.wheel(0, 300);
      await panel.waitForFunction(() => document.querySelector('#modelMenu').scrollTop > 0);
      await panel.evaluate(() => { document.querySelector('#chips').scrollLeft = 100; });
      await menuBounds(panel);
      assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await panel.keyboard.press('Escape');
      await panel.evaluate(() => { document.querySelector('#chips').scrollLeft = 0; });
    });

    await check('菜单向下与左右夹限 / 无模型也可管理', async () => {
      await panel.evaluate(() => Object.assign(document.querySelector('#modelPill').style, { position: 'fixed', top: '20px', left: '290px' }));
      await panel.locator('#modelPill').focus();
      await panel.keyboard.press('ArrowDown');
      const bounds = await menuBounds(panel);
      assert.ok(bounds.menu.top >= bounds.pill.bottom + 5, '上方触发器应向下展开');
      await panel.keyboard.press('Escape');
      await panel.evaluate(() => document.querySelector('#modelPill').removeAttribute('style'));
      await seed(optionsA, []);
      await panel.waitForFunction(() => document.querySelectorAll('#modelMenu button').length === 1);
      await panel.locator('#modelPill').press('ArrowDown');
      assert.equal(await panel.evaluate(() => document.activeElement.textContent), '管理模型…');
      await panel.keyboard.press('Escape');
      await seed(optionsA, models(6));
      await panel.setViewportSize({ width: 360, height: 850 });
    });

    await check('浅深色 mark 普通/粗体/链接/code 对比度均 >= 4.5', async () => {
      await panel.evaluate(() => addMessage('ai', '==普通 **加粗** [链接](https://example.invalid) `code`=='));
      for (const colorScheme of ['light', 'dark']) {
        await panel.emulateMedia({ colorScheme });
        const ratios = await panel.locator('mark').last().evaluate((mark) => {
          const luminance = (color) => {
            const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((value) => {
              value /= 255;
              return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            });
            return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
          };
          const bg = luminance(getComputedStyle(mark).backgroundColor);
          return [mark, ...mark.querySelectorAll('*')].map((element) => {
            const fg = luminance(getComputedStyle(element).color);
            return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
          });
        });
        assert.ok(ratios.every((ratio) => ratio >= 4.5), `${colorScheme}: ${ratios}`);
        await screenshot(panel, `highlight-${colorScheme}`);
      }
      await panel.emulateMedia({ colorScheme: 'light' });
    });

    const newWindow = context.waitForEvent('page');
    await optionsA.evaluate((optionsUrl) => chrome.windows.create({ url: optionsUrl, type: 'normal', width: 900, height: 850 }), url('options.html'));
    const optionsB = await newWindow;
    await optionsB.waitForLoadState();
    await optionsB.waitForFunction(() => latestPromptState !== null);
    assert.notEqual(await optionsA.evaluate(async () => (await chrome.windows.getCurrent()).id), await optionsB.evaluate(async () => (await chrome.windows.getCurrent()).id));

    await check('两个真实设置窗口：旧草稿不带新 revision 静默覆盖；冲突可恢复', async () => {
      await optionsA.locator('#systemPrompt').fill('A 草稿：保留全部文本');
      await savePrompt(optionsB, 'B 窗口的新提示词');
      await optionsA.locator('#promptConflict').waitFor({ state: 'visible' });
      assert.equal(await optionsA.locator('#systemPrompt').inputValue(), 'A 草稿：保留全部文本');
      assert.equal(await optionsA.locator('#latestPrompt').inputValue(), 'B 窗口的新提示词');
      await optionsA.locator('#btnSavePrompt').click();
      await optionsA.waitForFunction(() => !document.querySelector('#btnSavePrompt').disabled);
      assert.equal((await settings(optionsB)).systemPrompt, 'B 窗口的新提示词');
      assert.equal(await optionsA.locator('#systemPrompt').inputValue(), 'A 草稿：保留全部文本');
      await optionsA.locator('#promptConflict').scrollIntoViewIfNeeded();
      await screenshot(optionsA, 'options-conflict');
      await optionsA.locator('#btnRebasePrompt').click();
      await optionsA.locator('#btnSavePrompt').click();
      await optionsA.waitForFunction(() => !promptDirty && !promptSaving);
      assert.equal((await settings(optionsA)).systemPrompt, 'A 草稿：保留全部文本');
      await optionsB.waitForFunction(() => document.querySelector('#systemPrompt').value === 'A 草稿：保留全部文本');
    });

    await check('保存/删除模型不丢提示词；模型 formRevision 冲突机制保留', async () => {
      const draft = '模型操作过程中未保存的提示词草稿';
      await optionsA.locator('#systemPrompt').fill(draft);
      await optionsA.locator('#modelList .card').first().getByRole('button', { name: '编辑', exact: true }).click();
      await optionsA.locator('#fName').fill('已编辑模型');
      await optionsA.locator('#btnSave').click();
      await optionsA.locator('#formWrap').waitFor({ state: 'hidden' });
      await optionsA.waitForFunction(() => models[0].name === '已编辑模型');
      assert.equal(await optionsA.locator('#systemPrompt').inputValue(), draft);
      assert.equal(await optionsA.evaluate(() => promptDirty), true);
      optionsA.once('dialog', (dialog) => dialog.accept());
      await optionsA.locator('#modelList .card').last().getByRole('button', { name: '删除', exact: true }).click();
      await optionsA.waitForFunction(() => models.length === 5);
      assert.equal(await optionsA.locator('#systemPrompt').inputValue(), draft);
      assert.equal(await optionsA.locator('#promptConflict').isVisible(), false);
      await optionsA.locator('#btnSavePrompt').click();
      await optionsA.waitForFunction(() => !promptDirty && !promptSaving);
      assert.equal((await settings(optionsA)).systemPrompt, draft);
      await optionsB.waitForFunction((value) => document.querySelector('#systemPrompt').value === value, draft);
      await optionsA.locator('#systemPrompt').fill(draft);
      await optionsA.locator('#modelList .card').first().getByRole('button', { name: '编辑', exact: true }).click();
      await optionsA.locator('#fName').fill('不应写入的旧表单');
      await savePrompt(optionsB, 'B 更新以制造模型表单冲突');
      await optionsA.locator('#btnSave').click();
      await optionsA.locator('#formStatus').filter({ hasText: '表单内容已保留' }).waitFor();
      assert.equal(await optionsA.locator('#formWrap').isVisible(), true, '冲突后表单保持打开');
      assert.equal(await optionsA.locator('#fName').inputValue(), '不应写入的旧表单');
      assert.equal((await settings(optionsA)).models[0].name, '已编辑模型');
      assert.equal(await optionsA.locator('#systemPrompt').inputValue(), draft);
      await optionsA.locator('#btnCancel').click();
    });

    await check('编辑保存不回传明文 Key：留空保留、清除生效、内容脚本不可读写设置', async () => {
      await seed(optionsA, [{ id: 'k1', name: '带 Key 模型', baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: 'sk-keep-me', model: 'mock-k', vision: false }]);
      await optionsA.waitForFunction(() => models.length === 1 && models[0].id === 'k1');
      assert.equal(await optionsA.evaluate(() => JSON.stringify(models).includes('sk-keep-me')), false, '设置页内存中不得持有明文 Key');
      await optionsA.locator('#modelList .card').first().getByRole('button', { name: '编辑', exact: true }).click();
      await optionsA.locator('#fName').fill('改名但不动 Key');
      await optionsA.locator('#btnSave').click();
      await optionsA.locator('#formWrap').waitFor({ state: 'hidden' });
      const stored = await optionsA.evaluate(() => chrome.storage.local.get('models'));
      assert.equal(stored.models[0].apiKey, 'sk-keep-me');
      assert.equal(stored.models[0].name, '改名但不动 Key');
      await optionsA.locator('#modelList .card').first().getByRole('button', { name: '编辑', exact: true }).click();
      await optionsA.locator('#fClearKey').check();
      await optionsA.locator('#btnSave').click();
      await optionsA.locator('#formWrap').waitFor({ state: 'hidden' });
      assert.equal((await optionsA.evaluate(() => chrome.storage.local.get('models'))).models[0].apiKey, '');
      await seed(optionsA, models(6));
      await optionsA.waitForFunction(() => models.length === 6);
    });

    await check('保存响应延迟期间继续编辑：不清脏、不覆盖，后续保存使用正确基线', async () => {
      await optionsA.locator('#btnRebasePrompt').click();
      await optionsA.evaluate(() => {
        const original = chrome.runtime.sendMessage.bind(chrome.runtime);
        window.__sendMessage = original;
        window.__holdPrompt = true;
        chrome.runtime.sendMessage = (message, callback) => {
          if (message.operation !== 'setPrompt' || !window.__holdPrompt) return original(message, callback);
          return original(message, (response) => { window.__releasePrompt = () => callback(response); });
        };
      });
      await optionsA.locator('#systemPrompt').fill('提交时版本');
      await optionsA.locator('#btnSavePrompt').click();
      await optionsA.waitForFunction(() => typeof window.__releasePrompt === 'function');
      await optionsA.locator('#systemPrompt').fill('保存过程中继续输入的新草稿');
      await optionsA.evaluate(() => { window.__holdPrompt = false; window.__releasePrompt(); });
      await optionsA.waitForFunction(() => !promptSaving);
      assert.equal(await optionsA.locator('#systemPrompt').inputValue(), '保存过程中继续输入的新草稿');
      assert.equal(await optionsA.evaluate(() => promptDirty), true);
      assert.equal((await settings(optionsB)).systemPrompt, '提交时版本');
      assert.match(await optionsA.locator('#promptStatus').textContent(), /仍有未保存/);
      await optionsA.locator('#btnSavePrompt').click();
      await optionsA.waitForFunction(() => !promptSaving && !promptDirty);
      assert.equal((await settings(optionsB)).systemPrompt, '保存过程中继续输入的新草稿');
      await optionsA.evaluate(() => { chrome.runtime.sendMessage = window.__sendMessage; });
    });

    await check('保存期间另一个窗口再次写入：新草稿仍冲突且可合并', async () => {
      await optionsB.waitForFunction(() => document.querySelector('#systemPrompt').value === '保存过程中继续输入的新草稿');
      await optionsA.evaluate(() => {
        window.__releasePrompt = null;
        const original = chrome.runtime.sendMessage.bind(chrome.runtime);
        window.__sendMessage = original;
        chrome.runtime.sendMessage = (message, callback) => message.operation === 'setPrompt'
          ? original(message, (response) => { window.__releasePrompt = () => callback(response); })
          : original(message, callback);
      });
      await optionsA.locator('#systemPrompt').fill('再次提交时版本');
      await optionsA.locator('#btnSavePrompt').click();
      await optionsA.waitForFunction(() => typeof window.__releasePrompt === 'function');
      await optionsA.locator('#systemPrompt').fill('本地最新草稿不能被迟到响应覆盖');
      await optionsB.waitForFunction(() => document.querySelector('#systemPrompt').value === '再次提交时版本');
      await savePrompt(optionsB, 'B 在 A 保存回调之前再次更新');
      await optionsA.evaluate(() => { chrome.runtime.sendMessage = window.__sendMessage; window.__releasePrompt(); });
      await optionsA.waitForFunction(() => !promptSaving);
      await optionsA.locator('#promptConflict').waitFor({ state: 'visible' });
      assert.equal(await optionsA.locator('#systemPrompt').inputValue(), '本地最新草稿不能被迟到响应覆盖');
      assert.equal(await optionsA.locator('#latestPrompt').inputValue(), 'B 在 A 保存回调之前再次更新');
      await optionsA.locator('#btnRebasePrompt').click();
      await optionsA.locator('#btnSavePrompt').click();
      await optionsA.waitForFunction(() => !promptSaving && !promptDirty);
    });

    await seed(optionsA, models(2));
    await panel.waitForFunction(() => document.querySelector('#modelPill').textContent.includes('测试模型 1'));
    const target = await context.newPage();
    await target.goto(`http://127.0.0.1:${webPort}/`);
    // Match the native side panel's window after the two-window conflict test.
    const panelWindow = await panel.evaluate(async () => (await chrome.windows.getCurrent()).id);
    const targetTab = await panel.evaluate(async (targetUrl) => (await chrome.tabs.query({ url: targetUrl }))[0].id, `http://127.0.0.1:${webPort}/`);
    await panel.evaluate(async ({ targetTab, panelWindow }) => { await chrome.tabs.move(targetTab, { windowId: panelWindow, index: -1 }); }, { targetTab, panelWindow });
    const submit = async (question) => {
      await target.bringToFront();
      await panel.locator('#input').fill(question);
      await panel.locator('#inputForm').evaluate((form) => form.requestSubmit());
    };

    await check('golden path：真实 worker -> 本地模型 -> 自动点击 -> 反馈 -> done', async () => {
      golden = true;
      await submit('点击 Do work 并汇报结果');
      await panel.getByText('本地任务完成，已验证', { exact: true }).waitFor({ timeout: 30000 });
      await panel.waitForFunction(() => !activeRun);
      assert.equal(await target.locator('#result').textContent(), 'done');
      assert.equal(goldenStep, 2);
      assert.match(JSON.stringify(requests.at(-1).messages), /操作结果/);
      assert.equal(await panel.locator('.approval').count(), 0, '必须保持完全访问自动执行');
      await screenshot(panel, 'golden-path');
      golden = false;
    });

    await check('运行模型标签固定；任务结束刷新为外部新选模型', async () => {
      const pending = nextModel();
      await submit('等待本地假模型回复');
      const request = await pending;
      assert.equal(request.body.model, 'mock-0');
      const switched = await optionsB.evaluate(() => chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', operation: 'setActive', id: 'ui-1' }));
      assert.equal(switched.ok, true);
      assert.match(await panel.locator('#modelPill').textContent(), /测试模型 1/);
      assert.equal(await panel.locator('#modelPill').isDisabled(), true);
      request.reply({ say: '延迟回复完成', done: true, actions: [] });
      await panel.waitForFunction(() => !activeRun && document.querySelector('#modelPill').textContent.includes('测试模型 2'));
    });

    await check('真实停止：取消进行中的本地模型请求', async () => {
      const pending = nextModel();
      await submit('停止这个延迟请求');
      const request = await pending;
      await panel.locator('#send').click();
      await panel.waitForFunction(() => !activeRun);
      assert.match(await panel.locator('#chat').innerText(), /停止|取消/);
      request.reply({ say: '取消后不能显示的回复', done: true, actions: [] });
      assert.equal(await panel.getByText('取消后不能显示的回复', { exact: true }).count(), 0);
    });

    // Deterministic race injection in another real extension page, scoped to this profile.
    const race = await context.newPage();
    await race.goto(url('sidepanel.html'));
    await readyPanel(race);
    await race.evaluate(() => {
      window.__ports = [];
      window.__calls = [];
      chrome.tabs.query = async () => [{ id: 42, url: 'http://127.0.0.1/test-only' }];
      chrome.runtime.connect = () => {
        const listeners = [];
        const port = {
          sent: [], runId: '',
          onMessage: { addListener: (listener) => listeners.push(listener) },
          onDisconnect: { addListener() {} },
          postMessage(message) { this.sent.push(message); if (message.t === 'RUN') this.runId = message.runId; },
          disconnect() {},
          deliver(message) { for (const listener of listeners) listener({ runId: this.runId, ...message }); },
        };
        window.__ports.push(port);
        return port;
      };
      globalThis.ViasCore = { ...globalThis.ViasCore, callModel: (_cfg, _messages, { signal }) => new Promise((resolve) => window.__calls.push({ signal, resolve })) };
    });
    const raceSend = async (text) => {
      await race.locator('#input').fill(text);
      await race.locator('#send').click();
      await race.waitForFunction(() => activeRun?.port);
    };

    await check('停止后迟到 model_request 不发请求；旧 run 的回复/done 不污染新任务', async () => {
      await raceSend('旧任务');
      await race.evaluate(() => window.__ports[0].deliver({ t: 'model_request', requestId: 'before-stop', cfg: { name: '任务开始时的实际模型' }, messages: [] }));
      assert.equal(await race.evaluate(() => window.__calls.length), 1);
      assert.match(await race.locator('#modelPill').textContent(), /任务开始时的实际模型/);
      await race.locator('#send').click();
      await race.evaluate(() => window.__ports[0].deliver({ t: 'model_request', requestId: 'late-after-stop', cfg: { name: '迟到的错误模型' }, messages: [] }));
      assert.equal(await race.evaluate(() => window.__calls.length), 1);
      assert.match(await race.locator('#modelPill').textContent(), /任务开始时的实际模型/);
      assert.equal(await race.evaluate(() => window.__calls[0].signal.aborted), true);
      await race.evaluate(() => { window.__oldRun = activeRun; window.__ports[0].deliver({ t: 'done', outcome: 'cancelled' }); });
      await raceSend('新任务');
      await race.evaluate(async () => {
        window.__ports[0].deliver({ t: 'say', text: '旧任务不应出现' });
        window.__ports[0].deliver({ t: 'done' });
        finishRun(window.__oldRun, 'completed');
        window.__calls[0].resolve('迟到模型回复');
        await Promise.resolve();
        await Promise.resolve();
      });
      assert.equal(await race.evaluate(() => activeRun?.runId === window.__ports[1].runId), true);
      assert.equal(await race.evaluate(() => window.__ports[0].sent.some((message) => message.t === 'model_response')), false);
      assert.equal(await race.getByText('旧任务不应出现', { exact: true }).count(), 0);
      await race.evaluate(() => window.__ports[1].deliver({ t: 'done' }));
    });

    await check('旧 finishRun 模型刷新迟到：运行中与结束后均不覆盖更新标签', async () => {
      await race.evaluate(() => {
        const original = chrome.runtime.sendMessage.bind(chrome.runtime);
        window.__sendMessage = original;
        window.__settingsReplies = [];
        chrome.runtime.sendMessage = (message, callback) => message.type === 'GET_SETTINGS'
          ? original(message, (response) => window.__settingsReplies.push(() => callback({ ...response, activeModelId: 'stale', models: [{ id: 'stale', name: '过期模型标签' }] })))
          : original(message, callback);
      });
      await raceSend('刷新任务一');
      await race.evaluate(() => window.__ports.at(-1).deliver({ t: 'done' }));
      await race.waitForFunction(() => window.__settingsReplies.length === 1);
      await raceSend('刷新任务二');
      await race.evaluate(() => window.__settingsReplies[0]());
      assert.doesNotMatch(await race.locator('#modelPill').textContent(), /过期/);
      await race.evaluate(() => window.__ports.at(-1).deliver({ t: 'done' }));
      await race.waitForFunction(() => window.__settingsReplies.length === 2);
      await raceSend('刷新任务三');
      await race.evaluate(() => { chrome.runtime.sendMessage = window.__sendMessage; window.__ports.at(-1).deliver({ t: 'done' }); });
      await race.waitForFunction(() => !activeRun && document.querySelector('#modelPill').textContent.includes('测试模型 2'));
      await race.evaluate(() => window.__settingsReplies[1]());
      assert.doesNotMatch(await race.locator('#modelPill').textContent(), /过期/);
    });

    await check('清空与保存同队列：旧写入 -> remove -> 新会话写入', async () => {
      await race.locator('#clear').click();
      await race.getByText('已新建对话', { exact: true }).waitFor();
      await race.evaluate(() => {
        window.__sessionSet = chrome.storage.session.set.bind(chrome.storage.session);
        window.__sessionRemove = chrome.storage.session.remove.bind(chrome.storage.session);
        window.__writes = [];
        window.__operations = [];
        chrome.storage.session.set = (data) => new Promise((resolve, reject) => {
          window.__operations.push('set:start');
          window.__writes.push(async () => {
            try { await window.__sessionSet(data); window.__operations.push('set:done'); resolve(); }
            catch (error) { reject(error); }
          });
        });
        chrome.storage.session.remove = async (key) => { window.__operations.push('remove'); return window.__sessionRemove(key); };
      });
      await raceSend('旧会话待保存');
      await race.waitForFunction(() => window.__writes.length === 1);
      await race.evaluate(() => window.__ports.at(-1).deliver({ t: 'done' }));
      await race.locator('#clear').click();
      assert.deepEqual(await race.evaluate(() => window.__operations), ['set:start']);
      await raceSend('新会话唯一消息');
      await race.evaluate(() => window.__writes.shift()());
      await race.waitForFunction(() => window.__writes.length === 1);
      assert.deepEqual(await race.evaluate(() => window.__operations), ['set:start', 'set:done', 'remove', 'set:start']);
      await race.evaluate(async () => { await window.__writes.shift()(); await persistQueue; window.__ports.at(-1).deliver({ t: 'done' }); });
      assert.deepEqual(await race.evaluate(async () => (await chrome.storage.session.get(sessionKey))[sessionKey]), [{ role: 'user', content: '新会话唯一消息' }]);
      await race.evaluate(() => { chrome.storage.session.set = window.__sessionSet; chrome.storage.session.remove = window.__sessionRemove; });
    });

    await check('IPC/持久化统一最近 100 条、单条 20000 字；排队快照捕获 sessionKey', async () => {
      await race.evaluate(() => {
        history = Array.from({ length: 125 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `${index}:` + 'x'.repeat(21000) }));
        window.__oldKey = sessionKey;
        window.__releaseQueue = null;
        persistQueue = new Promise((resolve) => { window.__releaseQueue = resolve; });
      });
      await raceSend('最新问题');
      const ipc = await race.evaluate(() => window.__ports.at(-1).sent.find((message) => message.t === 'RUN').history);
      assert.equal(ipc.length, 100);
      assert.ok(ipc.every((item) => item.content.length === 20000));
      assert.ok(ipc[0].content.startsWith('25:'));
      await race.evaluate(async () => {
        sessionKey = 'chat:ui-test-other-window';
        window.__releaseQueue();
        await persistQueue;
      });
      const stored = await race.evaluate(async () => chrome.storage.session.get([window.__oldKey, sessionKey]));
      const oldKey = await race.evaluate(() => window.__oldKey);
      assert.equal(stored['chat:ui-test-other-window'], undefined);
      assert.equal(stored[oldKey].length, 100);
      assert.ok(stored[oldKey][0].content.startsWith('26:'));
      assert.equal(stored[oldKey].at(-1).content, '最新问题');
      assert.ok(stored[oldKey].every((item) => item.content.length <= 20000));
      await race.evaluate(() => { sessionKey = window.__oldKey; window.__ports.at(-1).deliver({ t: 'done' }); });
    });

    await check('存储失败准确提示；失败后队列继续、清空不会伪报成功', async () => {
      await race.evaluate(() => { chrome.storage.session.set = async () => { throw new Error('mock quota'); }; });
      await raceSend('失败保存');
      await race.getByText('对话保存失败：mock quota', { exact: true }).waitFor();
      await race.evaluate(() => {
        window.__ports.at(-1).deliver({ t: 'done' });
        chrome.storage.session.remove = async () => { throw new Error('mock remove failure'); };
      });
      await race.locator('#clear').click();
      await race.getByText(/新建失败：mock remove failure/).waitFor();
      assert.equal(await race.getByText('已新建对话', { exact: true }).count(), 0);
      await race.evaluate(() => { chrome.storage.session.set = window.__sessionSet; chrome.storage.session.remove = window.__sessionRemove; });
      await race.locator('#clear').click();
      await race.getByText('已新建对话', { exact: true }).waitFor();
      assert.equal(await race.evaluate(async () => (await chrome.storage.session.get(sessionKey))[sessionKey]), undefined);
    });

    assert.deepEqual(errors, [], `扩展页面脚本异常: ${errors.join(' | ')}`);
    console.log(`UI regression passed: ${passed} scenarios; ${requests.length} local-only model requests`);
    console.log(`Screenshots: ${artifacts}`);
  } catch (error) {
    if (context) {
      for (const [index, page] of context.pages().entries()) {
        if (!page.isClosed()) await screenshot(page, `failure-${index}`).catch(() => {});
      }
    }
    throw error;
  } finally {
    await context?.close();
    webServer.closeAllConnections();
    modelServer.closeAllConnections();
    await Promise.all([new Promise((resolve) => webServer.close(resolve)), new Promise((resolve) => modelServer.close(resolve))]);
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
