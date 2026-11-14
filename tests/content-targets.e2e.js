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

for (const tag of ['input', 'textarea', 'select']) {
  for (const mutation of ['label', 'question']) {
    test(`最终审查 原生${tag}快照后${mutation}变化拒绝旧ref`, { timeout: 20000 }, async () => {
      const field = tag === 'select' ? '<select id="field"><option value="original">Original</option><option value="next">Next</option></select>'
        : tag === 'textarea' ? '<textarea id="field">original</textarea>' : '<input id="field" value="original">';
      await fixture(`<fieldset><legend>Original question</legend><label for="field">Original field</label>${field}</fieldset>`, null, async (page) => {
        const snapshot = await extract(page);
        await page.evaluate((kind) => {
          document.querySelector(kind === 'label' ? 'label' : 'legend').textContent = 'Different meaning';
          window.fieldWrites = 0;
          document.querySelector('#field').addEventListener('input', () => window.fieldWrites++);
        }, mutation);
        stale(await execute(page, snapshot, [{ action: tag === 'select' ? 'select' : 'fill', ref: ref(snapshot, '标签:Original field'), value: 'next' }]));
        assert.equal(await page.evaluate(() => document.querySelector('#field').value), 'original');
        assert.equal(await page.evaluate(() => window.fieldWrites), 0);
      });
    });
  }
}

for (const mutation of ['text', 'value']) {
  test(`最终审查 select快照后选项${mutation}变化不能复用旧身份`, { timeout: 20000 }, async () => {
    await fixture('<fieldset><legend>Question</legend><select aria-label="Answer"><option value="a">Apple</option><option value="b">Banana</option></select></fieldset>', null, async (page) => {
      const snapshot = await extract(page);
      await page.evaluate((kind) => {
        const option = document.querySelectorAll('option')[1];
        if (kind === 'text') option.textContent = 'Different answer';
        else option.value = 'different-value';
      }, mutation);
      stale(await execute(page, snapshot, [{ action: 'select', ref: ref(snapshot, '下拉框'), value: 'b' }]));
      assert.equal(await page.evaluate(() => document.querySelector('select').value), 'a');
    });
  });
}

test('最终审查 aria-labelledby真实文字变化拒绝原生字段旧ref', { timeout: 20000 }, async () => {
  await fixture('<fieldset><span id="field-name">Original field</span><input aria-labelledby="field-name" value="original"></fieldset>', null, async (page) => {
    const snapshot = await extract(page);
    await page.evaluate(() => { document.querySelector('span').textContent = 'Different field'; });
    stale(await execute(page, snapshot, [{ action: 'fill', ref: ref(snapshot, 'Original field'), value: 'next' }]));
    assert.equal(await page.evaluate(() => document.querySelector('input').value), 'original');
  });
});

test('最终审查 原生字段值/多选状态/题内状态与题外抖动不使旧ref失效', { timeout: 20000 }, async () => {
  await fixture('<main><p id="progress">0</p><fieldset><legend>Stable question</legend><label>Text<input value="before"></label><label>Choice<select multiple><option value="a" selected>A</option><option value="b">B</option></select></label><output></output></fieldset></main>', null, async (page) => {
    const snapshot = await extract(page);
    await page.evaluate(() => {
      document.querySelector('input').value = 'restored';
      document.querySelectorAll('option')[1].selected = true;
      document.querySelector('output').textContent = 'Saved';
      document.querySelector('#progress').textContent = 'Unrelated progress';
      document.querySelector('input').className = 'focused';
    });
    const response = await execute(page, snapshot, [
      { action: 'fill', ref: ref(snapshot, '输入框'), value: 'after' },
      { action: 'select', ref: ref(snapshot, '下拉框'), value: ['b'] },
    ]);
    assert.ok(response.results.every((result) => result.ok), JSON.stringify(response));
    assert.equal(await page.evaluate(() => document.querySelector('input').value), 'after');
    assert.deepEqual(await page.evaluate(() => [...document.querySelector('select').selectedOptions].map((option) => option.value)), ['b']);
  });
});

