'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

function loadCore(fetchImpl = async () => {
  throw new Error('unexpected fetch');
}) {
  const sandbox = {
    AbortController,
    URL,
    clearTimeout,
    fetch: fetchImpl,
    setTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('core.js'), sandbox, { filename: 'core.js' });
  return sandbox.ViasCore;
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
  assert.equal(JSON.parse(request.options.body).apiKey, undefined);
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

test('侧边栏与设置页使用任务隔离、显式确认和集中设置写入', () => {
  const sidepanel = read('sidepanel.js');
  const options = read('options.js');
  const sidepanelHtml = read('sidepanel.html');
  const optionsHtml = read('options.html');

  assert.match(sidepanel, /runId:\s*crypto\.randomUUID\(\)/);
  assert.match(sidepanel, /message\.t === 'model_request'/);
  assert.match(sidepanel, /ViasCore\.callModel/);
  assert.match(sidepanel, /message\.t === 'approval'/);
  assert.match(sidepanel, /FORBID_TAGS:[\s\S]*'img'/);
  assert.match(sidepanel, /`chat:\$\{windowId\}`/);
  assert.match(options, /type:\s*'UPDATE_SETTINGS'/);
  assert.match(options, /expectedRevision(?:\s*=\s*settingsRevision|,)/);
  assert.match(options, /formRevision\s*=\s*settingsRevision/);
  assert.match(options, /ViasCore\.callModel/);
  assert.ok(sidepanelHtml.indexOf('core.js') < sidepanelHtml.indexOf('sidepanel.js'));
  assert.ok(optionsHtml.indexOf('core.js') < optionsHtml.indexOf('options.js'));
});

test('静态安全边界：密钥脱敏、敏感操作确认、无动态代码执行', () => {
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
