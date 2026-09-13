// Vias 页面感知与操作执行器。所有编号只在当前快照内有效。
(() => {
  'use strict';
  if (window.__viasPageAgentLoaded) return;
  window.__viasPageAgentLoaded = true;

  const TIMING = Object.freeze({ paint: 120, event: 80, settle: 220 });
  const ACTIONS = new Set(['click', 'dblclick', 'hover', 'fill', 'type', 'press', 'select', 'submitForm', 'scroll', 'navigate', 'wait', 'repeat', 'check', 'checkRadio']);
  const TARGET_ACTIONS = new Set(['click', 'dblclick', 'hover', 'fill', 'type', 'select', 'submitForm', 'check', 'checkRadio']);
  const INTERACTIVE_ROLES = new Set(['button', 'radio', 'checkbox', 'option', 'tab', 'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'link', 'textbox', 'combobox', 'slider']);
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'path', 'head', 'link', 'meta', 'template']);
  const SENSITIVE_AUTOCOMPLETE = /(current-password|new-password|one-time-code|cc-|transaction-|webauthn)/i;
  const documentId = crypto.randomUUID();
  const refMap = new Map();
  const operationCache = new Map();
  const cancelledRuns = new Set();
  let snapshotEpoch = 0;
  let currentSnapshotId = '';
  let currentSnapshotUrl = '';
  let mutationVersion = 0;
  let currentSnapshotMutationVersion = -1;
  let extracting = false;
  let executing = false;
  let activeRunId = '';

  const mutationObserver = new MutationObserver((records) => {
    if (records.some((record) => record.type !== 'attributes' || ['id', 'role', 'type', 'name', 'class', 'style', 'hidden', 'disabled', 'readonly', 'href', 'value', 'aria-label', 'aria-hidden', 'aria-disabled', 'aria-checked', 'aria-expanded'].includes(record.attributeName))) mutationVersion++;
  });
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
  document.addEventListener('input', () => { mutationVersion++; }, true);
  document.addEventListener('change', () => { mutationVersion++; }, true);
  addEventListener('popstate', () => { mutationVersion++; });
  addEventListener('hashchange', () => { mutationVersion++; });

  class CancelledError extends Error {
    constructor() { super('操作已取消'); this.name = 'CancelledError'; this.code = 'CANCELLED'; }
  }

  function errorResult(code, message) {
    return { ok: false, code, error: message, msg: message };
  }

  function cleanText(value, max = 80) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function isSensitive(el) {
    if (!(el instanceof Element)) return false;
    return (el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password')
      || SENSITIVE_AUTOCOMPLETE.test(el.getAttribute('autocomplete') || '');
  }

  function assertActive(runId) {
    if (!runId || cancelledRuns.has(runId) || (activeRunId && activeRunId !== runId)) throw new CancelledError();
  }

  function sleep(ms, runId) {
    assertActive(runId);
    const duration = Math.min(30000, Math.max(0, Number(ms) || 0));
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const tick = () => {
        try { assertActive(runId); } catch (error) { reject(error); return; }
        const remaining = duration - (performance.now() - started);
        if (remaining <= 0) resolve();
        else setTimeout(tick, Math.min(100, remaining));
      };
      tick();
    });
  }

  function waitForStable(runId, maxWait = 3000, quiet = 350) {
    assertActive(runId);
    return new Promise((resolve, reject) => {
      if (!document.body) { resolve(); return; }
      let quietTimer;
      let deadline;
      let abortTimer;
      const observer = new MutationObserver(scheduleQuiet);
      function cleanup() {
        observer.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(deadline);
        clearInterval(abortTimer);
      }
      function done() { cleanup(); resolve(); }
      function scheduleQuiet() {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(done, quiet);
      }
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      deadline = setTimeout(done, maxWait);
      quietTimer = setTimeout(done, quiet);
      abortTimer = setInterval(() => {
        try { assertActive(runId); } catch (error) { cleanup(); reject(error); }
      }, 100);
    });
  }

  function rootsFrom(root) {
    const roots = [root];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) if (node.shadowRoot) roots.push(...rootsFrom(node.shadowRoot));
    return roots;
  }

  function queryDeep(selector) {
    for (const root of rootsFrom(document)) {
      const element = root.querySelector(selector);
      if (element) return element;
    }
    return null;
  }

  function isHidden(el) {
    if (!(el instanceof Element)) return false;
    if (el.getAttribute('aria-hidden') === 'true' || el.getAttribute('role') === 'tooltip' || el.hidden) return true;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return true;
    if (style.display === 'contents') return false;
    if (el.checkVisibility) {
      try { return !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch {}
    }
    return el.getClientRects().length === 0;
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') return el.type !== 'hidden';
    if (['select', 'textarea', 'button', 'summary'].includes(tag)) return true;
    if (tag === 'a') return !!(el.getAttribute('href') || cleanText(el.textContent));
    const role = (el.getAttribute('role') || '').toLowerCase();
    return INTERACTIVE_ROLES.has(role)
      || el.hasAttribute('onclick')
      || (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false');
  }

  function visibleText(node, max = 120) {
    const parts = [];
    function visit(current) {
      if (parts.join(' · ').length >= max) return;
      for (const child of current.childNodes || []) {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = cleanText(child.textContent, max);
          if (text && text !== parts.at(-1)) parts.push(text);
        } else if (child.nodeType === Node.ELEMENT_NODE && !SKIP_TAGS.has(child.tagName.toLowerCase()) && !isHidden(child)) {
          visit(child);
          if (child.shadowRoot) visit(child.shadowRoot);
        }
      }
    }
    visit(node);
    return parts.join(' · ').slice(0, max);
  }

  function labelOf(el) {
    const aria = el.getAttribute('aria-label') || el.getAttribute('title');
    if (aria) return cleanText(aria, 60);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (cleanText(text)) return cleanText(text, 60);
    }
    if (el.labels?.length) return visibleText(el.labels[0], 60);
    const parent = el.closest('label');
    if (parent) return visibleText(parent, 60);
    return cleanText(el.placeholder || el.name || el.id, 60);
  }

  function targetForLabel(label) {
    if (label.htmlFor) return document.getElementById(label.htmlFor);
    return label.querySelector('input,select,textarea,button');
  }

  function readState(el) {
    const target = el.tagName === 'LABEL' ? targetForLabel(el) || el : el;
    const tag = target.tagName.toLowerCase();
    if (tag === 'input' && ['checkbox', 'radio'].includes(target.type)) return target.checked ? '已选中' : '未选中';
    if (tag === 'select') return `当前选项=${cleanText(target.selectedOptions[0]?.textContent || target.value, 60)}`;
    if (isSensitive(target)) return target.value ? '已有敏感内容（已隐藏）' : '当前为空';
    if (tag === 'input' || tag === 'textarea') return target.value ? `当前值="${cleanText(target.value, 80)}"` : '当前为空';
    if (target.isContentEditable) return target.textContent.trim() ? `当前内容="${cleanText(target.textContent, 80)}"` : '当前为空';
    const aria = target.getAttribute('aria-checked');
    if (aria != null) return aria === 'true' ? '已选中' : '未选中';
    return '';
  }

  function descriptionOf(el, ref) {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const text = visibleText(el, 80) || labelOf(el);
    if (tag === 'input') {
      if (['checkbox', 'radio'].includes(el.type)) return `[${ref}] 选项「${labelOf(el)}」 类型:${el.type === 'radio' ? '单选' : '复选'} ${el.checked ? '已选中' : '未选'}`;
      return `[${ref}] 输入框(${el.type}) 标签:${labelOf(el)} ${readState(el)}`;
    }
    if (tag === 'textarea') return `[${ref}] 文本域 标签:${labelOf(el)} ${readState(el)}`;
    if (tag === 'select') {
      const options = [...el.options].slice(0, 100).map((option) => `${cleanText(option.textContent, 30)}(value=${cleanText(option.value, 30)})`).join(' | ');
      return `[${ref}] 下拉框 标签:${labelOf(el)} ${readState(el)}\n    选项: ${options.slice(0, 1600)}`;
    }
    if (tag === 'button' || role === 'button') return `[${ref}] 按钮「${text}」`;
    if (tag === 'a' || role === 'link') return `[${ref}] 链接「${text}」`;
    if (tag === 'summary') return `[${ref}] 折叠面板「${text}」`;
    if (el.isContentEditable || role === 'textbox') return `[${ref}] 富文本输入区 标签:${labelOf(el)} ${readState(el)}`;
    return `[${ref}] ${role || '可交互'}「${text}」${readState(el) ? ` ${readState(el)}` : ''}`;
  }

  function directText(el, max = 2000) {
    const text = [...el.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(' ');
    return cleanText(text, max);
  }

  async function fetchImage(url, timeoutMs = 2500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let bitmap;
    try {
      const response = await fetch(url, { credentials: 'include', signal: controller.signal });
      if (!response.ok) return null;
      const blob = await response.blob();
      if (!blob.type.startsWith('image/') || blob.type === 'image/svg+xml' || blob.size > 12_000_000) return null;
      bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.8);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      bitmap?.close?.();
    }
  }

  async function collectImages(runId, enabled) {
    if (!enabled) return { images: [], found: document.querySelectorAll('img,canvas').length };
    const started = performance.now();
    const images = [];
    const seen = new Set();
    let found = 0;
    const push = (value) => { if (value && !seen.has(value) && images.length < 6) { seen.add(value); images.push(value); } };
    for (const img of document.querySelectorAll('img')) {
      assertActive(runId);
      if (images.length >= 4 || performance.now() - started > 9000) break;
      if (!img.currentSrc || isHidden(img)) continue;
      const rect = img.getBoundingClientRect();
      if (Math.max(img.naturalWidth, rect.width, rect.height) < 80) continue;
      found++;
      push(await fetchImage(img.currentSrc));
    }
    for (const canvas of document.querySelectorAll('canvas')) {
      if (images.length >= 6 || performance.now() - started > 9000) break;
      if (isHidden(canvas) || Math.max(canvas.width, canvas.height) < 100) continue;
      found++;
      try {
        const scale = Math.min(1, 1024 / Math.max(canvas.width, canvas.height));
        const copy = document.createElement('canvas');
        copy.width = Math.max(1, Math.round(canvas.width * scale));
        copy.height = Math.max(1, Math.round(canvas.height * scale));
        copy.getContext('2d').drawImage(canvas, 0, 0, copy.width, copy.height);
        push(copy.toDataURL('image/jpeg', 0.8));
      } catch {}
    }
    return { images, found };
  }

  async function buildSnapshot(runId, maxLen = 16000, includeImages = false) {
    assertActive(runId);
    // 图片读取可能持续数秒；必须先完成异步工作，再在同一个同步阶段构建 ref 与版本戳。
    const imageResult = await collectImages(runId, includeImages);
    await waitForStable(runId, 1000, 150);
    assertActive(runId);
    refMap.clear();
    const targets = {};
    const targetMeta = {};
    let ref = 0;
    const lines = [];
    const walk = (root) => {
      for (const el of root.children || []) {
        const tag = el.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag)) continue;
        const style = getComputedStyle(el);
        if (isHidden(el) && style.display !== 'contents') continue;
        if (tag === 'iframe') {
          lines.push(`嵌入页面: ${cleanText(el.title || el.src, 120)}（跨域内容可能无法读取）`);
          continue;
        }
        if (isInteractive(el)) {
          const id = ++ref;
          refMap.set(id, el);
          const description = descriptionOf(el, id);
          targets[id] = description;
          const target = el.tagName === 'LABEL' ? targetForLabel(el) || el : el;
          const tagName = target.tagName.toLowerCase();
          const inputType = tagName === 'input' || tagName === 'button' ? String(target.type || '').toLowerCase() : '';
          targetMeta[id] = {
            description,
            tag: tagName,
            type: inputType,
            role: (target.getAttribute('role') || '').toLowerCase(),
            inForm: !!target.closest('form'),
            submitsForm: target instanceof HTMLFormElement
              || (tagName === 'button' && (!inputType || inputType === 'submit'))
              || (tagName === 'input' && ['submit', 'image'].includes(inputType)),
            sensitive: isSensitive(target),
          };
          lines.push(description);
          if (el.shadowRoot) walk(el.shadowRoot);
          continue;
        }
        if (tag === 'label') {
          // Element UI 等组件库把原生 input 视觉隐藏（opacity:0），label 本身不是 isInteractive，
          // 必须给这种 label 发编号，否则整页选择题没有任何可操作目标。
          const controlled = targetForLabel(el);
          const isToggle = controlled instanceof HTMLInputElement && ['checkbox', 'radio'].includes(controlled.type) && controlled.type !== 'hidden';
          const own = visibleText(el, 120);
          if (isToggle && own) {
            const id = ++ref;
            refMap.set(id, el);
            const description = `[${id}] 选项「${cleanText(own, 60)}」 类型:${controlled.type === 'radio' ? '单选' : '复选'} ${controlled.checked ? '已选中' : '未选'}`;
            targets[id] = description;
            targetMeta[id] = { description, tag: 'label', type: controlled.type, role: '', inForm: !!controlled.closest('form'), submitsForm: false, sensitive: isSensitive(controlled) };
            lines.push(description);
            continue;
          }
          if (own) lines.push(own);
          walk(el);
          if (el.shadowRoot) walk(el.shadowRoot);
          continue;
        } else if (tag === 'li' && !el.children.length) {
          const own = directText(el, 120);
          if (own) {
            const id = ++ref;
            refMap.set(id, el);
            const description = `[${id}] 列表项「${own}」`;
            targets[id] = description;
            targetMeta[id] = { description, tag: 'li', type: '', role: '', inForm: false, submitsForm: false, sensitive: false };
            lines.push(description);
            continue;
          }
        } else {
          const own = directText(el);
          if (own) lines.push(own);
        }
        walk(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    if (document.body) walk(document.body);
    const deduplicated = lines.filter((line, index) => line && line !== lines[index - 1]);
    currentSnapshotUrl = location.href;
    currentSnapshotMutationVersion = mutationVersion;
    currentSnapshotId = `${documentId}:${++snapshotEpoch}:${currentSnapshotMutationVersion}`;
    return {
      snapshotId: currentSnapshotId,
      url: currentSnapshotUrl,
      title: document.title,
      text: deduplicated.join('\n').slice(0, Math.min(50000, Math.max(1000, Number(maxLen) || 16000))),
      targets,
      targetMeta,
      images: imageResult.images,
      hasImgElements: imageResult.found > 0,
    };
  }

  function waitForSelector(selector, timeout, runId) {
    return new Promise((resolve, reject) => {
      let observer;
      let timer;
      let poll;
      function cleanup() { observer?.disconnect(); clearTimeout(timer); clearInterval(poll); }
      function inspect() {
        try {
          assertActive(runId);
          const found = queryDeep(selector);
          if (found) { cleanup(); resolve(found); }
        } catch (error) { cleanup(); reject(error); }
      }
      try { if (queryDeep(selector)) { resolve(queryDeep(selector)); return; } } catch (error) { reject(error); return; }
      observer = new MutationObserver(inspect);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      poll = setInterval(inspect, 100);
      timer = setTimeout(() => { cleanup(); resolve(null); }, Math.min(30000, Math.max(0, timeout)));
    });
  }

  async function resolveTarget(action, runId, options = {}) {
    let element;
    if (action.ref != null) element = refMap.get(Number(action.ref));
    else if (action.selector) {
      try { element = queryDeep(String(action.selector)) || await waitForSelector(String(action.selector), 3000, runId); }
      catch { return { error: errorResult('INVALID_SELECTOR', `选择器语法错误: ${action.selector}`) }; }
    }
    if (!element) return { error: errorResult('TARGET_NOT_FOUND', action.ref != null ? `编号 ${action.ref} 不存在或已过期` : '找不到目标元素') };
    if (!element.isConnected) return { error: errorResult('STALE_TARGET', '目标元素已被页面移除') };
    if (!options.allowHidden && isHidden(element)) return { error: errorResult('TARGET_HIDDEN', '目标元素当前不可见') };
    const target = element.tagName === 'LABEL' ? targetForLabel(element) || element : element;
    if (target.disabled || target.getAttribute('aria-disabled') === 'true') return { error: errorResult('TARGET_DISABLED', '目标元素已禁用') };
    return { element, target };
  }

  function setNativeValue(el, value, emitChange = true) {
    const next = String(value ?? '');
    if (el.value === next) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) throw new Error('目标不支持设置值');
    setter.call(el, next);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: next }));
    if (emitChange) el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function safeLink(element) {
    const anchor = element.tagName === 'A' ? element : element.closest('a');
    if (!anchor) return null;
    const href = anchor.getAttribute('href') || '';
    if (/^\s*(javascript|data|vbscript):/i.test(href)) throw new Error('已阻止不安全链接');
    return anchor;
  }

  async function clickOnce(element, runId, detail = 1) {
    assertActive(runId);
    const anchor = safeLink(element);
    const originalTarget = anchor?.getAttribute('target');
    if (anchor && /^_blank$/i.test(originalTarget || '')) anchor.setAttribute('target', '_self');
    try {
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      await sleep(TIMING.paint, runId);
      const rect = element.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, detail, clientX: Math.round(rect.left + rect.width / 2), clientY: Math.round(rect.top + rect.height / 2) };
      if (window.PointerEvent) element.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      element.dispatchEvent(new MouseEvent('mousedown', init));
      if (window.PointerEvent) element.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      element.dispatchEvent(new MouseEvent('mouseup', init));
      element.dispatchEvent(new MouseEvent('click', init));
      await sleep(TIMING.event, runId);
    } finally {
      if (anchor?.isConnected) {
        if (originalTarget == null) anchor.removeAttribute('target');
        else anchor.setAttribute('target', originalTarget);
      }
    }
  }

  function pageSignature() {
    return `${location.href}|${cleanText(document.body?.innerText, 1000)}`;
  }

  async function performPress(element, value, runId) {
    const requested = String(value || '').trim();
    const aliases = { esc: 'Escape', space: ' ', enter: 'Enter', tab: 'Tab', arrowdown: 'ArrowDown', arrowup: 'ArrowUp', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', backspace: 'Backspace', delete: 'Delete' };
    const key = aliases[requested.toLowerCase()] || requested;
    if (!key || key.length > 20) return errorResult('INVALID_KEY', '按键名称无效');
    element.focus?.();
    const init = { key, code: key === ' ' ? 'Space' : key, bubbles: true, cancelable: true, composed: true };
    const proceed = element.dispatchEvent(new KeyboardEvent('keydown', init));
    if (proceed) {
      if (key === 'Enter') {
        const form = element.form || element.closest?.('form');
        if (form?.requestSubmit) form.requestSubmit();
      } else if (key === ' ' && element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) {
        element.click();
      } else if (key === 'Tab') {
        const focusable = [...document.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter((item) => !isHidden(item) && !item.disabled && item.tabIndex >= 0);
        const index = focusable.indexOf(element);
        focusable[(index + 1) % focusable.length]?.focus();
      }
    }
    element.dispatchEvent(new KeyboardEvent('keyup', init));
    await sleep(TIMING.settle, runId);
    return { ok: true, msg: `已按键 ${requested}`, state: readState(element) };
  }

  async function typeText(element, value, runId) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) return errorResult('NOT_EDITABLE', '目标不是可编辑元素');
    if (element.readOnly) return errorResult('READ_ONLY', '目标为只读');
    const text = String(value ?? '');
    element.scrollIntoView({ block: 'center' });
    element.focus();
    if (!element.isContentEditable && element.value === text) return { ok: true, code: 'NO_CHANGE', msg: '目标已是指定内容', state: readState(element) };
    if (element.isContentEditable) {
      if (element.textContent === text) return { ok: true, code: 'NO_CHANGE', msg: '目标已是指定内容', state: readState(element) };
      element.textContent = '';
    } else {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, '');
    }
    for (const char of text) {
      assertActive(runId);
      const down = element.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true, composed: true }));
      if (down) {
        if (element.isContentEditable) element.textContent += char;
        else Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set?.call(element, element.value + char);
        element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: char }));
      }
      element.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true, cancelable: true, composed: true }));
      await sleep(12, runId);
    }
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, msg: '已逐字输入', state: readState(element) };
  }

  async function executeAction(action, runId, depth = 0, approved = false) {
    assertActive(runId);
    if (!action || typeof action !== 'object' || !ACTIONS.has(action.action)) return errorResult('UNKNOWN_ACTION', `未知操作: ${action?.action || '(空)'}`);
    if (action.action === 'wait') {
      const timeout = Math.min(30000, Math.max(0, Number(action.value ?? 800)));
      if (action.selector) {
        let element;
        try { element = await waitForSelector(String(action.selector), timeout, runId); }
        catch { return errorResult('INVALID_SELECTOR', '等待选择器语法错误'); }
        return element ? { ok: true, msg: '元素已出现' } : errorResult('WAIT_TIMEOUT', '等待元素超时');
      }
      await sleep(timeout, runId);
      return { ok: true, msg: `已等待 ${Math.round(timeout)}ms` };
    }
    if (action.action === 'repeat') {
      if (depth > 0) return errorResult('NESTED_REPEAT', 'repeat 不允许嵌套');
      const times = Number(action.times);
      const interval = Number(action.value ?? 1000);
      if (!Number.isInteger(times) || times < 1 || times > 100 || !Number.isFinite(interval) || interval < 0 || interval > 60000) return errorResult('INVALID_REPEAT', 'repeat 参数无效');
      if (!Array.isArray(action.actions) || !action.actions.length || action.actions.some((item) => item?.action === 'repeat')) return errorResult('INVALID_REPEAT', 'repeat 子操作无效');
      const startUrl = location.href;
      const summaries = [];
      for (let index = 0; index < times; index++) {
        const started = performance.now();
        for (const subAction of action.actions) {
          const result = await executeAction(subAction, runId, depth + 1, approved);
          summaries.push(`第${index + 1}轮:${result.msg || result.error || ''}`);
          if (!result.ok) return errorResult(result.code || 'REPEAT_FAILED', `循环在第 ${index + 1} 轮停止：${result.msg || result.error}`);
          if (location.href !== startUrl) return { ok: true, code: 'NAVIGATED', msg: `循环执行 ${index + 1}/${times} 轮后页面跳转并停止` };
        }
        if (index < times - 1) await sleep(Math.max(0, interval - (performance.now() - started)), runId);
      }
      return { ok: true, msg: `已按 ${Math.round(interval)}ms 周期循环 ${times} 轮。${summaries.slice(-2).join('；').slice(0, 240)}` };
    }
    if (action.action === 'navigate') {
      let url;
      try { url = new URL(String(action.value || ''), location.href); } catch { return errorResult('INVALID_URL', '跳转地址无效'); }
      if (!['http:', 'https:'].includes(url.protocol)) return errorResult('UNSAFE_URL', 'navigate 仅支持 http(s) 地址');
      if (location.href === url.href) return { ok: true, code: 'NO_CHANGE', msg: '已在目标页面' };
      location.assign(url.href);
      return { ok: true, code: 'NAVIGATING', msg: `正在跳转到 ${url.href}` };
    }
    if (action.action === 'scroll') {
      let target = document.scrollingElement || document.documentElement;
      if (action.ref != null || action.selector) {
        const resolved = await resolveTarget(action, runId, { allowHidden: true });
        if (resolved.error) return resolved.error;
        target = resolved.element;
      }
      const value = action.value;
      if (value === 'top') target.scrollTo({ top: 0, behavior: 'smooth' });
      else if (value === 'bottom') target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' });
      else target.scrollBy({ top: Number(value) || 400, behavior: 'smooth' });
      await waitForStable(runId, 2500, 350);
      const top = Math.round(target === document.scrollingElement ? window.scrollY : target.scrollTop);
      const height = target.scrollHeight;
      const viewport = target === document.scrollingElement ? innerHeight : target.clientHeight;
      return { ok: true, msg: `已滚动：位置 ${top}/${height}px${top + viewport >= height - 2 ? '，已到底部' : ''}` };
    }

    let resolved;
    if (action.action === 'press' && action.ref == null && !action.selector) resolved = { element: document.activeElement || document.body, target: document.activeElement || document.body };
    else resolved = await resolveTarget(action, runId);
    if (resolved.error) return resolved.error;
    const { element, target } = resolved;
    if (TARGET_ACTIONS.has(action.action) && !element) return errorResult('MISSING_TARGET', '操作缺少目标');

    const tagName = target.tagName.toLowerCase();
    const inputType = tagName === 'input' || tagName === 'button' ? String(target.type || '').toLowerCase() : '';
    const submitsForm = target instanceof HTMLFormElement
      || (tagName === 'button' && (!inputType || inputType === 'submit'))
      || (tagName === 'input' && ['submit', 'image'].includes(inputType));
    const enterSubmits = action.action === 'press' && String(action.value || '').trim().toLowerCase() === 'enter' && !!(target.form || target.closest?.('form'));
    if (!approved && (action.action === 'submitForm' || enterSubmits || (['click', 'dblclick'].includes(action.action) && submitsForm))) {
      return errorResult('APPROVAL_REQUIRED', '此操作可能提交表单，必须先获得用户确认');
    }

    if (action.action === 'press') return performPress(target, action.value, runId);
    if (action.action === 'hover') {
      element.scrollIntoView({ block: 'center' });
      const rect = element.getBoundingClientRect();
      const init = { bubbles: true, composed: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      if (window.PointerEvent) element.dispatchEvent(new PointerEvent('pointerover', { ...init, pointerType: 'mouse', pointerId: 1, isPrimary: true }));
      element.dispatchEvent(new MouseEvent('mouseover', init));
      element.dispatchEvent(new MouseEvent('mousemove', init));
      await waitForStable(runId, 2000, 300);
      return { ok: true, msg: '已悬停目标' };
    }
    if (action.action === 'check' || action.action === 'checkRadio') {
      const checkbox = target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type) ? target : null;
      if (checkbox?.checked || target.getAttribute('aria-checked') === 'true') return { ok: true, code: 'NO_CHANGE', msg: '目标已选中', state: '已选中' };
      // label 引用时 target 是其内部 input，直接点 input 保证原生翻转与 change 事件
      await clickOnce(checkbox || element, runId);
      return { ok: true, msg: '已选中目标', state: readState(element) };
    }
    if (action.action === 'click') {
      const before = pageSignature();
      // 复选/单选目标直接点 input，避免合成点击 label 时激活行为不生效导致翻转失败
      const toggle = target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type);
      try { await clickOnce(toggle ? target : element, runId); } catch (error) { return errorResult('CLICK_BLOCKED', error.message); }
      await waitForStable(runId, 2500, 350);
      return { ok: true, msg: `已点击${pageSignature() !== before ? '，页面已更新' : ''}`, state: element.isConnected ? readState(element) : '页面已更新' };
    }
    if (action.action === 'dblclick') {
      const before = pageSignature();
      await clickOnce(element, runId, 1);
      await clickOnce(element, runId, 2);
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, view: window, button: 0, detail: 2, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
      await waitForStable(runId, 2000, 350);
      return { ok: true, msg: `已双击${pageSignature() !== before ? '，页面已更新' : ''}`, state: element.isConnected ? readState(element) : '页面已更新' };
    }
    if (action.action === 'type') return typeText(target, action.value, runId);
    if (action.action === 'fill') {
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable)) return errorResult('NOT_EDITABLE', '目标不是可编辑元素');
      if (target.readOnly) return errorResult('READ_ONLY', '目标为只读');
      target.scrollIntoView({ block: 'center' });
      target.focus();
      const next = String(action.value ?? '');
      let changed = false;
      if (target.isContentEditable) {
        changed = target.textContent !== next;
        if (changed) {
          target.textContent = next;
          target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: next }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else changed = setNativeValue(target, next);
      target.blur();
      await sleep(TIMING.event, runId);
      return { ok: true, code: changed ? 'FILLED' : 'NO_CHANGE', msg: changed ? '已填写目标' : '目标已是指定内容', state: readState(target) };
    }
    if (action.action === 'select') {
      if (!(target instanceof HTMLSelectElement)) return errorResult('NOT_SELECT', 'select 仅支持原生下拉框');
      const requested = String(action.value ?? '');
      const exact = [...target.options].filter((option) => option.value === requested || option.textContent.trim() === requested);
      const prefix = exact.length ? [] : [...target.options].filter((option) => option.textContent.trim().startsWith(requested));
      const hit = exact[0] || (prefix.length === 1 ? prefix[0] : null);
      if (!hit) return errorResult('OPTION_NOT_FOUND', prefix.length > 1 ? '选项前缀不唯一' : '选项不存在');
      const changed = setNativeValue(target, hit.value);
      return { ok: true, code: changed ? 'SELECTED' : 'NO_CHANGE', msg: changed ? `已选择「${cleanText(hit.textContent, 60)}」` : '已是指定选项', state: readState(target) };
    }
    if (action.action === 'submitForm') {
      const form = target instanceof HTMLFormElement ? target : target.form || target.closest('form');
      if (!form) {
        await clickOnce(element, runId);
        await waitForStable(runId, 3500, 500);
        return { ok: true, msg: '已点击提交目标' };
      }
      if (!form.reportValidity()) return errorResult('FORM_INVALID', '表单校验未通过，未提交');
      const submitter = target instanceof HTMLElement && ['BUTTON', 'INPUT'].includes(target.tagName) ? target : undefined;
      if (form.requestSubmit) form.requestSubmit(submitter);
      else form.submit();
      await waitForStable(runId, 3500, 500);
      return { ok: true, msg: '已提交表单' };
    }
    return errorResult('UNKNOWN_ACTION', `未知操作: ${action.action}`);
  }

  function pruneCache() {
    while (operationCache.size > 100) operationCache.delete(operationCache.keys().next().value);
  }

  async function executeBatch(message) {
    if (!message.runId || !message.operationId || !message.snapshotId) return { results: [errorResult('INVALID_REQUEST', '缺少 runId、operationId 或 snapshotId')] };
    if (message.snapshotId !== currentSnapshotId || currentSnapshotUrl !== location.href || currentSnapshotMutationVersion !== mutationVersion) {
      return { results: [errorResult('STALE_SNAPSHOT', '页面已在快照后发生变化，请重新读取页面')] };
    }
    if (!Array.isArray(message.actions) || message.actions.length < 1 || message.actions.length > 20) return { results: [errorResult('INVALID_ACTIONS', '操作数量必须为 1-20')] };
    if (executing) return { results: [errorResult('BUSY', '页面正在执行另一批操作')] };
    activeRunId = message.runId;
    assertActive(message.runId);
    executing = true;
    const results = [];
    const startUrl = location.href;
    try {
      for (let index = 0; index < message.actions.length; index++) {
        if (location.href !== startUrl) {
          results.push(errorResult('SKIPPED_AFTER_NAVIGATION', '页面已跳转，本批剩余操作已跳过'));
          continue;
        }
        try {
          const result = await executeAction(message.actions[index], message.runId, 0, true); // 完全访问权限：不再要求审批
          results.push(result);
          if (!result.ok && !['WAIT_TIMEOUT', 'TARGET_NOT_FOUND'].includes(result.code)) {
            for (let rest = index + 1; rest < message.actions.length; rest++) results.push(errorResult('SKIPPED_AFTER_FAILURE', '前序操作失败，已跳过'));
            break;
          }
        } catch (error) {
          const code = error.code || (error.name === 'CancelledError' ? 'CANCELLED' : 'ACTION_ERROR');
          results.push(errorResult(code, error.message || String(error)));
          for (let rest = index + 1; rest < message.actions.length; rest++) results.push(errorResult('SKIPPED_AFTER_FAILURE', '前序操作中止，已跳过'));
          break;
        }
        if (index < message.actions.length - 1) await sleep(TIMING.settle, message.runId);
      }
      let page;
      try { page = await buildSnapshot(message.runId, 12000, message.includeImages === true); }
      catch (error) { if (error.name !== 'CancelledError') throw error; }
      return { results, page };
    } finally {
      executing = false;
      if (activeRunId === message.runId) activeRunId = '';
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ABORT') {
      if (message.runId) cancelledRuns.add(message.runId);
      if (cancelledRuns.size > 100) cancelledRuns.delete(cancelledRuns.values().next().value);
      return;
    }
    if (message.type === 'EXTRACT') {
      if (!message.runId) { sendResponse(errorResult('INVALID_REQUEST', '缺少 runId')); return; }
      if (executing || extracting) { sendResponse(errorResult('BUSY', '页面正在处理另一项请求')); return; }
      activeRunId = message.runId;
      extracting = true;
      waitForStable(message.runId, 1500, 250)
        .then(() => buildSnapshot(message.runId, message.maxLen, message.includeImages === true))
        .then(sendResponse)
        .catch((error) => sendResponse(errorResult(error.code || 'EXTRACT_ERROR', error.message || String(error))))
        .finally(() => { extracting = false; if (activeRunId === message.runId) activeRunId = ''; });
      return true;
    }
    if (message.type === 'EXECUTE') {
      const key = String(message.operationId || '');
      if (key && operationCache.has(key)) {
        operationCache.get(key).then(sendResponse);
        return true;
      }
      const pending = executeBatch(message).catch((error) => ({ results: [errorResult(error.code || 'EXECUTE_ERROR', error.message || String(error))] }));
      if (key) { operationCache.set(key, pending); pruneCache(); }
      pending.then(sendResponse);
      return true;
    }
  });
})();
