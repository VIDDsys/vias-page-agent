'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const contentScript = path.join(root, 'content.js');
const fixtureHtml = fs.readFileSync(path.join(__dirname, 'content-fixture.html'), 'utf8');
const edgePath = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let browser;
let fixtureServer;
let fixtureUrl;
const pendingNavigations = new Map();
const navigationWaiters = new Map();

test.before(async () => {
  assert.ok(fs.existsSync(edgePath), `Edge 不存在: ${edgePath}`);
  fixtureServer = http.createServer((request, response) => {
    // 测试主动释放 HTTP 响应，保证 assign 后旧 URL/文档仍在，且无需固定长等待。
    if (request.url.startsWith('/slow-navigation')) {
      pendingNavigations.set(request.url, response);
      navigationWaiters.get(request.url)?.();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fixtureHtml);
  });
  await new Promise((resolve, reject) => {
    fixtureServer.once('error', reject);
    fixtureServer.listen(0, '127.0.0.1', resolve);
  });
  const address = fixtureServer.address();
  fixtureUrl = `http://127.0.0.1:${address.port}/fixture`;
  browser = await chromium.launch({ executablePath: edgePath, headless: true });
});

test.after(async () => {
  await browser?.close();
  if (fixtureServer?.listening) {
    await new Promise((resolve, reject) => fixtureServer.close((error) => error ? reject(error) : resolve()));
  }
});

async function openFixture() {
  const page = await browser.newPage();
  await page.goto(fixtureUrl, { waitUntil: 'load' });
  await page.evaluate(() => {
    const onMessage = {
      addListener(listener) {
        globalThis.__viasContentListener = listener;
      },
    };
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: { runtime: { onMessage } },
    });
  });
  await page.addScriptTag({ path: contentScript });
  await page.waitForFunction(() => typeof globalThis.__viasContentListener === 'function');
  return page;
}

async function withFixture(run) {
  const page = await openFixture();
  try {
    return await run(page);
  } finally {
    await page.close();
  }
}

async function dispatch(page, message, expectResponse = true) {
  return page.evaluate(({ payload, waitsForResponse }) => new Promise((resolve, reject) => {
    const listener = globalThis.__viasContentListener;
    if (typeof listener !== 'function') return reject(new Error('content listener 未注册'));

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error(`消息响应超时: ${payload.type}`));
    }, 20000);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    let asynchronous;
    try {
      asynchronous = listener(payload, {}, finish);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    if (!waitsForResponse) finish(undefined);
    else if (asynchronous !== true) queueMicrotask(() => finish(undefined));
  }), { payload: message, waitsForResponse: expectResponse });
}

function refMatching(extraction, pattern) {
  const line = String(extraction.text || '').split('\n').find((item) => pattern.test(item));
  const match = line?.match(/^\[(\d+)\]/);
  assert.ok(match, `未找到匹配 ref: ${pattern}`);
  return Number(match[1]);
}

function snapshotIdOf(extraction) {
  return extraction.snapshotId || '__missing_snapshot__';
}

async function extract(page, overrides = {}) {
  return dispatch(page, { type: 'EXTRACT', runId: 'run-e2e', maxLen: 30000, ...overrides });
}

async function execute(page, extraction, operationId, actions, approved = true) {
  return dispatch(page, {
    type: 'EXECUTE',
    runId: 'run-e2e',
    operationId,
    snapshotId: snapshotIdOf(extraction),
    approved,
    actions,
  });
}

test('EXTRACT 返回 snapshotId，并让 ref 可执行', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const extraction = await extract(page);
    assert.equal(typeof extraction.snapshotId, 'string');
    assert.ok(extraction.snapshotId.length >= 8);

    const ref = refMatching(extraction, /按钮「Count once」/);
    const response = await execute(page, extraction, 'op-extract-ref', [{ action: 'click', ref }]);
    assert.equal(response.results[0].ok, true);
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 1);
  });
});

test('EXECUTE 拒绝旧 snapshotId，且不触碰页面', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const oldExtraction = await extract(page);
    const ref = refMatching(oldExtraction, /按钮「Count once」/);
    await page.evaluate(() => {
      const marker = document.createElement('p');
      marker.textContent = 'snapshot changed';
      document.body.prepend(marker);
    });
    const currentExtraction = await extract(page);
    if (oldExtraction.snapshotId && currentExtraction.snapshotId) {
      assert.notEqual(oldExtraction.snapshotId, currentExtraction.snapshotId);
    }

    const response = await dispatch(page, {
      type: 'EXECUTE',
      runId: 'run-e2e',
      operationId: 'op-stale-snapshot',
      snapshotId: oldExtraction.snapshotId || '__definitely_stale__', approved: true,
      actions: [{ action: 'click', ref }],
    });
    const first = response?.results?.[0] || response;
    assert.equal(first?.ok, false);
    assert.match(`${first?.code || ''} ${first?.msg || first?.error || ''}`, /STALE|快照|过期|旧/i);
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 0);
  });
});

test('DOM 在快照后变化时拒绝执行旧 ref', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const extraction = await extract(page);
    const ref = refMatching(extraction, /按钮「Count once」/);
    await page.evaluate(() => {
      document.querySelector('#counter').textContent = 'Changed after snapshot';
    });
    await page.waitForTimeout(0);
    const response = await execute(page, extraction, 'op-dom-stale', [{ action: 'click', ref }]);
    assert.equal(response.results[0].ok, false);
    assert.equal(response.results[0].code, 'STALE_TARGET');
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 0);
  });
});

test('无关节点的持续抖动不再阻止对有效目标执行（回归：自动刷新页点击落不了地）', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const extraction = await extract(page);
    const ref = refMatching(extraction, /按钮「Count once」/);
    await page.evaluate(() => {
      // 模拟倒计时/自动保存：改无关节点的文字与属性，不动目标本身
      const h = document.querySelector('h1');
      h.textContent = `fixture-start-marker 12:${30 + Math.floor(Math.random() * 9)}`;
      h.dataset.tick = String(Date.now());
    });
    await page.waitForTimeout(0);
    const response = await execute(page, extraction, 'op-unrelated-churn', [{ action: 'click', ref }]);
    assert.equal(response.results[0].ok, true, JSON.stringify(response.results[0]));
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 1);
  });
});

test('fill 相同值重放不重复触发 input/change', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const firstExtraction = await extract(page);
    const nameRef = refMatching(firstExtraction, /输入框\(text\).*标签:Name/);
    await execute(page, firstExtraction, 'op-fill-1', [
      { action: 'fill', ref: nameRef, value: 'Alice' },
    ]);

    const secondExtraction = await extract(page);
    await execute(page, secondExtraction, 'op-fill-2', [
      { action: 'fill', selector: '#name', value: 'Alice' },
    ]);

    const state = await page.evaluate(() => ({
      value: document.querySelector('#name').value,
      counts: window.fixtureCounts,
    }));
    assert.equal(state.value, 'Alice');
    assert.equal(state.counts.nameInput, 1);
    assert.equal(state.counts.nameChange, 1);
  });
});

test('多选下拉：数组 value 多选不互斥，标量 value 精确设定单选', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const firstExtraction = await extract(page);
    const fruitsRef = refMatching(firstExtraction, /下拉框 标签:Fruits/);
    const multi = await execute(page, firstExtraction, 'op-multi-1', [
      { action: 'select', ref: fruitsRef, value: ['apple', 'cherry'] },
    ]);
    assert.equal(multi.results[0].ok, true);
    assert.deepEqual(await page.evaluate(() => [...document.querySelector('#fruits').selectedOptions].map((option) => option.value)), ['apple', 'cherry'], '数组多选不得互相覆盖');
    assert.equal(await page.evaluate(() => window.fixtureCounts.fruitsChange), 1);

    const secondExtraction = await extract(page);
    await execute(page, secondExtraction, 'op-multi-2', [
      { action: 'select', ref: refMatching(secondExtraction, /下拉框 标签:Fruits/), value: 'banana' },
    ]);
    assert.deepEqual(await page.evaluate(() => [...document.querySelector('#fruits').selectedOptions].map((option) => option.value)), ['banana'], '多选下拉上的标量 value 应精确设定为单项');
  });
});

test('textarea 上 press Enter 换行而不提交表单', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const firstExtraction = await extract(page);
    const notesRef = refMatching(firstExtraction, /文本域 标签:Notes/);
    await execute(page, firstExtraction, 'op-notes-1', [
      { action: 'fill', ref: notesRef, value: '第一行' },
    ]);

    const secondExtraction = await extract(page);
    const pressed = await execute(page, secondExtraction, 'op-notes-2', [
      { action: 'press', ref: refMatching(secondExtraction, /文本域 标签:Notes/), value: 'Enter' },
    ]);
    assert.equal(pressed.results[0].ok, true);
    assert.equal(await page.evaluate(() => document.querySelector('#notes').value), '第一行\n', 'textarea 的 Enter 应插入换行');
    assert.equal(await page.evaluate(() => window.fixtureCounts.formSubmit), 0, 'textarea 的 Enter 不得触发 requestSubmit');
  });
});

test('fill 文件输入返回明确错误且不抛异常', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const extraction = await extract(page);
    const uploadRef = refMatching(extraction, /输入框\(file\) 标签:Upload/);
    const outcome = await execute(page, extraction, 'op-file-1', [
      { action: 'fill', ref: uploadRef, value: 'fake.txt' },
    ]);
    assert.equal(outcome.results[0].ok, false);
    assert.equal(outcome.results[0].code, 'NOT_EDITABLE');
    assert.match(outcome.results[0].msg, /文件上传暂不支持/);
  });
});

test('页面合成的 beforeunload 不得伪造导航跳过整批操作', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const extraction = await extract(page);
    const spoofRef = refMatching(extraction, /按钮「Spoof beforeunload」/);
    const counterRef = refMatching(extraction, /按钮「Count once」/);
    const outcome = await execute(page, extraction, 'op-spoof-1', [
      { action: 'click', ref: spoofRef },
      { action: 'click', ref: counterRef },
    ]);
    assert.equal(outcome.results[0].ok, true);
    assert.equal(outcome.results[1].ok, true, '合成 beforeunload 后续操作必须照常执行');
    assert.notEqual(outcome.results[1].code, 'SKIPPED_AFTER_NAVIGATION');
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 1);
  });
});

test('单选下拉收到数组 value 返回明确错误', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const extraction = await extract(page);
    const petRef = refMatching(extraction, /下拉框 标签:Pet/);
    const outcome = await execute(page, extraction, 'op-pet-1', [
      { action: 'select', ref: petRef, value: ['cat', 'dog'] },
    ]);
    assert.equal(outcome.results[0].ok, false);
    assert.equal(outcome.results[0].code, 'INVALID_VALUE');
    assert.equal(await page.evaluate(() => document.querySelector('#pet').value), 'cat', '拒绝执行不得改动单选下拉');
  });
});

test('checkbox check 相同目标重放后仍保持选中', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const firstExtraction = await extract(page);
    const termsRef = refMatching(firstExtraction, /选项「Accept terms」/);
    await execute(page, firstExtraction, 'op-check-1', [{ action: 'check', ref: termsRef }]);

    const secondExtraction = await extract(page);
    await execute(page, secondExtraction, 'op-check-2', [{ action: 'check', selector: '#terms' }]);

    const state = await page.evaluate(() => ({
      checked: document.querySelector('#terms').checked,
      changes: window.fixtureCounts.termsChange,
    }));
    assert.equal(state.checked, true);
    assert.equal(state.changes, 1);
  });
});

test('真实 label/input 整页重绘：50 题重复和空选项按当前快照分批执行', { timeout: 90000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<style>input{opacity:0;position:absolute;width:0;height:0}label{display:block}</style><main id="paper"></main>';
      window.paperSelected = Array(50).fill(-1);
      const render = () => {
        document.querySelector('#paper').innerHTML = window.paperSelected.map((selected, question) => `<section><h2>题目 ${question + 1}</h2><div role="radiogroup">${['相同选项', '', '相同选项'].map((text, option) => `<label role="radio"><span><input type="radio" name="q${question}" value="${option}" ${selected === option ? 'checked' : ''}></span><span>${text}</span></label>`).join('')}</div></section>`).join('');
        document.querySelectorAll('input').forEach((input) => input.addEventListener('change', () => {
          const question = Number(input.name.slice(1));
          window.paperSelected[question] = Number(input.value);
          render();
        }));
      };
      render();
    });
    let snapshot = await extract(page, { maxLen: 50000 });
    for (let start = 0; start < 50; start += 10) {
      const refs = Object.keys(snapshot.targets).map(Number);
      assert.equal(refs.length, 150);
      const actions = Array.from({ length: 10 }, (_, index) => {
        const question = start + index;
        return { action: 'check', ref: refs[question * 3 + question % 3] };
      });
      const outcome = await execute(page, snapshot, `op-paper-${start}`, actions);
      assert.equal(outcome.results.length, 10);
      assert.ok(outcome.results.every((result) => result.ok), JSON.stringify(outcome.results));
      snapshot = outcome.page;
    }
    assert.deepEqual(await page.evaluate(() => window.paperSelected), Array.from({ length: 50 }, (_, index) => index % 3));
  });
});

for (const mutation of ['question-reordered', 'question-reused', 'input-replaced']) {
  test(`选项身份恢复必须核验题目和关联控件：${mutation}`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      await page.evaluate(() => {
        document.body.innerHTML = '<main><section><h2>题目甲</h2><div><label><input type="radio" name="a" value="1">相同选项</label><label><input type="radio" name="a" value="2">其他选项</label></div></section><section><h2>题目乙</h2><div><label><input type="radio" name="b" value="1">相同选项</label></div></section></main>';
        window.identityClicks = 0;
        document.addEventListener('click', () => window.identityClicks++);
      });
      const snapshot = await extract(page);
      const ref = refMatching(snapshot, /选项「相同选项」/);
      await page.evaluate((kind) => {
        const section = document.querySelector('section');
        if (kind === 'question-reordered') {
          const main = section.parentElement;
          main.innerHTML = main.lastElementChild.outerHTML + section.outerHTML;
        } else if (kind === 'question-reused') section.querySelector('h2').textContent = '题目丙';
        else if (kind === 'input-replaced') {
          const input = section.querySelector('input');
          input.replaceWith(input.cloneNode(true));
        }
      }, mutation);
      const outcome = await execute(page, snapshot, `op-identity-${mutation}`, [{ action: 'check', ref }]);
      if (mutation === 'input-replaced') {
        assert.equal(outcome.results[0].ok, true, JSON.stringify(outcome.results));
        assert.equal(await page.evaluate(() => document.querySelector('input').checked), true);
      } else {
        assert.equal(outcome.results[0].code, 'STALE_TARGET', JSON.stringify(outcome.results));
        assert.equal(await page.evaluate(() => window.identityClicks), 0);
      }
    });
  });
}

test('题干在多层包装之外改变时，旧选项编号不能恢复到新题', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => { document.body.innerHTML = '<section><h2>题目甲</h2><div class="answer"><div class="options"><label><input type="radio" name="answer" value="a">相同选项</label></div></div></section>'; });
    const snapshot = await extract(page);
    await page.evaluate(() => { const section = document.querySelector('section'); section.innerHTML = section.innerHTML.replace('题目甲', '题目乙'); });
    const outcome = await execute(page, snapshot, 'op-deep-question-reused', [{ action: 'check', ref: refMatching(snapshot, /选项「相同选项」/) }]);
    assert.equal(outcome.results[0].code, 'STALE_TARGET');
    assert.equal(await page.evaluate(() => document.querySelector('input').checked), false);
  });
});

test('更新整卷进度及题内状态提示不应使同批目标失效', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<main><p id="progress">已答0题</p><section><h2>题目甲</h2><label><input type="checkbox">选项甲</label><output></output></section><section><h2>题目乙</h2><label><input type="checkbox">选项乙</label><div role="status"></div></section></main>';
      document.querySelectorAll('input').forEach((input) => input.addEventListener('change', () => {
        document.querySelector('#progress').textContent = `已答${document.querySelectorAll('input:checked').length}题`;
        document.querySelectorAll('output,[role="status"]').forEach((status) => { status.textContent = '已更新'; });
      }));
    });
    const snapshot = await extract(page);
    const outcome = await execute(page, snapshot, 'op-progress-is-state', Object.keys(snapshot.targets).map((ref) => ({ action: 'check', ref: Number(ref) })));
    assert.ok(outcome.results.every((result) => result.ok), JSON.stringify(outcome.results));
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('input')].map((input) => input.checked)), [true, true]);
  });
});

