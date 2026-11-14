'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright-core');

const edgePath = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const script = path.join(__dirname, '..', 'content.js');
let browser;

test.before(async () => { browser = await chromium.launch({ executablePath: edgePath, headless: true }); });
test.after(async () => { await browser?.close(); });

async function setup(html) {
  const page = await browser.newPage();
  await page.setContent(html);
  await page.evaluate(() => {
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: { onMessage: { addListener(listener) { globalThis.listener = listener; } } } } });
  });
  await page.addScriptTag({ path: script });
  return page;
}

async function dispatch(page, message) {
  return page.evaluate((payload) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('消息超时')), 15000);
    globalThis.listener(payload, {}, (response) => { clearTimeout(timer); resolve(response); });
  }), message);
}

async function extract(page) {
  return dispatch(page, { type: 'EXTRACT', runId: 'sensitive-test', maxLen: 30000 });
}

async function execute(page, snapshot, actions, operationId) {
  return dispatch(page, { type: 'EXECUTE', runId: 'sensitive-test', snapshotId: snapshot.snapshotId, operationId, approved: true, actions });
}

function assertAbsent(response, secrets) {
  const output = JSON.stringify(response);
  for (const secret of secrets) assert.equal(output.includes(secret), false, `输出泄漏 ${secret}`);
}

test('字段名称和标签识别敏感值，快照和操作回显统一隐藏', { timeout: 30000 }, async () => {
  const page = await setup(`
    <label for="plain-pass">登录密码</label><input id="plain-pass" value="initial-secret-0">
    <input name="verification_code" value="initial-secret-1">
    <input placeholder="API Key" value="initial-secret-2">
    <span id="token-label">Access Token</span><input aria-labelledby="token-label" value="initial-secret-3">
    <label>安全码<textarea>initial-secret-4</textarea></label>
    <div role="button" aria-label="容器"><div contenteditable="true" aria-label="验证码">initial-secret-5</div></div>
    <select title="API key"><option value="initial-secret-6">initial-secret-7</option><option value="chosen-secret-6">chosen-secret-7</option></select>
    <label for="normal">Token count</label><input id="normal" value="visible-ordinary-value">
    <input name="keyboard" value="visible-keyboard-value">
  `);
  try {
    const snapshot = await extract(page);
    assertAbsent(snapshot, Array.from({ length: 8 }, (_, i) => `initial-secret-${i}`));
    assert.match(snapshot.text, /visible-ordinary-value/);
    assert.match(snapshot.text, /visible-keyboard-value/);
    const metas = Object.values(snapshot.targetMeta);
    assert.equal(metas.filter((meta) => meta.sensitive).length, 7);
    const actions = [
      { action: 'fill', selector: '#plain-pass', value: 'replacement-secret-0' },
      { action: 'type', selector: '[name=verification_code]', value: 'replacement-secret-1' },
      { action: 'fill', selector: '[placeholder="API Key"]', value: 'replacement-secret-2' },
      { action: 'fill', selector: '[aria-labelledby=token-label]', value: 'replacement-secret-3' },
      { action: 'fill', selector: 'textarea', value: 'replacement-secret-4' },
      { action: 'fill', selector: '[contenteditable]', value: 'replacement-secret-5' },
      { action: 'select', selector: 'select', value: 'chosen-secret-6' },
      { action: 'fill', selector: '#normal', value: 'visible-changed-value' },
    ];
    const response = await execute(page, snapshot, actions, 'sensitive-fill');
    assert.equal(response.results.length, actions.length);
    for (const result of response.results) assert.equal(result.ok, true, JSON.stringify(result));
    assertAbsent(response, ['replacement-secret-0', 'replacement-secret-1', 'replacement-secret-2', 'replacement-secret-3', 'replacement-secret-4', 'replacement-secret-5', 'chosen-secret-6', 'chosen-secret-7']);
    assert.match(JSON.stringify(response), /visible-changed-value/);
    assert.deepEqual(await page.locator('input,textarea,[contenteditable],select').evaluateAll((elements) => elements.map((el) => el.isContentEditable ? el.textContent : el.value)), [
      'replacement-secret-0', 'replacement-secret-1', 'replacement-secret-2', 'replacement-secret-3', 'replacement-secret-4', 'replacement-secret-5', 'chosen-secret-6', 'visible-changed-value', 'visible-keyboard-value',
    ]);
  } finally { await page.close(); }
});

