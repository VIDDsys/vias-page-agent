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
  // 纯 http 页面不是安全上下文，randomUUID 不可用；退化到时间戳+随机数，仅作快照命名空间
  const documentId = crypto.randomUUID?.() || `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const refMap = new Map();
  const refFingerprints = new Map();
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
  let activeOperation = null;

  const mutationObserver = new MutationObserver((records) => {
    if (records.some((record) => record.type !== 'attributes' || ['id', 'role', 'type', 'name', 'class', 'style', 'hidden', 'disabled', 'readonly', 'href', 'value', 'aria-label', 'aria-hidden', 'aria-disabled', 'aria-checked', 'aria-expanded'].includes(record.attributeName))) mutationVersion++;
  });
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['id', 'role', 'type', 'name', 'class', 'style', 'hidden', 'disabled', 'readonly', 'href', 'value', 'aria-label', 'aria-hidden', 'aria-disabled', 'aria-checked', 'aria-expanded'] });
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

  function navigationResult() {
    const operation = activeOperation;
    if (!operation) return null;
    const moved = location.href !== operation.startUrl;
    if (!moved && !operation.navigationStarted) return null;
    return {
      ok: true,
      code: moved ? 'NAVIGATED' : 'NAVIGATING',
      ...(moved || operation.navigationUrl ? { navigationUrl: moved ? location.href : operation.navigationUrl } : {}),
      msg: '页面正在或已经跳转，本批剩余操作已停止',
    };
  }

  function assertActive(runId) {
    if (!runId || cancelledRuns.has(runId) || (activeRunId && activeRunId !== runId)) throw new CancelledError();
    const navigation = activeOperation?.runId === runId && navigationResult();
    if (navigation) throw Object.assign(new Error(navigation.msg), navigation);
  }

  function sleep(ms, runId) {
    assertActive(runId);
    // wait 自行限制 30 秒；repeat 的合法周期可达 60 秒，不能在公共等待中截短。
    const duration = Math.min(60000, Math.max(0, Number(ms) || 0));
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
      function done() {
        cleanup();
        try { assertActive(runId); resolve(); } catch (error) { reject(error); }
      }
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
      if (isSensitive(current) || parts.join(' · ').length >= max) return;
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
    if (isSensitive(target)) return (target.value || (target.isContentEditable && target.textContent)) ? '已有敏感内容（已隐藏）' : '当前为空';
    if (tag === 'input' && ['checkbox', 'radio'].includes(target.type)) return target.checked ? '已选中' : '未选中';
    if (tag === 'select') return `当前选项=${cleanText(target.selectedOptions[0]?.textContent || target.value, 60)}`;
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
      if (isSensitive(el)) return `[${ref}] 下拉框 标签:${labelOf(el)} ${readState(el)}（敏感选项已隐藏）`;
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

  // 目标身份指纹：只含稳定特征（标签/类型/角色/名称/文字），刻意排除 checked、value 等会被操作改变的属性。
  // 用于执行前逐目标核验：若编号指向的节点已被复用成别的内容（乱序页常见），据指纹不符判定失效，避免点错。
  function fingerprintOf(el) {
    if (el === document.body || el === document.documentElement) return el === document.body ? 'body' : 'html';
    const tag = el.tagName.toLowerCase();
    if (tag === 'label') return `label|${visibleText(el, 120)}`;
    if (tag === 'input') return `input|${String(el.type || '').toLowerCase()}|${cleanText(el.getAttribute('aria-label') || el.getAttribute('title') || el.placeholder || el.name || el.id || '')}`;
    if (tag === 'textarea') return `textarea|${cleanText(el.getAttribute('aria-label') || el.getAttribute('title') || el.placeholder || el.name || el.id || '')}`;
    if (tag === 'select') return `select|${labelOf(el)}`;
    const role = (el.getAttribute('role') || '').toLowerCase();
    // 富文本的正文也是可变值，不能把本批合法输入当作节点身份变化。
    if (el.isContentEditable || role === 'textbox') return `${tag}|${role}|${labelOf(el)}`;
    const text = visibleText(el, 120) || labelOf(el);
    let href = '';
    if (tag === 'a' || role === 'link') {
      const raw = el.getAttribute('href');
      if (raw != null) {
        try { href = new URL(raw, document.baseURI).href; }
        catch { href = raw.trim(); }
      }
    }
    return `${tag}|${role}|${text}|${href}`;
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
    refFingerprints.clear();
    // 重建期间旧快照立即失效：若 walk 中途抛错，绝不让旧编号解析到新元素
    currentSnapshotId = '';
    const targets = {};
    const targetMeta = {};
    const mappedControls = new Set();
    const budget = Math.min(50000, Math.max(1000, Number(maxLen) || 16000));
    let ref = 0;
    let text = '';
    let previousLine = '';
    const append = (line) => {
      if (!line || line === previousLine || text.length >= budget) return false;
      previousLine = line;
      const addition = (text ? '\n' : '') + line;
      const complete = text.length + addition.length <= budget;
      text += addition.slice(0, budget - text.length);
      return complete;
    };
    const addTarget = (el, describe = (id) => descriptionOf(el, id)) => {
      const target = el.tagName === 'LABEL' ? targetForLabel(el) || el : el;
      if (mappedControls.has(target)) return;
      mappedControls.add(target);
      const id = ref + 1;
      let description = describe(id);
      const remaining = budget - text.length - (text ? 1 : 0);
      if (description.length > remaining) {
        const title = description.split('\n')[0];
        // 编号与完整标题是原子记录；只截短多行详情，绝不输出无法执行的半条 ref。
        if (title.length > remaining) return;
        const omitted = ' …（选项已省略）';
        const detailBudget = remaining - title.length - 1 - omitted.length;
        description = title;
        if (detailBudget >= 0) {
          const detail = describe(id).slice(title.length + 1, title.length + 1 + detailBudget);
          description += `\n${detail}${omitted}`;
        } else if (remaining >= title.length + 4) description += '（省略）';
      }
      if (!append(description)) return;
      ref = id;
      refMap.set(id, el);
      refFingerprints.set(id, fingerprintOf(el));
      targets[id] = description;
      const tagName = target.tagName.toLowerCase();
      const inputType = tagName === 'input' || tagName === 'button' ? String(target.type || '').toLowerCase() : '';
      targetMeta[id] = {
        tag: el.tagName === 'LABEL' ? 'label' : tagName,
        type: inputType,
        role: (target.getAttribute('role') || '').toLowerCase(),
        inForm: !!(target.form || target.closest('form')),
        submitsForm: target instanceof HTMLFormElement
          || (tagName === 'button' && (!inputType || inputType === 'submit'))
          || (tagName === 'input' && ['submit', 'image'].includes(inputType)),
        sensitive: isSensitive(target),
      };
    };
    const walk = (root, controlsOnly = false) => {
      for (const el of root.children || []) {
        if (text.length >= budget) return;
        const tag = el.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag)) continue;
        const style = getComputedStyle(el);
        if (isHidden(el) && style.display !== 'contents') continue;
        if (tag === 'iframe') {
          if (!controlsOnly) append(`嵌入页面: ${cleanText(el.title || el.src, 120)}（跨域内容可能无法读取）`);
          continue;
        }
        if (tag === 'label') {
          // 隐藏原生 input 的组件仍通过 label 操作；同一控件只发一个 ref。
          const controlled = targetForLabel(el);
          const isToggle = controlled instanceof HTMLInputElement && ['checkbox', 'radio'].includes(controlled.type);
          const own = visibleText(el, 120);
          if (isToggle && own) {
            addTarget(el, (id) => `[${id}] 选项「${cleanText(own, 60)}」 类型:${controlled.type === 'radio' ? '单选' : '复选'} ${controlled.checked ? '已选中' : '未选'}`);
            walk(el, true);
            if (el.shadowRoot) walk(el.shadowRoot, true);
            continue;
          }
        }
        if (isInteractive(el)) {
          addTarget(el);
          // 父级描述已包含普通文字，但不能吞掉内部真正的 input/button 等控件。
          if (!isSensitive(el) && !['select', 'textarea'].includes(tag)) {
            walk(el, true);
            if (el.shadowRoot) walk(el.shadowRoot, true);
          }
          continue;
        }
        if (tag === 'label') {
          if (!controlsOnly) append(visibleText(el, 120));
          walk(el, true);
          if (el.shadowRoot) walk(el.shadowRoot, true);
          continue;
        } else if (!controlsOnly && tag === 'li' && !el.children.length) {
          const own = directText(el, 120);
          if (own) {
            addTarget(el, (id) => `[${id}] 列表项「${own}」`);
            continue;
          }
        } else if (!controlsOnly) {
          append(directText(el));
        }
        walk(el, controlsOnly);
        if (el.shadowRoot) walk(el.shadowRoot, controlsOnly);
      }
    };
    if (document.body) walk(document.body);
    currentSnapshotUrl = location.href;
    currentSnapshotMutationVersion = mutationVersion;
    currentSnapshotId = `${documentId}:${++snapshotEpoch}:${currentSnapshotMutationVersion}`;
    return {
      snapshotId: currentSnapshotId,
      url: currentSnapshotUrl,
      title: document.title,
      text,
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
      try {
        assertActive(runId);
        const found = queryDeep(selector);
        if (found) { resolve(found); return; }
      } catch (error) { reject(error); return; }
      observer = new MutationObserver(inspect);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      poll = setInterval(inspect, 100);
      timer = setTimeout(() => {
        cleanup();
        try { assertActive(runId); resolve(null); } catch (error) { reject(error); }
      }, Math.min(30000, Math.max(0, timeout)));
    });
  }

  async function resolveTarget(action, runId, options = {}) {
    let element;
    if (action.ref != null) element = refMap.get(Number(action.ref));
    else if (action.selector) {
      try { element = queryDeep(String(action.selector)) || await waitForSelector(String(action.selector), 3000, runId); }
      catch (error) {
        if (typeof error.code === 'string') throw error;
        return { error: errorResult('INVALID_SELECTOR', `选择器语法错误: ${action.selector}`) };
      }
    }
    assertActive(runId);
    if (!element) return { error: errorResult('TARGET_NOT_FOUND', action.ref != null ? `编号 ${action.ref} 不存在或已过期` : '找不到目标元素') };
    if (!element.isConnected) return { error: errorResult('STALE_TARGET', '目标元素已被页面移除') };
    if (action.ref != null && options.verifyFingerprint !== false) {
      const recorded = refFingerprints.get(Number(action.ref));
      if (recorded && fingerprintOf(element) !== recorded) return { error: errorResult('STALE_TARGET', `编号 ${action.ref} 的目标内容已变化，请重新读取页面`) };
    }
    if (!options.allowHidden && isHidden(element)) return { error: errorResult('TARGET_HIDDEN', '目标元素当前不可见') };
    const target = element.tagName === 'LABEL' ? targetForLabel(element) || element : element;
    if (target.disabled || target.getAttribute('aria-disabled') === 'true') return { error: errorResult('TARGET_DISABLED', '目标元素已禁用') };
    return bindTarget(element, runId);
  }

  function bindTarget(element, runId) {
    const target = element.tagName === 'LABEL' ? targetForLabel(element) || element : element;
    const recorded = fingerprintOf(element);
    const targetRecorded = fingerprintOf(target);
    const anchor = element.closest('a');
    const linkRecorded = anchor && fingerprintOf(anchor);
    const form = target.form || target.closest('form');
    const formIdentity = () => form ? `${form.action}|${form.method}|${form.target}|${target.getAttribute('formaction') || ''}|${target.getAttribute('formmethod') || ''}` : '';
    const formRecorded = formIdentity();
    const verify = (click = false) => {
      assertActive(runId);
      if (!element.isConnected || !target.isConnected || fingerprintOf(element) !== recorded
          || fingerprintOf(target) !== targetRecorded
          || (element.tagName === 'LABEL' && (targetForLabel(element) || element) !== target)
          || (target.form || target.closest('form')) !== form || formIdentity() !== formRecorded
          || (click && (element.closest('a') !== anchor || (anchor && fingerprintOf(anchor) !== linkRecorded)))) {
        throw Object.assign(new Error('目标身份在操作准备期间变化，请重新读取页面'), { code: 'STALE_TARGET' });
      }
      if (target.disabled || target.getAttribute('aria-disabled') === 'true') {
        throw Object.assign(new Error('目标元素已禁用'), { code: 'TARGET_DISABLED' });
      }
      if (click) safeLink(element);
    };
    return { element, target, verify };
  }

  function setNativeValue(el, value, emitChange = true, verify = () => {}) {
    const next = String(value ?? '');
    if (el.value === next) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) throw new Error('目标不支持设置值');
    verify();
    setter.call(el, next);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: next }));
    if (emitChange) { verify(); el.dispatchEvent(new Event('change', { bubbles: true })); }
    return true;
  }

  function safeLink(element) {
    const anchor = element.tagName === 'A' ? element : element.closest('a');
    if (!anchor) return null;
    const href = anchor.getAttribute('href') || '';
    const protocol = new URL(href, document.baseURI).protocol;
    if (['javascript:', 'data:', 'vbscript:'].includes(protocol)) throw new Error('已阻止不安全链接');
    return anchor;
  }

  async function clickOnce(element, runId, verify, detail = 1) {
    verify(true);
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(TIMING.paint, runId);
    verify(true);
    const anchor = safeLink(element);
    const originalTarget = anchor?.getAttribute('target');
    if (anchor && /^_blank$/i.test(originalTarget || '')) anchor.setAttribute('target', '_self');
    try {
      const rect = element.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, detail, clientX: Math.round(rect.left + rect.width / 2), clientY: Math.round(rect.top + rect.height / 2) };
      // 每个前置事件都可能同步复用/移除节点或发起导航，不能只在整串事件前检查一次。
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        verify(true);
        if (type.startsWith('pointer')) {
          if (window.PointerEvent) element.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        } else element.dispatchEvent(new MouseEvent(type, init));
      }
      await sleep(TIMING.event, runId);
    } finally {
      // 页面可能在点击串中移除并稍后重挂 anchor；无条件恢复，避免 target=_self 永久泄漏
      if (anchor) {
        if (originalTarget == null) anchor.removeAttribute('target');
        else anchor.setAttribute('target', originalTarget);
      }
    }
  }

  function pageSignature() {
    return `${location.href}|${cleanText(document.body?.innerText, 1000)}`;
  }

  async function performPress(element, value, runId, verify) {
    const requested = String(value || '').trim();
    const aliases = { esc: 'Escape', space: ' ', enter: 'Enter', tab: 'Tab', arrowdown: 'ArrowDown', arrowup: 'ArrowUp', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', backspace: 'Backspace', delete: 'Delete' };
    const key = aliases[requested.toLowerCase()] || requested;
    if (!key || key.length > 20) return errorResult('INVALID_KEY', '按键名称无效');
    verify();
    element.focus?.();
    verify();
    const init = { key, code: key === ' ' ? 'Space' : key, bubbles: true, cancelable: true, composed: true };
    const proceed = element.dispatchEvent(new KeyboardEvent('keydown', init));
    verify();
    if (proceed) {
      if (key === 'Enter') {
        // 浏览器原生行为：textarea/富文本内 Enter 是换行而不是提交表单
        if (element instanceof HTMLTextAreaElement) {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(element, element.value + '\n');
          element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertLineBreak', data: '\n' }));
        } else if (element.isContentEditable) {
          // fill 后无选区，光标通常在开头：先把选区折叠到末尾再插入换行
          const selection = getSelection();
          const range = document.createRange();
          range.selectNodeContents(element);
          range.collapse(false);
          selection?.removeAllRanges();
          selection?.addRange(range);
          try { document.execCommand('insertText', false, '\n'); } catch {}
        } else {
          const form = element.form || element.closest?.('form');
          if (form?.requestSubmit) form.requestSubmit();
        }
      } else if (key === ' ' && element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) {
        element.click();
      } else if (key === 'Tab') {
        const focusable = [...document.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter((item) => !isHidden(item) && !item.disabled && item.tabIndex >= 0);
        const index = focusable.indexOf(element);
        focusable[(index + 1) % focusable.length]?.focus();
      }
    }
    assertActive(runId);
    element.dispatchEvent(new KeyboardEvent('keyup', init));
    await sleep(TIMING.settle, runId);
    return { ok: true, msg: `已按键 ${requested}`, state: readState(element) };
  }

  async function typeText(element, value, runId, verify) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) return errorResult('NOT_EDITABLE', '目标不是可编辑元素');
    if (element instanceof HTMLInputElement && element.type === 'file') return errorResult('NOT_EDITABLE', '文件上传暂不支持，请手动选择文件');
    if (element.readOnly) return errorResult('READ_ONLY', '目标为只读');
    const text = String(value ?? '');
    verify();
    element.scrollIntoView({ block: 'center' });
    verify();
    element.focus();
    verify();
    if (element.readOnly) return errorResult('READ_ONLY', '目标为只读');
    if (!element.isContentEditable && element.value === text) return { ok: true, code: 'NO_CHANGE', msg: '目标已是指定内容', state: readState(element) };
    if (element.isContentEditable) {
      if (element.textContent === text) return { ok: true, code: 'NO_CHANGE', msg: '目标已是指定内容', state: readState(element) };
      element.textContent = '';
    } else {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, '');
    }
    for (const char of text) {
      verify();
      const down = element.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true, composed: true }));
      verify();
      if (down) {
        if (element.isContentEditable) element.textContent += char;
        else Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set?.call(element, element.value + char);
        element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: char }));
      }
      verify();
      element.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true, cancelable: true, composed: true }));
      await sleep(12, runId);
    }
    verify();
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, msg: '已逐字输入', state: readState(element) };
  }

  function isNavigationResult(result) {
    return ['NAVIGATING', 'NAVIGATED'].includes(result?.code);
  }

  function skippedAfterNavigation() {
    const result = errorResult('SKIPPED_AFTER_NAVIGATION', '页面正在或已经跳转，本批剩余操作已跳过');
    const operation = activeOperation;
    if (operation?.navigationUrl) result.navigationUrl = operation.navigationUrl;
    else if (operation && location.href !== operation.startUrl) result.navigationUrl = location.href;
    return result;
  }

  async function executeAction(action, runId, depth = 0, approved = false) {
    try {
      const result = await performAction(action, runId, depth, approved);
      return isNavigationResult(result) ? result : navigationResult() || result;
    } catch (error) {
      if (isNavigationResult(error)) return navigationResult();
      if (error.code === 'STALE_TARGET') return errorResult(error.code, error.message);
      throw error;
    }
  }

  async function performAction(action, runId, depth, approved) {
    assertActive(runId);
    if (!action || typeof action !== 'object' || !ACTIONS.has(action.action)) return errorResult('UNKNOWN_ACTION', `未知操作: ${action?.action || '(空)'}`);
    if (action.action === 'wait') {
      const timeout = Math.min(30000, Math.max(0, Number(action.value ?? 800)));
      if (action.selector) {
        let element;
        try { element = await waitForSelector(String(action.selector), timeout, runId); }
        catch (error) {
          if (typeof error.code === 'string') throw error;
          return errorResult('INVALID_SELECTOR', '等待选择器语法错误');
        }
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
      const summaries = [];
      for (let index = 0; index < times; index++) {
        assertActive(runId);
        const started = performance.now();
        const roundResults = [];
        for (let subIndex = 0; subIndex < action.actions.length; subIndex++) {
          const result = await executeAction(action.actions[subIndex], runId, depth + 1, approved);
          roundResults.push(result);
          summaries.push(`第${index + 1}轮:${result.msg || result.error || ''}`);
          if (isNavigationResult(result)) {
            for (let rest = subIndex + 1; rest < action.actions.length; rest++) roundResults.push(skippedAfterNavigation());
            return { ...result, msg: `循环执行 ${index + 1}/${times} 轮后因导航停止`, results: roundResults };
          }
          if (!result.ok) return errorResult(result.code || 'REPEAT_FAILED', `循环在第 ${index + 1} 轮停止：${result.msg || result.error}`);
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
      activeOperation.navigationStarted = true;
      activeOperation.navigationUrl = url.href;
      return { ok: true, code: 'NAVIGATING', navigationUrl: url.href, msg: `正在跳转到 ${url.href}` };
    }
    if (action.action === 'scroll') {
      let target = document.scrollingElement || document.documentElement;
      if (action.ref != null || action.selector) {
        const resolved = await resolveTarget(action, runId, { allowHidden: true });
        if (resolved.error) return resolved.error;
        resolved.verify();
        target = resolved.element;
      }
      assertActive(runId);
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
    if (action.action === 'press' && action.ref == null && !action.selector) resolved = bindTarget(document.activeElement || document.body, runId);
    else resolved = await resolveTarget(action, runId);
    if (resolved.error) return resolved.error;
    const { element, target, verify } = resolved;
    if (TARGET_ACTIONS.has(action.action) && !element) return errorResult('MISSING_TARGET', '操作缺少目标');
    verify();

    const tagName = target.tagName.toLowerCase();
    const inputType = tagName === 'input' || tagName === 'button' ? String(target.type || '').toLowerCase() : '';
    const submitsForm = target instanceof HTMLFormElement
      || (tagName === 'button' && (!inputType || inputType === 'submit'))
      || (tagName === 'input' && ['submit', 'image'].includes(inputType));
    const enterSubmits = action.action === 'press' && String(action.value || '').trim().toLowerCase() === 'enter' && !!(target.form || target.closest?.('form'));
    if (!approved && (action.action === 'submitForm' || enterSubmits || (['click', 'dblclick'].includes(action.action) && submitsForm))) {
      return errorResult('APPROVAL_REQUIRED', '此操作可能提交表单，必须先获得用户确认');
    }

    if (action.action === 'press') return performPress(target, action.value, runId, verify);
    if (action.action === 'hover') {
      element.scrollIntoView({ block: 'center' });
      verify();
      const rect = element.getBoundingClientRect();
      const init = { bubbles: true, composed: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      if (window.PointerEvent) element.dispatchEvent(new PointerEvent('pointerover', { ...init, pointerType: 'mouse', pointerId: 1, isPrimary: true }));
      verify();
      element.dispatchEvent(new MouseEvent('mouseover', init));
      verify();
      element.dispatchEvent(new MouseEvent('mousemove', init));
      await waitForStable(runId, 2000, 300);
      return { ok: true, msg: '已悬停目标' };
    }
    if (action.action === 'check' || action.action === 'checkRadio') {
      const checkbox = target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type) ? target : null;
      // 原生控件以 checked 为准（aria 可能与实际状态脱节）；仅非原生 ARIA 控件才信 aria-checked
      if (checkbox?.checked || (!checkbox && target.getAttribute('aria-checked') === 'true')) return { ok: true, code: 'NO_CHANGE', msg: '目标已选中', state: '已选中' };
      // label 引用时 target 是其内部 input，直接点 input 保证原生翻转与 change 事件
      await clickOnce(checkbox || element, runId, verify);
      return { ok: true, msg: '已选中目标', state: readState(element) };
    }
    if (action.action === 'click') {
      const before = pageSignature();
      // 复选/单选目标直接点 input，避免合成点击 label 时激活行为不生效导致翻转失败
      const toggle = target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type);
      // 预记链接目标：原生导航触发 beforeunload 时 URL 尚未提交，让跳过结果能带上 navigationUrl
      try {
        const anchor = element.closest('a');
        const href = anchor?.getAttribute('href');
        if (href) activeOperation.navigationUrl = new URL(href, document.baseURI).href;
      } catch {}
      try { await clickOnce(toggle ? target : element, runId, verify); }
      catch (error) {
        if (typeof error.code === 'string') throw error;
        return errorResult('CLICK_BLOCKED', error.message);
      }
      await waitForStable(runId, 2500, 350);
      return { ok: true, msg: `已点击${pageSignature() !== before ? '，页面已更新' : ''}`, state: element.isConnected ? readState(element) : '页面已更新' };
    }
    if (action.action === 'dblclick') {
      const before = pageSignature();
      await clickOnce(element, runId, verify, 1);
      await clickOnce(element, runId, verify, 2);
      verify(true);
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, view: window, button: 0, detail: 2, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
      await waitForStable(runId, 2000, 350);
      return { ok: true, msg: `已双击${pageSignature() !== before ? '，页面已更新' : ''}`, state: element.isConnected ? readState(element) : '页面已更新' };
    }
    if (action.action === 'type') return typeText(target, action.value, runId, verify);
    if (action.action === 'fill') {
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable)) return errorResult('NOT_EDITABLE', '目标不是可编辑元素');
      if (target instanceof HTMLInputElement && target.type === 'file') return errorResult('NOT_EDITABLE', '文件上传暂不支持，请手动选择文件');
      if (target.readOnly) return errorResult('READ_ONLY', '目标为只读');
      target.scrollIntoView({ block: 'center' });
      verify();
      target.focus();
      verify();
      if (target.readOnly) return errorResult('READ_ONLY', '目标为只读');
      const next = String(action.value ?? '');
      let changed = false;
      if (target.isContentEditable) {
        changed = target.textContent !== next;
        if (changed) {
          target.textContent = next;
          target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: next }));
          verify();
          target.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else changed = setNativeValue(target, next, true, verify);
      assertActive(runId);
      target.blur();
      await sleep(TIMING.event, runId);
      return { ok: true, code: changed ? 'FILLED' : 'NO_CHANGE', msg: changed ? '已填写目标' : '目标已是指定内容', state: readState(target) };
    }
    if (action.action === 'select') {
      if (!(target instanceof HTMLSelectElement)) return errorResult('NOT_SELECT', 'select 仅支持原生下拉框');
      // 多选下拉 value 传数组；标量赋值会清掉其余已选项
      if (Array.isArray(action.value) && !target.multiple) return errorResult('INVALID_VALUE', '单选下拉不支持数组 value，请传单个选项');
      const requestedList = Array.isArray(action.value) ? action.value.map((item) => String(item ?? '')) : [String(action.value ?? '')];
      if (!requestedList.length || requestedList.includes('')) return errorResult('OPTION_NOT_FOUND', '选项不存在');
      const hits = [];
      for (const requested of requestedList) {
        const exact = [...target.options].filter((option) => option.value === requested || option.textContent.trim() === requested);
        const prefix = exact.length ? [] : [...target.options].filter((option) => option.textContent.trim().startsWith(requested));
        const hit = exact[0] || (prefix.length === 1 ? prefix[0] : null);
        if (!hit) return errorResult('OPTION_NOT_FOUND', prefix.length > 1 ? '选项前缀不唯一' : '选项不存在');
        if (!hits.includes(hit)) hits.push(hit);
      }
      if (target.multiple) {
        const signatureOf = () => [...target.selectedOptions].map((option) => option.value).join('\u0000');
        const before = signatureOf();
        verify();
        for (const option of target.options) option.selected = hits.includes(option);
        const changed = before !== signatureOf();
        if (changed) {
          target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { ok: true, code: changed ? 'SELECTED' : 'NO_CHANGE', msg: changed ? (isSensitive(target) ? '已选择敏感选项（已隐藏）' : `已选择 ${hits.length} 项`) : '已是指定选项', state: readState(target) };
      }
      const hit = hits[0];
      const changed = setNativeValue(target, hit.value, true, verify);
      return { ok: true, code: changed ? 'SELECTED' : 'NO_CHANGE', msg: changed ? (isSensitive(target) ? '已选择敏感选项（已隐藏）' : `已选择「${cleanText(hit.textContent, 60)}」`) : '已是指定选项', state: readState(target) };
    }
    if (action.action === 'submitForm') {
      const form = target instanceof HTMLFormElement ? target : target.form || target.closest('form');
      if (!form) {
        await clickOnce(element, runId, verify);
        await waitForStable(runId, 3500, 500);
        return { ok: true, msg: '已点击提交目标' };
      }
      target.scrollIntoView({ block: 'center' });
      verify();
      // 预记表单提交目标，供原生导航的跳过结果携带 navigationUrl
      try {
        const formAction = form.getAttribute('action');
        activeOperation.navigationUrl = new URL(formAction || location.href, document.baseURI).href;
      } catch {}
      // novalidate 表单本就不做约束校验，requestSubmit 会跳过；不能替它拦下
      const skipValidation = form.novalidate === true || target.getAttribute?.('formnovalidate') != null;
      const valid = skipValidation || form.reportValidity();
      verify();
      if (!valid) return errorResult('FORM_INVALID', '表单校验未通过，未提交');
      const submitter = (target instanceof HTMLButtonElement && target.type === 'submit')
        || (target instanceof HTMLInputElement && ['submit', 'image'].includes(target.type)) ? target : undefined;
      if (form.requestSubmit) {
        if (submitter) form.requestSubmit(submitter);
        else form.requestSubmit();
      } else form.submit();
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
    if (message.snapshotId !== currentSnapshotId || currentSnapshotUrl !== location.href) {
      return { results: [errorResult('STALE_SNAPSHOT', '页面已跳转或快照已重建，请重新读取页面')] };
    }
    if (!Array.isArray(message.actions) || message.actions.length < 1 || message.actions.length > 20) return { results: [errorResult('INVALID_ACTIONS', '操作数量必须为 1-20')] };
    if (executing || extracting) return { results: [errorResult('BUSY', '页面正在处理另一项请求')] };
    assertActive(message.runId);
    activeRunId = message.runId;
    executing = true;
    const operation = { runId: message.runId, startUrl: location.href, navigationStarted: false };
    activeOperation = operation;
    // 仅观察本次 operation；不阻断卸载、不改页面 API，finally 必须卸下监听。
    // 页面脚本可合成 beforeunload 事件伪造导航跳过整批操作，必须只信浏览器派发的可信事件。
    const onBeforeUnload = (event) => {
      if (event.isTrusted !== true) return;
      if (activeOperation === operation) operation.navigationStarted = true;
    };
    addEventListener('beforeunload', onBeforeUnload, true);
    const results = [];
    try {
      for (let index = 0; index < message.actions.length; index++) {
        assertActive(message.runId);
        try {
          const result = await executeAction(message.actions[index], message.runId, 0, message.approved === true); // 完全访问权限：background 恒发 approved=true
          results.push(result);
          if (isNavigationResult(result)) {
            for (let rest = index + 1; rest < message.actions.length; rest++) results.push(skippedAfterNavigation());
            break;
          }
          if (!result.ok && !['WAIT_TIMEOUT', 'TARGET_NOT_FOUND', 'STALE_TARGET', 'TARGET_HIDDEN'].includes(result.code)) {
            for (let rest = index + 1; rest < message.actions.length; rest++) results.push(errorResult('SKIPPED_AFTER_FAILURE', '前序操作失败，已跳过'));
            break;
          }
        } catch (error) {
          if (isNavigationResult(error)) throw error;
          const code = error.code || (error.name === 'CancelledError' ? 'CANCELLED' : 'ACTION_ERROR');
          results.push(errorResult(code, error.message || String(error)));
          for (let rest = index + 1; rest < message.actions.length; rest++) results.push(errorResult('SKIPPED_AFTER_FAILURE', '前序操作中止，已跳过'));
          break;
        }
        if (index < message.actions.length - 1) await sleep(TIMING.settle, message.runId);
      }
      // beforeunload 后 URL 仍可能是旧页；绝不能返回旧文档快照。
      if (navigationResult() || results.some(isNavigationResult)) return { results };
      let page;
      try { page = await buildSnapshot(message.runId, 12000, message.includeImages === true); }
      catch (error) {
        if (error.name !== 'CancelledError') throw error;
        return { results };
      }
      assertActive(message.runId);
      return { results, page };
    } catch (error) {
      // 导航也可能发生于批间等待或最终快照等待，把边界归到最后一个已执行动作。
      if (!isNavigationResult(error)) throw error;
      if (results.length) Object.assign(results.at(-1), navigationResult());
      else results.push(navigationResult());
      while (results.length < message.actions.length) results.push(skippedAfterNavigation());
      return { results };
    } finally {
      removeEventListener('beforeunload', onBeforeUnload, true);
      if (activeOperation === operation) activeOperation = null;
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
      (async () => {
        try {
          await waitForStable(message.runId, 1500, 250);
          return await buildSnapshot(message.runId, message.maxLen, message.includeImages === true);
        } finally {
          extracting = false;
          if (activeRunId === message.runId) activeRunId = '';
        }
      })().then(sendResponse, (error) => sendResponse(errorResult(error.code || 'EXTRACT_ERROR', error.message || String(error))));
      return true;
    }
    if (message.type === 'EXECUTE') {
      const key = String(message.operationId || '');
      if (key && operationCache.has(key)) {
        operationCache.get(key).then(sendResponse);
        return true;
      }
      const pending = executeBatch(message).catch((error) => ({ results: [errorResult(error.code || 'EXECUTE_ERROR', error.message || String(error))] }));
      if (key) {
        operationCache.set(key, pending);
        pruneCache();
        // 幂等缓存只该钉住「已执行」的结果：未执行成功的瞬态结局在结算后清除，允许同 operationId 重试；
        // 成功结果也剥掉整页快照，避免缓存长期驻留大对象。
        pending.then((result) => {
          const code = result?.results?.[0]?.code;
          if (['INVALID_REQUEST', 'STALE_SNAPSHOT', 'INVALID_ACTIONS', 'BUSY', 'EXECUTE_ERROR', 'CANCELLED'].includes(code)) operationCache.delete(key);
          else if (result?.page) operationCache.set(key, Promise.resolve({ results: result.results }));
        }).catch(() => {});
      }
      pending.then(sendResponse);
      return true;
    }
  });
})();