test('同文案原生选项重绘换序时不能按旧位置选中不同 value', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => { document.body.innerHTML = '<section><h2>根据图片选择</h2><label><input type="radio" name="answer" value="picture-a">相同选项</label><label><input type="radio" name="answer" value="picture-b">相同选项</label></section>'; });
    const snapshot = await extract(page);
    await page.evaluate(() => {
      const section = document.querySelector('section');
      const labels = [...section.querySelectorAll('label')];
      section.innerHTML = '<h2>根据图片选择</h2>' + labels.reverse().map((label) => label.outerHTML).join('');
    });
    const outcome = await execute(page, snapshot, 'op-equal-text-swapped', [{ action: 'check', ref: refMatching(snapshot, /选项「相同选项」/) }]);
    assert.equal(outcome.results[0].code, 'STALE_TARGET');
    assert.equal(await page.evaluate(() => document.querySelectorAll('input:checked').length), 0);
  });
});

test('新快照不能通过历史位置恢复旧 ref，失效目标不妨碍健康目标', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => { document.body.innerHTML = '<label><input type="checkbox">旧选项</label><label><input type="checkbox">健康选项</label>'; });
    const old = await extract(page);
    const oldRef = refMatching(old, /选项「旧选项」/);
    const current = await extract(page);
    const validRef = refMatching(current, /选项「健康选项」/);
    const outcome = await execute(page, current, 'op-old-ref-isolation', [{ action: 'check', ref: oldRef }, { action: 'check', ref: validRef }]);
    assert.equal(outcome.results[0].code, 'TARGET_NOT_FOUND');
    assert.equal(outcome.results[1].ok, true);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('input')].map((input) => input.checked)), [false, true]);
  });
});

test('check 不得在原生或 ARIA 控件拒绝选择时谎报成功', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<label><input type="checkbox">拒绝选择</label><div role="checkbox" aria-checked="false">无处理程序</div>';
      document.querySelector('input').addEventListener('click', (event) => event.preventDefault());
    });
    const snapshot = await extract(page);
    const outcome = await execute(page, snapshot, 'op-selection-rejected', Object.keys(snapshot.targets).map((ref) => ({ action: 'check', ref: Number(ref) })));
    assert.deepEqual(outcome.results.map((item) => item.code), ['CHECK_NOT_APPLIED', 'CHECK_NOT_APPLIED']);
    assert.ok(outcome.results.every((item) => !item.ok));
  });
});

test('repeat 中单个 stale 目标不阻止同轮健康目标，并保留逐项结果', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => { document.body.innerHTML = '<label><input type="checkbox">失效选项</label><label><input type="checkbox">健康选项</label>'; });
    const snapshot = await extract(page);
    const staleRef = refMatching(snapshot, /选项「失效选项」/);
    const validRef = refMatching(snapshot, /选项「健康选项」/);
    await page.evaluate(() => { document.querySelector('label').lastChild.textContent = '已换选项'; });
    const outcome = await execute(page, snapshot, 'op-repeat-partial', [{ action: 'repeat', times: 3, value: 0, actions: [{ action: 'check', ref: staleRef }, { action: 'check', ref: validRef }] }]);
    assert.equal(outcome.results[0].code, 'STALE_TARGET');
    assert.equal(outcome.results[0].results[0].code, 'STALE_TARGET');
    assert.equal(outcome.results[0].results[1].ok, true);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('input')].map((input) => input.checked)), [false, true]);
  });
});

test('批末观察失败仍保留已发生的点击结果，重发 operationId 不重复点击', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<button type="button">仅点一次</button>';
      window.observationClicks = 0;
      const original = window.getComputedStyle;
      window.getComputedStyle = (...args) => {
        if (args[0].id === 'observation-error') throw new Error('observation unavailable');
        return original(...args);
      };
      document.querySelector('button').onclick = () => {
        window.observationClicks++;
        document.body.insertAdjacentHTML('beforeend', '<div id="observation-error">观察失败</div>');
      };
    });
    const snapshot = await extract(page);
    const actions = [{ action: 'click', ref: refMatching(snapshot, /按钮「仅点一次」/) }];
    const outcome = await execute(page, snapshot, 'op-observation-failure', actions);
    assert.equal(outcome.results[0].ok, true, JSON.stringify(outcome));
    assert.equal(outcome.observationError.code, 'EXTRACT_ERROR');
    await page.evaluate(() => document.querySelector('#observation-error').remove());
    const retried = await execute(page, snapshot, 'op-observation-failure', actions);
    assert.equal(retried.results[0].ok, true);
    assert.equal(await page.evaluate(() => window.observationClicks), 1);
    assert.ok((await extract(page)).snapshotId, '观察失败后必须释放执行锁');
  });
});

test('试卷选项整组重绘后，同批按题目和选项位置继续勾选且文字冲突时拒绝', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.setContent(`<!doctype html><meta charset="utf-8"><main id="paper"></main><script>
      const questions = [['Python'], ['Java'], ['', 'SQL']];
      const selected = new Set();
      const render = () => {
        paper.replaceChildren(...questions.map((options, question) => {
          const list = document.createElement('ul');
          options.forEach((name, option) => {
            const item = document.createElement('li');
            item.setAttribute('role', 'checkbox');
            item.setAttribute('aria-checked', String(selected.has(question + ':' + option)));
            item.textContent = name;
            item.onclick = () => { selected.add(question + ':' + option); render(); };
            list.append(item);
          });
          return list;
        }));
      };
      render();
    </script>`);
    await page.addScriptTag({ path: contentScript });
    await page.waitForFunction(() => typeof globalThis.__viasContentListener === 'function');
    const extraction = await extract(page);
    const refs = [0, 1, 3].map((index) => refMatching(extraction, new RegExp(`\\[${index + 1}\\]`)));
    const result = await execute(page, extraction, 'op-exam-rebuild', refs.map((ref) => ({ action: 'click', ref })));
    assert.equal(result.results.every((item) => item.ok), true);
    await page.evaluate(() => {
      const item = document.querySelectorAll('li')[3];
      item.addEventListener('pointerdown', () => { item.textContent = 'CHANGED'; }, { once: true });
    });
    const conflict = await execute(page, result.page, 'op-exam-conflict', [{ action: 'click', ref: refMatching(result.page, /「SQL」/) }]);
    assert.equal(conflict.results[0].code, 'STALE_TARGET');
  });
});

test('自定义选项重建后，同批后续旧编号按唯一选项身份重新命中', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.setContent(`<!doctype html><meta charset="utf-8"><ul id="choices"></ul><script>
      const options = ['Python', 'Java', 'JavaScript'];
      const selected = new Set();
      const render = () => {
        choices.replaceChildren(...options.map((name) => {
          const item = document.createElement('li');
          item.setAttribute('role', 'checkbox');
          item.setAttribute('aria-checked', String(selected.has(name)));
          item.textContent = name;
          item.onclick = () => { selected.add(name); render(); };
          return item;
        }));
      };
      render();
    </script>`);
    await page.addScriptTag({ path: contentScript });
    await page.waitForFunction(() => typeof globalThis.__viasContentListener === 'function');
    const extraction = await extract(page);
    const refs = ['Python', 'Java', 'JavaScript'].map((name) => refMatching(extraction, new RegExp(`「${name}」`)));
    const result = await execute(page, extraction, 'op-rebuilt-options', refs.map((ref) => ({ action: 'click', ref })));
    assert.equal(result.results.every((item) => item.ok), true);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[role="checkbox"]')].map((item) => item.getAttribute('aria-checked'))), ['true', 'true', 'true']);
  });
});

test('operationId 是幂等键：不同 ID 执行，相同 ID 只执行一次', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const firstExtraction = await extract(page);
    const ref = refMatching(firstExtraction, /按钮「Count once」/);
    await execute(page, firstExtraction, 'op-button-a', [{ action: 'click', ref }]);

    const secondExtraction = await extract(page);
    const secondRef = refMatching(secondExtraction, /按钮「Count once」/);
    assert.notEqual(secondRef, ref, '新快照不能复用旧 ref');
    const identity = firstExtraction.targetMeta[ref].identity;
    assert.equal(typeof identity, 'string');
    assert.ok(identity.length > 0);
    assert.equal(secondExtraction.targetMeta[secondRef].identity, identity, '同一 DOM 目标跨快照身份稳定');
    const secondMessage = {
      type: 'EXECUTE',
      runId: 'run-e2e',
      operationId: 'op-button-b',
      snapshotId: snapshotIdOf(secondExtraction),
      approved: true,
      actions: [{ action: 'click', ref: refMatching(secondExtraction, /按钮「Count once」/) }],
    };
    await dispatch(page, secondMessage);
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 2, '不同 operationId 必须分别执行');

    await dispatch(page, secondMessage);
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 2, '相同 operationId 不得重演');
    await page.evaluate(() => { const button = document.querySelector('#counter'); button.replaceWith(button.cloneNode(true)); });
    const replaced = await extract(page);
    const replacedRef = refMatching(replaced, /按钮「Count once」/);
    assert.notEqual(replaced.targetMeta[replacedRef].identity, identity, '同描述替换节点必须获得新身份');
  });
});

test('ABORT 可中断正在执行的 repeat', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const extraction = await extract(page);
    const ref = refMatching(extraction, /按钮「Count once」/);
    const running = execute(page, extraction, 'op-repeat', [{
      action: 'repeat',
      times: 50,
      value: 500,
      actions: [{ action: 'click', ref }],
    }]);

    await page.waitForTimeout(250);
    await dispatch(page, { type: 'ABORT', runId: 'run-e2e' }, false);
    const response = await running;
    const repeatResult = response.results[0];
    const clicks = await page.evaluate(() => window.fixtureCounts.button);

    assert.equal(repeatResult.ok, false);
    assert.match(repeatResult.msg, /停止|取消/);
    assert.ok(clicks < 50, `repeat 未及时停止，点击次数=${clicks}`);
  });
});

test('EXTRACT 保留长文本并遍历 open shadow root', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const extraction = await extract(page, { maxLen: 30000 });

    assert.ok(extraction.text.length > 16000, `长文本被过早截断: ${extraction.text.length}`);
    assert.ok(extraction.text.includes('fixture-start-marker'), '长文本缺少开头标记');
    assert.ok(extraction.text.includes('fixture-end-marker'), '长文本缺少结尾标记');
    assert.ok(extraction.text.includes('Shadow action'), '未提取 open shadow root 中的按钮');
    assert.ok(extraction.text.includes('Shadow field'), '未提取 open shadow root 中的输入框');
  });
});

test('EXTRACT 对 password 当前值脱敏', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const extraction = await extract(page);
    assert.match(extraction.text, /输入框\(password\).*标签:Password/);
    assert.equal(extraction.text.includes('S3cr3t-fixture-value'), false, 'EXTRACT 泄露 password 当前值');
  });
});

test('password fill 的结果状态与新快照不回显密码', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const extraction = await extract(page);
    const passwordRef = refMatching(extraction, /输入框\(password\).*标签:Password/);
    const secret = 'Replacement-secret-123';
    const response = await execute(page, extraction, 'op-password-fill', [
      { action: 'fill', ref: passwordRef, value: secret },
    ]);

    assert.equal(response.results[0].ok, true);
    assert.equal(await page.$eval('#password', (element) => element.value), secret);
    assert.equal(JSON.stringify(response.results).includes(secret), false, '操作结果泄露 password 值');
    assert.equal(String(response.page?.text || '').includes(secret), false, '操作后快照泄露 password 值');
  });
});

test('ABORT(old) 后 EXTRACT(old) 同步取消不会锁死新 run', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await dispatch(page, { type: 'ABORT', runId: 'old-run' }, false);
    const cancelled = await extract(page, { runId: 'old-run' });
    assert.equal(cancelled.code, 'CANCELLED');
    const fresh = await extract(page, { runId: 'new-run' });
    assert.ok(fresh.snapshotId, JSON.stringify(fresh));
    const result = await dispatch(page, {
      type: 'EXECUTE', runId: 'new-run', operationId: 'op-after-cancel', snapshotId: fresh.snapshotId, approved: true,
      actions: [{ action: 'click', ref: refMatching(fresh, /按钮「Count once」/) }],
    });
    assert.equal(result.results[0].ok, true);
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 1);
  });
});

test('进行中的 EXTRACT 取消后释放互斥锁', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const pending = extract(page, { runId: 'extract-to-cancel' });
    await page.waitForTimeout(50);
    const busy = await extract(page, { runId: 'parallel-run' });
    assert.equal(busy.code, 'BUSY');
    await dispatch(page, { type: 'ABORT', runId: 'extract-to-cancel' }, false);
    assert.equal((await pending).code, 'CANCELLED');
    assert.ok((await extract(page, { runId: 'fresh-run' })).snapshotId);
  });
});

test('链接文字不变但 href 变化返回 STALE_TARGET；等价规范化 href 仍可执行', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      const anchor = document.createElement('a');
      anchor.id = 'same-text-link';
      anchor.href = '/link-a';
      anchor.textContent = 'Local link';
      window.linkClicks = 0;
      anchor.addEventListener('click', (event) => { event.preventDefault(); window.linkClicks++; });
      document.body.prepend(anchor);
    });
    let snap = await extract(page);
    let ref = refMatching(snap, /链接「Local link」/);
    await page.$eval('#same-text-link', (el) => { el.href = '/link-b'; });
    const stale = await execute(page, snap, 'op-link-stale', [{ action: 'click', ref }]);
    assert.equal(stale.results[0].code, 'STALE_TARGET');
    assert.equal(await page.evaluate(() => window.linkClicks), 0);
    snap = await extract(page);
    ref = refMatching(snap, /链接「Local link」/);
    await page.$eval('#same-text-link', (el) => { el.setAttribute('href', `${location.origin}/./link-b`); });
    const same = await execute(page, snap, 'op-link-normalized', [{ action: 'click', ref }]);
    assert.equal(same.results[0].ok, true);
    assert.equal(await page.evaluate(() => window.linkClicks), 1);
  });
});

for (const nested of [false, true]) {
  test(`慢 HTTP 导航立即停止${nested ? ' repeat 及外层' : ''}批次，不点击旧按钮或生成旧快照`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      const pathname = `/slow-navigation-${nested ? 'repeat' : 'batch'}`;
      const requested = new Promise((resolve) => navigationWaiters.set(pathname, resolve));
      try {
        const snap = await extract(page);
        const click = { action: 'click', ref: refMatching(snap, /按钮「Count once」/) };
        const navigate = { action: 'navigate', value: `/unused/..${pathname}` };
        const first = nested ? { action: 'repeat', times: 3, value: 60000, actions: [navigate, click] } : navigate;
        // 在消息回调内读取旧文档计数；导航期间新发 page.evaluate 会等待新执行上下文。
        const { response, clicks } = await page.evaluate((message) => new Promise((resolve) => {
          globalThis.__viasContentListener(message, {}, (response) => resolve({ response, clicks: window.fixtureCounts.button }));
        }), { type: 'EXECUTE', runId: 'run-e2e', operationId: `op-slow-${nested}`, snapshotId: snap.snapshotId, approved: true, actions: [first, click, click] });
        await requested;
        assert.equal(page.url(), fixtureUrl, '服务器尚未响应，必须仍为旧 URL');
        assert.equal(response.results[0].code, 'NAVIGATING');
        assert.equal(response.results[0].navigationUrl, new URL(pathname, fixtureUrl).href);
        assert.deepEqual(response.results.slice(1).map((result) => result.code), ['SKIPPED_AFTER_NAVIGATION', 'SKIPPED_AFTER_NAVIGATION']);
        if (nested) assert.equal(response.results[0].results[1].code, 'SKIPPED_AFTER_NAVIGATION');
        assert.equal(Object.hasOwn(response, 'page'), false, '不能把旧页快照当作导航结果');
        assert.equal(clicks, 0);
        pendingNavigations.get(pathname).end('<!doctype html><title>Local destination</title><p>Navigation complete</p>');
        await page.waitForURL(new URL(pathname, fixtureUrl).href);
      } finally {
        pendingNavigations.get(pathname)?.end();
        pendingNavigations.delete(pathname);
        navigationWaiters.delete(pathname);
      }
    });
  });
}

test('同文档 URL 变化保留 NAVIGATED，跳过后续动作且不重建旧快照', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => document.querySelector('#counter').addEventListener('click', () => history.pushState({}, '', '#moved')));
    const snap = await extract(page);
    const click = { action: 'click', ref: refMatching(snap, /按钮「Count once」/) };
    const response = await execute(page, snap, 'op-same-document-navigation', [{ action: 'repeat', times: 3, value: 0, actions: [click, click] }, click]);
    assert.equal(response.results[0].code, 'NAVIGATED');
    assert.equal(response.results[1].code, 'SKIPPED_AFTER_NAVIGATION');
    assert.equal(response.page, undefined);
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 1);
  });
});