for (const wrapper of ['section', 'div', 'shadow']) {
  for (const redraw of [false, true]) {
    test(`最终审查 ${wrapper}内层说明标题不遮蔽真实题干（${redraw ? '重绘' : '复用'}）`, { timeout: 20000 }, async () => {
      const question = '<h2>Original question</h2><div><h3>Choose an answer</h3><label><input type="checkbox" name="answer" value="a">Constant option</label></div>';
      await fixture(wrapper === 'shadow' ? '<div id="host"></div>' : `<${wrapper} id="question">${question}</${wrapper}>`, null, async (page) => {
        if (wrapper === 'shadow') await page.evaluate((html) => { document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = html; }, question);
        const snapshot = await extract(page);
        const originalIdentity = snapshot.targetMeta[ref(snapshot, 'Constant option')].choiceIdentity;
        await page.evaluate(({ shadow, redraw }) => {
          const root = shadow ? document.querySelector('#host').shadowRoot : document.querySelector('#question');
          root.querySelector('h2').textContent = 'Different question';
          if (redraw) root.innerHTML = root.innerHTML;
        }, { shadow: wrapper === 'shadow', redraw });
        const response = await execute(page, snapshot, [{ action: 'check', ref: ref(snapshot, 'Constant option') }]);
        stale(response);
        assert.deepEqual(await page.evaluate(() => window.clicks), []);
        assert.equal(await page.evaluate((shadow) => (shadow ? document.querySelector('#host').shadowRoot : document).querySelector('input').checked, wrapper === 'shadow'), false);
        const next = response.page.targetMeta[ref(response.page, 'Constant option')];
        assert.notEqual(next.choiceIdentity, originalIdentity);
      });
    });
  }
}

for (const kind of ['checkbox', 'radio', 'aria']) {
  for (const phase of ['paint', 'pointerdown']) {
    test(`最终审查 check ${kind}在${phase}已选中保持NO_CHANGE且不反选`, { timeout: 20000 }, async () => {
      const option = kind === 'aria' ? '<div role="checkbox" aria-checked="false" id="answer">Answer</div>'
        : `<label><input type="${kind}" name="answer" value="a">Answer</label>`;
      await fixture(`<fieldset><legend>Stable question</legend>${option}</fieldset>`, null, async (page) => {
        const snapshot = await extract(page);
        await page.evaluate(({ kind, phase }) => {
          const control = document.querySelector('input,[role="checkbox"]');
          const restore = () => {
            window.restoredBeforeClick = true;
            if (kind === 'aria') control.setAttribute('aria-checked', 'true');
            else control.checked = true;
          };
          if (phase === 'paint') (control.closest('label') || control).scrollIntoView = () => setTimeout(restore, 20);
          else control.addEventListener('pointerdown', restore, { once: true });
          if (kind === 'aria') control.onclick = () => control.setAttribute('aria-checked', String(control.getAttribute('aria-checked') !== 'true'));
        }, { kind, phase });
        const response = await execute(page, snapshot, [{ action: kind === 'radio' ? 'checkRadio' : 'check', ref: ref(snapshot, 'Answer') }]);
        assert.equal(response.results[0].code, 'NO_CHANGE', JSON.stringify(response));
        assert.equal(response.results[0].ok, true);
        assert.equal(await page.evaluate(() => window.restoredBeforeClick), true);
        assert.deepEqual(await page.evaluate(() => window.clicks), []);
        assert.equal(await page.evaluate(() => { const control = document.querySelector('input,[role="checkbox"]'); return control instanceof HTMLInputElement ? control.checked : control.getAttribute('aria-checked') === 'true'; }), true);
      });
    });
  }
}

test('最终审查 check派发中等价重绘为已选中只恢复身份不再次点击', { timeout: 20000 }, async () => {
  await fixture('<fieldset><legend>Stable question</legend><label><input type="checkbox" name="answer" value="a">Answer</label></fieldset>', null, async (page) => {
    const snapshot = await extract(page);
    await page.evaluate(() => document.querySelector('input').addEventListener('pointerdown', (event) => {
      event.target.setAttribute('checked', '');
      const fieldset = document.querySelector('fieldset');
      fieldset.outerHTML = fieldset.outerHTML;
    }, { once: true }));
    const response = await execute(page, snapshot, [{ action: 'check', ref: ref(snapshot, 'Answer') }]);
    assert.equal(response.results[0].code, 'NO_CHANGE', JSON.stringify(response));
    assert.equal(await page.evaluate(() => document.querySelector('input').checked), true);
    assert.deepEqual(await page.evaluate(() => window.clicks), []);
  });
});

