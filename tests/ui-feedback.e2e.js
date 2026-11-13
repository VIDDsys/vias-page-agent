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
const internalToolText = '<｜DSML｜function_calls><｜DSML｜invoke name="vias_read"><｜DSML｜parameter name="image_ids">[4]</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>';
const normalJson = '配置示例：\n```json\n{"name":"demo","enabled":true}\n```';
const normalCode = '源代码示例：\n```js\nfunction greet(name) { return `Hello, ${name}`; }\n```';
const cachedUser = `请解释这段工具语法，保留我的原文：${internalToolText}`;
const cachedHistory = [
  { role: 'user', content: cachedUser },
  { role: 'assistant', content: internalToolText },
  { role: 'assistant', content: normalJson },
  { role: 'assistant', content: normalCode },
];
const errors = [];
const missing = [];

async function checkModelFormLifecycle(context, optionsUrl) {
  const page = await context.newPage();
  const other = await context.newPage();
  try {
    await Promise.all([page.goto(optionsUrl), other.goto(optionsUrl)]);
    await Promise.all([page.waitForFunction(() => models.length === 2), other.waitForFunction(() => models.length === 2)]);
    await page.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__formHolds = [];
      window.__formRequests = [];
      window.__formReadsPending = 0;
      chrome.runtime.sendMessage = (message, callback) => {
        const index = window.__formHolds.findIndex((plan) => plan.type === message.type && (!plan.operation || plan.operation === message.operation));
        if (index < 0) {
          window.__formReadsPending += 1;
          return original(message, (response) => {
            callback(response);
            window.__formReadsPending -= 1;
          });
        }
        const [plan] = window.__formHolds.splice(index, 1);
        const request = { message, ready: false, done: false };
        window.__formRequests.push(request);
        const complete = (response) => { callback(response); request.done = true; };
        if (plan.mode === 'response') {
          return original(message, (response) => {
            request.release = () => complete(response);
            request.ready = true;
          });
        }
        request.release = () => plan.mode === 'failure'
          ? complete({ ok: false, error: plan.error }) : original(message, complete);
        request.ready = true;
      };
    });
    const hold = (mode, type = 'UPDATE_SETTINGS') => page.evaluate(({ mode, type, secret }) => {
      const index = window.__formRequests.length;
      window.__formHolds.push({ type, operation: type === 'UPDATE_SETTINGS' ? 'upsertModel' : undefined, mode, error: `synthetic save failure ${secret}` });
      return index;
    }, { mode, type, secret });
    const ready = (index) => page.waitForFunction((index) => window.__formRequests[index]?.ready, index);
    const release = async (index) => {
      await page.evaluate((index) => window.__formRequests[index].release(), index);
      await page.waitForFunction((index) => window.__formRequests[index].done && window.__formReadsPending === 0, index);
    };
    const edit = (id, target = page) => target.locator('#modelList .card').filter({ has: target.locator(`[data-test-model-id="${id}"]`) }).getByRole('button', { name: '编辑', exact: true }).click();
    const snapshot = () => page.evaluate(() => ({
      visible: document.querySelector('#formWrap').classList.contains('show'),
      id: editingId, revision: formRevision, version: formEditVersion, keyTouched: apiKeyTouched,
      fields: ['fName', 'fBase', 'fKey', 'fModel'].map((id) => document.getElementById(id).value),
      vision: document.querySelector('#fVision').checked,
      status: document.querySelector('#formStatus').textContent,
      statusClass: document.querySelector('#formStatus').className,
      disabled: document.querySelector('#btnSave').disabled,
      prompt: document.querySelector('#systemPrompt').value,
      promptStatus: document.querySelector('#promptStatus').textContent,
      promptDirty, promptRevision,
    }));
    const assertPrivate = async () => {
      assert.equal(await page.evaluate((secret) => document.body.innerText.includes(secret), secret), false);
      assert.equal(await page.locator(`[title*="${secret}"]`).count(), 0);
    };
    const changePromptElsewhere = async (text) => {
      await other.locator('#systemPrompt').fill(text);
      await other.locator('#btnSavePrompt').click();
      await other.waitForFunction(() => !promptSaving && !promptDirty);
      const revision = await other.evaluate(() => settingsRevision);
      await page.waitForFunction((revision) => settingsRevision === revision, revision);
    };

    // The save acknowledgement must update the list before slower storage/read callbacks.
    await page.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__settingsReadHold = true;
      window.__settingsReadResponses = [];
      chrome.runtime.sendMessage = (message, callback) => original(message, (response) => {
        if (message.type === 'GET_SETTINGS' && window.__settingsReadHold) {
          window.__settingsReadResponses.push(() => callback(response));
        } else callback(response);
      });
    });
    await edit('a');
    await page.locator('#fName').fill('A 快速保存后的名称');
    await page.locator('#btnSave').click();
    await page.locator('#formWrap').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.__settingsReadResponses.length > 0);
    await edit('a');
    assert.equal(await page.locator('#fName').inputValue(), 'A 快速保存后的名称', '新 revision 的列表必须是同一次保存返回的新数据');
    await page.locator('#btnSave').click();
    await page.locator('#formWrap').waitFor({ state: 'hidden' });
    await page.evaluate(() => {
      window.__settingsReadHold = false;
      for (const release of window.__settingsReadResponses.splice(0)) release();
    });
    await page.waitForFunction(() => window.__formReadsPending === 0);
    assert.equal(await page.evaluate(async () => (await chrome.storage.local.get('models')).models.find((model) => model.id === 'a').name), 'A 快速保存后的名称', '立即重开保存不得回写旧列表中的模型名称');

    // A stale activation acknowledgement must not revert a newer selection from another window.
    const oldActivation = await page.evaluate(() => {
      const index = window.__formRequests.length;
      window.__formHolds.push({ type: 'UPDATE_SETTINGS', operation: 'setActive', mode: 'response' });
      return index;
    });
    await page.locator('#modelList .card').filter({ has: page.locator('[data-test-model-id="b"]') }).getByRole('button', { name: '使用', exact: true }).click();
    await ready(oldActivation);
    const newerSelection = await other.evaluate(() => chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', operation: 'setActive', id: 'a' }));
    assert.equal(newerSelection.ok, true);
    await page.waitForFunction((revision) => settingsRevision === revision && activeModelId === 'a', newerSelection.settingsRevision);
    await release(oldActivation);
    assert.equal(await page.evaluate(() => activeModelId), 'a', '旧切换回包不得覆盖较新的模型选择');
    console.log('PASS settings acknowledgements: atomic model/revision snapshots, immediate reopen/save, stale activation isolation');

    // A real save can finish after the user has switched to an unrelated, unsaved B draft.
    await edit('a');
    await page.locator('#fName').fill('A 已提交的名称');
    const success = await hold('response');
    await page.locator('#btnSave').click();
    await ready(success);
    await page.waitForFunction(() => models.find((model) => model.id === 'a')?.name === 'A 已提交的名称');
    await edit('b');
    await page.locator('#fName').fill('B 未保存的名称');
    await page.locator('#fModel').fill('b-unsaved-model');
    await page.locator('#fKey').fill(secret);
    await page.locator('#fVision').check();
    const bDraft = await snapshot();
    await release(success);
    assert.deepEqual(await snapshot(), bDraft, 'A 的迟到成功不得关闭或修改 B 草稿');
    assert.equal(await page.evaluate(() => models.find((model) => model.id === 'b').name), '测试模型 B');
    await assertPrivate();
    await page.bringToFront();
    await page.locator('#formWrap').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(artifacts, 'options-form-session-1280.png') });
    await page.setViewportSize({ width: 390, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(artifacts, 'options-form-session-390.png') });
    await page.setViewportSize({ width: 1280, height: 900 });

    // Release A only after B opened at the old revision and another settings window changed it.
    await edit('a');
    const conflict = await hold('request');
    await page.locator('#btnSave').click();
    await ready(conflict);
    await edit('b');
    await page.locator('#fName').fill('B 冲突前的本地草稿');
    await page.locator('#fKey').fill(secret);
    await changePromptElsewhere('其他窗口推进 revision，不能替 B 偷偷 rebase');
    const beforeConflict = await snapshot();
    await release(conflict);
    assert.deepEqual(await snapshot(), beforeConflict, 'A 的迟到冲突不得重置 B 的 revision、dirty、Key 或状态');
    await page.locator('#btnSave').click();
    await page.waitForFunction(() => !document.querySelector('#btnSave').disabled);
    assert.match(await page.locator('#formStatus').textContent(), /表单内容已保留/);
    assert.equal(await page.evaluate(() => models.find((model) => model.id === 'b').name), '测试模型 B', 'B 必须仍命中冲突，不能静默覆盖');
    await page.locator('#btnSave').click();
    await page.locator('#formWrap').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => models.find((model) => model.id === 'b')?.name === 'B 冲突前的本地草稿');

    // B may itself be saving: the old A catch/finally cannot overwrite its progress or enable it.
    await edit('a');
    const failure = await hold('failure');
    await page.locator('#btnSave').click();
    await ready(failure);
    await edit('b');
    await page.locator('#fName').fill('B 自己正在保存');
    const bSaving = await hold('request');
    await page.locator('#btnSave').click();
    await ready(bSaving);
    const beforeFailure = await snapshot();
    assert.equal(beforeFailure.disabled, true);
    await release(failure);
    assert.deepEqual(await snapshot(), beforeFailure, 'A 的迟到失败/finally 不得写入或解锁正在保存的 B');
    await assertPrivate();
    await release(bSaving);
    await page.locator('#formWrap').waitFor({ state: 'hidden' });

    // An acknowledgement clears only the submitted version, including Key and checkbox edits.
    await edit('a');
    await page.locator('#fName').fill('A 保存请求中的版本');
    const sameForm = await hold('response');
    await page.locator('#btnSave').click();
    await ready(sameForm);
    await page.locator('#fName').fill('A 请求发出后继续编辑');
    await page.locator('#fKey').fill(secret);
    await page.locator('#fVision').check();
    await release(sameForm);
    assert.equal(await page.locator('#formWrap').isVisible(), true);
    assert.equal(await page.locator('#fName').inputValue(), 'A 请求发出后继续编辑');
    assert.equal(await page.locator('#fKey').inputValue(), secret);
    assert.equal(await page.locator('#fVision').isChecked(), true);
    assert.match(await page.locator('#formStatus').textContent(), /仍有未保存的新修改/);
    assert.equal(await page.locator('#btnSave').isEnabled(), true);
    assert.equal(await page.evaluate(() => models.find((model) => model.id === 'a').name), 'A 保存请求中的版本');
    await page.locator('#btnSave').click();
    await page.locator('#formWrap').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => models.find((model) => model.id === 'a')?.name === 'A 请求发出后继续编辑');

    // Cancel -> Add starts a new session; a new model edited during save must retain its saved ID.
    await edit('a');
    const cancelledSave = await hold('response');
    await page.locator('#btnSave').click();
    await ready(cancelledSave);
    await page.waitForFunction(() => formRevision < settingsRevision);
    await page.locator('#btnCancel').click();
    await page.locator('#btnAdd').click();
    await page.locator('#fName').fill('新增模型的提交版本');
    await page.locator('#fBase').fill('https://example.invalid/v1');
    await page.locator('#fModel').fill('new-synthetic-model');
    await page.locator('#fKey').fill(secret);
    const adding = await hold('response');
    await page.locator('#btnSave').click();
    await ready(adding);
    await page.locator('#fName').fill('新增模型保存中继续输入');
    const addingDraft = await snapshot();
    await release(cancelledSave);
    assert.deepEqual(await snapshot(), addingDraft, '取消后添加的新表单不受旧成功/finally 影响');
    await release(adding);
    assert.equal(await page.locator('#formWrap').isVisible(), true);
    const newId = await page.evaluate(() => editingId);
    assert.ok(newId && !['a', 'b'].includes(newId));
    await page.locator('#btnSave').click();
    await page.locator('#formWrap').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => models.length === 3 && models.some((model) => model.name === '新增模型保存中继续输入'));
    assert.equal(await page.evaluate((id) => models.filter((model) => model.id === id).length, newId), 1);

    // Same-ID close/reopen must reject the first session's key, even before this key was touched.
    const oldKey = await hold('response', 'RESOLVE_MODEL');
    await edit('a');
    await ready(oldKey);
    await page.locator('#btnCancel').click();
    await other.waitForFunction(() => models.find((model) => model.id === 'a')?.hasApiKey);
    await edit('a', other);
    await other.locator('#fKey').fill('synthetic-reopened-key');
    await other.locator('#btnSave').click();
    await other.locator('#formWrap').waitFor({ state: 'hidden' });
    const changedRevision = await other.evaluate(() => settingsRevision);
    await page.waitForFunction((revision) => settingsRevision === revision, changedRevision);
    const newKey = await hold('response', 'RESOLVE_MODEL');
    await edit('a');
    await ready(newKey);
    const reopened = await snapshot();
    await release(oldKey);
    assert.deepEqual(await snapshot(), reopened, '同 A 重开后也不能接受上次 RESOLVE_MODEL 的密钥');
    assert.equal(await page.locator('#fKey').inputValue(), '');
    await release(newKey);
    assert.equal(await page.locator('#fKey').inputValue(), 'synthetic-reopened-key');
    assert.equal(await page.locator('#fKey').getAttribute('type'), 'password');
    await page.locator('#fName').fill('不动密钥仍保留');
    await page.locator('#btnSave').click();
    await page.locator('#formWrap').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(async () => (await chrome.storage.local.get('models')).models.find((model) => model.id === 'a').apiKey === 'synthetic-reopened-key'), true);
    await edit('a');
    await page.waitForFunction(() => document.querySelector('#fKey').value !== '');
    await page.locator('#fKey').fill('');
    await page.locator('#btnSave').click();
    await page.locator('#formWrap').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => models.find((model) => model.id === 'a')?.hasApiKey === false);

    // An externally deleted model cannot be reconstructed with an untouched/empty key.
    await edit(newId);
    await page.waitForFunction(() => document.querySelector('#fKey').value !== '');
    await other.waitForFunction((id) => models.some((model) => model.id === id), newId);
    other.once('dialog', (dialog) => dialog.accept());
    await other.locator('#modelList .card').filter({ has: other.locator(`[data-test-model-id="${newId}"]`) }).getByRole('button', { name: '删除', exact: true }).click();
    await page.waitForFunction((id) => !models.some((model) => model.id === id), newId);
    await page.locator('#btnSave').click();
    await page.waitForFunction(() => !document.querySelector('#btnSave').disabled);
    assert.match(await page.locator('#formStatus').textContent(), /已在其他窗口被删除/);
    assert.equal(await page.evaluate((id) => models.some((model) => model.id === id), newId), false);
    await page.locator('#btnCancel').click();
    await page.locator('#systemPrompt').fill('独立提示词草稿不受迟到模型错误影响');
    const promptBefore = await page.locator('#promptStatus').textContent();
    await edit('a');
    const closedFailure = await hold('failure');
    await page.locator('#btnSave').click();
    await ready(closedFailure);
    await page.locator('#btnCancel').click();
    await release(closedFailure);
    assert.equal(await page.locator('#promptStatus').textContent(), promptBefore);
    assert.equal(await page.evaluate(() => promptDirty), true);
    await changePromptElsewhere('独立提示词冲突基线');
    await page.locator('#promptConflict').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#systemPrompt').inputValue(), '独立提示词草稿不受迟到模型错误影响');
    assert.equal(await page.locator('#latestPrompt').inputValue(), '独立提示词冲突基线');
    await assertPrivate();
    console.log('PASS model form sessions: late success/conflict/failure, save token, continued edits, cancel/add, reopened key, keep/clear/delete contracts, independent prompt draft');
  } finally {
    await Promise.all([page.close(), other.close()]);
  }
}

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
      page.on('console', (message) => {
        const expectedAuthFailure = message.location().url.startsWith('http://127.0.0.1:') && message.text().includes('401');
        if (message.type() === 'error' && !expectedAuthFailure) errors.push(message.text());
      });
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
    await checkModelFormLifecycle(context, `chrome-extension://${id}/options.html`);
    await options.waitForFunction(() => models.length === 2);

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

    await options.evaluate(async (cachedHistory) => {
      const { id } = await chrome.windows.getCurrent();
      await chrome.storage.session.set({ [`chat:${id}`]: cachedHistory });
    }, cachedHistory);
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 320, height: 850 });
    await panel.emulateMedia({ colorScheme: 'dark' });
    await panel.goto(`chrome-extension://${id}/sidepanel.html`);
    await panel.waitForFunction(() => initialized);
    const geometry = await panel.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      buttons: [...document.querySelectorAll('#chips .chip')].map((el) => ({ text: el.textContent, ...el.getBoundingClientRect().toJSON() })),
      header: [...document.querySelectorAll('header button')].map((el) => ({ text: el.textContent, ...el.getBoundingClientRect().toJSON() })),
      context: [...document.querySelectorAll('.context-bar button')].map((el) => ({ text: el.textContent, ...el.getBoundingClientRect().toJSON() })),
    }));
    assert.equal(geometry.overflow, false);
    assert.equal(geometry.buttons.length, 4);
    assert.equal(geometry.context.length, 3, '模型和工作模式在顶部保留独立入口');
    assert.ok(geometry.buttons.every((r) => r.left >= 16 && r.right <= 304 && r.height >= 44), JSON.stringify(geometry));
    assert.ok(geometry.header.every((r) => r.left >= 16 && r.right <= 304 && r.height >= 44), JSON.stringify(geometry));
    assert.ok(geometry.context.every((r) => r.left >= 16 && r.right <= 304 && r.height >= 44), JSON.stringify(geometry));
    // Old cached assistant protocol is discarded before rendering, persistence, or RUN history.
    const safeCachedHistory = cachedHistory.filter((item) => item.content !== internalToolText);
    assert.deepEqual(await panel.evaluate(() => history), safeCachedHistory);
    assert.equal(await panel.locator('.msg.user').textContent(), cachedUser, '用户协议示例必须原样保留');
    assert.equal(await panel.locator('.msg.ai').count(), 2);
    assert.match(await panel.locator('.msg.ai').nth(0).innerText(), /"name":"demo"/);
    assert.match(await panel.locator('.msg.ai').nth(1).innerText(), /function greet/);
    assert.equal(await panel.evaluate((text) => addMessage('ai', text) === null, internalToolText), true, '直接 AI 渲染入口也应拦截内部语法');
    assert.deepEqual(await panel.evaluate(async () => (await chrome.storage.session.get(sessionKey))[sessionKey]), safeCachedHistory);
    assert.deepEqual(await panel.evaluate((text) => boundedHistory([
      { role: 'assistant', content: 'x'.repeat(21000) + text },
      { role: 'user', content: text },
    ]), internalToolText), [{ role: 'user', content: internalToolText }], '须在截断之前检测完整 assistant 内容');

    // Isolated ports let results arrive out of order without involving real pages or model calls.
    await panel.evaluate(() => {
      chrome.tabs.query = async () => [{ id: 42, url: 'http://127.0.0.1/test' }];
      window.__feedbackPorts = [];
      chrome.runtime.connect = () => {
        const listeners = [];
        const disconnectListeners = [];
        const port = {
          sent: [], runId: '',
          onMessage: { addListener: (fn) => listeners.push(fn) },
          onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
          disconnect() {},
          drop() { for (const fn of disconnectListeners) fn(); },
          deliver(message) { for (const fn of listeners) fn({ runId: port.runId, ...message }); },
          postMessage(message) { port.sent.push(message); if (message.t === 'RUN') port.runId = message.runId; },
        };
        window.__feedbackPorts.push(port);
        return port;
      };
    });
    const startRun = async (question) => {
      await panel.locator('#input').fill(question);
      await panel.locator('#send').click();
      await panel.waitForFunction(() => activeRun && window.__feedbackPorts.at(-1)?.sent.some((message) => message.t === 'RUN'));
    };
    const deliver = (messages) => panel.evaluate((messages) => {
      for (const message of messages) window.__feedbackPorts.at(-1).deliver(message);
    }, messages);
    await startRun('验证缓存过滤');
    assert.deepEqual(await panel.evaluate(() => window.__feedbackPorts.at(-1).sent.find((message) => message.t === 'RUN').history), safeCachedHistory);
    assert.equal(await panel.evaluate(() => window.__feedbackPorts.at(-1).sent.find((message) => message.t === 'RUN').maxSteps), 100);
    assert.equal(await panel.locator('#send').textContent(), '停止');
    await deliver([{ t: 'status', text: '第 72 轮：模型分析中…' }]);
    assert.equal(await panel.locator('#status').textContent(), '模型分析中…');
    assert.doesNotMatch(await panel.locator('body').innerText(), /第\s*\d+\s*轮/u);
    await deliver([{ t: 'status', text: '已达到最大轮数 100' }]);
    assert.equal(await panel.locator('#status').textContent(), '任务已达到执行上限');
    await deliver([{ t: 'done', outcome: 'limit' }]);
    assert.match(await panel.locator('.msg.sys').last().textContent(), /达到执行上限/u);
    assert.equal(await panel.locator('#send').textContent(), '发送');
    await panel.locator('#clear').click();
    await panel.locator('.msg.sys').filter({ hasText: '已新建对话' }).waitFor();

    await startRun('测试图片与页面操作的实际顺序');
    await deliver([
      { t: 'say', text: '先读取图片' },
      { t: 'say', text: internalToolText },
      { t: 'actions', operationId: 'image-a', round: 1, title: '图片分析', actions: [{ action: 'image analyze', detail: '图片 #4 · 对照电路图中的连接', snapshotId: 'synthetic-snapshot-private', source: `data:image/png;base64,${secret}` }] },
      { t: 'say', text: '再读取另一张图片' },
      { t: 'actions', operationId: 'image-b', round: 1, title: '图片分析', actions: [{ action: 'image analyze', detail: '图片 #5 · 核对图中标签' }] },
      { t: 'say', text: internalToolText },
      { t: 'say', text: '开始点击并填写' },
      { t: 'actions', operationId: 'page-a', round: 1, actions: [{ action: 'click', ref: 1 }, { action: 'fill', ref: 2, value: '测试输入' }] },
      { t: 'actions', operationId: 'page-read', round: 1, title: '页面读取', actions: [{ action: 'read', detail: '第 2 段 · 继续读取题目' }] },
      { t: 'say', text: '等待结果' },
      { t: 'actions', round: 1, actions: [{ action: 'click', ref: 9 }] },
      { t: 'result', operationId: 'unknown-operation', round: 1, index: 0, ok: true, state: '不得误配旧操作' },
    ]);
    assert.equal(await panel.locator('.tools').count(), 5);
    assert.equal(await panel.locator('.tool.pending').count(), 6, '未知 operationId 不能误配同轮 legacy 操作');
    assert.equal(await panel.evaluate(() => !!activeRun && !activeRun.finished), true, '被挡 say 不应结束仍在修复的任务');
    assert.deepEqual(await panel.evaluate(() => [...document.querySelectorAll('#chat > .msg.ai, #chat > .tools')].map((el) =>
      el.classList.contains('tools') ? `tools:${[...el.querySelectorAll('.tool-name')].map((name) => name.textContent).join('|')}` : `say:${el.textContent.trim()}`)), [
      'say:先读取图片', 'tools:image analyze', 'say:再读取另一张图片', 'tools:image analyze',
      'say:开始点击并填写', 'tools:click|fill', 'tools:read', 'say:等待结果', 'tools:click',
    ]);
    await panel.evaluate(() => { window.__timelineNodes = [...document.querySelector('#chat').children]; });
    await deliver([
      { t: 'result', operationId: 'image-b', round: 1, index: 0, ok: false, code: 'VISION_DISABLED', msg: secret },
      { t: 'say', text: '第二张图片未能读取' },
      { t: 'result', operationId: 'page-a', round: 99, index: 1, ok: true, state: '当前值=测试输入', msg: secret },
      { t: 'result', operationId: 'image-a', round: 1, index: 0, ok: true, state: '已读取', msg: internalToolText },
      { t: 'result', operationId: 'page-read', round: 1, index: 0, ok: false, code: 'READ_FAILED', msg: `${internalToolText}${secret}` },
      { t: 'result', operationId: 'page-a', round: 1, index: 0, ok: false, code: 'TARGET_NOT_FOUND', msg: secret },
      { t: 'result', round: 1, index: 0, ok: true, state: '完成' },
      { t: 'result', operationId: 'image-a', round: 1, index: 0, ok: false, code: 'STALE_IMAGE', msg: secret },
      { t: 'actions', operationId: 'image-a', round: 1, actions: [{ action: 'click', ref: 99 }] },
      { t: 'say', text: internalToolText },
    ]);
    assert.equal(await panel.evaluate(() => window.__timelineNodes.every((el, index) => document.querySelector('#chat').children[index] === el)), true, '结果不得重新插入或移动旧块');
    assert.equal((await panel.locator('#chat > .msg.ai').last().textContent()).trim(), '第二张图片未能读取');
    assert.equal(await panel.locator('.tools').count(), 5, '同 operationId 重发不应追加或覆盖旧块');
    assert.deepEqual(await panel.locator('.tools').nth(0).locator('.tool-state').allTextContents(), ['已读取']);
    assert.equal(await panel.locator('.tools').nth(0).locator('.tool.ok').count(), 1);
    assert.match(await panel.locator('.tools').nth(1).locator('.tool-reason').innerText(), /未启用图片能力/);
    assert.deepEqual(await panel.locator('.tools').nth(2).locator('.tool-state').allTextContents(), ['失败', '测试输入']);
    assert.match(await panel.locator('.tools').nth(3).locator('.tool-reason').innerText(), /读取未完成/);
    assert.deepEqual(await panel.locator('.tools').nth(4).locator('.tool-state').allTextContents(), ['完成']);
    assert.equal(await panel.locator('.tool.pending').count(), 0);
    assert.equal(await panel.locator('.tools').nth(0).locator('.tools-head').textContent(), '图片分析');
    assert.equal(await panel.locator('.tools').nth(3).locator('.tools-head').textContent(), '页面读取');
    assert.doesNotMatch(await panel.locator('.tools').allTextContents().then((items) => items.join('\n')), /第\s*\d+\s*轮/u);
    assert.equal((await panel.locator('body').innerText()).includes(secret), false);
    assert.equal((await panel.locator('body').innerText()).includes('synthetic-snapshot-private'), false);
    assert.equal((await panel.locator('#chat').innerText()).includes('DSML'), false);
    assert.equal(await panel.locator(`[title*="${secret}"]`).count(), 0);
    await panel.evaluate(async () => { await persistQueue; });
    assert.equal(await panel.evaluate(() => history.some((item) => item.content.includes('DSML'))), false);
    assert.equal(await panel.evaluate(async () => JSON.stringify((await chrome.storage.session.get(sessionKey))[sessionKey]).includes('DSML')), false);
    await deliver([{ t: 'done' }]);
    await panel.locator('#chat').evaluate((el) => { el.scrollTop = 0; });
    await panel.screenshot({ path: path.join(artifacts, 'panel-320-dark-error.png') });
    await panel.setViewportSize({ width: 390, height: 850 });
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
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
    await panel.setViewportSize({ width: 1280, height: 900 });
    await panel.screenshot({ path: path.join(artifacts, 'panel-1280-dark-timeline.png') });

    // The next task must see the previous task's last actions and failures, even after the run stopped.
    await startRun('验证执行记录同步');
    await deliver([
      { t: 'actions', operationId: 'journal-op', round: 1, actions: [{ action: 'click', ref: 1, detail: '@1 提交按钮' }] },
      { t: 'result', operationId: 'journal-op', round: 1, index: 0, ok: false, code: 'TARGET_NOT_FOUND' },
      { t: 'done', outcome: 'unverified' },
    ]);
    assert.match(await panel.locator('.msg.sys').last().textContent(), /未获成功确认/);
    await startRun('继续处理页面');
    const priorRun = await panel.evaluate(() => window.__feedbackPorts.at(-1).sent.find((message) => message.t === 'RUN').priorRun);
    assert.match(priorRun, /上一任务/);
    assert.match(priorRun, /click/);
    assert.match(priorRun, /找不到目标/);
    await deliver([{ t: 'done' }]);
    await startRun('验证中断原因同步');
    await deliver([{ t: 'done', outcome: 'interrupted', error: '后台连接中断，任务已停止' }]);
    await startRun('再次继续处理');
    const interruptedJournal = await panel.evaluate(() => window.__feedbackPorts.at(-1).sent.find((message) => message.t === 'RUN').priorRun);
    assert.match(interruptedJournal, /停止原因：后台连接中断/);
    await deliver([{ t: 'done' }]);
    await panel.locator('#clear').click();
    await panel.locator('.msg.sys').filter({ hasText: '已新建对话' }).waitFor();
    assert.equal(await panel.evaluate(() => lastRunJournal), '', '新建对话必须清空上一任务记录');

    await panel.locator('#input').fill('验证 Enter 发送');
    await panel.locator('#input').press('Enter');
    await panel.waitForFunction(() => activeRun && window.__feedbackPorts.at(-1)?.sent.some((message) => message.t === 'RUN' && message.question === '验证 Enter 发送'));
    assert.equal(await panel.locator('.composer-hint').count(), 0, '输入区不再显示换行提示');
    await deliver([{ t: 'done' }]);

    // Every image failure uses a fixed, useful reason instead of an untrusted backend message.
    const imageFailures = [
      ['VISION_DISABLED', /未启用图片能力/], ['INVALID_IMAGE', /图片编号无效/],
      ['IMAGE_UNREADABLE', /无法读取这张图片/], ['STALE_IMAGE', /图片已变化/],
      ['ENCODED_LIMIT', /编码后的大小超出限制/], ['DOWNLOAD_LIMIT', /下载大小超出限制/],
      ['PIXEL_LIMIT', /分辨率超出限制/], ['UNSUPPORTED_IMAGE', /不支持这种图片格式/],
      ['TIMEOUT', /读取超时/], ['IMAGE_REASON_REQUIRED', /缺少原因/],
      ['IMAGE_ALREADY_READ', /已读取，无需重复/], ['READ_FAILED', /读取未完成/],
      ['ACTION_COMMUNICATION_FAILED', /页面通信失败/], ['INTERRUPTED', /操作已中断/],
      ['CANCELLED', /操作已取消/], ['UNKNOWN_IMAGE_FAILURE', /操作未完成/],
    ];
    await startRun('验证图片失败文案及有界文本');
    const priorBlocks = await panel.locator('.tools').count();
    await deliver(imageFailures.flatMap(([code]) => [
      { t: 'actions', operationId: `failure-${code}`, round: 2, title: '图片分析', actions: [{ action: 'image analyze', detail: '图片 #4 · 核对题目' }] },
      { t: 'result', operationId: `failure-${code}`, round: 2, index: 0, ok: false, code, msg: `${secret}${internalToolText}` },
    ]));
    for (const [index, [code, reason]] of imageFailures.entries()) {
      assert.match(await panel.locator('.tools').nth(priorBlocks + index).locator('.tool-reason').textContent(), reason, code);
    }
    const boundedDetail = `图片 #6 · <b>图例</b> ${'核对标签'.repeat(100)}`;
    await deliver([
      { t: 'actions', operationId: 'bounded-detail', round: 2, title: '图片分析', actions: [{ action: 'image analyze', detail: boundedDetail, source: secret, snapshotId: secret }] },
      { t: 'result', operationId: 'bounded-detail', round: 2, index: 0, ok: true, state: '已读取' },
      { t: 'actions', operationId: 'internal-detail', round: 2, actions: [{ action: 'read', detail: internalToolText }] },
      { t: 'result', operationId: 'internal-detail', round: 2, index: 0, ok: true, state: '已读取' },
      { t: 'say', text: normalJson }, { t: 'say', text: normalCode }, { t: 'done' },
    ]);
    const boundedBlock = panel.locator('.tools').nth(priorBlocks + imageFailures.length);
    assert.equal(await boundedBlock.locator('.tool-detail').textContent(), boundedDetail.slice(0, 320));
    assert.equal(await boundedBlock.locator('.tool-detail > *').count(), 0, 'detail 中的 HTML 必须只作为文本');
    assert.equal(await panel.locator('.tools').last().locator('.tool-detail').textContent(), '');
    assert.equal((await panel.locator('body').innerText()).includes(secret), false);
    assert.equal((await panel.locator('#chat').innerText()).includes('DSML'), false);
    assert.deepEqual(await panel.evaluate(() => history.slice(-2)), [
      { role: 'assistant', content: normalJson }, { role: 'assistant', content: normalCode },
    ], '普通 JSON 和源代码回答继续保留');

    await startRun('验证键盘操作失败文案');
    await deliver([
      { t: 'actions', operationId: 'key-failures', round: 3, actions: [{ action: 'press', key: 'Tab' }, { action: 'press', key: 'Enter' }] },
      { t: 'result', operationId: 'key-failures', round: 3, index: 0, ok: false, code: 'UNSUPPORTED_KEY', msg: secret },
      { t: 'result', operationId: 'key-failures', round: 3, index: 1, ok: false, code: 'NO_EFFECT', msg: secret },
      { t: 'done', outcome: 'unverified' },
    ]);
    assert.match(await panel.locator('.tools').last().locator('.tool-reason').nth(0).textContent(), /无法可靠模拟该按键.*点击或填写/);
    assert.match(await panel.locator('.tools').last().locator('.tool-reason').nth(1).textContent(), /按键未生效.*重新读取页面/);
    assert.equal((await panel.locator('body').innerText()).includes(secret), false);

    await startRun('停止仍在读取的图片');
    await deliver([
      { t: 'actions', operationId: 'stop-image', round: 3, title: '图片分析', actions: [{ action: 'image analyze', detail: '图片 #4 · 读取中' }, { action: 'click', ref: 7 }] },
      { t: 'result', operationId: 'stop-image', round: 3, index: 1, ok: true, state: '完成' },
    ]);
    assert.equal(await panel.locator('.tool.pending').count(), 1);
    await panel.locator('#send').click();
    assert.equal(await panel.locator('.tool.pending').count(), 0, '停止请求发出后无需等后台确认便应结算 pending');
    assert.deepEqual(await panel.locator('.tools').last().locator('.tool-state').allTextContents(), ['已取消', '完成']);
    assert.match(await panel.locator('.tools').last().locator('.tool-reason').first().textContent(), /操作已取消/);
    const stoppedBlockCount = await panel.locator('.tools').count();
    await deliver([
      { t: 'result', operationId: 'stop-image', round: 3, index: 0, ok: true, state: '已读取' },
      { t: 'actions', operationId: 'too-late', round: 3, actions: [{ action: 'click', ref: 99 }] },
      { t: 'say', text: '停止后不应追加' }, { t: 'done', outcome: 'cancelled' },
    ]);
    assert.equal(await panel.locator('.tools').count(), stoppedBlockCount);
    assert.deepEqual(await panel.locator('.tools').last().locator('.tool-state').allTextContents(), ['已取消', '完成']);
    assert.equal(await panel.locator('.msg.ai').filter({ hasText: '停止后不应追加' }).count(), 0);

    for (const termination of ['completed', 'error', 'disconnect']) {
      await startRun(`验证 ${termination} 时 pending 结算`);
      await deliver([
        { t: 'actions', operationId: `pending-${termination}`, round: 4, title: '图片分析', actions: [{ action: 'image analyze', detail: '图片 #4 · 已完成' }, { action: 'image analyze', detail: '图片 #5 · 等待结果' }] },
        { t: 'result', operationId: `pending-${termination}`, round: 4, index: 0, ok: true, state: '已读取' },
      ]);
      if (termination === 'disconnect') await panel.evaluate(() => window.__feedbackPorts.at(-1).drop());
      else await deliver([termination === 'error' ? { t: 'error', message: `合成 API 错误：${internalToolText}${secret}` } : { t: 'done', outcome: 'completed' }]);
      if (termination === 'error') {
        assert.equal(await panel.locator('.msg.sys').last().textContent(), '任务出现异常，请稍后重试。');
        assert.equal((await panel.locator('#chat').innerText()).includes('DSML'), false, 'sys 错误不得泄漏内部协议');
        assert.equal((await panel.locator('#chat').innerText()).includes(secret), false, '被拦截的错误正文不得残留');
      }
      assert.equal(await panel.evaluate(() => activeRun), null);
      assert.equal(await panel.locator('.tool.pending').count(), 0, termination);
      assert.deepEqual(await panel.locator('.tools').last().locator('.tool-state').allTextContents(), ['已读取', '已中断'], termination);
      assert.match(await panel.locator('.tools').last().locator('.tool-reason').last().textContent(), /操作已中断/, termination);
    }

    await startRun('验证工具协议错误码与未确认终态');
    await panel.evaluate(() => {
      window.__originalPanelCore = globalThis.ViasCore;
      window.__syntheticModelCode = 'UNSUPPORTED_TOOL_PROTOCOL';
      globalThis.ViasCore = { ...globalThis.ViasCore, callModel: async () => {
        throw Object.assign(new Error('模型工具协议无法执行，请修正后重试'), { code: window.__syntheticModelCode });
      } };
    });
    await deliver([{ t: 'model_request', requestId: 'unsupported-tool', cfg: { name: '合成模型' }, messages: [] }]);
    await panel.waitForFunction(() => window.__feedbackPorts.at(-1).sent.some((message) => message.requestId === 'unsupported-tool'));
    const unsupportedResponse = await panel.evaluate(() => window.__feedbackPorts.at(-1).sent.find((message) => message.requestId === 'unsupported-tool'));
    assert.equal(unsupportedResponse.t, 'model_response');
    assert.equal(unsupportedResponse.code, 'UNSUPPORTED_TOOL_PROTOCOL');
    assert.equal(unsupportedResponse.error, '模型工具协议无法执行，请修正后重试');
    assert.equal(await panel.evaluate(() => !!activeRun && !activeRun.finished), true, '错误码须留给后台纠正，不能在侧栏结束任务');
    await panel.evaluate(() => { window.__syntheticModelCode = 'UNTRUSTED_ERROR_CODE'; });
    await deliver([{ t: 'model_request', requestId: 'untrusted-code', cfg: { name: '合成模型' }, messages: [] }]);
    await panel.waitForFunction(() => window.__feedbackPorts.at(-1).sent.some((message) => message.requestId === 'untrusted-code'));
    assert.equal(await panel.evaluate(() => Object.hasOwn(window.__feedbackPorts.at(-1).sent.find((message) => message.requestId === 'untrusted-code'), 'code')), false);
    await panel.evaluate(() => { globalThis.ViasCore = window.__originalPanelCore; });
    await deliver([
      { t: 'actions', operationId: 'unverified-image', round: 5, title: '图片分析', actions: [{ action: 'image analyze', detail: '图片 #4 · 仍需确认' }] },
      { t: 'result', operationId: 'unverified-image', round: 5, index: 0, ok: false, code: 'READ_FAILED' },
      { t: 'done', outcome: 'unverified' },
    ]);
    assert.equal((await panel.locator('.msg.sys').last().textContent()).trim(), '任务已结束，但仍有操作未获成功确认，请核对页面状态');
    assert.equal(await panel.locator('.tools').last().locator('.tool.fail').count(), 1);
    assert.equal(await panel.locator('.tool.pending').count(), 0);

    // Also cover migration from the older unscoped cache, without changing the stored message shape.
    await options.evaluate(async (cachedHistory) => {
      const { id } = await chrome.windows.getCurrent();
      await chrome.storage.session.remove(`chat:${id}`);
      await chrome.storage.session.set({ chat: cachedHistory });
    }, cachedHistory);
    const legacyPanel = await context.newPage();
    await legacyPanel.goto(`chrome-extension://${id}/sidepanel.html`);
    await legacyPanel.waitForFunction(() => initialized);
    assert.deepEqual(await legacyPanel.evaluate(() => history), safeCachedHistory);
    assert.equal(await legacyPanel.locator('.msg.user').textContent(), cachedUser);
    assert.equal(await legacyPanel.locator('.msg.ai').count(), 2);
    assert.deepEqual(await legacyPanel.evaluate(async () => (await chrome.storage.session.get(sessionKey))[sessionKey]), safeCachedHistory);
    assert.equal(await legacyPanel.evaluate(async () => Object.hasOwn(await chrome.storage.session.get('chat'), 'chat')), false);
    assert.deepEqual(errors, []);
    assert.deepEqual(missing, []);
    console.log('PASS model failures, immediate retry, redaction, operation timeline, internal protocol/cache filtering, fixed image reasons, pending cancellation/interruption, dark contrast, 320/390px layout');
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
