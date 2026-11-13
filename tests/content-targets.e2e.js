'use strict';

// Run a release or the saved pre-fix executor with VIAS_CONTENT_SCRIPT to compare
// the identical local fixture against different content.js implementations.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');

const contentScript = process.env.VIAS_CONTENT_SCRIPT || path.resolve(__dirname, '..', 'content.js');
let browser;
let server;
let fixtureUrl;
const repeats = Number(process.env.VIAS_TARGET_REPEATS || 1);
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 20);
let fixtureExecutions = 0;

test.before(async () => {
  server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><body></body>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({
    executablePath: process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
});

test.after(async () => {
  await browser?.close();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  console.log(`target fixtures: ${fixtureExecutions}; repeats per case: ${repeats}`);
});

async function fixture(markup, setup, run) {
  for (let iteration = 0; iteration < repeats; iteration++) {
    const page = await browser.newPage();
    try {
      await page.goto(fixtureUrl);
      await page.evaluate((html) => {
        document.body.innerHTML = html;
        globalThis.chrome = { runtime: { onMessage: { addListener(listener) { globalThis.__listener = listener; } } } };
        window.clicks = [];
        document.addEventListener('click', (event) => { if (event.target.matches('input,[role="checkbox"],[role="radio"]')) window.clicks.push(event.target.getAttribute('value') || event.target.id); });
      }, markup);
      if (setup) await page.evaluate(setup);
      await page.addScriptTag({ path: contentScript });
      await run(page);
      fixtureExecutions++;
    } finally { await page.close(); }
  }
}

async function message(page, payload) {
  return page.evaluate((data) => new Promise((resolve) => globalThis.__listener(data, {}, resolve)), payload);
}
async function extract(page) { return message(page, { type: 'EXTRACT', runId: 'target-regression', maxLen: 30000 }); }
async function execute(page, snapshot, actions, operationId = 'target-operation') {
  return message(page, { type: 'EXECUTE', runId: 'target-regression', operationId, snapshotId: snapshot.snapshotId, actions, approved: true });
}
function ref(snapshot, text) {
  const target = Object.entries(snapshot.targets).find(([, description]) => description.includes(text));
  assert.ok(target, JSON.stringify(snapshot));
  return Number(target[0]);
}
function success(result) { assert.equal(result.results[0].ok, true, JSON.stringify(result.results)); }
function stale(result) { assert.equal(result.results[0].code, 'STALE_TARGET', JSON.stringify(result.results)); }

for (const status of ['label-status', 'input-aria']) {
  test(`选中后的 ${status} 增补保持实际成功且只点一次`, { timeout: 20000 }, async () => {
    await fixture('<fieldset><legend>第一题</legend><label><input type="checkbox" name="answer" value="a">选项甲</label></fieldset>', () => {}, async (page) => {
      await page.evaluate((kind) => {
        document.querySelector('input').onchange = (event) => {
          if (kind === 'label-status') event.target.parentElement.insertAdjacentHTML('beforeend', '<span role="status">已选择</span>');
          else event.target.setAttribute('aria-label', '选项甲，已选择');
        };
      }, status);
      const snapshot = await extract(page);
      const result = await execute(page, snapshot, [{ action: 'check', ref: ref(snapshot, '选项甲') }]);
      assert.equal(await page.evaluate(() => document.querySelector('input').checked), true, '复现关键：即使执行结果报错，实际选中也已发生');
      assert.deepEqual(await page.evaluate(() => window.clicks), ['a']);
      success(result);
    });
  });
}

for (const container of ['fieldset', 'list']) {
  test(`${container} 题干固定时 focus/blur 状态及可见性变化不阻止点击`, { timeout: 20000 }, async () => {
    const wrapper = container === 'fieldset' ? ['<fieldset><legend>第一题</legend>', '</fieldset>'] : ['<section><h2>第一题</h2><ul><li>', '</li></ul></section>'];
    await fixture(`<input id="previous"><div>${wrapper[0]}<div role="checkbox" id="answer" aria-checked="false" tabindex="0"><span>选项甲</span><span role="status" hidden>焦点已进入</span></div><span id="feedback" role="status"></span>${wrapper[1]}</div>`, () => {
      const previous = document.querySelector('#previous');
      previous.focus();
      previous.onblur = () => { document.querySelector('#feedback').textContent = '已保存'; };
      const answer = document.querySelector('#answer');
      answer.onpointerdown = () => { answer.focus(); answer.querySelector('[role="status"]').hidden = false; };
      answer.onclick = () => answer.setAttribute('aria-checked', 'true');
    }, async (page) => {
      const snapshot = await extract(page);
      const result = await execute(page, snapshot, [{ action: 'check', ref: ref(snapshot, '选项甲') }]);
      success(result);
      assert.equal(await page.evaluate(() => document.querySelector('#answer').getAttribute('aria-checked')), 'true');
      assert.deepEqual(await page.evaluate(() => window.clicks), ['answer']);
    });
  });
}

for (const phase of ['scroll', 'pointerdown']) {
  test(`${phase} 等价局部重绘后只派发到同题同值的当前控件`, { timeout: 20000 }, async () => {
    await fixture('<fieldset><legend>第一题</legend><div id="options"><label><input type="checkbox" name="answer" value="a">选项甲</label><label><input type="checkbox" name="answer" value="b">选项乙</label></div></fieldset>', () => {}, async (page) => {
      const snapshot = await extract(page);
      await page.evaluate((when) => {
        const options = document.querySelector('#options');
        const rebuild = () => { options.innerHTML = options.innerHTML; };
        if (when === 'scroll') document.querySelector('label').scrollIntoView = rebuild;
        else document.querySelector('input').addEventListener('pointerdown', rebuild, { once: true });
      }, phase);
      const result = await execute(page, snapshot, [{ action: 'check', ref: ref(snapshot, '选项甲') }]);
      success(result);
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('input')].map((input) => input.checked)), [true, false]);
      assert.deepEqual(await page.evaluate(() => window.clicks), ['a']);
    });
  });
}

