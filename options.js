'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULT_SYSTEM_PROMPT = globalThis.ViasCore.DEFAULT_SYSTEM_PROMPT;
// 赞助者名单：固定格式 { name, avatar }。name 为用户提供的 id/显示名，头像放 sponsors/ 目录。
// 新增时只追加数组项并放入对应图片；npm test 会校验字段、文件名和图片是否存在。
const SPONSORS = [
  { name: '野生的神秘哈基米', avatar: 'sponsors/wild-mystery-hajimi.jpg' },
];
let models = [];
let activeModelId = '';
let editingId = null;
let settingsRevision = 0;
let formRevision = 0;
let formSession = 0;
let formEditVersion = 0;
let formSaveAttempt = null;
let apiKeyTouched = false;
let promptDirty = false;
let promptRevision = 0;
let promptBaseText = '';
let promptEditVersion = 0;
let promptSaving = false;
let latestPromptState = null;
const modelStatuses = new Map();
const testingModels = new Map();

// Settings revisions cover model credentials too, without exposing or retaining keys.
function advanceSettingsRevision(revision) {
  if (revision <= settingsRevision) return false;
  settingsRevision = revision;
  modelStatuses.clear();
  testingModels.clear();
  return true;
}

function applyModelState(state) {
  const revision = state.settingsRevision || 0;
  if (revision < settingsRevision) return false;
  // The displayed models and revision must always describe the same saved snapshot.
  models = Array.isArray(state.models) ? state.models : [];
  activeModelId = state.activeModelId || '';
  advanceSettingsRevision(revision);
  return true;
}

function modelStatus(id, message, ok = false) {
  if (message) modelStatuses.set(id, { message, ok });
  else modelStatuses.delete(id);
  const status = [...$('modelList').querySelectorAll('.model-status')].find((item) => item.dataset.modelId === id);
  if (status) {
    status.textContent = message;
    status.hidden = !message;
    status.className = `status model-status ${ok ? 'ok' : 'fail'}`;
  } else if (message) {
    $('modelListStatus').textContent = message;
    $('modelListStatus').hidden = false;
  }
  if (!message) {
    $('modelListStatus').textContent = '';
    $('modelListStatus').hidden = true;
  }
}

function modelOperationError(error, action) {
  if (error?.message === '设置已在其他窗口更新，列表已刷新，请重试') return error.message;
  if (error?.message === '要启用的模型不存在') return '切换模型失败：该模型已不存在，请刷新列表后重试。';
  return `${action}失败：无法保存设置，请检查模型列表后重试。`;
}

function connectionError(error) {
  const message = String(error?.message || '');
  const status = /^API (\d{3})(?:\D|$)/.exec(message)?.[1];
  if (status === '401' || status === '403') return '连接失败：鉴权未通过，请检查 API Key 和接口权限。';
  if (status === '404') return '连接失败：接口地址或模型不存在，请检查配置。';
  if (status === '429') return '连接失败：请求受到限流，请稍后重试。';
  if (status && Number(status) >= 500) return '连接失败：接口服务暂不可用，请稍后重试。';
  if (status) return `连接失败：接口返回 HTTP ${status}，请检查模型配置。`;
  if (/超时|timeout/i.test(message)) return '连接失败：请求超时，请检查网络和接口地址。';
  if (message === '模型返回为空' || message.includes('缺少 choices[0].message.content')) return '连接失败：模型没有返回有效内容，请检查模型配置。';
  if (message === '无法读取模型配置') return '连接失败：无法读取模型配置，请刷新列表后重试。';
  return '连接失败：无法完成请求，请检查网络和模型配置后重试。';
}

function runtimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

async function load() {
  const state = await runtimeMessage({ type: 'GET_SETTINGS' });
  if (!state?.ok) throw new Error(state?.error || '无法读取设置');
  if (!applyModelState(state)) return;
  latestPromptState = { revision: settingsRevision, text: state.systemPrompt || DEFAULT_SYSTEM_PROMPT };
  syncPromptState();
  renderList();
}

function syncPromptState() {
  if (!latestPromptState || promptSaving || latestPromptState.revision < promptRevision) return;
  if (!promptDirty) {
    $('systemPrompt').value = latestPromptState.text;
    promptRevision = latestPromptState.revision;
    promptBaseText = latestPromptState.text;
  } else if (latestPromptState.text === promptBaseText) {
    promptRevision = latestPromptState.revision;
  }
  const conflict = promptDirty && promptRevision !== latestPromptState.revision;
  $('promptConflict').hidden = !conflict;
  if (conflict) {
    $('latestPrompt').value = latestPromptState.text;
    setStatus('promptStatus', '设置已更新，草稿已保留；请核对下方最新提示词后继续', false, true);
  }
}