test('navigate 到当前 URL 为 NO_CHANGE，不误跳过后续操作', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const snap = await extract(page);
    const response = await execute(page, snap, 'op-navigation-no-change', [
      { action: 'navigate', value: fixtureUrl },
      { action: 'click', ref: refMatching(snap, /按钮「Count once」/) },
    ]);
    assert.equal(response.results[0].code, 'NO_CHANGE');
    assert.equal(response.results[1].ok, true);
    assert.ok(response.page.snapshotId);
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 1);
  });
});

test('敏感 select 的选项文本和值在快照、父级描述、状态及结果中均脱敏', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = `<div role="button" aria-label="Sensitive container">
        ${['cc-name', 'one-time-code', 'current-password'].map((kind, index) => `<label>Secret choice ${index}<select id="s${index}" autocomplete="${kind}"><option value="fake-value-${index}-a">fake-text-${index}-a</option><option value="fake-value-${index}-b">fake-text-${index}-b</option></select></label>`).join('')}
        </div><label>Public choice<select id="public"><option value="public-value">Public option</option></select></label>`;
    });
    const snap = await extract(page);
    assert.doesNotMatch(JSON.stringify(snap), /fake-(?:value|text)/);
    assert.match(snap.text, /Public option\(value=public-value\)/);
    const sensitiveRefs = Object.entries(snap.targetMeta).filter(([, meta]) => meta.tag === 'select' && meta.sensitive).map(([ref]) => Number(ref));
    assert.equal(sensitiveRefs.length, 3);
    const response = await execute(page, snap, 'op-sensitive-select', sensitiveRefs.map((ref, index) => ({ action: 'select', ref, value: `fake-value-${index}-b` })));
    assert.ok(response.results.every((result) => result.code === 'SELECTED'));
    assert.doesNotMatch(JSON.stringify(response), /fake-(?:value|text)/);
    assert.deepEqual(await page.locator('select[autocomplete]').evaluateAll((elements) => elements.map((el) => el.value)), ['fake-value-0-b', 'fake-value-1-b', 'fake-value-2-b']);
    const unchanged = await execute(page, response.page, 'op-sensitive-no-change', [{ action: 'select', selector: '#s0', value: 'fake-value-0-b' }]);
    assert.equal(unchanged.results[0].code, 'NO_CHANGE');
    assert.doesNotMatch(JSON.stringify(unchanged), /fake-(?:value|text)/);
  });
});

test('交互容器继续枚举内部原生及 Shadow 控件，不重复普通内容', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<div role="button"><span>Container copy only once</span><section><input id="nested-field" aria-label="Nested field"><button id="nested-button" type="button">Nested action</button><div id="nested-shadow"></div></section></div>';
      document.querySelector('#nested-shadow').attachShadow({ mode: 'open' }).innerHTML = '<input aria-label="Nested shadow field">';
      window.nestedClicks = 0;
      document.querySelector('#nested-button').addEventListener('click', () => window.nestedClicks++);
    });
    const snap = await extract(page);
    assert.equal(Object.keys(snap.targets).length, 4);
    assert.equal(snap.text.split('Container copy only once').length - 1, 1);
    const response = await execute(page, snap, 'op-nested-controls', [
      { action: 'fill', ref: refMatching(snap, /输入框\(text\).*标签:Nested field/), value: 'nested value' },
      { action: 'click', ref: refMatching(snap, /按钮「Nested action」/) },
      { action: 'fill', ref: refMatching(snap, /输入框\(text\).*标签:Nested shadow field/), value: 'shadow value' },
    ]);
    assert.ok(response.results.every((result) => result.ok), JSON.stringify(response.results));
    assert.equal(await page.evaluate(() => window.nestedClicks), 1);
    assert.equal(await page.$eval('#nested-field', (el) => el.value), 'nested value');
    assert.equal(await page.locator('#nested-shadow input').inputValue(), 'shadow value');
  });
});

test('submitForm 保留原生校验，只有真实 submit/image 控件充当 submitter', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<form id="local-form"><input id="form-field" aria-label="Required field" required><button id="plain-button" type="button">Plain</button><input id="plain-input" type="button" value="Plain input"><button id="reset-button" type="reset">Reset</button><button id="submit-button" type="submit">Submit</button><input id="submit-input" type="submit"><input id="image-input" type="image" alt="Image submit" style="width:80px;height:40px"></form>';
      window.submitters = [];
      window.invalidCount = 0;
      document.querySelector('#form-field').addEventListener('invalid', () => window.invalidCount++);
      document.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); window.submitters.push(event.submitter?.id || null); });
    });
    const snap = await extract(page);
    const invalid = await execute(page, snap, 'op-invalid-form', [{ action: 'submitForm', selector: '#form-field' }], true);
    assert.equal(invalid.results[0].code, 'FORM_INVALID');
    assert.deepEqual(await page.evaluate(() => window.submitters), []);
    assert.ok(await page.evaluate(() => window.invalidCount > 0));
    const response = await execute(page, invalid.page, 'op-native-submitters', [
      { action: 'fill', selector: '#form-field', value: 'local valid value' },
      ...['form-field', 'plain-button', 'plain-input', 'reset-button', 'submit-button', 'submit-input', 'image-input'].map((id) => ({ action: 'submitForm', selector: `#${id}` })),
    ], true);
    assert.ok(response.results.every((result) => result.ok), JSON.stringify(response.results));
    assert.deepEqual(await page.evaluate(() => window.submitters), [null, null, null, null, 'submit-button', 'submit-input', 'image-input']);
  });
});

async function startClockBatch(page, snap, operationId, actions) {
  await page.evaluate((message) => {
    window.clockResponse = null;
    globalThis.__viasContentListener(message, {}, (response) => { window.clockResponse = response; });
  }, { type: 'EXECUTE', runId: 'run-e2e', snapshotId: snap.snapshotId, operationId, approved: true, actions });
}

for (const cancel of [false, true]) {
  test(`repeat 60000ms 周期${cancel ? '可在长等待中取消' : '完整等待而非截成30000ms'}（虚拟时钟）`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      await page.evaluate(() => {
        window.clickTimes = [];
        document.querySelector('#counter').addEventListener('click', () => window.clickTimes.push(performance.now()));
      });
      const snap = await extract(page);
      await page.clock.install();
      await startClockBatch(page, snap, `op-long-repeat-${cancel}`, [{ action: 'repeat', times: 2, value: 60000, actions: [{ action: 'click', ref: refMatching(snap, /按钮「Count once」/) }] }]);
      await page.clock.runFor(31000);
      assert.equal(await page.evaluate(() => window.clickTimes.length), 1, '31000ms 时不能已开始第二轮');
      assert.equal(await page.evaluate(() => window.clockResponse), null);
      if (cancel) {
        await dispatch(page, { type: 'ABORT', runId: 'run-e2e' }, false);
        await page.clock.runFor(200);
        const result = await page.evaluate(() => window.clockResponse);
        assert.equal(result.results[0].code, 'CANCELLED');
        assert.equal(await page.evaluate(() => window.clickTimes.length), 1);
      } else {
        await page.clock.runFor(31000);
        const result = await page.evaluate(() => window.clockResponse);
        assert.equal(result.results[0].ok, true, JSON.stringify(result));
        const times = await page.evaluate(() => window.clickTimes);
        assert.equal(times.length, 2);
        // runFor 之间的浏览器通信仍消耗少量实时时间，但不能提前启动第二轮。
        assert.ok(times[1] - times[0] >= 60000 && times[1] - times[0] < 60250, `实际周期: ${times[1] - times[0]}`);
      }
    });
  });
}

test('wait 仍限制30000ms，repeat 拒绝超过60000ms（虚拟时钟）', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const snap = await extract(page);
    await page.clock.install();
    await startClockBatch(page, snap, 'op-wait-limit', [{ action: 'wait', value: 60000 }]);
    await page.clock.runFor(29900);
    assert.equal(await page.evaluate(() => window.clockResponse), null);
    await page.clock.runFor(1100);
    const waited = await page.evaluate(() => window.clockResponse);
    assert.equal(waited.results[0].msg, '已等待 30000ms');
    await startClockBatch(page, waited.page, 'op-repeat-limit', [{ action: 'repeat', times: 2, value: 60001, actions: [{ action: 'wait', value: 0 }] }]);
    await page.clock.runFor(500);
    assert.equal(await page.evaluate(() => window.clockResponse.results[0].code), 'INVALID_REPEAT');
  });
});

test('分段预算与 targets/targetMeta 一致，未交付 ref 拒绝，跨段后完整 ref 可执行', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = `<button id="budget-first">Visible first action</button><p>${'budget-copy-'.repeat(100)}</p><select aria-label="Budget select">${Array.from({ length: 100 }, (_, index) => `<option value="v${index}">Budget option ${index}</option>`).join('')}</select><button id="last">Page tail action</button>`;
      window.budgetClicks = 0;
      document.querySelector('#budget-first').addEventListener('click', () => window.budgetClicks++);
    });
    const first = await extract(page, { maxLen: 1000 });
    assert.ok(first.segmentCount > 1);
    assert.equal(first.text.includes('[2]'), false);
    const denied = await execute(page, first, 'op-undelivered', [{ action: 'select', ref: 2, value: 'v1' }]);
    assert.equal(denied.results[0].code, 'TARGET_NOT_FOUND');
    const snap = await extract(page, { maxLen: 1000 });
    let selectRef;
    let firstRef = refMatching(snap, /按钮「Visible first action」/);
    for (let index = 0; index < snap.segmentCount; index++) {
      const part = index ? await dispatch(page, { type: 'READ_SEGMENT', runId: 'run-e2e', snapshotId: snap.snapshotId, index }) : snap;
      assert.ok(part.text.length <= 1000);
      const refs = [...part.text.matchAll(/^\[(\d+)\]/gm)].map((match) => match[1]);
      assert.deepEqual(Object.keys(part.targets), refs);
      assert.deepEqual(Object.keys(part.targetMeta), refs);
      for (const [ref, description] of Object.entries(part.targets)) {
        assert.ok(part.text.includes(description));
        assert.match(description.split('\n')[0], /^\[\d+\] .+/);
        assert.equal(Object.hasOwn(part.targetMeta[ref], 'description'), false);
        if (description.includes('Budget select')) { selectRef = Number(ref); assert.match(description, /省略/); }
      }
    }
    assert.ok(selectRef);
    const result = await execute(page, snap, 'op-across-segments', [
      { action: 'click', ref: firstRef }, { action: 'select', ref: selectRef, value: 'v1' },
    ]);
    assert.ok(result.results.every((item) => item.ok), JSON.stringify(result.results));
    assert.equal(await page.locator('select').inputValue(), 'v1');
    assert.equal(await page.evaluate(() => window.budgetClicks), 1);
  });
});

test('长单段跨冻结分段和续读窗口无遗漏，页面变化拒绝续读', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    // Keep the same 600000 UTF-16 units in one Text node. Dense alternating
    // Latin/emoji runs spend seconds in Chromium Layout, unrelated to extraction.
    // Distinct blocks detect reordering; surrogate pairs straddle actual budgets.
    let expected = Array.from({ length: 600 }, (_, index) => String(index).padStart(4, '0') + 'abc'.repeat(332)).join('');
    for (const boundary of [16000, 31999, 512000]) expected = expected.slice(0, boundary - 1) + '😀' + expected.slice(boundary + 1);
    assert.equal(expected.length, 600000);
    await page.evaluate((text) => { document.body.innerHTML = ''; const p = document.createElement('p'); p.textContent = text; document.body.append(p); }, expected);
    let snap = await extract(page, { maxLen: 16000 });
    assert.match(snap.truncated, /上限/);
    assert.equal(snap.canContinue, true);
    let joined = '';
    const oldSnapshot = snap.snapshotId;
    for (let windowIndex = 0; ; windowIndex++) {
      for (let index = 0; index < snap.segmentCount; index++) {
        const part = index ? await dispatch(page, { type: 'READ_SEGMENT', runId: 'run-e2e', snapshotId: snap.snapshotId, index }) : snap;
        assert.equal(part.snapshotId, snap.snapshotId);
        assert.ok(part.text.length > 0 && part.text.length <= 16000);
        assert.ok(part.text.isWellFormed(), '分段和窗口不能切开 UTF-16 代理对');
        joined += part.text;
      }
      if (!snap.canContinue) break;
      snap = await extract(page, { maxLen: 16000, continueSnapshotId: snap.snapshotId });
      assert.ok(snap.snapshotId, JSON.stringify(snap));
      assert.ok(windowIndex < 4);
    }
    assert.equal(joined, expected);
    assert.equal((await dispatch(page, { type: 'READ_SEGMENT', runId: 'run-e2e', snapshotId: oldSnapshot, index: 0 })).code, 'STALE_SNAPSHOT');
    const fresh = await extract(page, { maxLen: 16000 });
    await page.evaluate(() => { document.querySelector('p').textContent += 'changed'; });
    const failed = await extract(page, { maxLen: 16000, continueSnapshotId: fresh.snapshotId });
    assert.equal(failed.code, 'STALE_CONTINUATION');
  });
});

test('默认和操作后统一32000分段，切段不改变进展签名，长button/label正文和旧ref不碰撞', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = `<button id="long">CONTROL_START${'正文'.repeat(17000)}CONTROL_TAIL</button><label><input type="checkbox">LABEL_START${'标签'.repeat(17000)}LABEL_TAIL</label>`;
    });
    const first = await dispatch(page, { type: 'EXTRACT', runId: 'run-e2e' });
    assert.equal(first.text.length, 32000);
    const oldRef = refMatching(first, /按钮/);
    let combined = first.text;
    for (let index = 1; index < first.segmentCount; index++) {
      const part = await dispatch(page, { type: 'READ_SEGMENT', runId: 'run-e2e', snapshotId: first.snapshotId, index });
      assert.equal(part.signature, first.signature);
      combined += part.text;
    }
    assert.match(combined, /CONTROL_TAIL/); assert.match(combined, /LABEL_TAIL/);
    const reconstructed = combined
      .replace(/^\[\d+\] 按钮「(.*)」\n/, '$1')
      .replace(/\n\[\d+\] 选项「(.*)」 类型:复选 未选\n/, '\n$1');
    assert.equal(reconstructed, `CONTROL_START${'正文'.repeat(17000)}CONTROL_TAIL\nLABEL_START${'标签'.repeat(17000)}LABEL_TAIL`, '标题预览和分段尾文合并后必须逐字无重无漏');
    const result = await execute(page, first, 'op-unified-budget', [{ action: 'scroll', value: 'top' }]);
    assert.equal(result.page.text.length, 32000);
    assert.equal(result.page.signature, first.signature);
    assert.notEqual(result.page.snapshotId, first.snapshotId);
    const rejected = await execute(page, result.page, 'op-no-ref-collision', [{ action: 'click', ref: oldRef }]);
    assert.equal(rejected.results[0].code, 'TARGET_NOT_FOUND');
    assert.equal(await page.locator('input').isChecked(), false);
  });
});

test('长交互容器跨续读只补标题未覆盖尾文，仍枚举原生和 Shadow 子控件并脱敏', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = `<div role="button"><span>UNIQUE_CONTROL_PREFIX</span><span>${'z'.repeat(520000)}</span><input aria-label="Tail field"><div id="tail-shadow"></div><label><input type="checkbox">Unique label</label><textarea autocomplete="one-time-code">fake-container-secret</textarea></div><button type="button">Final action</button>`;
      document.querySelector('#tail-shadow').attachShadow({ mode: 'open' }).innerHTML = '<input aria-label="Tail shadow field">';
    });
    let snap = await extract(page, { maxLen: 16000 });
    assert.equal(snap.canContinue, true);
    let combined = '';
    for (let window = 0; ; window++) {
      assert.ok(window < 2);
      for (let index = 0; index < snap.segmentCount; index++) {
        const part = index ? await dispatch(page, { type: 'READ_SEGMENT', runId: 'run-e2e', snapshotId: snap.snapshotId, index }) : snap;
        assert.ok(part.text.length <= 16000);
        assert.doesNotMatch(JSON.stringify(part), /fake-container-secret/);
        combined += part.text;
      }
      if (!snap.canContinue) break;
      snap = await extract(page, { maxLen: 16000, continueSnapshotId: snap.snapshotId });
      assert.ok(snap.snapshotId, JSON.stringify(snap));
    }
    assert.equal(combined.split('UNIQUE_CONTROL_PREFIX').length - 1, 1);
    assert.equal(combined.match(/z/g)?.length, 520000, '标题跨文本节点的截断前缀和续读尾文不能重复或遗漏');
    assert.equal(combined.split('Unique label').length - 1, 1);
    const response = await execute(page, snap, 'op-long-container-tail', [
      { action: 'fill', ref: refMatching(snap, /输入框\(text\).*标签:Tail field/), value: 'native tail' },
      { action: 'fill', ref: refMatching(snap, /输入框\(text\).*标签:Tail shadow field/), value: 'shadow tail' },
      { action: 'check', ref: refMatching(snap, /选项「Unique label」/) },
    ]);
    assert.ok(response.results.every((result) => result.ok), JSON.stringify(response.results));
    assert.doesNotMatch(JSON.stringify(response), /fake-container-secret/);
    assert.equal(await page.locator('input[type="checkbox"]').isChecked(), true);
    assert.equal(await page.locator('#tail-shadow input').inputValue(), 'shadow tail');
    assert.equal(await page.locator('input[aria-label="Tail field"]').inputValue(), 'native tail');
  });
});

