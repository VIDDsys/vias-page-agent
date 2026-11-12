'use strict';
// 极端场景压测：病态页面是否会让快照/执行崩溃或永久挂起
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..', '..');
const contentScript = path.join(root, 'content.js');
const edgePath = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const CASES = {
  '空 body': '<!DOCTYPE html><html><head><title>空</title></head><body></body></html>',
  '只有文本无标签': '<!DOCTYPE html><html><body>纯文本一段没有任何元素包裹的内容</body></html>',
  '超深嵌套 800 层': `<!DOCTYPE html><html><body>${'<div>'.repeat(800)}${'深层按钮'}<button>深层按钮</button>${'</div>'.repeat(800)}</body></html>`,
  '万个元素': `<!DOCTYPE html><html><body>${Array.from({ length: 10000 }, (_, i) => `<div>行 ${i}</div>`).join('')}<button>最后的按钮</button></body></html>`,
  '自引用 iframe': '<!DOCTYPE html><html><body><iframe id="a" srcdoc="&lt;iframe src=\'about:blank\'&gt;&lt;/iframe&gt;"></iframe></body></html>',
  '超长单行文本': `<!DOCTYPE html><html><body><p>${'超'.repeat(200000)}</p><button>按钮</button></body></html>`,
  '巨幅 select': `<!DOCTYPE html><html><body><select>${Array.from({ length: 5000 }, (_, i) => `<option value="v${i}">选项 ${i}</option>`).join('')}</select></body></html>`,
  'SVG 风暴': `<!DOCTYPE html><html><body>${Array.from({ length: 500 }, (_, i) => `<svg width="16" height="16"><rect width="16" height="16"/></svg>`).join('')}<button>按钮</button></body></html>`,
  '巨量图片': `<!DOCTYPE html><html><body>${Array.from({ length: 300 }, (_, i) => `<img alt="图${i}" width="200" height="150" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`).join('')}</body></html>`,
  '损坏 selector 场景': '<!DOCTYPE html><html><body><button id="ok">正常按钮</button></body></html>',
  '巨量同名元素': `<!DOCTYPE html><html><body>${Array.from({ length: 3000 }, () => '<button>删除</button>').join('')}</body></html>`,
  '表单嵌套表单': '<!DOCTYPE html><html><body><form><input name="a"><div><button>内层提交</button></div></form></body></html>',
};

let browser;

async function withPage(html, fn) {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => {
    const onMessage = { addListener(listener) { globalThis.__viasContentListener = listener; } };
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: { onMessage } } });
  });
  await page.addScriptTag({ path: contentScript });
  await page.waitForFunction(() => !!window.__viasPageAgentLoaded);
  try { return await fn(page); } finally { await page.close(); }
}

const extract = (page) => page.evaluate(() => new Promise((resolve) => {
  globalThis.__viasContentListener({ type: 'EXTRACT', runId: 'stress', includeImages: false }, {}, resolve);
}));

(async () => {
  browser = await chromium.launch({ executablePath: edgePath, headless: true });
  let failures = 0;
  for (const [name, html] of Object.entries(CASES)) {
    const started = Date.now();
    try {
      const snap = await withPage(html, async (page) => {
        // 给足 20 秒：超时即视为挂死
        return Promise.race([
          extract(page),
          new Promise((_, reject) => setTimeout(() => reject(new Error('EXTRACT 超时 20s，疑似挂死')), 20000)),
        ]);
      });
      const ms = Date.now() - started;
      const targets = Object.keys(snap.targets || {}).length;
      const meta = snap.snapshotMeta || {};
      const len = String(snap.text || '').length;
      console.log(`✓ ${name.padEnd(18)} ${String(ms).padStart(6)}ms  文本 ${String(len).padStart(7)}  目标 ${String(targets).padStart(4)}  meta=${meta.textTruncated ? '截断' : '完整'}${meta.omittedTargets ? `/省略${meta.omittedTargets}` : ''}${meta.nodeBudgetExhausted ? '/遍历触顶' : ''}`);
    } catch (error) {
      failures++;
      console.log(`✗ ${name.padEnd(18)} 失败：${error.message}`);
    }
  }
  console.log(failures ? `\n${failures} 个场景失败` : '\n全部场景通过');
  await browser.close();
  process.exit(failures ? 1 : 0);
})();