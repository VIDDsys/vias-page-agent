'use strict';

const TEXT_LIMITS = globalThis.ViasCore.TEXT_LIMITS;
const $ = (selector) => document.querySelector(selector);
const chatEl = $('#chat');
const inputEl = $('#input');
const sendEl = $('#send');
const statusEl = $('#status');
const modeAsk = $('#modeAsk');
const modeAgent = $('#modeAgent');
const formEl = $('#inputForm');
const chipsEl = $('#chips');
const toastEl = $('#copyToast');
const modelPill = $('#modelPill');
const modelMenu = $('#modelMenu');
const clearButton = $('#clear');
let allowActions = true;
let activeRun = null;
let history = [];
let sessionKey = '';
let initialized = false;
let currentModelId = '';
let menuModels = [];
let modelRefreshId = 0;
let persistQueue = Promise.resolve();
let historyOmissionShown = false;
let autoStick = true;
let toastTimer;
let lastRunJournal = '';

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    // DOMPurify 禁止 input，任务列表复选框改用自绘 span；同时容忍未来 marked 传入 token 对象
    checkbox(checked) {
      const isChecked = typeof checked === 'boolean' ? checked : checked?.checked === true;
      return `<span class="visually-hidden">${isChecked ? '已勾选' : '未勾选'}</span><span class="task-checkbox${isChecked ? ' checked' : ''}" aria-hidden="true"></span>`;
    },
  },
  extensions: [{
    name: 'highlight',
    level: 'inline',
    start(source) { return source.indexOf('=='); },
    tokenizer(source) {
      const match = /^==(?=\S)([\s\S]*?\S)==/.exec(source);
      if (match) return { type: 'highlight', raw: match[0], tokens: this.lexer.inlineTokens(match[1]) };
    },
    renderer(token) { return `<mark>${this.parser.parseInline(token.tokens)}</mark>`; },
  }],
});

function renderMarkdown(text) {
  const raw = marked.parse(String(text ?? ''));
  const clean = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['img', 'picture', 'source', 'audio', 'video', 'iframe', 'object', 'embed', 'style', 'form', 'input', 'button'],
    FORBID_ATTR: ['style', 'srcset', 'formaction', 'background', 'poster', 'ping', 'action', 'xlink:href'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  });
  // 净化后的字符串不能再做正则手术（属性里的 <table> 会破坏词法）：经 detached DOM 包装表格
  const template = document.createElement('template');
  template.innerHTML = clean;
  for (const table of [...template.content.querySelectorAll('table')]) {
    if (table.parentElement?.classList.contains('table-scroll')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'table-scroll';
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }
  return template.innerHTML;
}

function hardenLinks(root) {
  for (const link of root.querySelectorAll('a')) {
    let url;
    try { url = new URL(link.getAttribute('href') || '', location.href); } catch { link.removeAttribute('href'); continue; }
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) link.removeAttribute('href');
    else {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.referrerPolicy = 'no-referrer';
    }
  }
}

chatEl.addEventListener('scroll', () => {
  autoStick = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 80;
});

function scrollBottom(force = false) {
  if (force) autoStick = true;
  if (autoStick) chatEl.scrollTop = chatEl.scrollHeight;
}

function displayTaskText(text) {
  return String(text ?? '')
    .replace(/^第\s*\d+\s*轮[：:]\s*/u, '')
    .replace(/^已达到最大轮数\s*\d+$/u, '任务已达到执行上限')
    .replace(/^(模型|页面)连续三轮/u, '$1多次')
    .replace(/^连续多轮操作后/u, '多次操作后');
}

function addMessage(role, text) {
  if (role === 'ai' && globalThis.ViasCore.isInternalToolText(text)) return null;
  if (role === 'sys' && globalThis.ViasCore.isInternalToolText(text)) text = '任务出现异常，请稍后重试。';
  if (role !== 'user') text = displayTaskText(text);
  const element = document.createElement('div');
  element.className = `msg ${role}`;
  if (role === 'ai') {
    const markdown = document.createElement('div');
    markdown.className = 'md-content';
    markdown.innerHTML = renderMarkdown(text);
    hardenLinks(markdown);
    for (const pre of markdown.querySelectorAll('pre')) { pre.tabIndex = 0; pre.title = '点击或按 Enter 复制'; }
    element.appendChild(markdown);
  } else {
    element.textContent = text;
  }
  chatEl.appendChild(element);
  scrollBottom(role !== 'sys');
  return element;
}