test('同节点的原生 value 改变必须拒绝且不点击', { timeout: 20000 }, async () => {
  await fixture('<fieldset><legend>第一题</legend><label><input type="checkbox" name="answer" value="a">相同选项</label></fieldset>', null, async (page) => {
    const snapshot = await extract(page);
    await page.evaluate(() => { document.querySelector('input').value = 'wrong'; });
    const result = await execute(page, snapshot, [{ action: 'check', ref: ref(snapshot, '相同选项') }]);
    stale(result);
    assert.deepEqual(await page.evaluate(() => window.clicks), []);
    assert.equal(await page.evaluate(() => document.querySelector('input').checked), false);
  });
});

test('同批首项成功不授权后项变更提交值，后项拒绝且不点击', { timeout: 20000 }, async () => {
  await fixture('<fieldset><legend>第一题</legend><label><input type="checkbox" name="answer" value="a">选项甲</label><label><input type="checkbox" name="answer" value="b">选项乙</label></fieldset>', () => {
    document.querySelector('input').onchange = () => { document.querySelectorAll('input')[1].value = 'wrong'; };
  }, async (page) => {
    const snapshot = await extract(page);
    const result = await execute(page, snapshot, [{ action: 'check', ref: ref(snapshot, '选项甲') }, { action: 'check', ref: ref(snapshot, '选项乙') }]);
    assert.equal(result.results[0].ok, true, JSON.stringify(result));
    assert.equal(result.results[1].code, 'STALE_TARGET', JSON.stringify(result));
    assert.deepEqual(await page.evaluate(() => window.clicks), ['a']);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('input')].map((input) => input.checked)), [true, false]);
  });
});