test('图片候选包含小内容图和开放Shadow DOM，能力关闭/枚举均不读取像素或fetch，只返回所选图且不改ref', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(async () => {
      document.body.innerHTML = '<button>保持ref</button><figure>题目中的小符号<img id="small" alt="16px数学符号"></figure><div id="host"></div>';
      const source = document.createElement('canvas'); source.width = 16; source.height = 16;
      source.getContext('2d').fillRect(0, 0, 16, 16);
      document.querySelector('#small').src = source.toDataURL();
      await document.querySelector('#small').decode();
      document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<p>Shadow图表</p><canvas width="48" height="32" aria-label="统计图"></canvas>';
      window.pixelCalls = 0; window.extraFetches = 0;
      const originalBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (...args) { window.pixelCalls++; return originalBlob.apply(this, args); };
      window.fetch = () => { window.extraFetches++; throw new Error('候选阶段禁止fetch'); };
    });
    const disabled = await extract(page);
    assert.deepEqual(disabled.imageCandidates, []);
    const snap = await extract(page, { includeImages: true });
    assert.equal(snap.imageCandidates.length, 2);
    assert.ok(snap.imageCandidates.some((item) => item.kind === 'img' && item.width === 16 && item.alt.includes('数学符号')));
    assert.ok(snap.imageCandidates.some((item) => item.kind === 'canvas' && item.alt === '统计图'));
    assert.ok(snap.imageCandidates.every((item) => typeof item.inViewport === 'boolean' && 'displayWidth' in item && 'nearby' in item));
    assert.deepEqual(await page.evaluate(() => [window.pixelCalls, window.extraFetches]), [0, 0]);
    const selected = snap.imageCandidates.find((item) => item.kind === 'canvas').id;
    const message = { type: 'READ_IMAGES', runId: 'run-e2e', snapshotId: snap.snapshotId, allowImages: true, ids: [selected] };
    const result = await dispatch(page, message);
    assert.equal(result.results.length, 1); assert.equal(result.results[0].id, selected);
    assert.match(result.results[0].dataUrl, /^data:image\/jpeg;base64,/);
    const reread = await dispatch(page, { type: 'READ_SEGMENT', runId: 'run-e2e', snapshotId: snap.snapshotId, index: 0 });
    assert.equal(reread.snapshotId, snap.snapshotId);
    const clicked = await execute(page, snap, 'op-image-ref-stable', [{ action: 'click', ref: refMatching(snap, /保持ref/) }]);
    assert.equal(clicked.results[0].ok, true);
    assert.equal((await dispatch(page, message)).code, 'STALE_SNAPSHOT');
  });
});

test('图片必须已展示，节点替换/来源变更/编码期间变化拒绝，像素和编码字节有界', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => { document.body.innerHTML = '<canvas width="16" height="16" aria-label="first"></canvas><p>' + 'x'.repeat(32000) + '</p><canvas id="later" width="20" height="20"></canvas>'; });
    const snap = await dispatch(page, { type: 'EXTRACT', runId: 'run-e2e', includeImages: true });
    const base = { type: 'READ_IMAGES', runId: 'run-e2e', snapshotId: snap.snapshotId, allowImages: true };
    assert.equal((await dispatch(page, { ...base, ids: [2] })).code, 'INVALID_IMAGE');
    const tail = await dispatch(page, { type: 'READ_SEGMENT', runId: 'run-e2e', snapshotId: snap.snapshotId, index: snap.segmentCount - 1 });
    assert.ok(tail.imageCandidates.some((item) => item.id === 2));
    await page.evaluate(() => { const el = document.querySelector('canvas'); el.replaceWith(el.cloneNode()); });
    assert.equal((await dispatch(page, { ...base, ids: [1] })).results[0].code, 'STALE_IMAGE');
    await page.evaluate(() => { document.body.innerHTML = '<canvas width="5000" height="4000"></canvas>'; });
    const large = await extract(page, { includeImages: true });
    assert.equal((await dispatch(page, { ...base, snapshotId: large.snapshotId, ids: [1] })).results[0].code, 'PIXEL_LIMIT');
    await page.evaluate(() => {
      document.body.innerHTML = '<canvas width="32" height="32"></canvas>';
      HTMLCanvasElement.prototype.toBlob = function (callback) { callback(new Blob([new Uint8Array(400000)], { type: 'image/jpeg' })); };
    });
    const encoded = await extract(page, { includeImages: true });
    assert.equal((await dispatch(page, { ...base, snapshotId: encoded.snapshotId, ids: [1] })).results[0].code, 'ENCODED_LIMIT');
    await page.evaluate(() => { HTMLCanvasElement.prototype.toBlob = function (callback) { document.querySelector('canvas').width++; callback(new Blob(['ok'], { type: 'image/jpeg' })); }; });
    assert.equal((await dispatch(page, { ...base, snapshotId: encoded.snapshotId, ids: [1] })).results[0].code, 'STALE_IMAGE');
  });
});

test('图片编码挂起时取消立即结算并释放互斥，停止后不返回迟到像素', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<canvas width="32" height="32"></canvas>';
      HTMLCanvasElement.prototype.toBlob = function (callback) { window.lateImageCallback = callback; };
    });
    const snap = await extract(page, { includeImages: true });
    const started = Date.now();
    const pending = dispatch(page, { type: 'READ_IMAGES', runId: 'run-e2e', snapshotId: snap.snapshotId, allowImages: true, ids: [1] });
    await page.waitForFunction(() => typeof window.lateImageCallback === 'function');
    await dispatch(page, { type: 'ABORT', runId: 'run-e2e' }, false);
    assert.equal((await pending).code, 'CANCELLED');
    assert.ok(Date.now() - started < 2000);
    await page.evaluate(() => window.lateImageCallback(new Blob(['late'])));
    const fresh = await dispatch(page, { type: 'EXTRACT', runId: 'next-run' });
    assert.ok(fresh.snapshotId);
  });
});

test('冻结分段不随 DOM 变化，已交付目标仍逐个校验，导航和取消使读取失效', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => { document.body.innerHTML = `<button id="first">First</button><p>${'x'.repeat(2200)}</p><button id="later">Later</button>`; });
    const snap = await extract(page, { maxLen: 1000 });
    const first = refMatching(snap, /按钮「First」/);
    const index = snap.segmentCount - 1;
    const later = await dispatch(page, { type: 'READ_SEGMENT', runId: 'run-e2e', snapshotId: snap.snapshotId, index });
    const laterRef = refMatching(later, /按钮「Later」/);
    await page.evaluate(() => { document.querySelector('#first').textContent = 'Changed'; document.querySelector('p').textContent = 'MUTATED'; });
    const frozen = await dispatch(page, { type: 'READ_SEGMENT', runId: 'run-e2e', snapshotId: snap.snapshotId, index });
    assert.equal(frozen.text, later.text);
    const result = await execute(page, snap, 'op-segment-stale', [{ action: 'click', ref: first }, { action: 'click', ref: laterRef }]);
    assert.equal(result.results[0].code, 'STALE_TARGET');
    assert.equal(result.results[1].ok, true);
    const next = result.page;
    await page.evaluate(() => history.pushState({}, '', '#different'));
    assert.equal((await dispatch(page, { type: 'READ_SEGMENT', runId: 'run-e2e', snapshotId: next.snapshotId, index: 0 })).code, 'STALE_SNAPSHOT');
    const fresh = await extract(page);
    await dispatch(page, { type: 'ABORT', runId: 'run-e2e' }, false);
    assert.equal((await dispatch(page, { type: 'READ_SEGMENT', runId: 'run-e2e', snapshotId: fresh.snapshotId, index: 0 })).code, 'CANCELLED');
  });
});

for (const boundary of ['surrogate', 'separator']) {
  test(`续读窗口边界 ${boundary} 不死循环、不丢字符且每段 Unicode 完整`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      const firstText = 'x'.repeat(boundary === 'surrogate' ? 511999 : 512000);
      const tail = '😀WINDOW_TAIL';
      await page.evaluate(({ firstText, tail, boundary }) => {
        document.body.innerHTML = '';
        const first = document.createElement('p');
        first.textContent = firstText + (boundary === 'surrogate' ? tail : '');
        document.body.append(first);
        if (boundary === 'separator') {
          const second = document.createElement('p'); second.textContent = tail; document.body.append(second);
        }
      }, { firstText, tail, boundary });
      let snap = await extract(page, { maxLen: 50000 });
      assert.equal(snap.canContinue, true);
      assert.equal(snap.totalChars, firstText.length);
      let actual = '';
      for (let window = 0; ; window++) {
        assert.ok(window < 2, '续读必须前进并在第二窗口结束');
        for (let index = 0; index < snap.segmentCount; index++) {
          const part = index ? await dispatch(page, { type: 'READ_SEGMENT', runId: 'run-e2e', snapshotId: snap.snapshotId, index }) : snap;
          assert.ok(part.text.length > 0 && part.text.length <= 50000);
          assert.ok(part.text.isWellFormed(), '不能切开 UTF-16 代理对');
          actual += part.text;
        }
        if (!snap.canContinue) break;
        snap = await extract(page, { maxLen: 50000, continueSnapshotId: snap.snapshotId });
        assert.ok(snap.snapshotId, JSON.stringify(snap));
      }
      assert.equal(actual, firstText + (boundary === 'separator' ? '\n' : '') + tail);
    });
  });
}

test('分段读取校验 run、snapshot 和 index，新提取拒绝旧 ref 且不产生动作', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = `<button>First action</button><p>${'x'.repeat(2200)}</p><button>Last action</button>`;
      window.snapshotClicks = 0;
      document.addEventListener('click', () => window.snapshotClicks++);
    });
    const old = await extract(page, { maxLen: 1000 });
    const read = (patch) => dispatch(page, { type: 'READ_SEGMENT', runId: 'run-e2e', snapshotId: old.snapshotId, index: 1, ...patch });
    assert.equal((await read({ runId: 'another-run' })).code, 'STALE_SNAPSHOT');
    assert.equal((await read({ snapshotId: 'other-snapshot' })).code, 'STALE_SNAPSHOT');
    for (const index of [-1, 0.5, '1', old.segmentCount]) assert.equal((await read({ index })).code, 'INVALID_SEGMENT');
    const last = await read({ index: old.segmentCount - 1 });
    const lastRef = refMatching(last, /按钮「Last action」/);
    const fresh = await extract(page, { maxLen: 1000 });
    assert.notEqual(fresh.snapshotId, old.snapshotId);
    assert.equal((await read({ index: 0 })).code, 'STALE_SNAPSHOT');
    assert.equal((await execute(page, old, 'op-old-snapshot', [{ action: 'click', ref: lastRef }])).results[0].code, 'STALE_SNAPSHOT');
    assert.equal((await execute(page, fresh, 'op-old-ref-new-snapshot', [{ action: 'click', ref: lastRef }])).results[0].code, 'TARGET_NOT_FOUND');
    assert.equal(await page.evaluate(() => window.snapshotClicks), 0);
  });
});

test('节点预算可续读至页尾，Shadow DOM 属性变化也拒绝续读', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<p>NODE_START</p>';
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < 30005; i++) fragment.append(document.createComment('bounded-node'));
      const tail = document.createElement('p'); tail.textContent = 'NODE_TAIL'; fragment.append(tail);
      const host = document.createElement('div'); host.id = 'shadow-host';
      host.attachShadow({ mode: 'open' }).innerHTML = '<p>SHADOW_CONTENT</p>'; fragment.append(host);
      document.body.append(fragment);
    });
    const first = await extract(page);
    assert.match(first.truncated, /节点上限/);
    assert.equal(first.canContinue, true);
    const next = await extract(page, { continueSnapshotId: first.snapshotId });
    assert.ok(next.snapshotId, JSON.stringify(next));
    assert.notEqual(next.snapshotId, first.snapshotId);
    assert.equal(next.canContinue, false);
    assert.match(next.text, /NODE_TAIL/);
    assert.match(next.text, /SHADOW_CONTENT/);
    const fresh = await extract(page);
    await page.evaluate(() => document.querySelector('#shadow-host').shadowRoot.querySelector('p').setAttribute('data-revision', 'changed'));
    assert.equal((await extract(page, { continueSnapshotId: fresh.snapshotId })).code, 'STALE_CONTINUATION');
    assert.equal((await extract(page, { continueSnapshotId: first.snapshotId })).code, 'STALE_CONTINUATION');
  });
});

for (const action of ['click', 'submitForm', 'press']) {
  for (const nested of [false, true]) {
    test(`真实慢 HTTP ${action}${nested ? ' / repeat' : ''}：beforeunload 截停旧文档动作`, { timeout: 30000 }, async () => {
      await withFixture(async (page) => {
        const pathname = `/slow-navigation-native-${action}-${nested}`;
        const requested = new Promise((resolve) => navigationWaiters.set(pathname, resolve));
        try {
          await page.evaluate((destination) => {
            document.body.insertAdjacentHTML('afterbegin', `<a id="slow-link" href="${destination}">Slow local link</a><form action="${destination}" method="post"><input id="slow-field" aria-label="Slow local field"><button id="slow-submit" type="submit">Slow local submit</button></form>`);
            window.unloadObserved = null;
            addEventListener('beforeunload', (event) => { window.unloadObserved = { trusted: event.isTrusted, prevented: event.defaultPrevented, returnValue: event.returnValue }; });
          }, pathname);
          const snap = await extract(page);
          const first = action === 'click' ? { action, ref: refMatching(snap, /链接「Slow local link」/) }
            : action === 'submitForm' ? { action, ref: refMatching(snap, /按钮「Slow local submit」/) }
            : { action, ref: refMatching(snap, /输入框\(text\).*标签:Slow local field/), value: 'Enter' };
          const oldClick = { action: 'click', ref: refMatching(snap, /按钮「Count once」/) };
          const { response, clicks, unload, url } = await page.evaluate((message) => new Promise((resolve) => {
            globalThis.__viasContentListener(message, {}, (response) => resolve({ response, clicks: window.fixtureCounts.button, unload: window.unloadObserved, url: location.href }));
          }), { type: 'EXECUTE', runId: 'run-e2e', operationId: `op-native-${action}-${nested}`, snapshotId: snap.snapshotId, approved: true, actions: [nested ? { action: 'repeat', times: 3, value: 60000, actions: [first, oldClick] } : first, oldClick] });
          await requested;
          assert.equal(url, fixtureUrl, '响应未释放前 location 仍必须是旧页');
          assert.equal(response.results[0].code, 'NAVIGATING', JSON.stringify(response));
          assert.equal(response.results[0].ok, true);
          assert.equal(response.results[1].code, 'SKIPPED_AFTER_NAVIGATION');
          if (nested) assert.equal(response.results[0].results[1].code, 'SKIPPED_AFTER_NAVIGATION');
          assert.equal(Object.hasOwn(response, 'page'), false);
          assert.equal(clicks, 0);
          assert.deepEqual(unload, { trusted: true, prevented: false, returnValue: '' }, '监听不得阻断原生导航');
          pendingNavigations.get(pathname).end('<!doctype html><title>Native destination</title>');
          await page.waitForURL(new URL(pathname, fixtureUrl).href);
        } finally {
          pendingNavigations.get(pathname)?.end();
          pendingNavigations.delete(pathname);
          navigationWaiters.delete(pathname);
        }
      });
    });
  }
}