const ACTION_FAILURES = {
  INVALID_SELECTOR: '目标选择器无效，请检查页面后重试。',
  TARGET_NOT_FOUND: '找不到目标，请重新读取页面后重试。',
  STALE_TARGET: '目标已变化，请重新读取页面后重试。',
  STALE_SNAPSHOT: '页面已变化，请重新读取页面后重试。',
  TARGET_HIDDEN: '目标当前不可见，请检查页面状态。',
  TARGET_DISABLED: '目标当前不可操作，请检查页面状态。',
  NOT_EDITABLE: '目标不可编辑，请检查目标或手动操作。',
  READ_ONLY: '目标为只读，请检查页面状态。',
  WAIT_TIMEOUT: '等待目标超时，请检查页面后重试。',
  FORM_INVALID: '表单校验未通过，请检查表单内容。',
  OPTION_NOT_FOUND: '找不到匹配选项，请检查页面选项。',
  CLICK_BLOCKED: '点击未能完成，请检查页面后重试。',
  CHECK_NOT_APPLIED: '点击后目标仍未选中，请重读页面核对，必要时手动选择。',
  VALUE_NOT_APPLIED: '网站未保留填写/选择结果，已停止后续操作，请检查字段要求。',
  SKIPPED_AFTER_NAVIGATION: '页面正在跳转，此操作已跳过，请检查新页面。',
  SKIPPED_AFTER_FAILURE: '前序操作失败，此操作已跳过，请检查前面的结果。',
  BUSY: '页面正在处理其他操作，请稍后重试。',
  CANCELLED: '操作已取消，请检查页面状态。',
  INTERRUPTED: '操作已中断，请检查页面状态后重试。',
  VISION_DISABLED: '当前模型未启用图片能力，请在模型设置中启用后重试。',
  INVALID_IMAGE: '图片编号无效，请重新读取页面后选择图片。',
  IMAGE_UNREADABLE: '无法读取这张图片，请检查页面或换一张图片。',
  STALE_IMAGE: '图片已变化，请重新读取页面后重试。',
  ENCODED_LIMIT: '图片编码后的大小超出限制，请选择更小的图片。',
  DOWNLOAD_LIMIT: '图片下载大小超出限制，请选择更小的图片。',
  PIXEL_LIMIT: '图片分辨率超出限制，请选择尺寸更小的图片。',
  UNSUPPORTED_IMAGE: '暂不支持这种图片格式，请换一张图片。',
  TIMEOUT: '图片读取超时，请检查网络后重试。',
  IMAGE_REASON_REQUIRED: '图片读取缺少原因，请补充读取原因后重试。',
  IMAGE_ALREADY_READ: '这张图片已读取，无需重复读取。',
  READ_FAILED: '读取未完成，请重新读取页面后重试。',
  ACTION_COMMUNICATION_FAILED: '页面通信失败，请检查页面状态后重试。',
  UNSUPPORTED_KEY: '当前页面无法可靠模拟该按键，请改用点击或填写。',
  NO_EFFECT: '按键未生效，请重新读取页面后核对状态。',
};

function toolText(value, limit) {
  const text = String(value ?? '');
  return globalThis.ViasCore.isInternalToolText(text) ? '' : text.slice(0, limit);
}

function addTools(round, actions, title) {
  const block = document.createElement('div');
  block.className = 'tools';
  const heading = document.createElement('div');
  heading.className = 'tools-head';
  const label = ['图片分析', '页面读取'].includes(title) ? title : `${actions.length} 个操作`;
  heading.textContent = label;
  block.appendChild(heading);
  const slots = [];
  for (const action of actions) {
    const row = document.createElement('div');
    row.className = 'tool pending';
    const name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = toolText(action.action, 48);
    const detail = document.createElement('span');
    detail.className = 'tool-detail';
    const sensitive = /password|密码|验证码|token|secret|银行卡|cvv|身份证/i.test(String(action.selector || ''));
    const value = sensitive ? '[已隐藏]' : action.value;
    const fallbackDetail = `${action.ref != null ? `@${action.ref}` : action.selector || ''}${value != null && value !== '' ? ` ← "${String(value).slice(0, 160)}"` : ''}`;
    detail.textContent = toolText(typeof action.detail === 'string' ? action.detail : fallbackDetail, 320);
    const state = document.createElement('span');
    state.className = 'tool-state';
    state.textContent = '…';
    const reason = document.createElement('span');
    reason.className = 'tool-reason';
    reason.hidden = true;
    row.append(name, detail, state, reason);
    block.appendChild(row);
    slots.push({ row, state, reason, image: action.action === 'image analyze' });
  }
  chatEl.appendChild(block);
  scrollBottom();
  return slots;
}