function setStatus(id, message, ok, persistent = false) {
  const element = $(id);
  element.textContent = message;
  element.className = `status ${ok ? 'ok' : 'fail'}`;
  if (!persistent) setTimeout(() => { if (element.textContent === message) element.textContent = ''; }, 3500);
}

function button(text, className, onClick, disabled = false) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = text;
  if (className) element.className = className;
  element.disabled = disabled;
  element.addEventListener('click', onClick);
  return element;
}

function renderList() {
  const list = $('modelList');
  list.innerHTML = '';
  if (!models.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = '还没有模型，点下方「添加模型」创建第一个。';
    list.appendChild(empty);
    return;
  }
  for (const model of models) {
    const active = model.id === activeModelId;
    const card = document.createElement('section');
    card.className = 'card';
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('strong');
    name.style.marginRight = 'auto';
    name.textContent = model.name || '未命名模型';
    name.title = name.textContent;
    row.appendChild(name);
    if (active) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '当前使用';
      row.appendChild(tag);
    }
    if (!active) row.appendChild(button('使用', 'primary', () => setActive(model.id)));
    const testButton = button(testingModels.has(model.id) ? '测试中…' : '测试', '', () => testModel(model), testingModels.has(model.id));
    testButton.dataset.testModelId = model.id;
    row.append(
      button(model.id === 'builtin-viddsys-api' && !model.hasApiKey ? '填写密钥' : '编辑', '', () => openForm(model)),
      testButton,
      button('删除', 'danger', () => deleteModel(model)),
    );
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${model.baseUrl}\u00a0· ${model.model}\u00a0· Key: ${model.hasApiKey ? '已配置' : '免鉴权/未填'}\u00a0· 图片: ${model.vision ? '允许' : '关闭'}`;
    const status = document.createElement('div');
    const previousStatus = modelStatuses.get(model.id);
    status.dataset.modelId = model.id;
    status.className = `status model-status ${previousStatus?.ok ? 'ok' : 'fail'}`;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = !previousStatus;
    status.textContent = previousStatus?.message || '';
    card.append(row, meta, status);
    list.appendChild(card);
  }
}

async function update(operation, fields = {}, expectedRevision = settingsRevision) {
  const response = await runtimeMessage({ type: 'UPDATE_SETTINGS', operation, expectedRevision, ...fields });
  if (!response?.ok) {
    if (response?.code === 'REVISION_CONFLICT') {
      await load();
      throw Object.assign(new Error(operation === 'setPrompt'
        ? '设置已在其他窗口更新；提示词草稿已保留，请核对下方最新提示词后继续'
        : operation === 'upsertModel'
          ? '设置已在其他窗口更新；表单内容已保留，请核对上方列表后再次保存以覆盖'
          : '设置已在其他窗口更新，列表已刷新，请重试'), { code: response.code });
    }
    throw new Error(response?.error || '保存失败');
  }
  if (applyModelState(response)) renderList();
  return response;
}

async function setActive(id) {
  modelStatus(id, '');
  try {
    await update('setActive', { id });
  } catch (error) {
    modelStatus(id, modelOperationError(error, '切换模型'));
  }
}

async function deleteModel(model) {
  if (!confirm(`删除模型「${model.name}」？`)) return;
  modelStatus(model.id, '');
  try {
    await update('deleteModel', { id: model.id });
    modelStatuses.delete(model.id);
    if (editingId === model.id) closeForm();
    await load();
  } catch (error) {
    modelStatus(model.id, modelOperationError(error, '删除模型'));
  }
}

function ownsFormSave(attempt) {
  return formSession === attempt.session && formSaveAttempt === attempt;
}

function openForm(model) {
  const session = ++formSession;
  formEditVersion = 0;
  formSaveAttempt = null;
  $('btnSave').disabled = false;
  editingId = model?.id || null;
  formRevision = settingsRevision;
  apiKeyTouched = false;
  $('formTitle').textContent = model ? '编辑模型' : '添加模型';
  $('fName').value = model?.name || '';
  $('fBase').value = model?.baseUrl || '';
  $('fKey').value = '';
  setKeyVisible(false);
  if (model?.hasApiKey) {
    runtimeMessage({ type: 'RESOLVE_MODEL', id: model.id })
      .then((resolved) => { if (resolved?.ok && formSession === session && !apiKeyTouched && editingId === model.id) $('fKey').value = resolved.model?.apiKey || ''; })
      .catch(() => {});
  }
  $('fModel').value = model?.model || '';
  $('fVision').checked = model?.vision === true;
  $('formStatus').textContent = '';
  $('formWrap').classList.add('show');
  $(model?.id === 'builtin-viddsys-api' && !model.hasApiKey ? 'fKey' : 'fName').focus();
}

function closeForm() {
  $('fKey').value = '';
  formSession += 1;
  formSaveAttempt = null;
  $('btnSave').disabled = false;
  editingId = null;
  apiKeyTouched = false;
  $('formWrap').classList.remove('show');
}

const EYE_OPEN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>';
const EYE_CLOSED = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/><line x1="4" y1="20" x2="20" y2="4"/></svg>';

function setKeyVisible(visible) {
  const input = $('fKey');
  const button = $('toggleKey');
  input.type = visible ? 'text' : 'password';
  button.innerHTML = visible ? EYE_CLOSED : EYE_OPEN;
  button.classList.toggle('on', visible);
  button.setAttribute('aria-pressed', String(visible));
  const label = visible ? '隐藏密钥' : '显示密钥';
  button.title = label;
  button.setAttribute('aria-label', label);
}

$('toggleKey').addEventListener('click', () => setKeyVisible($('fKey').type === 'password'));
setKeyVisible(false);

$('btnAdd').addEventListener('click', () => openForm(null));
$('btnCancel').addEventListener('click', closeForm);
for (const id of ['fName', 'fBase', 'fKey', 'fModel', 'fVision']) {
  $(id).addEventListener('input', () => {
    formEditVersion += 1;
    if (id === 'fKey') apiKeyTouched = true;
    setStatus('formStatus', '有未保存的修改', true, true);
  });
}
$('systemPrompt').addEventListener('input', () => {
  // The draft stays based on the last displayed/saved/reconciled prompt, not a model-list refresh.
  promptDirty = true;
  promptEditVersion += 1;
  setStatus('promptStatus', '有未保存的修改', true, true);
  syncPromptState();
});
$('btnRebasePrompt').addEventListener('click', () => {
  if (promptSaving || !latestPromptState) return;
  promptRevision = latestPromptState.revision;
  promptBaseText = latestPromptState.text;
  $('promptConflict').hidden = true;
  setStatus('promptStatus', '草稿已保留，请再次保存提示词；若设置再次变化仍会提示冲突', true, true);
});

$('btnSave').addEventListener('click', async () => {
  if (formSaveAttempt || !$('formWrap').classList.contains('show')) return;
  const saveButton = $('btnSave');
  const attempt = { session: formSession, editVersion: formEditVersion, revision: formRevision };
  formSaveAttempt = attempt;
  saveButton.disabled = true;
  setStatus('formStatus', '正在保存…', true, true);
  try {
    const keepApiKey = !!editingId && !apiKeyTouched;
    if (keepApiKey && !models.some((model) => model.id === editingId)) {
      throw new Error('该模型已在其他窗口被删除；请重新填写 API Key 后再保存，否则会以空 Key 重建');
    }
    const validated = globalThis.ViasCore.validateModel({
      id: editingId || crypto.randomUUID(),
      name: $('fName').value,
      baseUrl: $('fBase').value,
      apiKey: keepApiKey ? '' : $('fKey').value,
      model: $('fModel').value,
      vision: $('fVision').checked,
    });
    if (!validated.name) throw new Error('请填写显示名称');
    const response = await update('upsertModel', { model: validated, keepApiKey }, attempt.revision);
    if (ownsFormSave(attempt)) {
      if (formEditVersion === attempt.editVersion) closeForm();
      else {
        // Continue the same draft from this acknowledgement, never a newer global revision.
        editingId = validated.id;
        formRevision = response.settingsRevision ?? attempt.revision + 1;
        setStatus('formStatus', '提交的版本已保存；仍有未保存的新修改', true, true);
      }
    }
    await load();
  } catch (error) {
    // Conflict rebasing and error text belong only to the submitted draft.
    if (ownsFormSave(attempt) && formEditVersion === attempt.editVersion) {
      if (error.code === 'REVISION_CONFLICT') formRevision = settingsRevision;
      setStatus('formStatus', error.message, false, true);
    }
  } finally {
    if (ownsFormSave(attempt)) {
      formSaveAttempt = null;
      saveButton.disabled = false;
    }
  }
});

async function testModel(model) {
  if (testingModels.has(model.id)) return;
  const attempt = { revision: settingsRevision };
  testingModels.set(model.id, attempt);
  modelStatus(model.id, '正在测试连接…', true);
  const testButton = [...$('modelList').querySelectorAll('[data-test-model-id]')].find((item) => item.dataset.testModelId === model.id);
  if (testButton) { testButton.disabled = true; testButton.textContent = '测试中…'; }
  try {
    let result;
    try {
      const resolved = await runtimeMessage({ type: 'RESOLVE_MODEL', id: model.id });
      if (!resolved?.ok) throw new Error('无法读取模型配置');
      const text = await globalThis.ViasCore.callModel(resolved.model, [{ role: 'user', content: '请仅回复 OK' }], { timeoutMs: 60000, retries: 0 });
      if (!text.trim()) throw new Error('模型返回为空');
      result = { message: '连接测试通过。', ok: true };
    } catch (error) {
      result = { message: connectionError(error), ok: false };
    }
    if (testingModels.get(model.id) !== attempt) return;
    // Re-read the public revision to catch changes whose storage event has not arrived yet.
    const state = await runtimeMessage({ type: 'GET_SETTINGS' });
    if (testingModels.get(model.id) !== attempt) return;
    if (!state?.ok || !Number.isInteger(state.settingsRevision)) throw new Error('无法确认设置版本');
    if (state.settingsRevision !== attempt.revision || settingsRevision !== attempt.revision) {
      modelStatus(model.id, '');
      await load();
      return;
    }
    modelStatus(model.id, result.message, result.ok);
  } catch {
    if (testingModels.get(model.id) === attempt) modelStatus(model.id, '无法确认模型配置，请刷新页面后重新测试。');
  } finally {
    if (testingModels.get(model.id) === attempt) {
      testingModels.delete(model.id);
      const currentButton = [...$('modelList').querySelectorAll('[data-test-model-id]')].find((item) => item.dataset.testModelId === model.id);
      if (currentButton) { currentButton.disabled = false; currentButton.textContent = '测试'; }
    }
  }
}

$('btnSavePrompt').addEventListener('click', async () => {
  if (promptSaving) return;
  const saveButton = $('btnSavePrompt');
  const text = $('systemPrompt').value.trim() || DEFAULT_SYSTEM_PROMPT;
  const editVersion = promptEditVersion;
  const revision = promptRevision;
  promptDirty = true;
  promptSaving = true;
  saveButton.disabled = true;
  $('btnRebasePrompt').disabled = true;
  try {
    const response = await update('setPrompt', { systemPrompt: text }, revision);
    promptRevision = response.settingsRevision;
    promptBaseText = text;
    $('promptConflict').hidden = true;
    // An acknowledgement only clears the exact draft that was submitted.
    promptDirty = promptEditVersion !== editVersion;
    if (!promptDirty) $('systemPrompt').value = text;
    setStatus('promptStatus', promptDirty ? '提交的版本已保存；仍有未保存的新修改' : '已保存', true, promptDirty);
    await load();
  } catch (error) {
    setStatus('promptStatus', error.message, false, true);
  } finally {
    promptSaving = false;
    saveButton.disabled = false;
    $('btnRebasePrompt').disabled = false;
    syncPromptState();
  }
});

function renderSponsors() {
  const list = $('sponsorList');
  if (!list) return;
  list.textContent = '';
  if (!SPONSORS.length) {
    const empty = document.createElement('p');
    empty.className = 'hint sponsor-empty';
    empty.textContent = '暂无赞助者。';
    list.appendChild(empty);
    return;
  }
  for (const sponsor of SPONSORS) {
    const item = document.createElement('div');
    item.className = 'sponsor';
    const avatar = document.createElement('img');
    avatar.className = 'sponsor-avatar';
    avatar.src = sponsor.avatar;
    avatar.alt = `${sponsor.name} 的头像`;
    avatar.width = 42;
    avatar.height = 42;
    avatar.loading = 'lazy';
    avatar.decoding = 'async';
    avatar.addEventListener('error', () => {
      const fallback = document.createElement('span');
      fallback.className = 'sponsor-avatar sponsor-fallback';
      fallback.textContent = sponsor.name.slice(0, 1);
      fallback.setAttribute('aria-hidden', 'true');
      avatar.replaceWith(fallback);
    }, { once: true });
    const name = document.createElement('span');
    name.className = 'sponsor-name';
    name.textContent = sponsor.name;
    item.append(avatar, name);
    list.appendChild(item);
  }
}

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') load().catch((error) => setStatus('promptStatus', error.message, false, true));
});

renderSponsors();
load().catch((error) => setStatus('promptStatus', error.message, false, true));