test('同节点选项移入另一题必须拒绝且不点击', { timeout: 20000 }, async () => {
  await fixture('<main><fieldset id="q1"><legend>第一题</legend><label><input type="checkbox" name="answer" value="a">选项甲</label></fieldset><fieldset id="q2"><legend>第二题</legend><label><input type="checkbox" name="other" value="b">选项乙</label></fieldset></main>', null, async (page) => {
    const snapshot = await extract(page);
    await page.evaluate(() => { document.querySelector('#q2').append(document.querySelector('#q1 label')); });
    const result = await execute(page, snapshot, [{ action: 'check', ref: ref(snapshot, '选项甲') }]);
    stale(result);
    assert.deepEqual(await page.evaluate(() => window.clicks), []);
  });
});

for (const mutation of ['question', 'value', 'label', 'name', 'document', 'form', 'association']) {
  test(`派发前 ${mutation} 变化不能借等价重绘放行`, { timeout: 20000 }, async () => {
    await fixture('<fieldset><legend>第一题</legend><div id="options"><label><input type="checkbox" name="answer" value="a">选项甲</label></div></fieldset>', null, async (page) => {
      const snapshot = await extract(page);
      await page.evaluate((kind) => {
        const input = document.querySelector('input');
        input.addEventListener('pointerdown', () => {
          if (kind === 'question') document.querySelector('legend').textContent = '另一题';
          else if (kind === 'value') input.value = 'wrong';
          else if (kind === 'name') input.name = 'another-question';
          else if (kind === 'label') input.parentElement.lastChild.textContent = '错误选项';
          else if (kind === 'form') {
            const form = document.createElement('form'); form.id = 'other-form'; document.body.append(form); form.append(input.parentElement);
          } else if (kind === 'association') {
            const other = input.cloneNode(true); other.id = 'other-input'; document.querySelector('fieldset').append(other);
            input.parentElement.htmlFor = other.id;
          } else { const foreign = document.implementation.createHTMLDocument('foreign'); foreign.body.append(input); }
        }, { once: true });
      }, mutation);
      const result = await execute(page, snapshot, [{ action: 'check', ref: ref(snapshot, '选项甲') }]);
      stale(result);
      assert.deepEqual(await page.evaluate(() => window.clicks), []);
    });
  });
}

for (const redraw of ['input-only', 'fieldset', 'aria-list']) {
  test(`${redraw} 在派发期间等价重绘且原题保持不变`, { timeout: 20000 }, async () => {
    const html = redraw === 'aria-list'
      ? '<section><h2>第一题</h2><ul><li role="checkbox" id="a" aria-checked="false">选项甲</li><li role="checkbox" id="b" aria-checked="false">选项乙</li></ul></section>'
      : '<fieldset><legend>第一题</legend><div><label><input type="checkbox" name="answer" value="a">选项甲</label><label><input type="checkbox" name="answer" value="b">选项乙</label></div></fieldset>';
    await fixture(html, null, async (page) => {
      const snapshot = await extract(page);
      await page.evaluate((kind) => {
        const input = document.querySelector('input,[role="checkbox"]');
        input.addEventListener('mousedown', () => {
          if (kind === 'input-only') input.replaceWith(input.cloneNode(true));
          else {
            const group = document.querySelector('fieldset,section'); group.outerHTML = group.outerHTML;
          }
        }, { once: true });
        if (kind === 'aria-list') document.addEventListener('click', (event) => {
          if (event.target.matches('[role="checkbox"]')) event.target.setAttribute('aria-checked', 'true');
        });
      }, redraw);
      const result = await execute(page, snapshot, [{ action: 'check', ref: ref(snapshot, '选项甲') }]);
      success(result);
      assert.deepEqual(await page.evaluate(() => window.clicks), ['a']);
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('input,[role="checkbox"]')].map((input) => input instanceof HTMLInputElement ? input.checked : input.getAttribute('aria-checked') === 'true')), [true, false]);
    });
  });
}