// —— 搜索/聊天类页面：联想词、热搜、隐藏计数等外围动态不属于字段身份 ——
const searchMarkup = `<div id="wrapper">
  <div id="head">新闻 贴吧 知道 地图</div>
  <form id="form" action="/s">
    <span class="s_ipt_wr"><textarea id="kw" name="wd" autocomplete="off"></textarea><i class="quickdelete">清空</i></span>
    <span class="s_btn_wr"><input id="su" type="submit" value="百度一下"></span>
    <div id="sug" class="bdsug"></div>
  </form>
  <div id="hot">热搜榜</div>
  <div id="counter" style="display:none">0</div>
</div>`;
const setupSearch = () => {
  window.ev = { input: 0, click: 0, submit: 0 };
  document.getElementById('form').addEventListener('submit', (event) => { window.ev.submit++; event.preventDefault(); });
  document.getElementById('su').addEventListener('click', () => { window.ev.click++; });
  document.getElementById('kw').addEventListener('input', () => {
    window.ev.input++;
    document.getElementById('sug').innerHTML = '<ul><li>测试查询 百度百科</li><li>测试查询 新闻</li></ul>';
  });
};

test('搜索联想/热搜/隐藏计数变化不使输入框与提交按钮旧ref失效', { timeout: 20000 }, async () => {
  await fixture(searchMarkup, setupSearch, async (page) => {
    const snapshot = await extract(page);
    await page.evaluate(() => {
      document.getElementById('sug').innerHTML = '<ul><li>测试查询 百度百科</li></ul>';
      document.getElementById('hot').textContent = '热搜榜：换了新词';
      document.getElementById('counter').textContent = '37';
    });
    const response = await execute(page, snapshot, [
      { action: 'fill', ref: ref(snapshot, '文本域'), value: '测试查询' },
      { action: 'click', ref: ref(snapshot, '输入框(submit)') },
    ]);
    assert.ok(response.results.every((result) => result.ok), JSON.stringify(response));
    assert.deepEqual(await page.evaluate(() => window.ev), { input: 1, click: 1, submit: 1 });
    assert.equal(await page.locator('#kw').inputValue(), '测试查询');
  });
});

test('搜索联想同步出现时 fill 仍以值保真为成功，不误报 VALUE_NOT_APPLIED', { timeout: 20000 }, async () => {
  await fixture(searchMarkup, setupSearch, async (page) => {
    const snapshot = await extract(page);
    const response = await execute(page, snapshot, [{ action: 'fill', ref: ref(snapshot, '文本域'), value: '浏览器 自动化 测试' }]);
    assert.equal(response.results[0].ok, true, JSON.stringify(response));
    assert.equal(response.results[0].code, 'FILLED');
    assert.equal(await page.locator('#kw').inputValue(), '浏览器 自动化 测试');
  });
});

test('提交按钮文字变成删除全部后拒绝旧ref，不误点危险操作', { timeout: 20000 }, async () => {
  await fixture(searchMarkup, setupSearch, async (page) => {
    const snapshot = await extract(page);
    await page.evaluate(() => { document.getElementById('su').value = '删除全部'; });
    stale(await execute(page, snapshot, [{ action: 'click', ref: ref(snapshot, '输入框(submit)') }]));
    assert.deepEqual(await page.evaluate(() => window.ev), { input: 0, click: 0, submit: 0 });
  });
});

test('纯div题块标题是字段题干：标题变化拒绝输入框旧ref', { timeout: 20000 }, async () => {
  await fixture('<div class="question"><h3>Original prompt</h3><input id="field" aria-label="Answer" value="original"><div id="hint">0</div></div>', null, async (page) => {
    const snapshot = await extract(page);
    await page.evaluate(() => { document.querySelector('h3').textContent = 'Different prompt'; });
    stale(await execute(page, snapshot, [{ action: 'fill', ref: ref(snapshot, '输入框'), value: 'next' }]));
    assert.equal(await page.locator('#field').inputValue(), 'original');
  });
});