for (const action of ['click', 'dblclick', 'check']) {
  for (const mutation of ['reuse-on-scroll', 'href-during-paint', 'detach-during-paint', 'href-on-mousedown']) {
    test(`${action} 派发前重验固定 ref：${mutation}`, { timeout: 30000 }, async () => {
      await withFixture(async (page) => {
        await page.evaluate(() => {
          document.body.innerHTML = '<div style="height:2500px"></div><a id="race-target" href="/safe-link">Original race target</a>';
          window.raceEvents = [];
          const target = document.querySelector('#race-target');
          for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) target.addEventListener(type, (event) => {
            window.raceEvents.push(type);
            if (type === 'click') event.preventDefault();
          });
        });
        const snap = await extract(page);
        const ref = refMatching(snap, /链接「Original race target」/);
        await page.evaluate((kind) => {
          const target = document.querySelector('#race-target');
          window.raceMutationDone = false;
          const mutate = () => {
            if (kind === 'reuse-on-scroll') target.textContent = 'Reused virtual row';
            else if (kind === 'detach-during-paint') target.remove();
            else target.href = 'java\nscript:window.unsafeClicked=true';
            window.raceMutationDone = true;
          };
          if (kind === 'href-on-mousedown') target.addEventListener('mousedown', mutate, { once: true });
          else addEventListener('scroll', () => {
            if (kind === 'reuse-on-scroll') mutate();
            else setTimeout(mutate, 30);
          }, { once: true });
        }, mutation);
        const response = await execute(page, snap, `op-race-${action}-${mutation}`, [{ action, ref }]);
        assert.equal(response.results[0].code, 'STALE_TARGET', JSON.stringify(response));
        assert.equal(response.results[0].ok, false);
        const state = await page.evaluate(() => ({ mutated: window.raceMutationDone, events: window.raceEvents, unsafe: window.unsafeClicked }));
        assert.equal(state.mutated, true, '必须真实触发滚动或前置鼠标事件');
        assert.equal(state.events.includes('click'), false);
        assert.equal(state.events.includes('dblclick'), false);
        assert.equal(state.unsafe, undefined);
        if (mutation !== 'href-on-mousedown') assert.deepEqual(state.events, [], 'paint 后检查必须早于任何指针事件');
      });
    });
  }
}

for (const action of ['fill', 'type', 'submitForm', 'press']) {
  for (const phase of action === 'press' ? ['focus'] : ['scroll', 'focus']) {
    test(`${action} 的 ${phase} 同步复用/替换目标不得写入或提交`, { timeout: 30000 }, async () => {
      await withFixture(async (page) => {
        await page.evaluate(() => {
          document.body.innerHTML = '<form><input id="race-field" aria-label="Original field" value="original"><button id="race-submit" type="submit">Submit local race</button></form>';
          window.raceWrites = 0;
          window.raceSubmits = 0;
          document.addEventListener('input', () => window.raceWrites++);
          document.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); window.raceSubmits++; });
        });
        const snap = await extract(page);
        await page.evaluate(({ action, phase }) => {
          const target = document.querySelector('#race-field');
          window.originalRaceField = target;
          const mutate = () => {
            target.setAttribute('aria-label', 'Reused field');
            const replacement = target.cloneNode(true);
            target.replaceWith(replacement);
          };
          // 只在测试目标实例模拟组件的同步滚动重渲染，不改全局页面 API。
          if (phase === 'scroll') target.scrollIntoView = mutate;
          else if (action === 'submitForm') {
            target.required = true;
            target.value = '';
            target.addEventListener('invalid', mutate, { once: true });
          } else target.addEventListener('focus', mutate, { once: true });
        }, { action, phase });
        const response = await execute(page, snap, `op-edit-race-${action}-${phase}`, [{ action, selector: '#race-field', value: action === 'press' ? 'Enter' : 'must not be written' }]);
        assert.equal(response.results[0].code, 'STALE_TARGET', JSON.stringify(response));
        const state = await page.evaluate(() => ({ writes: window.raceWrites, submits: window.raceSubmits, original: window.originalRaceField.value, replacement: document.querySelector('#race-field').value }));
        assert.equal(state.writes, 0);
        assert.equal(state.submits, 0);
        assert.notEqual(state.original, 'must not be written');
        assert.notEqual(state.replacement, 'must not be written');
      });
    });
  }
}

test('selector 固定首次定位节点，paint 期间替换为同描述节点也不能重找后点击', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<button id="selector-race" type="button">Same identity text</button>';
      window.selectorClicks = 0;
      document.addEventListener('click', () => window.selectorClicks++);
      const target = document.querySelector('#selector-race');
      target.scrollIntoView = () => setTimeout(() => target.replaceWith(target.cloneNode(true)), 30);
    });
    const snap = await extract(page);
    const response = await execute(page, snap, 'op-selector-fixed', [{ action: 'click', selector: '#selector-race' }]);
    assert.equal(response.results[0].code, 'STALE_TARGET');
    assert.equal(await page.evaluate(() => window.selectorClicks), 0);
  });
});

test('预算只剩半个标题时整条目标移到下一段，编号与可执行映射保持原子性', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = `<p>${'x'.repeat(995)}</p><button type="button">Complete target title</button>`;
      window.atomicClicks = 0;
      document.querySelector('button').onclick = () => window.atomicClicks++;
    });
    const snap = await extract(page, { maxLen: 1000 });
    assert.equal(snap.text, 'x'.repeat(995));
    assert.deepEqual(snap.targets, {});
    assert.deepEqual(snap.targetMeta, {});
    assert.equal(snap.segmentCount, 2);
    const part = await dispatch(page, { type: 'READ_SEGMENT', runId: 'run-e2e', snapshotId: snap.snapshotId, index: 1 });
    const ref = refMatching(part, /按钮「Complete target title」/);
    assert.equal(part.text, part.targets[ref]);
    assert.deepEqual(Object.keys(part.targetMeta), [String(ref)]);
    assert.equal((await execute(page, snap, 'op-atomic-title', [{ action: 'click', ref }])).results[0].ok, true);
    assert.equal(await page.evaluate(() => window.atomicClicks), 1);
  });
});

for (const phase of ['paint', 'batch-wait', 'repeat-wait', 'wait', 'selector-wait', 'selector-resolution', 'snapshot']) {
  test(`真实导航在 ${phase} 期间启动时中断等待且不派发旧页动作`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      const pathname = `/slow-navigation-boundary-${phase}`;
      const requested = new Promise((resolve) => navigationWaiters.set(pathname, resolve));
      try {
        const snap = await extract(page);
        const click = { action: 'click', ref: refMatching(snap, /按钮「Count once」/) };
        const actions = phase === 'paint' ? [click, click]
          : phase === 'batch-wait' ? [{ action: 'wait', value: 0 }, click]
          : phase === 'repeat-wait' ? [{ action: 'repeat', times: 3, value: 60000, actions: [{ action: 'wait', value: 0 }] }, click]
          : phase === 'wait' ? [{ action: 'wait', value: 30000 }, click]
          : phase === 'selector-wait' ? [{ action: 'wait', selector: '#never-created', value: 30000 }, click]
          : phase === 'selector-resolution' ? [{ action: 'click', selector: '#never-created' }, click]
          : [{ action: 'wait', value: 0 }];
        const { response, clicks, elapsed } = await page.evaluate(({ message, destination }) => new Promise((resolve) => {
          const started = performance.now();
          setTimeout(() => location.assign(destination), 30);
          globalThis.__viasContentListener(message, {}, (response) => resolve({ response, clicks: window.fixtureCounts.button, elapsed: performance.now() - started }));
        }), { message: { type: 'EXECUTE', runId: 'run-e2e', operationId: `op-boundary-${phase}`, snapshotId: snap.snapshotId, approved: true, actions }, destination: pathname });
        await requested;
        assert.equal(page.url(), fixtureUrl);
        assert.equal(response.results[0].code, 'NAVIGATING', JSON.stringify(response));
        assert.equal(response.results[0].ok, true);
        assert.ok(response.results.slice(1).every((result) => result.code === 'SKIPPED_AFTER_NAVIGATION'));
        assert.equal(Object.hasOwn(response, 'page'), false);
        assert.equal(clicks, 0);
        assert.ok(elapsed < 2000, `不能等满长等待，实际 ${elapsed}ms`);
        pendingNavigations.get(pathname).end('<!doctype html><title>Boundary destination</title>');
        await page.waitForURL(new URL(pathname, fixtureUrl).href);
      } finally {
        pendingNavigations.get(pathname)?.end();
        pendingNavigations.delete(pathname);
        navigationWaiters.delete(pathname);
      }
    });
  });
}

test('导航无提交后 finally 清理旗标，新 run/operation 和 EXTRACT 不继承导航状态', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const pathname = '/slow-navigation-cancelled';
    try {
      await page.evaluate((destination) => {
        document.body.insertAdjacentHTML('afterbegin', `<a id="cancelled-link" href="${destination}">Cancelled local navigation</a>`);
        window.originalPageApis = [window.open, window.confirm, window.alert];
        window.cancelledUnloadCount = 0;
        addEventListener('beforeunload', () => window.cancelledUnloadCount++);
      }, pathname);
      const snap = await extract(page);
      const response = await page.evaluate((message) => new Promise((resolve) => {
        globalThis.__viasContentListener(message, {}, (response) => {
          // 测试取消尚未提交的本地请求；生产执行器不得调用或替换此 API。
          setTimeout(() => { window.stop(); resolve(response); }, 100);
        });
      }), { type: 'EXECUTE', runId: 'run-e2e', operationId: 'op-cancelled-navigation', snapshotId: snap.snapshotId, approved: true, actions: [{ action: 'click', ref: refMatching(snap, /链接「Cancelled local navigation」/) }] });
      assert.equal(response.results[0].code, 'NAVIGATING');
      assert.equal(response.page, undefined);
      assert.equal(page.url(), fixtureUrl);
      assert.equal(await page.evaluate(() => window.cancelledUnloadCount), 1);
      for (const runId of ['run-e2e', 'fresh-after-navigation']) {
        const fresh = await extract(page, { runId });
        assert.ok(fresh.snapshotId);
        assert.equal(fresh.snapshotId.split(':')[0], snap.snapshotId.split(':')[0], '取消导航后仍为旧 documentId，由后台负责拒绝误判成功');
        const result = await dispatch(page, { type: 'EXECUTE', runId, operationId: `op-fresh-${runId}`, snapshotId: fresh.snapshotId, approved: true, actions: [{ action: 'click', ref: refMatching(fresh, /按钮「Count once」/) }] });
        assert.equal(result.results[0].ok, true);
        assert.equal(result.results[0].code, undefined);
        assert.ok(result.page.snapshotId);
      }
      // EXTRACT 期间无论收到何种卸载通知，都不应写入执行批的导航旗标。
      const extraction = await page.evaluate(() => new Promise((resolve) => {
        globalThis.__viasContentListener({ type: 'EXTRACT', runId: 'extract-only' }, {}, resolve);
        dispatchEvent(new Event('beforeunload'));
      }));
      assert.ok(extraction.snapshotId);
      assert.equal(await page.evaluate(() => window.fixtureCounts.button), 2);
      assert.equal(await page.evaluate(() => [window.open, window.confirm, window.alert].every((api, index) => api === window.originalPageApis[index])), true);
    } finally {
      pendingNavigations.get(pathname)?.end();
      pendingNavigations.delete(pathname);
    }
  });
});

test('同批原生输入与富文本值变化不使固定目标指纹失效', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => { document.body.innerHTML = '<input aria-label="Editable native"><div contenteditable="true" aria-label="Editable rich">Initial text</div>'; });
    const snap = await extract(page);
    const refs = [refMatching(snap, /输入框\(text\).*标签:Editable native/), refMatching(snap, /富文本输入区 标签:Editable rich/)];
    const response = await execute(page, snap, 'op-same-batch-values', refs.flatMap((ref) => [
      { action: 'fill', ref, value: 'first' }, { action: 'type', ref, value: 'second' }, { action: 'fill', ref, value: 'final' },
    ]));
    assert.ok(response.results.every((result) => result.ok), JSON.stringify(response));
    assert.equal(await page.locator('input').inputValue(), 'final');
    assert.equal(await page.locator('[contenteditable]').textContent(), 'final');
  });
});

test('选择器语法错误仍返回 INVALID_SELECTOR，不与导航/取消的字符串 code 混淆', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    let snap = await extract(page);
    for (const action of ['click', 'wait']) {
      const response = await execute(page, snap, `op-invalid-selector-${action}`, [{ action, selector: '[', value: 1000 }]);
      assert.equal(response.results[0].code, 'INVALID_SELECTOR');
      assert.equal(response.results[0].ok, false);
      snap = response.page;
      assert.ok(snap.snapshotId);
    }
    assert.equal(await page.evaluate(() => window.fixtureCounts.button), 0);
  });
});

for (const shadow of [false, true]) {
  test(`可靠性 signature 反映 ARIA 状态和连续点击进展${shadow ? '（open Shadow DOM）' : ''}`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      await page.evaluate((useShadow) => {
        document.body.innerHTML = '<div id="semantic-host"></div>';
        const host = document.querySelector('#semantic-host');
        const root = useShadow ? host.attachShadow({ mode: 'open' }) : host;
        root.innerHTML = '<div id="aria-choice" role="checkbox" tabindex="0" aria-checked="false">ARIA choice</div>'
          + ['selected', 'expanded', 'pressed', 'valuenow', 'valuetext'].map((name) => `<button id="state-${name}" aria-${name}="${name.startsWith('value') ? '1' : 'false'}">${name}</button>`).join('');
        root.querySelector('#aria-choice').addEventListener('click', (event) => {
          event.currentTarget.setAttribute('aria-checked', String(event.currentTarget.getAttribute('aria-checked') !== 'true'));
        });
        for (const name of ['selected', 'expanded', 'pressed', 'valuenow', 'valuetext']) root.querySelector(`#state-${name}`).addEventListener('click', (event) => {
          event.currentTarget.setAttribute(`aria-${name}`, name.startsWith('value') ? '2' : 'true');
        });
      }, shadow);
      let snap = await extract(page);
      for (let index = 0; index < 4; index++) {
        const response = await execute(page, snap, `op-aria-${shadow}-${index}`, [{ action: 'click', selector: '#aria-choice' }]);
        assert.equal(response.results[0].ok, true, JSON.stringify(response));
        assert.equal(await page.evaluate(() => {
          const host = document.querySelector('#semantic-host');
          return (host.shadowRoot || host).querySelector('#aria-choice').getAttribute('aria-checked');
        }), String(index % 2 === 0));
        assert.notEqual(response.page.signature, snap.signature, '每次真实翻转都必须算进展');
        snap = response.page;
      }
      for (const name of ['selected', 'expanded', 'pressed', 'valuenow', 'valuetext']) {
        const response = await execute(page, snap, `op-aria-${shadow}-${name}`, [{ action: 'click', selector: `#state-${name}` }]);
        assert.equal(response.results[0].ok, true);
        assert.notEqual(response.page.signature, snap.signature, `aria-${name} 状态改变必须改变签名`);
        assert.equal(await page.evaluate((attribute) => {
          const host = document.querySelector('#semantic-host');
          return (host.shadowRoot || host).querySelector(`#state-${attribute}`).getAttribute(`aria-${attribute}`);
        }, name), name.startsWith('value') ? '2' : 'true');
        snap = response.page;
      }
    });
  });
}

test('可靠性 signature 忽略动画属性和计时器，保留正文及原生多选变化', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<div id="animation">Stable</div><span role="timer">剩余 30 秒</span><span id="clock">12:30:01</span><p id="message">Pending</p>'
        + '<label><input id="hidden-choice" style="display:none" type="checkbox">Hidden native choice</label>'
        + '<select id="multiple" multiple><option selected>A</option><option>B</option><option>C</option></select>';
    });
    const before = await extract(page);
    await page.evaluate(() => {
      document.querySelector('[role="timer"]').textContent = '剩余 29 秒';
      document.querySelector('#clock').textContent = '12:30:02';
      document.querySelector('#animation').setAttribute('style', 'transform:translateX(1px)');
      document.querySelector('#animation').dataset.timestamp = String(Date.now());
    });
    const jitter = await extract(page);
    assert.equal(jitter.signature, before.signature, '无关时间/动画抖动不算任务进展');
    await page.evaluate(() => { document.querySelector('#message').textContent = 'Completed'; });
    const changed = await extract(page);
    assert.notEqual(changed.signature, jitter.signature, '普通正文变化仍算进展');
    await page.evaluate(() => { document.querySelector('#multiple').options[2].selected = true; });
    const selected = await extract(page);
    assert.notEqual(selected.signature, changed.signature, '首个value/index不变时其他多选项也应进入签名');
    assert.deepEqual(await page.locator('#multiple').evaluate((el) => [...el.selectedOptions].map((option) => option.text)), ['A', 'C']);
    await page.evaluate(() => { document.querySelector('#hidden-choice').checked = true; });
    assert.notEqual((await extract(page)).signature, selected.signature, '可见label关联的隐藏原生控件状态也应纳入');
  });
});

