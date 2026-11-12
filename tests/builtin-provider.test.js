'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const core = fs.readFileSync(path.join(root, 'core.js'), 'utf8');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const builtinId = 'builtin-viddsys-api';
const plain = (value) => JSON.parse(JSON.stringify(value));

function boot(state) {
  const event = () => ({ addListener() {}, removeListener() {} });
  const context = vm.createContext({ URL, crypto: webcrypto, console, setTimeout, clearTimeout, setInterval, clearInterval,
    chrome: {
      sidePanel: { setPanelBehavior: async () => {} },
      storage: { local: {
        get: async (keys) => Array.isArray(keys)
          ? Object.fromEntries(keys.filter((key) => Object.hasOwn(state, key)).map((key) => [key, structuredClone(state[key])]))
          : { ...structuredClone(keys), ...structuredClone(state) },
        set: async (patch) => Object.assign(state, plain(patch)),
        remove: async (keys) => { for (const key of keys) delete state[key]; },
      } },
      runtime: { id: 'mock', getURL: (file) => `chrome-extension://mock/${file}`, onMessage: event(), onConnect: event() },
    },
  });
  context.importScripts = () => vm.runInContext(core, context);
  vm.runInContext(background, context);
  return context;
}

test('首次使用预置并选中VIDDsys API，所有字段是实际值且密钥为空', async () => {
  const state = {};
  const context = boot(state);
  const settings = await context.getState();
  assert.deepEqual(plain(settings.models), [{ id: builtinId, name: 'VIDDsys API', baseUrl: 'https://api.viddsys.xyz/v1', model: 'deepseek-v4.1-flash', apiKey: '', vision: false }]);
  assert.equal(settings.activeModelId, builtinId);
  assert.equal(state.builtinProviderInitialized, true);
  assert.equal(context.publicState(settings).models[0].hasApiKey, false);
  assert.equal(Object.hasOwn(context.publicState(settings).models[0], 'apiKey'), false);
});

test('已有提供商、密钥、当前选择与revision不被内置配置覆盖', async () => {
  const original = { id: 'custom', name: 'Custom', baseUrl: 'http://localhost:1234/v1', model: 'local', apiKey: 'memory-only-test', vision: true };
  const state = { models: [original], activeModelId: 'custom', settingsRevision: 7 };
  const context = boot(state);
  const settings = await context.getState();
  assert.deepEqual(plain(settings.models), [original]);
  assert.equal(settings.activeModelId, 'custom');
  assert.equal(settings.settingsRevision, 7);
  assert.equal(state.builtinProviderInitialized, true);
});

test('旧版单模型配置仍正常迁移且保留密钥，不替换为预置提供商', async () => {
  const state = { baseUrl: 'http://localhost:1234/v1', model: 'old-local', apiKey: 'legacy-memory-only' };
  const settings = await boot(state).getState();
  assert.equal(settings.models.length, 1);
  assert.equal(settings.models[0].id, 'migrated');
  assert.equal(settings.models[0].model, 'old-local');
  assert.equal(settings.models[0].apiKey, 'legacy-memory-only');
  assert.equal(settings.activeModelId, 'migrated');
  assert.equal(Object.hasOwn(state, 'apiKey'), false);
});

test('既有空列表只补一次并更新revision，后续启动不会重复新增', async () => {
  const state = { models: [], activeModelId: '', settingsRevision: 3 };
  await boot(state).getState();
  assert.equal(state.settingsRevision, 4);
  await boot(state).getState();
  assert.equal(state.models.length, 1);
  assert.equal(state.settingsRevision, 4);
});

test('只填写密钥即可保存使用，之后删除预置提供商不会在下次启动重建', async () => {
  const state = {};
  const context = boot(state);
  const settings = await context.getState();
  const saved = await context.updateSettings({ operation: 'upsertModel', expectedRevision: settings.settingsRevision,
    model: { ...plain(settings.models[0]), apiKey: 'new-memory-only' }, keepApiKey: false });
  assert.equal(saved.ok, true);
  assert.equal(saved.models[0].hasApiKey, true);
  assert.equal(saved.activeModelId, builtinId);
  const deleted = await context.updateSettings({ operation: 'deleteModel', id: builtinId, expectedRevision: saved.settingsRevision });
  assert.equal(deleted.ok, true);
  const restarted = await boot(state).getState();
  assert.equal(restarted.models.length, 0);
  assert.equal(restarted.activeModelId, '');
});

test('已有列表确认过初始化后手动清空也不会被重新添加', async () => {
  const state = { models: [], activeModelId: '', builtinProviderInitialized: true, settingsRevision: 9 };
  const settings = await boot(state).getState();
  assert.equal(settings.models.length, 0);
  assert.equal(settings.settingsRevision, 9);
});