test('纯div题块内联想/提示文字变化不算题干变化，字段旧ref仍可填写', { timeout: 20000 }, async () => {
  await fixture('<div class="question"><h3>Stable prompt</h3><input id="field" aria-label="Answer" value="original"><div id="hint">建议：无</div></div>', null, async (page) => {
    const snapshot = await extract(page);
    await page.evaluate(() => { document.querySelector('#hint').textContent = '建议：测试查询'; });
    success(await execute(page, snapshot, [{ action: 'fill', ref: ref(snapshot, '输入框'), value: 'next' }]));
    assert.equal(await page.locator('#field').inputValue(), 'next');
  });
});

test('字段集legend变化仍拒绝字段旧ref；同批无关提示文字变化不阻断有效字段', { timeout: 20000 }, async () => {
  await fixture('<p id="progress">0</p><fieldset><legend>Original question</legend><label for="field">Original field</label><input id="field" value="original"><span id="hint">无</span></fieldset><fieldset><legend>Stable question</legend><label for="other">Stable field</label><input id="other" value="before"></fieldset>', null, async (page) => {
    const snapshot = await extract(page);
    await page.evaluate(() => {
      document.querySelector('legend').textContent = 'Different question';
      document.querySelector('#hint').textContent = '联想：测试';
      document.querySelector('#progress').textContent = '已答 1 题';
    });
    const response = await execute(page, snapshot, [
      { action: 'fill', ref: ref(snapshot, '标签:Original field'), value: 'must-not-write' },
      { action: 'fill', ref: ref(snapshot, '标签:Stable field'), value: 'after' },
    ]);
    assert.equal(response.results[0].code, 'STALE_TARGET', JSON.stringify(response));
    assert.equal(response.results[1].ok, true, JSON.stringify(response));
    assert.equal(await page.locator('#field').inputValue(), 'original');
    assert.equal(await page.locator('#other').inputValue(), 'after');
  });
});

// 补全浮层在 mousedown 关闭属于搜索页正常时序，不能因此放弃点击。
const closeOnMousedownMarkup = '<div id="wrapper"><form id="form" action="/s"><textarea id="kw" name="wd"></textarea><input id="su" type="submit" value="百度一下"><div id="sug"><ul><li>测试查询 百科</li></ul></div></form></div>';
const setupCloseOnMousedown = () => {
  window.ev = { click: 0, submit: 0, mousedown: 0 };
  document.addEventListener('mousedown', () => { window.ev.mousedown++; document.getElementById('sug').innerHTML = ''; }, true);
  document.getElementById('form').addEventListener('submit', (event) => { window.ev.submit++; event.preventDefault(); });
  document.getElementById('su').addEventListener('click', () => { window.ev.click++; });
};

test('mousedown 关闭联想浮层不阻止提交按钮点击', { timeout: 20000 }, async () => {
  await fixture(closeOnMousedownMarkup, setupCloseOnMousedown, async (page) => {
    const snapshot = await extract(page);
    const response = await execute(page, snapshot, [{ action: 'click', ref: ref(snapshot, '输入框(submit)') }]);
    assert.equal(response.results[0].ok, true, JSON.stringify(response));
    assert.deepEqual(await page.evaluate(() => window.ev), { click: 1, submit: 1, mousedown: 1 });
  });
});

test('mousedown 中提交按钮文字被换成删除全部时拒绝派发点击', { timeout: 20000 }, async () => {
  await fixture(closeOnMousedownMarkup, () => {
    window.ev = { click: 0, submit: 0, mousedown: 0 };
    document.addEventListener('mousedown', () => { window.ev.mousedown++; document.getElementById('sug').innerHTML = ''; }, true);
    document.getElementById('form').addEventListener('submit', (event) => { window.ev.submit++; event.preventDefault(); });
    document.getElementById('su').addEventListener('click', () => { window.ev.click++; });
    document.getElementById('su').addEventListener('mousedown', () => { document.getElementById('su').value = '删除全部'; }, { once: true });
  }, async (page) => {
    const snapshot = await extract(page);
    stale(await execute(page, snapshot, [{ action: 'click', ref: ref(snapshot, '输入框(submit)') }]));
    assert.deepEqual(await page.evaluate(() => window.ev), { click: 0, submit: 0, mousedown: 1 });
  });
});