async function pressAndRead(page, snap, operationId, key, selector = '#name') {
  const response = await execute(page, snap, operationId, [{ action: 'press', ...(selector ? { selector } : {}), value: key }]);
  const state = await page.evaluate((targetSelector) => {
    let el = targetSelector ? document.querySelector(targetSelector) : document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return { value: el.value, start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection };
  }, selector);
  return { response, state };
}

test('可靠性 press Backspace/Delete 真正删除当前选区和完整 Unicode 字符', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    let snap = await extract(page);
    const cases = [
      ['abc', 3, 3, 'Backspace', 'ab', 2],
      ['abc', 1, 1, 'Delete', 'ac', 1],
      ['abcdef', 1, 4, 'Backspace', 'aef', 1],
      ['abcdef', 1, 4, 'Delete', 'aef', 1],
      ['a👨‍👩‍👧‍👦e\u0301', 14, 14, 'Backspace', 'a👨‍👩‍👧‍👦', 12],
      ['a👨‍👩‍👧‍👦', 12, 12, 'Backspace', 'a', 1],
    ];
    for (const [index, [value, start, end, key, expected, caret]] of cases.entries()) {
      await page.locator('#name').evaluate((el, state) => { el.value = state.value; el.setSelectionRange(state.start, state.end); }, { value, start, end });
      const { response, state } = await pressAndRead(page, snap, `op-delete-${index}`, key);
      assert.equal(response.results[0].ok, true, JSON.stringify(response));
      assert.deepEqual({ value: state.value, start: state.start, end: state.end }, { value: expected, start: caret, end: caret });
      snap = response.page;
    }
    assert.equal(await page.evaluate(() => window.fixtureCounts.nameInput), cases.length, '每次删除都应产生真实input通知');
  });
});

test('可靠性 press 全选、左右方向、Shift 选区和输入均核对实际选区', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.locator('#name').evaluate((el) => { el.value = 'abcd'; el.setSelectionRange(2, 2); });
    let snap = await extract(page);
    const cases = [
      ['ArrowLeft', 'abcd', 1, 1], ['Shift+ArrowRight', 'abcd', 1, 2],
      ['Shift+ArrowRight', 'abcd', 1, 3], ['x', 'axd', 2, 2],
      ['Home', 'axd', 0, 0], ['Shift+End', 'axd', 0, 3],
      ['ArrowLeft', 'axd', 0, 0], ['Control+A', 'axd', 0, 3],
      ['ArrowRight', 'axd', 3, 3], ['Shift+ArrowLeft', 'axd', 2, 3],
      ['Backspace', 'ax', 2, 2], ['Meta+A', 'ax', 0, 2],
    ];
    for (const [index, [key, value, start, end]] of cases.entries()) {
      const { response, state } = await pressAndRead(page, snap, `op-selection-${index}`, key);
      assert.equal(response.results[0].ok, true, `${key}: ${JSON.stringify(response)}`);
      assert.deepEqual({ value: state.value, start: state.start, end: state.end }, { value, start, end }, key);
      if (key === 'Shift+ArrowLeft') assert.equal(state.direction, 'backward');
      snap = response.page;
    }
  });
});

test('可靠性 press textarea Enter 替换选区并换行，普通 Enter 保留提交事件', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.locator('#notes').evaluate((el) => { el.value = 'abcDEF'; el.setSelectionRange(3, 6); });
    let snap = await extract(page);
    const newline = await pressAndRead(page, snap, 'op-selection-newline', 'Enter', '#notes');
    assert.equal(newline.response.results[0].ok, true);
    assert.deepEqual({ value: newline.state.value, start: newline.state.start, end: newline.state.end }, { value: 'abc\n', start: 4, end: 4 });
    assert.equal(await page.evaluate(() => window.fixtureCounts.formSubmit), 0);
    await page.evaluate(() => {
      document.querySelector('#note-form').insertAdjacentHTML('beforeend', '<input id="enter-field" aria-label="Enter field">');
      window.pressTrust = [];
      document.querySelector('#enter-field').addEventListener('keydown', (event) => window.pressTrust.push(event.isTrusted));
    });
    snap = await extract(page);
    const submit = await execute(page, snap, 'op-real-enter-submit', [{ action: 'press', selector: '#enter-field', value: 'Enter' }]);
    assert.equal(submit.results[0].ok, true);
    assert.equal(await page.evaluate(() => window.fixtureCounts.formSubmit), 1);
    assert.deepEqual(await page.evaluate(() => window.pressTrust), [false], '不得伪造isTrusted');
  });
});

test('可靠性 press custom ArrowDown/Escape 仅在真实语义变化后成功', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<div role="listbox"><div id="first-option" role="option" tabindex="0" aria-selected="true">First</div><div id="next-option" role="option" aria-selected="false">Next</div></div><button id="menu-toggle" aria-expanded="true">Menu</button><div id="menu">Menu content</div>';
      document.querySelector('#first-option').addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowDown') return;
        event.preventDefault();
        event.currentTarget.setAttribute('aria-selected', 'false');
        document.querySelector('#next-option').setAttribute('aria-selected', 'true');
      });
      document.querySelector('#menu-toggle').addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.currentTarget.setAttribute('aria-expanded', 'false');
        document.querySelector('#menu').hidden = true;
      });
    });
    let snap = await extract(page);
    const down = await execute(page, snap, 'op-custom-down', [{ action: 'press', selector: '#first-option', value: 'ArrowDown' }]);
    assert.equal(down.results[0].ok, true, JSON.stringify(down));
    assert.deepEqual(await page.locator('[role="option"]').evaluateAll((options) => options.map((option) => option.getAttribute('aria-selected'))), ['false', 'true']);
    assert.notEqual(down.page.signature, snap.signature);
    snap = down.page;
    const escape = await execute(page, snap, 'op-custom-escape', [{ action: 'press', selector: '#menu-toggle', value: 'Escape' }]);
    assert.equal(escape.results[0].ok, true);
    assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#menu').isVisible(), false);
    assert.notEqual(escape.page.signature, snap.signature);
    const again = await execute(page, escape.page, 'op-custom-escape-no-effect', [{ action: 'press', selector: '#menu-toggle', value: 'Escape' }]);
    assert.equal(again.results[0].ok, false);
    assert.equal(again.results[0].code, 'UNSUPPORTED_KEY');
  });
});

for (const mode of ['keydown', 'beforeinput', 'input-revert', 'keyup-revert', 'readonly', 'boundary', 'unknown', 'custom', 'richtext']) {
  test(`可靠性 press 不假成功：${mode}`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      await page.evaluate((failureMode) => {
        document.body.innerHTML = '<input id="name" value="abc"><div id="custom" role="textbox" tabindex="0">abc</div><div id="rich" contenteditable="true">abc</div>';
        const el = document.querySelector('#name');
        el.setSelectionRange(failureMode === 'boundary' ? 0 : 3, failureMode === 'boundary' ? 0 : 3);
        if (failureMode === 'readonly') el.readOnly = true;
        if (['keydown', 'beforeinput'].includes(failureMode)) el.addEventListener(failureMode, (event) => event.preventDefault());
        if (failureMode.endsWith('-revert')) el.addEventListener(failureMode.split('-')[0], () => { el.value = 'abc'; el.setSelectionRange(3, 3); });
      }, mode);
      const snap = await extract(page);
      const selector = mode === 'custom' ? '#custom' : mode === 'richtext' ? '#rich' : '#name';
      const key = mode === 'unknown' ? 'F4' : 'Backspace';
      const response = await execute(page, snap, `op-no-effect-${mode}`, [{ action: 'press', selector, value: key }]);
      assert.equal(response.results[0].ok, false, JSON.stringify(response));
      assert.equal(response.results[0].code, mode === 'readonly' ? 'READ_ONLY' : ['unknown', 'custom', 'richtext'].includes(mode) ? 'UNSUPPORTED_KEY' : 'NO_EFFECT');
      assert.equal(await page.locator(selector).evaluate((el) => el.value ?? el.textContent), 'abc');
    });
  });
}

for (const phase of ['keydown', 'beforeinput']) {
  test(`可靠性 press ${phase} 复用目标返回 STALE_TARGET 且不写入`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      await page.locator('#name').evaluate((el, eventName) => {
        el.value = 'abc'; el.setSelectionRange(3, 3);
        el.addEventListener(eventName, () => el.setAttribute('aria-label', 'Reused field'), { once: true });
      }, phase);
      const snap = await extract(page);
      const response = await execute(page, snap, `op-key-race-${phase}`, [{ action: 'press', selector: '#name', value: 'Backspace' }]);
      assert.equal(response.results[0].code, 'STALE_TARGET');
      assert.equal(await page.locator('#name').inputValue(), 'abc');
    });
  });
}

test('可靠性 press beforeinput 中取消任务不得继续写字段', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.locator('#name').evaluate((el) => {
      el.value = 'abc'; el.setSelectionRange(3, 3);
      el.addEventListener('beforeinput', () => globalThis.__viasContentListener({ type: 'ABORT', runId: 'run-e2e' }, {}, () => {}), { once: true });
    });
    const snap = await extract(page);
    const response = await execute(page, snap, 'op-key-abort', [{ action: 'press', selector: '#name', value: 'Backspace' }]);
    assert.equal(response.results[0].code, 'CANCELLED');
    assert.equal(await page.locator('#name').inputValue(), 'abc');
  });
});

test('可靠性 press 隐式焦点进入 open Shadow DOM，Tab 可验证双向切换', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<div id="host"></div><input id="after" value="after">';
      const shadow = document.querySelector('#host').attachShadow({ mode: 'open' });
      shadow.innerHTML = '<input id="shadow-edit" value="abc">';
      shadow.querySelector('input').focus();
      shadow.querySelector('input').setSelectionRange(3, 3);
    });
    let snap = await extract(page);
    const deletion = await pressAndRead(page, snap, 'op-shadow-key', 'Backspace', null);
    assert.equal(deletion.response.results[0].ok, true);
    assert.equal(deletion.state.value, 'ab');
    assert.equal(deletion.state.start, 2);
    snap = deletion.response.page;
    const tab = await execute(page, snap, 'op-shadow-tab', [{ action: 'press', value: 'Tab' }]);
    assert.equal(tab.results[0].ok, true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'after');
    const back = await execute(page, tab.page, 'op-shadow-shift-tab', [{ action: 'press', value: 'Shift+Tab' }]);
    assert.equal(back.results[0].ok, true);
    assert.equal(await page.evaluate(() => document.querySelector('#host').shadowRoot.activeElement.id), 'shadow-edit');
  });
});

test('可靠性 submitForm novalidate/formnovalidate 跳过原生约束，正常 required 仍拦截', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<form id="validation"><input id="required-field" required><button id="normal-submit">Normal submit</button><button id="skip-submit" formnovalidate>Skip validation</button><button id="not-submitter" type="button" formnovalidate>Plain button</button></form>';
      window.validationEvents = { submits: [], invalid: 0 };
      document.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); window.validationEvents.submits.push(event.submitter?.id || null); });
      document.querySelector('input').addEventListener('invalid', () => window.validationEvents.invalid++);
    });
    let snap = await extract(page);
    for (const [index, selector] of ['#normal-submit', '#not-submitter'].entries()) {
      const response = await execute(page, snap, `op-validation-block-${index}`, [{ action: 'submitForm', selector }]);
      assert.equal(response.results[0].code, 'FORM_INVALID');
      assert.deepEqual(await page.evaluate(() => window.validationEvents.submits), []);
      snap = response.page;
    }
    const bypass = await execute(page, snap, 'op-formnovalidate-submit', [{ action: 'submitForm', selector: '#skip-submit' }]);
    assert.equal(bypass.results[0].ok, true);
    assert.deepEqual(await page.evaluate(() => window.validationEvents), { submits: ['skip-submit'], invalid: 2 });
    await page.evaluate(() => { document.querySelector('form').noValidate = true; });
    snap = await extract(page);
    const noValidate = await execute(page, snap, 'op-novalidate-submit', [{ action: 'submitForm', selector: '#normal-submit' }]);
    assert.equal(noValidate.results[0].ok, true);
    assert.deepEqual(await page.evaluate(() => window.validationEvents), { submits: ['skip-submit', 'normal-submit'], invalid: 2 });
    await page.evaluate(() => { document.querySelector('form').noValidate = false; document.querySelector('input').value = 'valid'; });
    snap = await extract(page);
    const valid = await execute(page, snap, 'op-required-valid-submit', [{ action: 'submitForm', selector: '#normal-submit' }]);
    assert.equal(valid.results[0].ok, true);
    assert.deepEqual(await page.evaluate(() => window.validationEvents.submits), ['skip-submit', 'normal-submit', 'normal-submit']);
  });
});

test('可靠性 repeat 末轮首项失败保留之前成功计数及有界历史', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<button id="repeat-button">Repeat target</button>';
      window.repeatClicks = 0;
      document.querySelector('button').addEventListener('click', (event) => { if (++window.repeatClicks === 2) event.currentTarget.disabled = true; });
    });
    const snap = await extract(page);
    const response = await execute(page, snap, 'op-repeat-partial-history', [{ action: 'repeat', times: 4, value: 0, actions: [{ action: 'click', selector: '#repeat-button' }, { action: 'wait', value: 0 }] }]);
    const result = response.results[0];
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TARGET_DISABLED');
    assert.equal(await page.evaluate(() => window.repeatClicks), 2);
    assert.deepEqual(result.repeatSummary, { plannedIterations: 4, completedIterations: 2, iteration: 3, subIndex: 1, successCount: 4, failureCount: 1, skippedCount: 3, omittedCount: 0 });
    assert.equal(result.results.length, 6);
    assert.equal(result.results[4].iteration, 3);
    assert.equal(result.results[4].subIndex, 1);
    assert.equal(result.results[5].code, 'SKIPPED_AFTER_FAILURE');
  });
});

for (const kind of ['fill', 'type', 'single', 'multiple']) {
  for (const timing of ['sync', 'next-tick']) {
    for (const mode of ['truncate', 'revert']) {
      test(`可靠性值确认 ${kind} ${timing} ${mode} 失败且阻止同批提交`, { timeout: 30000 }, async () => {
        await withFixture(async (page) => {
          await page.evaluate(({ kind, timing, mode }) => {
            document.body.innerHTML = `<form><label>Verified field${['single', 'multiple'].includes(kind)
              ? `<select id="verified" ${kind === 'multiple' ? 'multiple' : ''}><option value="a" selected>A</option><option value="b">B</option><option value="c">C</option></select>`
              : '<input id="verified" value="safe">'}</label><button type="submit">Local submit</button></form>`;
            window.valueSubmits = 0;
            document.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); window.valueSubmits++; });
            document.querySelector('#verified').addEventListener('input', (event) => {
              const apply = () => {
                const el = event.target;
                if (el.tagName === 'SELECT') [...el.options].forEach((option) => { option.selected = option.value === (mode === 'truncate' && kind === 'multiple' ? 'b' : 'a'); });
                else el.value = mode === 'truncate' ? el.value.slice(0, 3) : 'safe';
              };
              if (timing === 'sync') apply(); else setTimeout(apply, 0);
            });
          }, { kind, timing, mode });
          const snap = await extract(page);
          const response = await execute(page, snap, `op-confirm-${kind}-${timing}-${mode}`, [
            { action: ['single', 'multiple'].includes(kind) ? 'select' : kind, selector: '#verified', value: kind === 'multiple' ? ['b', 'c'] : kind === 'single' ? 'b' : 'requested-complete' },
            { action: 'submitForm', selector: '#verified' },
          ]);
          assert.equal(response.results[0].ok, false);
          assert.equal(response.results[0].code, 'VALUE_NOT_APPLIED', JSON.stringify(response));
          assert.equal(response.results[1].code, 'SKIPPED_AFTER_FAILURE');
          assert.equal(await page.evaluate(() => window.valueSubmits), 0);
          assert.equal(Object.hasOwn(response.results[0], 'state'), false);
        });
      });
    }
  }
}

for (const eventName of ['change', 'blur']) {
  test(`可靠性值确认 fill ${eventName} 下一tick回退不误成功`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      await page.locator('#name').evaluate((el, eventName) => el.addEventListener(eventName, () => setTimeout(() => { el.value = 'safe'; }, 0)), eventName);
      const response = await execute(page, await extract(page), `op-late-${eventName}`, [{ action: 'fill', selector: '#name', value: 'complete' }]);
      assert.equal(response.results[0].code, 'VALUE_NOT_APPLIED');
    });
  });
}