for (const mutation of ['question', 'value', 'label']) {
  test(`重绘为不同 ${mutation} 时必须拒绝，不能只凭旧位置恢复`, { timeout: 20000 }, async () => {
    await fixture('<fieldset><legend>第一题</legend><label><input type="checkbox" name="answer" value="a">选项甲</label></fieldset>', null, async (page) => {
      const snapshot = await extract(page);
      await page.evaluate((kind) => {
        document.querySelector('input').addEventListener('pointerdown', () => {
          const group = document.querySelector('fieldset');
          group.outerHTML = group.outerHTML.replace(kind === 'question' ? '第一题' : kind === 'value' ? 'value="a"' : '选项甲', kind === 'question' ? '另一题' : kind === 'value' ? 'value="wrong"' : '错误选项');
        }, { once: true });
      }, mutation);
      stale(await execute(page, snapshot, [{ action: 'check', ref: ref(snapshot, '选项甲') }]));
      assert.deepEqual(await page.evaluate(() => window.clicks), []);
    });
  });
}

test('列表选项外题干改变不能被列表边界遮蔽', { timeout: 20000 }, async () => {
  await fixture('<section><h2>第一题</h2><ul><li><label><input type="checkbox" name="answer" value="a">选项甲</label></li><li><label><input type="checkbox" name="answer" value="b">选项乙</label></li></ul></section>', null, async (page) => {
    const snapshot = await extract(page);
    await page.evaluate(() => { document.querySelector('h2').textContent = '另一题'; });
    stale(await execute(page, snapshot, [{ action: 'check', ref: ref(snapshot, '选项甲') }]));
    assert.deepEqual(await page.evaluate(() => window.clicks), []);
  });
});

test('非语义状态的选项正文改变仍拒绝，不能以选中为理由吞掉 STALE_TARGET', { timeout: 20000 }, async () => {
  await fixture('<fieldset><legend>第一题</legend><label><input type="checkbox" name="answer" value="a">选项甲</label></fieldset>', () => {
    document.querySelector('input').onchange = (event) => { event.target.parentElement.lastChild.textContent = '另一个选项'; };
  }, async (page) => {
    const snapshot = await extract(page);
    stale(await execute(page, snapshot, [{ action: 'check', ref: ref(snapshot, '选项甲') }]));
    assert.equal(await page.evaluate(() => document.querySelector('input').checked), true);
    assert.deepEqual(await page.evaluate(() => window.clicks), ['a']);
  });
});

for (const mutation of ['reuse', 'redraw', 'stable-redraw', 'numbered-reuse', 'numbered-redraw', 'numbered-stable-redraw']) {
  test(`DIV 包装选项边界必须继续读取外层题干：${mutation}`, { timeout: 20000 }, async () => {
    const kind = mutation.replace('numbered-', '');
    let markup = '<div class="question"><p>第一题题干</p><div class="choices"><div class="option"><label><input type="checkbox" name="answer" value="a">选项甲</label></div><div class="option"><label><input type="checkbox" name="answer" value="b">选项乙</label></div></div></div>';
    if (mutation.startsWith('numbered-')) markup = markup.replace('<div class="option">', '<div class="option"><span>A.</span>').replace('<div class="option"><label>', '<div class="option"><span>B.</span><label>');
    await fixture(markup, null, async (page) => {
      const snapshot = await extract(page);
      await page.evaluate((kind) => {
        const question = document.querySelector('.question');
        if (kind !== 'stable-redraw') question.querySelector('p').textContent = '完全不同的另一题';
        if (kind !== 'reuse') question.outerHTML = question.outerHTML;
      }, kind);
      const result = await execute(page, snapshot, Object.keys(snapshot.targets).map((id) => ({ action: 'check', ref: Number(id) })));
      if (kind === 'stable-redraw') {
        assert.ok(result.results.every((item) => item.ok), JSON.stringify(result));
        assert.deepEqual(await page.evaluate(() => window.clicks), ['a', 'b']);
      } else {
        assert.ok(result.results.every((item) => item.code === 'STALE_TARGET'), JSON.stringify(result));
        assert.deepEqual(await page.evaluate(() => window.clicks), []);
      }
    });
  });
}