function updateTool(context, slot, result) {
  if (!slot || !context.pendingTools.has(slot)) return;
  const ok = result.ok === true;
  slot.row.classList.remove('pending');
  slot.row.classList.add(ok ? 'ok' : 'fail');
  slot.state.textContent = ok ? (slot.image ? '已读取' : toolText(result.state, 160).replace('当前值=', '') || '完成')
    : result.code === 'CANCELLED' ? '已取消' : result.code === 'INTERRUPTED' ? '已中断' : '失败';
  slot.reason.hidden = ok;
  slot.reason.textContent = ok ? '' : (Object.hasOwn(ACTION_FAILURES, result.code) ? ACTION_FAILURES[result.code] : '操作未完成，请检查页面状态后重试。');
  context.pendingTools.delete(slot);
}

function settlePendingTools(context, code) {
  for (const slot of context.pendingTools) updateTool(context, slot, { ok: false, code });
}

function setStatus(text) {
  const visible = displayTaskText(text);
  statusEl.classList.toggle('show', !!visible);
  statusEl.textContent = visible;
}

function showToast(message) {
  toastEl.textContent = message || '已复制';
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
}

async function copyText(text, success) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(success);
  } catch {
    showToast('复制失败');
  }
}

document.addEventListener('keydown', (event) => {
  const pre = event.target.closest?.('.md-content pre');
  if (pre && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void copyText((pre.innerText || '').trim(), '代码块已复制'); }
});
document.addEventListener('click', (event) => {
  if (String(getSelection() || '').length) return;
  const pre = event.target.closest('pre');
  if (pre?.closest('.md-content')) { void copyText((pre.innerText || '').trim(), '代码块已复制'); return; }
  if (event.target.tagName === 'CODE' && event.target.closest('.md-content') && !event.target.closest('pre')) void copyText((event.target.innerText || '').trim(), '行内代码已复制');
});

function setControlsRunning(running) {
  sendEl.textContent = running ? '停止' : '发送';
  sendEl.title = running ? '停止' : '发送';
  sendEl.setAttribute('aria-label', running ? '停止' : '发送');
  modeAsk.disabled = running;
  modeAgent.disabled = running;
  clearButton.disabled = running;
  modelPill.disabled = running;
  for (const chip of chipsEl.querySelectorAll('.chip:not(#modelPill)')) chip.disabled = running;
}

function setMode(value) {
  if (activeRun) return;
  allowActions = value;
  modeAsk.classList.toggle('on', !value);
  modeAgent.classList.toggle('on', value);
  modeAsk.setAttribute('aria-pressed', String(!value));
  modeAgent.setAttribute('aria-pressed', String(value));
}
modeAsk.addEventListener('click', () => setMode(false));
modeAgent.addEventListener('click', () => setMode(true));

function showHistoryOmission() {
  if (historyOmissionShown) return;
  historyOmissionShown = true;
  addMessage('sys', '较早对话因保存预算已省略，最近消息保持完整。');
}

function boundedHistory(items, onOmitted) {
  const valid = items.filter((item) => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string'
    && (item.role === 'user' || !globalThis.ViasCore.isInternalToolText(item.content)));
  const selected = [];
  let bytes = 2; // JSON array brackets; never slice an individual message.
  for (let index = valid.length - 1; index >= 0; index--) {
    const item = { role: valid[index].role, content: valid[index].content };
    const size = globalThis.ViasCore.utf8ByteLength(JSON.stringify(item)) + Number(selected.length > 0);
    if (bytes + size > TEXT_LIMITS.sessionBytes || selected.length >= 100) {
      if (!selected.length) throw new Error('最新消息超过本窗口 8 MiB 保存预算，原文未截短；请复制保存并拆分任务');
      break;
    }
    bytes += size;
    selected.unshift(item);
  }
  if (selected.length < valid.length) onOmitted?.();
  return selected;
}