for (const kind of ['fill', 'type', 'single', 'multiple']) {
  test(`可靠性值确认 ${kind} 敏感失败不泄漏请求值和实际值`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      await page.evaluate((kind) => {
        document.body.innerHTML = ['single', 'multiple'].includes(kind)
          ? `<select id="secret-field" autocomplete="one-time-code" ${kind === 'multiple' ? 'multiple' : ''}><option value="actual-secret" selected>Actual secret text</option><option value="requested-secret">Requested secret text</option><option value="other-secret">Other secret text</option></select>`
          : '<input id="secret-field" type="password" value="actual-secret">';
        const el = document.querySelector('#secret-field');
        el.addEventListener('change', () => setTimeout(() => {
          if (el.tagName === 'SELECT') [...el.options].forEach((option) => { option.selected = option.value === 'actual-secret'; });
          else el.value = 'actual-secret';
        }, 0));
      }, kind);
      const response = await execute(page, await extract(page), `op-secret-confirm-${kind}`, [{ action: ['single', 'multiple'].includes(kind) ? 'select' : kind, selector: '#secret-field', value: kind === 'multiple' ? ['requested-secret', 'other-secret'] : 'requested-secret' }]);
      assert.equal(response.results[0].code, 'VALUE_NOT_APPLIED');
      assert.doesNotMatch(JSON.stringify(response), /requested-secret|actual-secret|other-secret|Requested secret text|Actual secret text|Other secret text/);
    });
  });
}

for (const kind of ['input', 'textarea', 'richtext']) {
  test(`可靠性值确认 fill ${kind} 200000代码单元全量保留`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      await page.evaluate((kind) => { document.body.innerHTML = kind === 'input' ? '<input id="large" aria-label="Large field">' : kind === 'textarea' ? '<textarea id="large" aria-label="Large field"></textarea>' : '<div id="large" contenteditable="true" aria-label="Large field"></div>'; }, kind);
      const value = 'BEGIN中文🙂'.repeat(19999).padEnd(199996, 'z').slice(0, 199996) + 'TAIL';
      assert.equal(value.length, 200000);
      const response = await execute(page, await extract(page), `op-large-confirm-${kind}`, [{ action: 'fill', selector: '#large', value }]);
      assert.equal(response.results[0].code, 'FILLED', JSON.stringify(response.results));
      assert.deepEqual(await page.locator('#large').evaluate((el, value) => ({ length: (el.value ?? el.textContent).length, full: (el.value ?? el.textContent) === value }), value), { length: 200000, full: true });
    });
  });
}

for (const action of ['fill', 'type']) {
  test(`可靠性值确认 ${action} 正常化换行、整字段替换及末尾光标`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      await page.locator('#notes').evaluate((el) => { el.value = 'old content'; el.setSelectionRange(1, 4); });
      const response = await execute(page, await extract(page), `op-normalized-${action}`, [{ action, selector: '#notes', value: 'a\r\nb\rc\n🙂' }]);
      assert.equal(response.results[0].ok, true, JSON.stringify(response));
      assert.deepEqual(await page.locator('#notes').evaluate((el) => ({ value: el.value, start: el.selectionStart, end: el.selectionEnd })), { value: 'a\nb\nc\n🙂', start: 8, end: 8 });
      await page.locator('#notes').evaluate((el) => el.setSelectionRange(1, 3, 'backward'));
      const noChange = await execute(page, response.page, `op-normalized-no-change-${action}`, [{ action, selector: '#notes', value: 'a\r\nb\rc\n🙂' }]);
      assert.equal(noChange.results[0].code, 'NO_CHANGE');
      assert.deepEqual(await page.locator('#notes').evaluate((el) => [el.selectionStart, el.selectionEnd, el.selectionDirection]), [1, 3, 'backward']);
    });
  });

  test(`可靠性值确认 ${action} maxlength及number/date拒值明确失败`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      await page.evaluate(() => { document.body.innerHTML = '<input id="limited" maxlength="3" value="old"><input id="numeric" type="number"><input id="date" type="date">'; });
      for (const [index, selector] of ['#limited', '#numeric', '#date'].entries()) {
        const response = await execute(page, await extract(page), `op-native-rejection-${action}-${index}`, [{ action, selector, value: 'not-accepted' }]);
        assert.equal(response.results[0].code, 'VALUE_NOT_APPLIED', JSON.stringify(response));
        assert.equal(await page.locator(selector).inputValue(), selector === '#limited' ? 'old' : '');
      }
    });
  });

  test(`可靠性值确认 ${action} 下一tick选区被页面重置仍以值保真为成功`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      await page.locator('#name').evaluate((el) => el.addEventListener('change', () => setTimeout(() => el.setSelectionRange(0, 0), 0)));
      const response = await execute(page, await extract(page), `op-caret-reset-${action}`, [{ action, selector: '#name', value: 'new text' }]);
      // 纯填写以值为成功依据：页面合法重置光标不是填写失败；press 的光标语义另有断言。
      assert.equal(response.results[0].ok, true, JSON.stringify(response));
      assert.notEqual(response.results[0].code, 'VALUE_NOT_APPLIED');
      assert.deepEqual(await page.locator('#name').evaluate((el) => ({ value: el.value, start: el.selectionStart, end: el.selectionEnd })), { value: 'new text', start: 0, end: 0 });
    });
  });
}

test('可靠性值确认 fill 接受email和本地日期时间的正常DOM规范化', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => { document.body.innerHTML = '<input id="addresses" type="email" multiple><input id="local-time" type="datetime-local">'; });
    for (const [index, [selector, value, expected]] of [
      ['#addresses', ' a@example.com , b@example.com ', 'a@example.com,b@example.com'],
      ['#local-time', '2026-11-12 10:30:00', '2026-11-12T10:30'],
    ].entries()) {
      const response = await execute(page, await extract(page), `op-dom-canonical-${index}`, [{ action: 'fill', selector, value }]);
      assert.equal(await page.locator(selector).inputValue(), expected);
      assert.equal(response.results[0].ok, true, JSON.stringify(response.results));
    }
  });
});

for (const multiple of [false, true]) {
  test(`可靠性值确认 select ${multiple ? '多选' : '单选'} 按选项身份处理重复value`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      await page.evaluate((multiple) => { document.body.innerHTML = `<select id="duplicate" aria-label="Duplicate values" ${multiple ? 'multiple' : ''}><option value="same" selected>First</option><option value="same">Second</option><option value="third">Third</option></select>`; }, multiple);
      const value = multiple ? ['Second', 'Third'] : 'Second';
      const response = await execute(page, await extract(page), `op-duplicate-values-${multiple}`, [{ action: 'select', selector: '#duplicate', value }]);
      assert.equal(response.results[0].code, 'SELECTED');
      assert.deepEqual(await page.locator('#duplicate').evaluate((el) => [...el.selectedOptions].map((option) => option.index)), multiple ? [1, 2] : [1]);
      const noChange = await execute(page, response.page, `op-duplicate-idempotent-${multiple}`, [{ action: 'select', selector: '#duplicate', value }]);
      assert.equal(noChange.results[0].code, 'NO_CHANGE');
    });
  });
}

for (const kind of ['fill', 'type', 'single', 'multiple']) {
  for (const timing of ['sync', 'next-tick']) {
    test(`可靠性值确认 ${kind} ${timing} 最终输入后同身份重绘只读恢复`, { timeout: 30000 }, async () => {
      await withFixture(async (page) => {
        await page.evaluate(({ kind, timing }) => {
          document.body.innerHTML = ['single', 'multiple'].includes(kind) ? `<select id="redraw" aria-label="Redraw field" ${kind === 'multiple' ? 'multiple' : ''}><option value="old" selected>Old</option><option value="done">Done</option><option value="other">Other</option></select>` : '<input id="redraw" aria-label="Redraw field">';
          window.replacementInputs = 0;
          const el = document.querySelector('#redraw');
          el.addEventListener('input', () => {
            if (el.value !== 'done') return;
            const redraw = () => {
              const replacement = el.cloneNode(true);
              if (el.tagName === 'SELECT') [...replacement.options].forEach((option, index) => { option.selected = el.options[index].selected; });
              else { replacement.value = el.value; replacement.setSelectionRange(el.selectionStart, el.selectionEnd); }
              replacement.addEventListener('input', () => window.replacementInputs++);
              el.replaceWith(replacement);
            };
            if (timing === 'sync') redraw(); else setTimeout(redraw, 0);
          });
        }, { kind, timing });
        const response = await execute(page, await extract(page), `op-value-redraw-${kind}-${timing}`, [{ action: ['single', 'multiple'].includes(kind) ? 'select' : kind, selector: '#redraw', value: kind === 'multiple' ? ['done', 'other'] : 'done' }]);
        assert.equal(response.results[0].ok, true, JSON.stringify(response));
        assert.equal(await page.evaluate(() => window.replacementInputs), 0);
      });
    });
  }
}

for (const kind of ['fill', 'type', 'select']) {
  test(`可靠性值确认 ${kind} 稳定等待可取消且不提交`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      await page.evaluate((kind) => {
        document.body.innerHTML = `<form>${kind === 'select' ? '<select id="abort-value"><option>A</option><option>B</option></select>' : '<input id="abort-value">'}<button>Submit</button></form>`;
        window.valueSubmits = 0;
        document.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); window.valueSubmits++; });
        document.querySelector('#abort-value').addEventListener('change', () => setTimeout(() => globalThis.__viasContentListener({ type: 'ABORT', runId: 'run-e2e' }, {}, () => {}), 0));
      }, kind);
      const response = await execute(page, await extract(page), `op-value-abort-${kind}`, [{ action: kind, selector: '#abort-value', value: kind === 'select' ? 'B' : 'complete' }, { action: 'submitForm', selector: '#abort-value' }]);
      assert.equal(response.results[0].code, 'CANCELLED');
      assert.equal(response.results[1].code, 'SKIPPED_AFTER_FAILURE');
      assert.equal(await page.evaluate(() => window.valueSubmits), 0);
    });
  });

  test(`可靠性值确认 ${kind} 输入引发导航不误报失败且跳过提交`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      await page.evaluate((kind) => {
        document.body.innerHTML = `<form>${kind === 'select' ? '<select id="navigation-value"><option>A</option><option>B</option></select>' : '<input id="navigation-value">'}<button>Submit</button></form>`;
        window.valueSubmits = 0;
        document.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); window.valueSubmits++; });
        document.querySelector('#navigation-value').addEventListener('change', () => { location.hash = 'value-applied'; });
      }, kind);
      const response = await execute(page, await extract(page), `op-value-navigation-${kind}`, [{ action: kind, selector: '#navigation-value', value: kind === 'select' ? 'B' : 'complete' }, { action: 'submitForm', selector: '#navigation-value' }]);
      assert.equal(response.results[0].code, 'NAVIGATED');
      assert.equal(response.results[0].ok, true);
      assert.equal(response.results[1].code, 'SKIPPED_AFTER_NAVIGATION');
      assert.equal(response.page, undefined);
      assert.equal(await page.evaluate(() => window.valueSubmits), 0);
    });
  });
}

test('可靠性值确认 repeat 失败立即停止后续提交和剩余轮次', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<form><input id="repeat-value"><button>Submit</button></form>';
      window.valueSubmits = 0;
      document.querySelector('input').addEventListener('input', (event) => { event.target.value = 'safe'; });
      document.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); window.valueSubmits++; });
    });
    const response = await execute(page, await extract(page), 'op-value-repeat-stop', [{ action: 'repeat', times: 3, value: 0, actions: [{ action: 'fill', selector: '#repeat-value', value: 'complete' }, { action: 'submitForm', selector: '#repeat-value' }] }]);
    assert.equal(response.results[0].code, 'VALUE_NOT_APPLIED');
    assert.equal(response.results[0].repeatSummary.failureCount, 1);
    assert.equal(response.results[0].repeatSummary.skippedCount, 5);
    assert.equal(await page.evaluate(() => window.valueSubmits), 0);
  });
});

for (const mode of ['default', 'external-default', 'disabled-default', 'fieldset-disabled-default', 'no-default-single', 'no-default-multiple', 'click-prevented', 'keydown-prevented', 'formnovalidate', 'formaction']) {
  test(`可靠性隐式提交 Enter 对照原生 submitter/FormData：${mode}`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      const setup = async () => page.evaluate((mode) => {
        const noDefault = mode.startsWith('no-default');
        const external = mode === 'external-default';
        const button = `<button id="default-submit" ${external ? 'form="implicit"' : ''} name="operation" value="search" ${mode === 'disabled-default' ? 'disabled' : ''} ${mode === 'formnovalidate' ? 'formnovalidate' : ''} ${mode === 'formaction' ? 'formaction="/local-search" formmethod="post"' : ''}>Search</button>`;
        document.body.innerHTML = `${external ? button : ''}<form id="implicit" action="/normal-search"><input id="implicit-field" name="query" value="lookup">${mode === 'no-default-multiple' ? '<input name="second" value="other">' : ''}${['formnovalidate', 'formaction'].includes(mode) ? '<input name="required" required>' : ''}${noDefault || external ? '' : mode === 'fieldset-disabled-default' ? `<fieldset disabled>${button}</fieldset>` : button}${noDefault ? '' : '<button id="second-submit" name="operation" value="wrong-second">Second</button>'}</form>`;
        window.implicitEvents = [];
        document.querySelector('form').addEventListener('submit', (event) => {
          event.preventDefault();
          window.implicitEvents.push({ submitter: event.submitter?.id || null, data: [...new FormData(event.target, event.submitter).entries()], action: event.submitter?.formAction || event.target.action, method: event.submitter?.formMethod || event.target.method });
        });
        document.querySelector('#default-submit')?.addEventListener('click', (event) => { if (mode === 'click-prevented') event.preventDefault(); });
        document.querySelector('#implicit-field').addEventListener('keydown', (event) => { if (mode === 'keydown-prevented') event.preventDefault(); });
        if (mode === 'formaction') document.querySelector('[name="required"]').value = 'valid';
      }, mode);
      await setup();
      await page.locator('#implicit-field').press('Enter');
      const native = await page.evaluate(() => window.implicitEvents);
      await setup();
      const response = await execute(page, await extract(page), `op-implicit-${mode}`, [{ action: 'press', selector: '#implicit-field', value: 'Enter' }]);
      const actual = await page.evaluate(() => window.implicitEvents);
      assert.deepEqual(actual, native, `必须与浏览器原生隐式提交一致：${mode}`);
      assert.equal(response.results[0].ok, native.length > 0, JSON.stringify(response));
      if (native.length) {
        assert.equal(native[0].submitter, noDefaultMode(mode) ? null : 'default-submit');
        assert.equal(native[0].data.some(([name, value]) => name === 'operation' && value === 'search'), !noDefaultMode(mode));
      } else assert.equal(response.results[0].code, 'NO_EFFECT');
    });
  });
}

function noDefaultMode(mode) { return mode.startsWith('no-default'); }

test('可靠性 repeat 200 个成功叶节点仅保留100条历史且不带参数或快照', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    const snap = await extract(page);
    const response = await execute(page, snap, 'op-repeat-history-limit', [{ action: 'repeat', times: 100, value: 0, actions: [{ action: 'wait', value: 0 }, { action: 'wait', value: 0 }] }]);
    const result = response.results[0];
    assert.equal(result.ok, true);
    assert.equal(result.repeatSummary.successCount, 200);
    assert.equal(result.repeatSummary.completedIterations, 100);
    assert.equal(result.repeatSummary.omittedCount, 100);
    assert.equal(result.repeatSummary.skippedCount, 0);
    assert.equal(result.results.length, 100);
    assert.equal(result.results[0].iteration, 51);
    for (const child of result.results) assert.deepEqual(Object.keys(child).sort(), ['action', 'iteration', 'msg', 'ok', 'subIndex']);
  });
});

test('最终审查 select精确提交值优先于另一选项的显示文字', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => { document.body.innerHTML = '<select aria-label="Country"><option value="original">Original</option><option value="wrong">CA</option><option value="CA">Canada</option></select>'; });
    const snap = await extract(page);
    const response = await execute(page, snap, 'op-value-before-label', [{ action: 'select', ref: refMatching(snap, /下拉框/), value: 'CA' }]);
    assert.equal(response.results[0].code, 'SELECTED');
    assert.equal(await page.locator('select').inputValue(), 'CA');
    assert.equal(await page.locator('option:checked').textContent(), 'Canada');
  });
});

