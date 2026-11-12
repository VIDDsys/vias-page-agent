(() => {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 180000;
  const MODEL_REQUEST_POLICY = Object.freeze({ timeoutMs: DEFAULT_TIMEOUT_MS, totalTimeoutMs: DEFAULT_TIMEOUT_MS, retries: 2, coordinationTimeoutMs: DEFAULT_TIMEOUT_MS + 15000 });
  const MAX_ERROR_BODY = 500;
  const MAX_REPLY_LENGTH = 1000000;

  function normalizeBaseUrl(url) {
    let value = String(url || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(value)) value = value.slice(0, -'/chat/completions'.length);
    return value;
  }

  function validateModel(input) {
    const cfg = input && typeof input === 'object' ? input : {};
    const baseUrl = normalizeBaseUrl(cfg.baseUrl);
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error('API 地址无效');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('API 地址仅支持 http(s)');
    if (parsed.username || parsed.password) throw new Error('API 地址不能包含账号或密码');
    const model = String(cfg.model || '').trim();
    if (!model || model.length > 200) throw new Error('模型名不能为空且不能超过 200 个字符');
    const name = String(cfg.name || '').trim();
    if (name.length > 80) throw new Error('显示名称不能超过 80 个字符');
    const apiKey = String(cfg.apiKey || '').trim();
    if (apiKey.length > 4096) throw new Error('API Key 长度异常');
    return {
      ...cfg,
      name,
      baseUrl,
      apiKey,
      model,
      vision: cfg.vision === true,
    };
  }

  function abortError(message = '请求已取消') {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
  }

  function wait(ms, signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(done, ms);
      function done() {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }
      function onAbort() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(abortError());
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function beforeAttempt(check, signal) {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const onAbort = () => { cleanup(); reject(abortError()); };
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve().then(() => {
        if (signal.aborted) throw abortError();
        return check(signal);
      }).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    });
  }

  function retryAfterMs(resp, attempt) {
    const header = resp.headers.get('retry-after');
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds)) return Math.min(10000, Math.max(0, seconds * 1000));
      const date = Date.parse(header);
      if (Number.isFinite(date)) return Math.min(10000, Math.max(0, date - Date.now()));
    }
    return Math.min(4000, 500 * (2 ** attempt));
  }

  function linkAbort(parent, child) {
    if (!parent) return () => {};
    if (parent.aborted) child.abort(parent.reason);
    const onAbort = () => child.abort(parent.reason);
    parent.addEventListener('abort', onAbort, { once: true });
    return () => parent.removeEventListener('abort', onAbort);
  }

  function redactErrorText(text, apiKey) {
    let safe = String(text);
    if (apiKey) {
      // 精确屏蔽本次凭据（含 JSON 转义形式），必须先于正文规范化与截断。
      for (const secret of new Set([apiKey, JSON.stringify(apiKey).slice(1, -1)])) {
        safe = safe.split(secret).join('[REDACTED]');
      }
    }
    return safe.replace(/(\bauthorization["']?\s*:\s*["']?(?:bearer|basic)\s+)[^\s"',;<>\\]+/gi, '$1[REDACTED]');
  }

  async function callModel(input, messages, options = {}) {
    const cfg = validateModel(input);
    if (!Array.isArray(messages) || !messages.length) throw new Error('模型消息不能为空');
    const timeoutMs = Math.min(300000, Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
    const retries = Math.floor(Math.min(3, Math.max(0, Number(options.retries) || 0)));
    const totalTimeoutMs = Number.isFinite(Number(options.totalTimeoutMs))
      ? Math.min(900000, Math.max(1000, Number(options.totalTimeoutMs))) : Infinity;
    const now = () => globalThis.performance?.now?.() ?? Date.now();
    const deadline = now() + totalTimeoutMs;
    const budgetError = () => Object.assign(new Error('模型请求总时限已用尽或不足以重试，请稍后重试'), { retryable: false });
    const url = cfg.baseUrl + '/chat/completions';
    let lastError;
    let omitTemperature = false;
    let extraAttempt = 0;

    for (let attempt = 0; attempt <= retries + extraAttempt; attempt++) {
      if (options.signal?.aborted) throw abortError();
      const remainingMs = deadline - now();
      if (remainingMs <= 0) throw budgetError();
      const attemptTimeoutMs = Math.min(timeoutMs, remainingMs);
      const ctrl = new AbortController();
      const unlink = linkAbort(options.signal, ctrl);
      const timer = setTimeout(() => ctrl.abort('timeout'), attemptTimeoutMs);
      let responseRetryable;
      try {
        if (options.beforeAttempt) await beforeAttempt(options.beforeAttempt, ctrl.signal);
        if (ctrl.signal.aborted) throw abortError();
        if (now() >= deadline) throw budgetError();
        const headers = { 'Content-Type': 'application/json' };
        if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(omitTemperature ? { model: cfg.model, messages } : { model: cfg.model, messages, temperature: 0.2 }),
          signal: ctrl.signal,
          cache: 'no-store',
          credentials: 'omit',
        });
        if (ctrl.signal.aborted) throw abortError();

        if (!resp.ok) {
          responseRetryable = resp.status === 408 || resp.status === 429 || resp.status >= 500;
          let body;
          try {
            const raw = await resp.text();
            if (raw.length > 2000000) throw new Error('模型错误响应过大，已停止读取');
            body = redactErrorText(raw, cfg.apiKey).replace(/[\r\n\t]+/g, ' ').slice(0, MAX_ERROR_BODY);
          } catch (error) {
            if (ctrl.signal.aborted) throw error;
            body = '错误响应正文读取失败';
          }
          const error = new Error(`API ${resp.status}${body ? `: ${body}` : ''}`);
          // 推理类模型（o1/o3/gpt-5 等）会拒绝显式 temperature：去掉该参数不计次重试一次
          const dropTemperature = resp.status === 400 && !omitTemperature && /temperature/i.test(body);
          if (dropTemperature) { omitTemperature = true; extraAttempt = 1; responseRetryable = true; }
          error.retryable = responseRetryable;
          error.retryDelay = dropTemperature ? 0 : retryAfterMs(resp, attempt);
          throw error;
        }

        let data;
        try {
          data = await resp.json();
        } catch (error) {
          if (ctrl.signal.aborted) throw error;
          throw new Error('API 返回的不是有效 JSON');
        }
        if (ctrl.signal.aborted) throw abortError();
        const choice = data?.choices?.[0];
        const finishReason = choice?.finish_reason == null ? '' : String(choice.finish_reason).toLowerCase();
        if (finishReason === 'length' || finishReason === 'max_tokens') {
          throw new Error('模型输出达到长度限制，回复可能被截断，未执行任何操作；请缩小任务后重试');
        }
        if (finishReason === 'content_filter' || finishReason === 'safety') {
          throw new Error('模型输出被内容过滤，未执行任何操作；请调整请求后重试');
        }
        // 兼容省略或置 null 的 finish_reason 网关与各家等价正常结束值；工具调用等其他状态不支持。
        if (finishReason !== '' && !['stop', 'end_turn', 'eos', 'stop_sequence'].includes(finishReason)) {
          throw new Error('模型响应未正常结束或返回了不支持的工具调用，未执行任何操作');
        }
        let content = choice?.message?.content;
        if (Array.isArray(content)) {
          // 部分网关把 content 拆成多段：只拼接文本段，其余段忽略。
          content = content.map((part) => typeof part === 'string' ? part : (part && typeof part === 'object' && typeof part.text === 'string' && (part.type == null || part.type === 'text') ? part.text : '')).join('');
        }
        if (typeof content !== 'string' || !content.trim()) {
          throw new Error('模型响应缺少 choices[0].message.content 最终回答（推理内容不会执行）');
        }
        if (content.length > 1000000) throw new Error('模型回复过长，已拒绝接收，未执行任何操作');
        if (now() >= deadline) throw budgetError();
        return content;
      } catch (error) {
        if (options.signal?.aborted) throw abortError();
        if (now() >= deadline) throw budgetError();
        if (ctrl.signal.aborted) {
          lastError = new Error(`模型请求超时（${Math.round(attemptTimeoutMs / 1000)} 秒）`);
          // 已收到 401 等非重试状态时，读取正文超时也不能再次请求。
          lastError.retryable = responseRetryable !== false;
        } else if (error?.name === 'AbortError') {
          throw abortError();
        } else {
          // 不复用上游 Error：其 message、stack 或自定义属性都可能携带凭据。
          lastError = new Error(redactErrorText(error?.message ?? error, cfg.apiKey));
          lastError.retryable = responseRetryable ?? (error?.retryable == null ? error instanceof TypeError : error.retryable === true);
          if (Number.isFinite(error?.retryDelay)) lastError.retryDelay = error.retryDelay;
        }
        if (attempt >= retries + extraAttempt || !lastError.retryable) throw lastError;
      } finally {
        clearTimeout(timer);
        unlink();
      }
      // 退避不再保留上一请求的超时计时器与父信号监听器，且 Retry-After: 0 有效。
      const retryDelay = lastError.retryDelay ?? Math.min(4000, 500 * (2 ** attempt));
      if (retryDelay >= deadline - now()) throw budgetError();
      await wait(retryDelay, options.signal);
    }
    throw lastError || new Error('模型请求失败');
  }

  function repairControlEscapes(text) {
    const valid = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);
    let out = '';
    let inStr = false;
    let esc = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) { esc = false; out += ch; continue; }
        if (ch === '\\') {
          const next = text[i + 1];
          const validUnicode = next !== 'u' || /^[0-9a-f]{4}$/i.test(text.slice(i + 2, i + 6));
          if (valid.has(next) && validUnicode) { out += ch; esc = true; }
          else out += '\\\\';
          continue;
        }
        if (ch === '"') { inStr = false; out += ch; continue; }
        const code = ch.charCodeAt(0);
        if (code < 0x20) {
          out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : `\\u${code.toString(16).padStart(4, '0')}`;
          continue;
        }
        out += ch;
        continue;
      }
      if (ch === '"') { inStr = true; }
      out += ch;
    }
    return out;
  }

  function tryParseJson(str) {
    try { return JSON.parse(str); } catch {}
    try { return JSON.parse(repairControlEscapes(str)); } catch { return null; }
  }

  function isInstructionObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
      && (Array.isArray(value.actions) || typeof value.say === 'string' || typeof value.done === 'boolean');
  }

  function looksLikeProtocol(text) {
    return /[\{｛]/u.test(text)
      && /(?:["'“”‘’＂＇`]\s*(?:say|actions|done|vias_read)\s*["'“”‘’＂＇`]|\b(?:say|actions|done|vias_read)\b)\s*(?:[:：]|$)/u.test(text);
  }

  // 只扫描顶层容器，忽略 JSON 字符串内括号；前言中的孤立引号不应吞掉后续指令。
  function scanInstructions(text) {
    const found = [];
    const malformed = [];
    const inspect = (start, end) => {
      const fragment = text.slice(start, end);
      if (!fragment.startsWith('{') && !fragment.startsWith('｛')) return;
      const value = tryParseJson(fragment);
      if (isInstructionObject(value) && (!Object.hasOwn(value, 'actions') || Array.isArray(value.actions))) {
        found.push({ value, index: start, end });
      } else if ((value === null && looksLikeProtocol(fragment))
        || (value && ['say', 'actions', 'done', 'vias_read'].some((key) => Object.hasOwn(value, key)))) {
        malformed.push(start);
      }
    };
    let depth = 0;
    let start = -1;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"' && depth > 0) { inStr = true; continue; }
      if (ch === '{' || ch === '[' || ch === '｛' || ch === '［') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}' || ch === ']' || ch === '｝' || ch === '］') {
        if (depth === 0) continue;
        depth--;
        if (depth === 0 && start >= 0) {
          inspect(start, i + 1);
          start = -1;
        }
      }
    }
    if (start >= 0) inspect(start, text.length);
    return { found, malformed };
  }

  function cleanSay(value) {
    const text = typeof value === 'string' ? value.slice(0, 50000) : '';
    const scan = scanInstructions(text);
    if (scan.malformed.length) return '';
    let cleaned = text;
    let removed = false;
    for (const item of scan.found.reverse()) {
      cleaned = cleaned.slice(0, item.index) + cleaned.slice(item.end);
      removed = true;
    }
    return removed ? cleaned.replace(/```(?:json)?\s*```/gi, '').trim() : text;
  }

  function normalizeInstruction(value) {
    return {
      say: cleanSay(value.say),
      actions: Array.isArray(value.actions) ? value.actions : [],
      done: value.done === true,
    };
  }

  // 解析模型回复为 {say, actions, done}。done 是任务真正完成的显式截止信号。
  function parseReply(text) {
    const source = String(text);
    // 不截断后解析，避免超长回复的合法前缀被当成完整指令。
    if (source.length > MAX_REPLY_LENGTH) {
      return { say: '模型回复过长，未解析或执行操作；请缩小任务后重试', actions: [], done: false };
    }
    const trimmed = source.trim();
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    const value = tryParseJson(fence ? fence[1] : trimmed);
    if (isInstructionObject(value) && (!Object.hasOwn(value, 'actions') || Array.isArray(value.actions))) return normalizeInstruction(value);
    if (value && typeof value === 'object' && !Array.isArray(value)
      && ['say', 'actions', 'done', 'vias_read'].some((key) => Object.hasOwn(value, key))) {
      return { say: '', actions: [], done: false, malformed: true };
    }
    // 完整的数据容器不挖掘嵌套指令。动作只接受整条回复的唯一指令，避免把示例当成执行请求。
    if (value !== null) return { say: source.slice(0, 50000), actions: [], done: false };
    const scan = scanInstructions(source);
    if (scan.found.length || scan.malformed.length || looksLikeProtocol(source)) {
      return { say: '', actions: [], done: false, malformed: true };
    }
    return { say: source.slice(0, 50000), actions: [], done: false };
  }

  // 控制消息必须是完整且精确的顶层 JSON，不从普通答案或代码块中挖取。
  function parseReadRequest(text) {
    let value;
    try { value = JSON.parse(String(text)); } catch { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'vias_read')) return null;
    const read = value.vias_read;
    if (!read || typeof read !== 'object' || Array.isArray(read)
      || typeof read.snapshotId !== 'string' || !read.snapshotId || read.snapshotId.length > 300) return null;
    const hasNotes = Object.hasOwn(read, 'notes');
    if (hasNotes && (typeof read.notes !== 'string' || read.notes.length > 12000)) return null;
    const fields = Object.keys(read).length - Number(hasNotes);
    if (read.kind === 'segment' && fields === 3 && Object.hasOwn(read, 'index')
      && Number.isSafeInteger(read.index) && read.index >= 0) return read;
    if (read.kind === 'continue' && fields === 2) return read;
    if (read.kind === 'images' && fields === 3 && Array.isArray(read.ids)
      && read.ids.length >= 1 && read.ids.length <= 3
      && read.ids.every((id) => Number.isSafeInteger(id) && id > 0)
      && new Set(read.ids).size === read.ids.length) return read;
    return null;
  }

  globalThis.ViasCore = Object.freeze({ MODEL_REQUEST_POLICY, normalizeBaseUrl, validateModel, callModel, parseReply, parseReadRequest });
})();