for (const redraw of [false, true]) {
  test(`aria-live 题块仍核验真实题干：${redraw ? '重绘' : '复用'}`, { timeout: 20000 }, async () => {
    await fixture('<fieldset aria-live="polite"><legend>第一题</legend><label><input type="checkbox" name="answer" value="a">选项甲</label></fieldset>', null, async (page) => {
      const snapshot = await extract(page);
      await page.evaluate((replace) => {
        const fieldset = document.querySelector('fieldset');
        fieldset.querySelector('legend').textContent = '第二题';
        if (replace) fieldset.outerHTML = fieldset.outerHTML;
      }, redraw);
      stale(await execute(page, snapshot, [{ action: 'check', ref: ref(snapshot, '选项甲') }]));
      assert.deepEqual(await page.evaluate(() => window.clicks), []);
    });
  });
}

test('内部 choiceIdentity 跨快照区分真实语义并隐藏原始身份文字和值', { timeout: 20000 }, async () => {
  await fixture('<fieldset><legend>第一题</legend><label><input type="checkbox" name="answer" value="private-choice-value">选项甲</label><span role="status"></span></fieldset>', null, async (page) => {
    let snapshot = await extract(page);
    let meta = snapshot.targetMeta[ref(snapshot, '选项甲')];
    const targetIdentity = meta.identity;
    const original = meta.choiceIdentity;
    assert.equal(typeof original, 'string', JSON.stringify(meta));
    assert.ok(original.length > 8);
    await page.evaluate(() => {
      const input = document.querySelector('input');
      input.checked = true;
      input.setAttribute('aria-label', '选项甲，已选择');
      input.parentElement.classList.add('selected');
      document.querySelector('[role="status"]').textContent = '已保存';
    });
    snapshot = await extract(page);
    meta = snapshot.targetMeta[ref(snapshot, '选项甲')];
    assert.equal(meta.choiceIdentity, original, '同节点同题同值，仅选中/ARIA/状态变化保持身份');
    for (const mutation of ['value', 'name', 'type', 'label', 'question']) {
      const previous = meta.choiceIdentity;
      await page.evaluate((kind) => {
        const input = document.querySelector('input');
        if (kind === 'value') input.value = 'another-private-value';
        else if (kind === 'name') input.name = 'another-answer';
        else if (kind === 'type') input.type = 'radio';
        else if (kind === 'label') input.parentElement.lastChild.textContent = '选项乙';
        else document.querySelector('legend').textContent = '第二题';
      }, mutation);
      snapshot = await extract(page);
      meta = Object.values(snapshot.targetMeta)[0];
      assert.equal(meta.identity, targetIdentity, '原 DOM 控件身份不变，必须另核验语义身份');
      assert.notEqual(meta.choiceIdentity, previous, `${mutation} 变化必须换语义身份`);
      assert.doesNotMatch(meta.choiceIdentity, /private|another|answer|选项|题/);
      assert.doesNotMatch(JSON.stringify(snapshot.targetMeta), /private-choice-value|another-private-value/);
    }
  });
});

test('状态增补但原生点击被取消仍报告 CHECK_NOT_APPLIED', { timeout: 20000 }, async () => {
  await fixture('<fieldset><legend>第一题</legend><label><input type="checkbox" name="answer" value="a">选项甲</label></fieldset>', () => {
    document.querySelector('input').onclick = (event) => {
      event.preventDefault();
      event.target.parentElement.insertAdjacentHTML('beforeend', '<span role="status">已处理</span>');
    };
  }, async (page) => {
    const snapshot = await extract(page);
    const result = await execute(page, snapshot, [{ action: 'check', ref: ref(snapshot, '选项甲') }]);
    assert.equal(result.results[0].code, 'CHECK_NOT_APPLIED', JSON.stringify(result));
    assert.equal(result.results[0].ok, false);
    assert.equal(await page.evaluate(() => document.querySelector('input').checked), false);
  });
});