test('关联名称中的敏感控件内容和 Shadow DOM 标签不泄漏', { timeout: 30000 }, async () => {
  const page = await setup(`
    <span id="shared">API Key <textarea aria-label="密码">nested-secret</textarea></span>
    <input aria-labelledby="shared" value="labelled-secret">
    <input aria-labelledby="missing-id" value="ordinary-value">
    <div id="host"></div>
  `);
  try {
    await page.evaluate(() => {
      const root = document.querySelector('#host').attachShadow({ mode: 'open' });
      root.innerHTML = '<span id="shadow-label">验证码</span><input aria-labelledby="shadow-label" value="shadow-secret">';
    });
    const snapshot = await extract(page);
    assertAbsent(snapshot, ['nested-secret', 'labelled-secret', 'shadow-secret']);
    assert.match(snapshot.text, /ordinary-value/);
    assert.equal(Object.values(snapshot.targetMeta).filter((meta) => meta.sensitive).length, 3);
  } finally { await page.close(); }
});

test('标识符分词识别常见凭据并避免普通字段误遮', { timeout: 30000 }, async () => {
  const page = await setup(`
    <input id="userPassword" value="secret-a">
    <input id="otp_code" value="secret-b">
    <input name="api_key" value="secret-c">
    <input aria-label="一次性密码" value="secret-d">
    <input aria-label="身份证号" value="secret-e">
    <input aria-label="银行卡号" value="secret-f">
    <input aria-label="CVV" value="secret-g">
    <input name="monkey" value="ordinary-a">
    <input name="token_count" value="ordinary-b">
    <input aria-label="Verification status" value="ordinary-c">
  `);
  try {
    const snapshot = await extract(page);
    assertAbsent(snapshot, ['secret-a', 'secret-b', 'secret-c', 'secret-d', 'secret-e', 'secret-f', 'secret-g']);
    for (const value of ['ordinary-a', 'ordinary-b', 'ordinary-c']) assert.match(snapshot.text, new RegExp(value));
    assert.equal(Object.values(snapshot.targetMeta).filter((meta) => meta.sensitive).length, 7);
  } finally { await page.close(); }
});

for (const role of ['textbox', 'combobox']) {
  test(`最终审查 敏感${role}宿主的Shadow内容不进入父级描述，普通Shadow仍可读`, { timeout: 30000 }, async () => {
    const page = await setup('<div role="button"><audit-secret></audit-secret><audit-public></audit-public></div>');
    try {
      await page.evaluate((role) => {
        const sensitive = document.querySelector('audit-secret');
        sensitive.setAttribute('role', role);
        sensitive.setAttribute('aria-label', '验证码');
        sensitive.attachShadow({ mode: 'open' }).innerHTML = '<span>SYNTHETIC_SHADOW_SECRET</span><div id="inner"></div>';
        sensitive.shadowRoot.querySelector('#inner').attachShadow({ mode: 'open' }).innerHTML = '<span>SYNTHETIC_NESTED_SECRET</span>';
        document.querySelector('audit-public').attachShadow({ mode: 'open' }).innerHTML = '<span>Public shadow text</span><button type="button">Public shadow action</button>';
      }, role);
      const snapshot = await extract(page);
      assertAbsent(snapshot, ['SYNTHETIC_SHADOW_SECRET', 'SYNTHETIC_NESTED_SECRET']);
      assert.match(snapshot.text, /Public shadow text/);
      assert.match(snapshot.text, /Public shadow action/);
      assert.equal(Object.values(snapshot.targetMeta).filter((meta) => meta.sensitive).length, 1);
      const parentRef = Object.entries(snapshot.targets).find(([, description]) => description.includes('按钮「Public shadow text'))?.[0];
      assert.ok(parentRef, '普通父级按钮及非敏感Shadow文字必须保留');
      const response = await execute(page, snapshot, [{ action: 'click', ref: Number(parentRef) }], `sensitive-shadow-parent-${role}`);
      assert.equal(response.results[0].ok, true, JSON.stringify(response));
      assertAbsent(response, ['SYNTHETIC_SHADOW_SECRET', 'SYNTHETIC_NESTED_SECRET']);
      assert.match(response.page.text, /Public shadow text/);
    } finally { await page.close(); }
  });
}

test('最终审查 多选状态完整化不回显敏感select的选项和值', { timeout: 30000 }, async () => {
  const page = await setup('<div role="button"><label>验证码<select autocomplete="one-time-code" multiple><option value="private-a" selected>Private option A</option><option value="private-b" selected>Private option B</option></select></label></div>');
  try {
    const snapshot = await extract(page);
    assertAbsent(snapshot, ['private-a', 'private-b', 'Private option A', 'Private option B']);
    const [ref] = Object.entries(snapshot.targetMeta).find(([, meta]) => meta.tag === 'select');
    const response = await execute(page, snapshot, [{ action: 'select', ref: Number(ref), value: ['private-b'] }], 'sensitive-multiple-state');
    assert.equal(response.results[0].code, 'SELECTED');
    assertAbsent(response, ['private-a', 'private-b', 'Private option A', 'Private option B']);
    assert.deepEqual(await page.locator('select').evaluate((el) => [...el.selectedOptions].map((option) => option.value)), ['private-b']);
  } finally { await page.close(); }
});
