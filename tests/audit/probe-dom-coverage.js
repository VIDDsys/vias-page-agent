'use strict';
// 临时探针（可删）：用真实 Edge 验证「很多页面无法操作」的候选根因。
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..', '..');
const contentScript = path.join(root, 'content.js');
const edgePath = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

// 广告位：大量无意义 div 文本 + 一个真实按钮
const ads = Array.from({ length: Number(process.env.ADS||220) }, (_, i) => `<div class="ad">推广位 ${i}：双十一大促 限时折扣 广告内容占位文本占位文本占位文本</div>`).join('');
const PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>广告页</title></head><body>
<h1>页面顶部</h1>
${ads}
<button id="real">真正要点的按钮</button>
<div id="reactish" style="cursor:pointer">React 风格可点 div（addEventListener 绑定，无 role/无 onclick 属性）</div>
<button>重复按钮</button><button>重复按钮</button><button>重复按钮</button>
<div style="opacity:0" id="fade">淡入中纯文本 opacity:0</div>
<button id="fadebtn" style="opacity:0">淡入中的按钮 opacity:0</button>
<button id="after">预算耗尽后的按钮</button>
<iframe id="frame" srcdoc="<button id='inframe'>iframe 内的按钮</button>"></iframe>
<script>
  document.getElementById('reactish').addEventListener('click', () => {});
</script>
</body></html>`;

let server;
let browser;

(async () => {
  server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/p`;
  browser = await chromium.launch({ executablePath: edgePath, headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.evaluate(() => {
    const onMessage = { addListener(listener) { globalThis.__viasContentListener = listener; } };
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: { runtime: { onMessage } },
    });
  });
  await page.addScriptTag({ path: contentScript });
  await page.waitForFunction(() => !!window.__viasPageAgentLoaded);
  await new Promise((r) => setTimeout(r, 400));

  const snap = await page.evaluate(() => new Promise((resolve) => {
    globalThis.__viasContentListener({ type: 'EXTRACT', runId: 'probe', includeImages: false }, {}, resolve);
  }));

  const t = snap.targets || {};
  const find = (needle) => Object.entries(t).filter(([, v]) => String(v).includes(needle)).map(([k]) => k);
  const inText = (needle) => String(snap.text || '').includes(needle);
  console.log(`快照文本长度: ${String(snap.text || '').length} / 正文预算 60000`);
  console.log(`发号目标总数: ${Object.keys(t).length}`);
  console.log('');
  console.log(`广告区之后的真实按钮 #real          → ref: ${find('真正要点的按钮').join(',') || '❌ 无编号'}`);
  console.log(`React 风格 div（仅 addEventListener）→ ref: ${find('React 风格').join(',') || '❌ 无编号'}`);
  console.log(`连续三个同名「重复按钮」             → 命中数: ${find('重复按钮').length} / 3  ${find('重复按钮').length < 3 ? '❌ 被去重丢弃' : ''}`);
  console.log(`opacity:0 的按钮（淡入中）          → ref: ${find('淡入中的按钮').join(',') || '❌ 被判隐藏'}`);
  console.log(`opacity:0 的纯文本是否进入正文       → ${inText('淡入中纯文本') ? '✓ 在正文里' : '✗ 正文也丢了'}`);
  console.log(`同源 iframe 内的按钮                → ref: ${find('iframe 内的按钮').join(',') || '❌ 未遍历到'}`);
  console.log(`同源 iframe 标注                    → ${inText('同源，已进入') ? '✓ 已识别为同源' : inText('跨域或受限') ? '✗ 误判为跨域' : '✗ 没有任何 iframe 标注'}`);
  console.log('');
  console.log('--- 快照尾部 500 字符 ---');
  console.log(String(snap.text || '').slice(-500));

  await browser?.close();
  server.close();
  process.exit(0);
})();