async function writeSessionSnapshot(key, snapshot) {
  const session = chrome.storage.session;
  const bytes = globalThis.ViasCore.utf8ByteLength(JSON.stringify({ [key]: snapshot }));
  if (bytes > TEXT_LIMITS.sessionBytes) throw new Error('本窗口对话超过 8 MiB 保存预算，原文未截短；请复制保存并新建对话');
  const quota = Number(session.QUOTA_BYTES) || 10 * 1024 * 1024;
  const reserve = Math.min(256 * 1024, Math.floor(quota * 0.05));
  let otherBytes = 0;
  if (typeof session.getBytesInUse === 'function') {
    const [total, own] = await Promise.all([session.getBytesInUse(null), session.getBytesInUse(key)]);
    otherBytes = Math.max(0, total - own);
  }
  // Chrome session storage estimates allocated memory. Include a conservative UTF-16 floor as well as JSON bytes.
  const estimatedBytes = Math.max(bytes, snapshot.reduce((sum, item) => sum + item.content.length * 2 + 256, key.length * 2));
  if (otherBytes + estimatedBytes > quota - reserve) {
    throw new Error('会话存储空间不足，本次内容尚未保存；请复制保存或关闭不需要的对话。其它窗口的历史未删除');
  }
  await session.set({ [key]: snapshot });
}

function queueSessionWrite(operation) {
  const next = persistQueue.then(operation);
  // Keep the queue usable after failure, but let each caller report its own error.
  persistQueue = next.catch(() => {});
  return next;
}

function persist() {
  const key = sessionKey;
  if (!key) return Promise.resolve();
  let snapshot;
  try { snapshot = boundedHistory(history, showHistoryOmission); }
  catch (error) { addMessage('sys', `对话保存失败：${error.message}`); return Promise.resolve(); }
  return queueSessionWrite(() => writeSessionSnapshot(key, snapshot)).catch((error) => {
    addMessage('sys', `对话保存失败：${error.message}`);
  });
}

async function initializeHistory(windowId) {
  sessionKey = `chat:${windowId}`;
  const stored = await chrome.storage.session.get([sessionKey, 'chat']);
  const saved = Array.isArray(stored[sessionKey]) ? stored[sessionKey] : Array.isArray(stored.chat) ? stored.chat : [];
  history = boundedHistory(saved, showHistoryOmission);
  if (!stored[sessionKey] && Array.isArray(stored.chat)) {
    const key = sessionKey;
    const snapshot = boundedHistory(history);
    await queueSessionWrite(async () => {
      await writeSessionSnapshot(key, snapshot);
      await chrome.storage.session.remove('chat');
    });
  } else if (saved.length !== history.length) {
    const key = sessionKey;
    const snapshot = boundedHistory(history);
    await queueSessionWrite(() => writeSessionSnapshot(key, snapshot));
  }
  for (const item of history) addMessage(item.role === 'user' ? 'user' : 'ai', item.content);
}

