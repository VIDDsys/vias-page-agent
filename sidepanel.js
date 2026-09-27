'use strict';

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
let autoStick = true;
let toastTimer;

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    // DOMPurify 禁止 input，任务列表复选框改用自绘 span，避免被剥掉后丢失
    checkbox(checked) { return `<span class="task-checkbox${checked ? ' checked' : ''}" aria-hidden="true"></span>`; },
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
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['img', 'picture', 'source', 'audio', 'video', 'iframe', 'object', 'embed', 'style', 'form', 'input', 'button'],
    FORBID_ATTR: ['style', 'srcset', 'formaction', 'background', 'poster', 'ping', 'action', 'xlink:href'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  }).replace(/<table>/g, '<div class="table-scroll"><table>').replace(/<\/table>/g, '</table></div>');
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

function addMessage(role, text) {
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

function addTools(round, actions) {
  const block = document.createElement('div');
  block.className = 'tools';
  const heading = document.createElement('div');
  heading.className = 'tools-head';
  heading.textContent = `第 ${round} 轮 · ${actions.length} 个操作`;
  block.appendChild(heading);
  const slots = [];
  for (const action of actions) {
    const row = document.createElement('div');
    row.className = 'tool pending';
    const name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = action.action;
    const detail = document.createElement('span');
    detail.className = 'tool-detail';
    const sensitive = /password|密码|验证码|token|secret|银行卡|cvv/i.test(String(action.selector || ''));
    const value = sensitive ? '[已隐藏]' : action.value;
    detail.textContent = `${action.ref != null ? `@${action.ref}` : action.selector || ''}${value != null && value !== '' ? ` ← "${String(value).slice(0, 160)}"` : ''}`;
    const state = document.createElement('span');
    state.className = 'tool-state';
    state.textContent = '…';
    row.append(name, detail, state);
    block.appendChild(row);
    slots.push({ row, state });
  }
  chatEl.appendChild(block);
  scrollBottom();
  return slots;
}

function setStatus(text) {
  statusEl.classList.toggle('show', !!text);
  statusEl.textContent = text || '';
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
  sendEl.textContent = running ? '■' : '➤';
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

function boundedHistory(items) {
  return items.slice(-100).map((item) => ({ role: item.role, content: String(item.content || '').slice(0, 20000) }));
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
  const snapshot = boundedHistory(history);
  return queueSessionWrite(() => chrome.storage.session.set({ [key]: snapshot })).catch((error) => {
    addMessage('sys', `对话保存失败：${error.message}`);
  });
}

async function initializeHistory(windowId) {
  sessionKey = `chat:${windowId}`;
  const stored = await chrome.storage.session.get([sessionKey, 'chat']);
  const saved = Array.isArray(stored[sessionKey]) ? stored[sessionKey] : Array.isArray(stored.chat) ? stored.chat : [];
  history = boundedHistory(saved.filter((item) => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string'));
  if (!stored[sessionKey] && Array.isArray(stored.chat)) {
    const key = sessionKey;
    const snapshot = boundedHistory(history);
    await queueSessionWrite(async () => {
      await chrome.storage.session.set({ [key]: snapshot });
      await chrome.storage.session.remove('chat');
    });
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

function finishRun(context, outcome, error = '') {
  if (!context || context.finished) return;
  context.finished = true;
  clearInterval(context.heartbeat);
  clearTimeout(context.stopFallback);
  for (const controller of context.modelControllers.values()) controller.abort();
  context.modelControllers.clear();
  try { context.port?.disconnect(); } catch {}
  if (activeRun !== context) return;
  activeRun = null;
  setControlsRunning(false);
  setStatus('');
  if (error) addMessage('sys', error);
  else if (outcome === 'cancelled') addMessage('sys', '任务已停止');
  else if (outcome === 'limit') addMessage('sys', '任务达到最大轮数后停止');
  else if (outcome === 'stalled') addMessage('sys', '任务因连续重复或无进展而安全停止');
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
    const text = await globalThis.ViasCore.callModel(message.cfg, message.messages, { signal: controller.signal, timeoutMs: 180000, retries: 2 });
    if (!context.finished && !context.stopRequested && activeRun === context) context.port.postMessage({ t: 'model_response', runId: context.runId, requestId: message.requestId, text });
  } catch (error) {
    if (!context.finished && !context.stopRequested && activeRun === context) context.port.postMessage({ t: 'model_response', runId: context.runId, requestId: message.requestId, error: error.name === 'AbortError' ? '模型请求已取消' : error.message });
  } finally {
    context.modelControllers.delete(message.requestId);
  }
}

function stopRun() {
  const context = activeRun;
  if (!context || context.stopRequested) return;
  context.stopRequested = true;
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
  const question = inputEl.value.trim();
  if (!question || activeRun) return;
  if (!initialized) { addMessage('sys', '侧边栏尚未初始化成功，请关闭后重新打开侧边栏'); return; }
  const context = {
    runId: crypto.randomUUID(),
    port: null,
    heartbeat: null,
    modelControllers: new Map(),
    toolsByRound: new Map(),
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
      else if (message.t === 'say') {
        addMessage('ai', message.text);
        history.push({ role: 'assistant', content: message.text });
        void persist();
      } else if (message.t === 'actions') {
        context.toolsByRound.set(message.round, addTools(message.round, message.actions || []));
      } else if (message.t === 'result') {
        const slot = context.toolsByRound.get(message.round)?.[message.index];
        if (slot) {
          slot.row.classList.remove('pending');
          slot.row.classList.add(message.ok ? 'ok' : 'fail');
          slot.state.textContent = message.ok ? (message.state?.replace('当前值=', '') || '完成') : '失败';
          slot.row.title = message.msg || message.code || '';
        }
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
    const conversation = boundedHistory(history.slice(0, -1));
    // 会话窗口取「提问前最近 100 条」，快照取「含当前提问最近 100 条」；裁剪须在两者都构造完之后
    if (history.length > 100) history.splice(0, history.length - 100);
    port.postMessage({ t: 'RUN', runId: context.runId, tabId: tab.id, question, allowActions, maxSteps: allowActions ? 50 : 1, history: conversation });
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
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); }
});

function autosize() {
  inputEl.style.height = '0px';
  const height = inputEl.scrollHeight;
  if (height > 48) {
    inputEl.style.height = `${Math.min(height, 132) - 16}px`;
    inputEl.style.overflowY = height > 132 ? 'auto' : 'hidden';
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
    if (!chatEl.children.length) addMessage('sys', 'Vias 已就绪\n「执行」可操作当前页面，「问答」只读取页面。复杂任务会持续观察并自动执行页面操作（已开启完全访问权限，全部自动允许）。');
    initialized = true;
  } catch (error) {
    addMessage('sys', `初始化失败：${error.message}`);
  } finally {
    setControlsRunning(false);
  }
})();