for (const ambiguity of ['value', 'text', 'prefix']) {
  test(`最终审查 select ${ambiguity}歧义拒绝且不改变当前选择`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      await page.evaluate((kind) => {
        const options = kind === 'value' ? '<option value="same">First</option><option value="same">Second</option>'
          : kind === 'text' ? '<option value="a">Duplicate</option><option value="b">Duplicate</option>'
          : '<option value="a">Prefix one</option><option value="b">Prefix two</option>';
        document.body.innerHTML = `<select aria-label="Ambiguous choice"><option value="original">Original</option>${options}</select>`;
        window.selectionEvents = 0;
        document.querySelector('select').addEventListener('input', () => window.selectionEvents++);
      }, ambiguity);
      const snap = await extract(page);
      const response = await execute(page, snap, `op-ambiguous-${ambiguity}`, [{ action: 'select', ref: refMatching(snap, /下拉框/), value: { value: 'same', text: 'Duplicate', prefix: 'Prefix' }[ambiguity] }]);
      assert.equal(response.results[0].ok, false);
      assert.equal(response.results[0].code, 'OPTION_NOT_FOUND');
      assert.equal(await page.locator('select').inputValue(), 'original');
      assert.equal(await page.evaluate(() => window.selectionEvents), 0);
    });
  });
}

test('最终审查 select无同值时保留唯一文字和唯一前缀匹配', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => { document.body.innerHTML = '<select aria-label="Choice"><option value="original">Original</option><option value="a">Alpha option</option><option value="b">Beta option</option></select>'; });
    let snap = await extract(page);
    for (const [index, value] of ['Alpha option', 'Beta'].entries()) {
      const response = await execute(page, snap, `op-unique-text-${index}`, [{ action: 'select', ref: refMatching(snap, /下拉框/), value }]);
      assert.equal(response.results[0].code, 'SELECTED');
      assert.equal(await page.locator('select').inputValue(), index === 0 ? 'a' : 'b');
      snap = response.page;
    }
  });
});

test('最终审查 type数字保留合法小数/负数/指数且重复值不发事件', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<input type="number" aria-label="Amount" value="10">';
      window.numberEvents = { input: 0, change: 0 };
      for (const type of ['input', 'change']) document.querySelector('input').addEventListener(type, () => window.numberEvents[type]++);
    });
    let snap = await extract(page);
    for (const [index, value] of ['12.3', '-12.3', '1e-3'].entries()) {
      const response = await execute(page, snap, `op-numeric-complete-${index}`, [{ action: 'type', ref: refMatching(snap, /输入框\(number\)/), value }]);
      assert.equal(response.results[0].ok, true, JSON.stringify(response));
      assert.equal(await page.locator('input').inputValue(), value);
      snap = response.page;
    }
    const repeated = await execute(page, snap, 'op-numeric-no-change', [{ action: 'type', ref: refMatching(snap, /输入框\(number\)/), value: '1e-3' }]);
    assert.equal(repeated.results[0].code, 'NO_CHANGE');
    assert.deepEqual(await page.evaluate(() => window.numberEvents), { input: 3, change: 3 });
  });
});

test('最终审查 type数字仍核验异步回退并阻止后续提交', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<form><input type="number" aria-label="Amount" value="10"><button>Submit</button></form>';
      window.numberSubmits = 0;
      document.querySelector('input').addEventListener('input', (event) => setTimeout(() => { event.target.value = '10'; }, 0));
      document.querySelector('form').onsubmit = (event) => { event.preventDefault(); window.numberSubmits++; };
    });
    const snap = await extract(page);
    const response = await execute(page, snap, 'op-numeric-reverted', [{ action: 'type', ref: refMatching(snap, /输入框\(number\)/), value: '12.3' }, { action: 'submitForm', selector: 'form' }]);
    assert.equal(response.results[0].code, 'VALUE_NOT_APPLIED');
    assert.equal(response.results[1].code, 'SKIPPED_AFTER_FAILURE');
    assert.equal(await page.locator('input').inputValue(), '10');
    assert.equal(await page.evaluate(() => window.numberSubmits), 0);
  });
});

test('最终审查 多选快照与结果显示全部已选项和多选语义', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => { document.body.innerHTML = '<select multiple aria-label="Fruits"><option value="a" selected>Apple</option><option value="b">Banana</option><option value="c" selected>Cherry</option></select>'; });
    const snap = await extract(page);
    const description = Object.values(snap.targets)[0];
    assert.match(description.split('\n')[0], /Apple\(value=a\).*Cherry\(value=c\).*多选.*已选2项/);
    const response = await execute(page, snap, 'op-multiple-observed', [{ action: 'select', ref: refMatching(snap, /下拉框/), value: ['a', 'b', 'c'] }]);
    assert.match(response.results[0].state, /Apple\(value=a\).*Banana\(value=b\).*Cherry\(value=c\).*已选3项/);
    assert.deepEqual(await page.locator('select').evaluate((el) => [...el.selectedOptions].map((option) => option.value)), ['a', 'b', 'c']);
  });
});

test('最终审查 多选状态有界且省略明示，1000代码单元分段仍可登记完整目标', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => { document.body.innerHTML = '<select multiple aria-label="Many choices">' + Array.from({ length: 60 }, (_, index) => `<option value="v${index}" selected>Option ${index}</option>`).join('') + '</select>'; });
    const snap = await extract(page, { maxLen: 1000 });
    assert.equal(Object.keys(snap.targets).length, 1);
    assert.ok(snap.text.length <= 1000);
    const title = Object.values(snap.targets)[0].split('\n')[0];
    assert.ok(title.length < 600);
    assert.match(title, /多选，已选60项，其余\d+项已省略/);
    const response = await execute(page, snap, 'op-multiple-bounded', [{ action: 'select', ref: refMatching(snap, /下拉框/), value: ['v0'] }]);
    assert.equal(response.results[0].code, 'SELECTED');
    assert.match(response.results[0].state, /已选1项/);
  });
});

for (const hidden of ['aria-hidden="true"', 'role="tooltip"', 'hidden']) {
  test(`最终审查 display:contents仍过滤${hidden}且保留普通contents子控件`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      await page.evaluate((attribute) => {
        document.body.innerHTML = `<div style="display:contents" ${attribute}><span>HIDDEN_CONTENTS_COPY</span><button>Hidden contents action</button></div><div style="display:contents"><span>Visible contents copy</span><button>Visible contents action</button></div>`;
        window.contentsClicks = 0;
        document.querySelectorAll('button')[1].onclick = () => window.contentsClicks++;
      }, hidden);
      const snap = await extract(page);
      assert.doesNotMatch(JSON.stringify(snap), /HIDDEN_CONTENTS_COPY|Hidden contents action/);
      assert.match(snap.text, /Visible contents copy/);
      const response = await execute(page, snap, `op-contents-${hidden}`, [{ action: 'click', ref: refMatching(snap, /按钮「Visible contents action」/) }]);
      assert.equal(response.results[0].ok, true);
      assert.equal(await page.evaluate(() => window.contentsClicks), 1);
    });
  });
}

for (const skippedSubmit of [false, true]) {
  test(`最终审查 批末导航保留真实失败${skippedSubmit ? '和跳过提交' : ''}并另报navigation`, { timeout: 30000 }, async () => {
    await withFixture(async (page) => {
      await page.evaluate(() => {
        document.body.innerHTML = '<form><input aria-label="Reverted field"><button>Submit</button></form>';
        window.finalObservationSubmits = 0;
        window.finalObservationWrites = 0;
        document.querySelector('form').onsubmit = (event) => { event.preventDefault(); window.finalObservationSubmits++; };
        document.querySelector('input').oninput = (event) => {
          window.finalObservationWrites++;
          event.target.value = 'rollback';
          setTimeout(() => { location.hash = 'final-observation-navigation'; }, 350);
        };
      });
      const snap = await extract(page);
      await page.clock.install();
      const actions = [{ action: 'fill', ref: refMatching(snap, /输入框/), value: 'requested' }, ...(skippedSubmit ? [{ action: 'submitForm', ref: refMatching(snap, /按钮「Submit」/) }] : [])];
      const operationId = `op-final-observation-${skippedSubmit}`;
      await startClockBatch(page, snap, operationId, actions);
      await page.clock.runFor(1000);
      const response = await page.evaluate(() => window.clockResponse);
      assert.equal(response.results[0].ok, false, JSON.stringify(response));
      assert.equal(response.results[0].code, 'VALUE_NOT_APPLIED');
      if (skippedSubmit) assert.equal(response.results[1].code, 'SKIPPED_AFTER_FAILURE');
      assert.equal(response.results.length, actions.length);
      assert.equal(response.results.filter((result) => result.ok).length, 0);
      assert.equal(response.navigation.ok, true);
      assert.equal(response.navigation.code, 'NAVIGATED');
      assert.match(response.navigation.navigationUrl, /#final-observation-navigation$/);
      assert.equal(Object.hasOwn(response, 'page'), false);
      assert.equal(await page.evaluate(() => window.finalObservationSubmits), 0);
      assert.deepEqual(await execute(page, snap, operationId, actions), response, '相同operationId必须保留批级导航且不重放');
      assert.equal(await page.evaluate(() => window.finalObservationWrites), 1);
    });
  });
}

// —— 搜索/聊天框：联想词与选区抖动不再误判填写失败，真实回退/身份变化仍失败 ——
test('填写触发同步联想并重置光标时 fill 仍成功且值完整', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<form id="search-form"><textarea id="search-box" aria-label="搜索"></textarea><button id="go" type="submit">搜索</button><div id="sug"></div></form>';
      window.searchEvents = { input: 0, submit: 0 };
      document.querySelector('#search-form').addEventListener('submit', (event) => { event.preventDefault(); window.searchEvents.submit++; });
      const box = document.querySelector('#search-box');
      box.addEventListener('input', () => {
        window.searchEvents.input++;
        document.querySelector('#sug').textContent = '建议：' + box.value;
        box.setSelectionRange(0, 0);
      });
      box.addEventListener('blur', () => { document.querySelector('#sug').textContent = ''; });
    });
    const snap = await extract(page);
    const response = await execute(page, snap, 'op-search-fill-autocomplete', [{ action: 'fill', ref: refMatching(snap, /文本域/), value: '浏览器 自动化 测试' }]);
    assert.equal(response.results[0].ok, true, JSON.stringify(response));
    assert.equal(response.results[0].code, 'FILLED');
    assert.equal(await page.locator('#search-box').inputValue(), '浏览器 自动化 测试');
  });
});

test('type 联想逐字同步变化时输入完整文本，不只首字', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<form><input id="type-box" aria-label="搜索"><button type="submit">搜索</button></form><div id="sug"></div>';
      window.typeInputs = 0;
      const box = document.querySelector('#type-box');
      box.addEventListener('input', () => {
        window.typeInputs++;
        document.querySelector('#sug').textContent = '建议：' + box.value;
      });
    });
    const snap = await extract(page);
    const value = '测试查询';
    const response = await execute(page, snap, 'op-search-type-autocomplete', [{ action: 'type', ref: refMatching(snap, /输入框/), value }]);
    assert.equal(response.results[0].ok, true, JSON.stringify(response));
    assert.equal(await page.locator('#type-box').inputValue(), value);
    assert.equal(await page.evaluate(() => window.typeInputs), [...value].length, '每个字符都应真实输入并通知页面');
  });
});

test('同批 fill 后联想出现仍能点击提交按钮且只提交一次', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<form id="search-form"><input id="search-field" aria-label="搜索"><button id="search-go" type="submit">百度一下</button><div id="sug"></div></form>';
      window.searchBatch = { click: 0, submit: 0 };
      document.querySelector('#search-form').addEventListener('submit', (event) => { event.preventDefault(); window.searchBatch.submit++; });
      document.querySelector('#search-go').addEventListener('click', () => window.searchBatch.click++);
      document.querySelector('#search-field').addEventListener('input', (event) => {
        document.querySelector('#sug').innerHTML = '<ul><li>' + event.target.value + ' 百科</li></ul>';
      });
    });
    const snap = await extract(page);
    const response = await execute(page, snap, 'op-search-batch-fill-click', [
      { action: 'fill', ref: refMatching(snap, /输入框/), value: '测试查询' },
      { action: 'click', ref: refMatching(snap, /按钮「百度一下」/) },
    ]);
    assert.ok(response.results.every((result) => result.ok), JSON.stringify(response));
    assert.deepEqual(await page.evaluate(() => window.searchBatch), { click: 1, submit: 1 });
    assert.equal(await page.locator('#search-field').inputValue(), '测试查询');
  });
});

test('Enter 提交后页面改写内容仍报告成功，且不向已替换节点补发 keyup', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<form id="enter-form"><input id="enter-box" aria-label="搜索" value="测试查询"><input id="enter-submit" type="submit" value="百度一下"></form><div id="results">旧结果</div>';
      window.enterSubmit = { submit: 0, oldKeyups: 0, newKeyups: 0 };
      const box = document.querySelector('#enter-box');
      box.addEventListener('keyup', () => window.enterSubmit.oldKeyups++);
      document.querySelector('#enter-form').addEventListener('submit', (event) => {
        event.preventDefault();
        window.enterSubmit.submit++;
        document.querySelector('#results').textContent = '新结果';
        const replacement = box.cloneNode(true);
        replacement.addEventListener('keyup', () => window.enterSubmit.newKeyups++);
        box.replaceWith(replacement);
      });
    });
    const snap = await extract(page);
    const response = await execute(page, snap, 'op-search-enter-replaced', [{ action: 'press', ref: refMatching(snap, /输入框\(text\)/), value: 'Enter' }]);
    assert.equal(response.results[0].ok, true, JSON.stringify(response));
    assert.equal(await page.evaluate(() => window.enterSubmit.submit), 1);
    assert.equal(await page.evaluate(() => window.enterSubmit.oldKeyups), 0, '已提交后不得继续向旧节点派发 keyup');
  });
});

test('Enter 提交后同容器文字更新（联想结果）仍报告已按键成功', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<form id="sug-form"><input id="sug-box" aria-label="搜索" value="测试查询"><div id="sug-list"></div></form>';
      window.sugSubmit = 0;
      document.querySelector('#sug-form').addEventListener('submit', (event) => {
        event.preventDefault();
        window.sugSubmit++;
        document.querySelector('#sug-list').innerHTML = '<ul><li>结果已更新</li></ul>';
      });
    });
    const snap = await extract(page);
    const response = await execute(page, snap, 'op-search-enter-suggestion', [{ action: 'press', ref: refMatching(snap, /输入框/), value: 'Enter' }]);
    assert.equal(response.results[0].ok, true, JSON.stringify(response));
    assert.equal(await page.evaluate(() => window.sugSubmit), 1);
  });
});

test('提交按钮 value 快照后变化必须拒绝旧ref，不能点成另一个操作', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<form id="label-form"><input id="label-box" aria-label="搜索"><input id="label-submit" type="submit" value="百度一下"></form>';
      window.labelClicks = 0;
      document.querySelector('#label-submit').addEventListener('click', () => window.labelClicks++);
    });
    const snap = await extract(page);
    await page.evaluate(() => { document.querySelector('#label-submit').value = '删除全部'; });
    const response = await execute(page, snap, 'op-search-button-label', [{ action: 'click', ref: refMatching(snap, /输入框\(submit\)/) }]);
    assert.equal(response.results[0].code, 'STALE_TARGET', JSON.stringify(response));
    assert.equal(await page.evaluate(() => window.labelClicks), 0);
  });
});

test('type 值被页面同步回退仍报 VALUE_NOT_APPLIED，不吞真实失败', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<input id="rollback-box" aria-label="搜索" value="old">';
      const box = document.querySelector('#rollback-box');
      box.addEventListener('input', () => { box.value = 'old'; });
    });
    const response = await execute(page, await extract(page), 'op-search-type-rollback', [{ action: 'type', selector: '#rollback-box', value: '测试查询' }]);
    assert.equal(response.results[0].code, 'VALUE_NOT_APPLIED', JSON.stringify(response));
    assert.equal(await page.locator('#rollback-box').inputValue(), 'old');
  });
});

test('填写期间字段被替换为不同身份报 STALE_TARGET，不冒充值未写入', { timeout: 30000 }, async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<input id="swap-box" aria-label="Original field">';
      const box = document.querySelector('#swap-box');
      box.addEventListener('input', () => {
        const other = document.createElement('input');
        other.setAttribute('aria-label', 'Different field');
        box.replaceWith(other);
      });
    });
    const response = await execute(page, await extract(page), 'op-search-fill-swap', [{ action: 'fill', selector: '#swap-box', value: 'requested' }]);
    assert.equal(response.results[0].code, 'STALE_TARGET', JSON.stringify(response));
  });
});