function positionModelMenu() {
  if (!modelMenu.classList.contains('show')) return;
  const viewport = window.visualViewport;
  const left = (viewport?.offsetLeft || 0) + 8;
  const top = (viewport?.offsetTop || 0) + 8;
  const right = left + (viewport?.width || innerWidth) - 16;
  const bottom = top + (viewport?.height || innerHeight) - 16;
  const rect = modelPill.getBoundingClientRect();
  const scrollTop = modelMenu.scrollTop;
  modelMenu.style.minWidth = `${Math.min(150, right - left)}px`;
  modelMenu.style.maxWidth = `${Math.min(240, right - left)}px`;
  modelMenu.style.maxHeight = 'none';
  const naturalHeight = modelMenu.getBoundingClientRect().height;
  const below = Math.max(0, bottom - rect.bottom - 6);
  const above = Math.max(0, rect.top - 6 - top);
  const opensDown = naturalHeight <= below || below >= above;
  modelMenu.style.maxHeight = `${Math.min(bottom - top, opensDown ? below : above)}px`;
  const size = modelMenu.getBoundingClientRect();
  modelMenu.style.left = `${Math.max(left, Math.min(rect.left, right - size.width))}px`;
  modelMenu.style.top = `${Math.max(top, Math.min(opensDown ? rect.bottom + 6 : rect.top - 6 - size.height, bottom - size.height))}px`;
  modelMenu.scrollTop = scrollTop;
  if (modelMenu.contains(document.activeElement)) document.activeElement.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function focusMenuItem(item) {
  if (!item) return;
  for (const button of modelMenu.querySelectorAll('button')) button.tabIndex = button === item ? 0 : -1;
  item.focus({ preventScroll: true });
  item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function toggleMenu(open, restoreFocus = true) {
  const next = open ?? !modelMenu.classList.contains('show');
  if (next && !activeRun) {
    modelMenu.classList.add('show');
    modelPill.setAttribute('aria-expanded', 'true');
    positionModelMenu();
    focusMenuItem(modelMenu.querySelector('[aria-checked="true"]') || modelMenu.querySelector('button'));
  } else {
    const wasOpen = modelMenu.classList.contains('show');
    modelMenu.classList.remove('show');
    modelPill.setAttribute('aria-expanded', 'false');
    if (wasOpen && restoreFocus) modelPill.focus({ preventScroll: true });
  }
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

function setModelLabel(model) {
  modelPill.textContent = model ? `${model.name || '未命名模型'} ▾` : '＋ 配置模型';
  modelPill.title = model ? `切换模型：${model.name || '未命名模型'}` : '配置模型';
}

async function refreshModels() {
  const refreshId = ++modelRefreshId;
  const state = await runtimeMessage({ type: 'GET_SETTINGS' });
  // Requests from an ended run (or an older refresh) cannot relabel a new run.
  if (refreshId !== modelRefreshId || activeRun) return null;
  if (!state?.ok) throw new Error(state?.error || '无法读取模型设置');
  menuModels = state.models || [];
  currentModelId = state.activeModelId || '';
  const current = menuModels.find((model) => model.id === currentModelId);
  setModelLabel(current);
  renderModelMenu();
  return current;
}

function renderModelMenu() {
  const focusedId = modelMenu.contains(document.activeElement) ? document.activeElement.dataset.modelId : null;
  modelMenu.innerHTML = '';
  for (const model of menuModels) {
    const item = document.createElement('button');
    item.type = 'button';
    item.role = 'menuitemradio';
    item.className = `model-item${model.id === currentModelId ? ' on' : ''}`;
    item.setAttribute('aria-checked', String(model.id === currentModelId));
    item.dataset.modelId = model.id;
    item.tabIndex = -1;
    item.textContent = model.name || '未命名模型';
    item.addEventListener('click', async () => {
      if (activeRun) return;
      toggleMenu(false);
      try {
        const response = await runtimeMessage({ type: 'UPDATE_SETTINGS', operation: 'setActive', id: model.id });
        if (!response?.ok) throw new Error(response?.error || '切换失败');
        await refreshModels();
        addMessage('sys', `已切换模型：${model.name || '未命名模型'}`);
      } catch (error) { addMessage('sys', `切换模型失败：${error.message}`); }
    });
    modelMenu.appendChild(item);
  }
  const manage = document.createElement('button');
  manage.type = 'button';
  manage.role = 'menuitem';
  manage.className = 'model-item manage';
  manage.dataset.modelId = '';
  manage.tabIndex = -1;
  manage.textContent = '管理模型…';
  manage.addEventListener('click', () => { toggleMenu(false); chrome.runtime.openOptionsPage(); });
  modelMenu.appendChild(manage);
  if (modelMenu.classList.contains('show')) {
    positionModelMenu();
    if (focusedId != null) focusMenuItem([...modelMenu.querySelectorAll('button')].find((item) => item.dataset.modelId === focusedId) || manage);
  }
}

modelPill.setAttribute('aria-haspopup', 'menu');
modelPill.setAttribute('aria-controls', 'modelMenu');
modelPill.setAttribute('aria-expanded', 'false');
modelPill.addEventListener('click', (event) => { event.stopPropagation(); toggleMenu(); });
modelPill.addEventListener('keydown', (event) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || activeRun) return;
  event.preventDefault();
  toggleMenu(true);
  const items = modelMenu.querySelectorAll('button');
  focusMenuItem(items[['ArrowUp', 'End'].includes(event.key) ? items.length - 1 : 0]);
});
modelMenu.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') { toggleMenu(false); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const items = [...modelMenu.querySelectorAll('button')];
  const index = items.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
    : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  focusMenuItem(items[next]);
});
document.addEventListener('click', (event) => { if (!modelMenu.contains(event.target) && event.target !== modelPill) toggleMenu(false, false); });
document.addEventListener('focusin', (event) => { if (!modelMenu.contains(event.target) && event.target !== modelPill) toggleMenu(false, false); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && modelMenu.classList.contains('show')) { event.preventDefault(); toggleMenu(false); }
});
window.addEventListener('resize', positionModelMenu);
document.addEventListener('scroll', (event) => { if (event.target !== modelMenu) positionModelMenu(); }, true);
window.visualViewport?.addEventListener('resize', positionModelMenu);
window.visualViewport?.addEventListener('scroll', positionModelMenu);
const menuAnchorObserver = new ResizeObserver(positionModelMenu);
menuAnchorObserver.observe(modelPill);
menuAnchorObserver.observe(document.querySelector('footer'));

$('#gear').addEventListener('click', () => chrome.runtime.openOptionsPage());
clearButton.addEventListener('click', async () => {
  if (activeRun || !sessionKey) return;
  const key = sessionKey;
  history = [];
  lastRunJournal = '';
  historyOmissionShown = false;
  chatEl.innerHTML = '';
  try { await queueSessionWrite(() => chrome.storage.session.remove(key)); addMessage('sys', '已新建对话'); }
  catch (error) { addMessage('sys', `新建失败：${error.message}（旧对话可能仍保存在本机，请重试新建）`); }
});

const CHIPS = [
  { label: '做题', mode: true, question: '自动完成当前页面的所有题目：认真读题（含图片题）后逐题作答，多选题选择全部正确选项；全部答完后停下向我汇报，未经我确认不要提交。' },
  { label: '翻译', mode: false, question: '把当前页面的主要内容完整翻译成英文，保持原有结构和 Markdown 格式。' },
  { label: '总结', mode: false, question: '用简洁清晰的 Markdown 总结当前页面，先给一句话结论，再列要点。' },
  { label: '解释', mode: false, question: '这个页面讲了什么？请用通俗易懂的语言解释。' },
];
for (const chip of CHIPS) {
  const button = document.createElement('button');
  button.className = 'chip';
  button.type = 'button';
  button.textContent = chip.label;
  button.addEventListener('click', () => {
    if (activeRun) return;
    setMode(chip.mode);
    inputEl.value = chip.question;
    autosize();
    void send();
  });
  chipsEl.appendChild(button);
}

function describeJournalResult(action, result, prefix = '') {
  const name = toolText(action.action, 32) || '操作';
  const detail = toolText(typeof action.detail === 'string' ? action.detail : '', 80);
  const state = !result ? '结果未知'
    : result.ok === true ? '成功'
      : `失败（${Object.hasOwn(ACTION_FAILURES, result.code) ? ACTION_FAILURES[result.code] : '未完成，请检查页面状态'}）`;
  return `${prefix}${name}${detail ? ` ${detail}` : ''}：${state}`;
}

function buildRunJournal(context, outcome, error = '') {
  const operations = [...context.operations.values()];
  if (!operations.length) return error ? `上一任务已停止。停止原因：${toolText(error, 300)}`.slice(0, 1500) : '';
  const total = operations.reduce((count, entry) => count + entry.actions.length, 0);
  const failed = [];
  operations.forEach((entry, batch) => entry.actions.forEach((action, index) => {
    const result = entry.results.get(index);
    if (result && result.ok !== true) failed.push(describeJournalResult(action, result, `第 ${batch + 1} 批 ${index + 1}. `));
  }));
  const last = operations.at(-1);
  const lines = failed.length
    ? failed.slice(-8)
    : last.actions.slice(0, 10).map((action, index, _all) => describeJournalResult(action, last.results.get(index), `${index + 1}. `));
  const heading = failed.length ? '本任务失败或未确认的操作' : '最后一批操作';
  const outcomeText = outcome === 'unverified' ? '已结束，但仍有未确认的操作'
    : outcome === 'stalled' ? '因连续无进展或重复而停止'
      : outcome === 'limit' ? '达到执行上限后停止'
        : outcome === 'cancelled' ? '已停止' : '已结束';
  const errorText = error ? `\n停止原因：${toolText(error, 300)}` : '';
  return `上一任务${outcomeText}，共执行 ${total} 个页面操作。${heading}：\n${lines.join('\n')}${errorText}`.slice(0, 1500);
}

function finishRun(context, outcome, error = '') {
  if (!context || context.finished) return;
  context.finished = true;
  settlePendingTools(context, context.stopRequested || outcome === 'cancelled' ? 'CANCELLED' : 'INTERRUPTED');
  clearInterval(context.heartbeat);
  clearTimeout(context.stopFallback);
  for (const controller of context.modelControllers.values()) controller.abort();
  context.modelControllers.clear();
  try { context.port?.disconnect(); } catch {}
  if (activeRun !== context) return;
  const journal = buildRunJournal(context, outcome, error);
  if (journal) lastRunJournal = journal;
  activeRun = null;
  setControlsRunning(false);
  setStatus('');
  if (error) addMessage('sys', error);
  else if (outcome === 'cancelled') addMessage('sys', '任务已停止');
  else if (outcome === 'limit') addMessage('sys', '任务已达到执行上限并停止');
  else if (outcome === 'stalled') addMessage('sys', '任务因连续重复或无进展而安全停止');
  else if (outcome === 'unverified') addMessage('sys', '任务已结束，但仍有操作未获成功确认，请核对页面状态');
  void refreshModels().catch(() => {});
}

async function handleModelRequest(context, message) {
  if (context.finished || context.stopRequested || activeRun !== context) return;
  if (!context.modelLabel) {
    // The worker captures the task's actual model; an idle settings refresh may still be in flight.
    context.modelLabel = message.cfg?.name || '未命名模型';
    setModelLabel({ name: context.modelLabel });
  }
  const controller = new AbortController();
  context.modelControllers.set(message.requestId, controller);
  try {
    const policy = globalThis.ViasCore.MODEL_REQUEST_POLICY;
    const hasImages = message.messages.some((item) => Array.isArray(item.content) && item.content.some((part) => part?.type === 'image_url'));
    const beforeAttempt = hasImages ? async () => {
      const state = await runtimeMessage({ type: 'GET_SETTINGS' });
      const current = state?.ok ? state.models?.find((model) => model.id === message.cfg?.id) : null;
      if (message.cfg?.vision !== true || !current || current.vision !== true || current.baseUrl !== message.cfg.baseUrl || current.model !== message.cfg.model) {
        throw new Error('当前模型未启用图片能力或配置已变更，未发送图片；请检查模型设置后重新运行');
      }
    } : undefined;
    const text = await globalThis.ViasCore.callModel(message.cfg, message.messages, {
      signal: controller.signal, timeoutMs: policy.timeoutMs, totalTimeoutMs: policy.totalTimeoutMs, retries: policy.retries, beforeAttempt,
      maxReplyLength: message.replyLimit,
    });
    if (!context.finished && !context.stopRequested && activeRun === context) context.port.postMessage({ t: 'model_response', runId: context.runId, requestId: message.requestId, text });
  } catch (error) {
    if (!context.finished && !context.stopRequested && activeRun === context) {
      const code = error.code === 'UNSUPPORTED_TOOL_PROTOCOL' ? { code: 'UNSUPPORTED_TOOL_PROTOCOL' } : {};
      context.port.postMessage({ t: 'model_response', runId: context.runId, requestId: message.requestId, error: error.name === 'AbortError' ? '模型请求已取消' : error.message, ...code });
    }
  } finally {
    context.modelControllers.delete(message.requestId);
  }
}

function stopRun() {
  const context = activeRun;
  if (!context || context.stopRequested) return;
  context.stopRequested = true;
  settlePendingTools(context, 'CANCELLED');
  setStatus('正在安全停止…');
  for (const controller of context.modelControllers.values()) controller.abort();
  if (context.port) {
    try { context.port.postMessage({ t: 'cancel', runId: context.runId }); } catch { finishRun(context, 'interrupted', '连接已中断，任务已停止'); return; }
    context.stopFallback = setTimeout(() => finishRun(context, 'cancelled', '后台未及时确认停止，已在侧边栏强制结束；请检查页面状态'), 8000);
  } else {
    finishRun(context, 'cancelled');
  }
}

async function send() {
  const question = inputEl.value;
  if (!question.trim() || activeRun) return;
  if (question.length > TEXT_LIMITS.question) {
    addMessage('sys', `任务不能超过 ${TEXT_LIMITS.question} 个 UTF-16 代码单元，未发送且输入已保留；请拆分任务`);
    return;
  }
  if (!initialized) { addMessage('sys', '侧边栏尚未初始化成功，请关闭后重新打开侧边栏'); return; }
  const context = {
    runId: crypto.randomUUID(),
    port: null,
    heartbeat: null,
    modelControllers: new Map(),
    toolsByOperation: new Map(),
    toolsByRound: new Map(),
    operations: new Map(),
    pendingTools: new Set(),
    finished: false,
    stopRequested: false,
  };
  activeRun = context;
  modelRefreshId += 1;
  toggleMenu(false, false);
  setControlsRunning(true);
  setStatus('准备任务…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeRun !== context || context.stopRequested) { finishRun(context, 'cancelled'); return; }
    if (!tab?.id || !/^https?:/i.test(tab.url || '') || /^https:\/\/(microsoftedge\.microsoft\.com\/addons|chromewebstore\.google\.com)\//i.test(tab.url)) throw new Error('当前页面不可读取，请切换到普通 http(s) 网页');
    inputEl.value = '';
    autosize();
    addMessage('user', question);
    history.push({ role: 'user', content: question });
    void persist();
    scrollBottom(true);

    const port = chrome.runtime.connect({ name: 'agent' });
    context.port = port;
    port.onMessage.addListener((message) => {
      if (message.runId && message.runId !== context.runId) return;
      if (activeRun !== context || context.finished) return;
      if (message.t === 'status') setStatus(message.text);
      else if (message.t === 'notice') {
        if (!context.stopRequested) addMessage('sys', toolText(message.text, 300));
      } else if (message.t === 'say') {
        if (context.stopRequested || globalThis.ViasCore.isInternalToolText(message.text)) return;
        addMessage('ai', message.text);
        history.push({ role: 'assistant', content: message.text });
        void persist();
      } else if (message.t === 'actions') {
        if (context.stopRequested) return;
        const operationId = typeof message.operationId === 'string' && message.operationId ? message.operationId : null;
        if (operationId && context.toolsByOperation.has(operationId)) return;
        const slots = addTools(message.round, Array.isArray(message.actions) ? message.actions : [], message.title);
        if (operationId) context.toolsByOperation.set(operationId, slots);
        else context.toolsByRound.set(message.round, slots);
        context.operations.set(operationId || `round-${context.operations.size + 1}`, {
          actions: Array.isArray(message.actions) ? message.actions : [],
          results: new Map(),
        });
        for (const slot of slots) context.pendingTools.add(slot);
      } else if (message.t === 'result') {
        // A known operation is authoritative; an unknown ID must never fall back to a different legacy block.
        const slots = message.operationId ? context.toolsByOperation.get(message.operationId) : context.toolsByRound.get(message.round);
        if (Number.isSafeInteger(message.index) && message.index >= 0) updateTool(context, slots?.[message.index], message);
        const entry = message.operationId ? context.operations.get(message.operationId) : [...context.operations.values()].at(-1);
        if (entry && Number.isSafeInteger(message.index) && message.index >= 0) entry.results.set(message.index, message);
      } else if (message.t === 'model_request') {
        void handleModelRequest(context, message);
      } else if (message.t === 'model_cancel') {
        context.modelControllers.get(message.requestId)?.abort();
      } else if (message.t === 'error') {
        finishRun(context, 'interrupted', message.message || '任务启动失败');
      } else if (message.t === 'done') {
        finishRun(context, message.outcome || 'completed', message.error || '');
      }
      scrollBottom();
    });
    port.onDisconnect.addListener(() => {
      if (!context.finished) finishRun(context, 'interrupted', '后台连接中断，任务已安全停止；请检查页面状态后再决定是否重试');
    });
    context.heartbeat = setInterval(() => {
      try { port.postMessage({ t: 'ping', runId: context.runId }); } catch {}
    }, 15000);
    const conversation = boundedHistory(history.slice(0, -1), showHistoryOmission);
    // 会话窗口取「提问前最近 100 条」，快照取「含当前提问最近 100 条」；构造完后仅按完整条目裁剪内存。
    history = boundedHistory(history, showHistoryOmission);
    port.postMessage({ t: 'RUN', runId: context.runId, tabId: tab.id, question, allowActions, maxSteps: allowActions ? 100 : 1, history: conversation, priorRun: lastRunJournal });
  } catch (error) {
    finishRun(context, 'interrupted', error.message);
  }
}

formEl.addEventListener('submit', (event) => {
  event.preventDefault();
  if (activeRun) stopRun();
  else void send();
});
inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); if (activeRun) stopRun(); else void send(); }
});

function autosize() {
  inputEl.style.height = '0px';
  const height = inputEl.scrollHeight;
  if (height > 48) {
    inputEl.style.height = `${Math.min(height, 154) - 22}px`;
    inputEl.style.overflowY = height > 154 ? 'auto' : 'hidden';
  } else {
    inputEl.style.height = '22px';
    inputEl.style.overflowY = 'hidden';
  }
}
inputEl.addEventListener('input', autosize);

window.addEventListener('pagehide', () => {
  if (activeRun) {
    try { activeRun.port?.postMessage({ t: 'cancel', runId: activeRun.runId }); } catch {}
    for (const controller of activeRun.modelControllers.values()) controller.abort();
    try { activeRun.port?.disconnect(); } catch {}
  }
});
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local' && !activeRun) refreshModels().catch(() => {});
});

(async () => {
  setControlsRunning(true);
  try {
    const currentWindow = await chrome.windows.getCurrent();
    await initializeHistory(currentWindow.id);
    let current = await refreshModels();
    if (current === null) current = await refreshModels();
    if (!current) addMessage('sys', '尚未配置模型：点击上方「＋ 配置模型」添加 API 地址、Key 和模型名。');
    initialized = true;
  } catch (error) {
    addMessage('sys', `初始化失败：${error.message}`);
  } finally {
    setControlsRunning(false);
  }
})();
