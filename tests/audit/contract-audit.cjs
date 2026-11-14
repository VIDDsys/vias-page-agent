'use strict';
// 历史契约审计器：依赖旧版源码布局；适用边界见本目录 README.md。
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const content = read('content.js');
const background = read('background.js');
const sidepanel = read('sidepanel.js');
const options = read('options.js');
const core = read('core.js');

const legacySourceLayout = /\bconst DEFAULT_TEXT_BUDGET\s*=/.test(content)
  && /\bconst DEFAULT_TARGET_BUDGET\s*=/.test(content)
  && /\bconst ACTION_PROTOCOL\s*=/.test(background);
if (!legacySourceLayout) {
  console.error('审计器不适配：此历史脚本依赖的源码结构已变更，未执行契约判定。');
  console.error('当前验证请在源码目录执行 npm run test:all；历史脚本说明见 tests/audit/README.md。');
  process.exit(2);
}

let problems = 0;
const check = (label, condition, detail = '') => {
  if (!condition) { problems++; console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`✓ ${label}`);
};

// 1) 动作集合三处一致
const bgActions = new Set([...(background.match(/ALLOWED_ACTIONS = new Set\(\[([^\]]*)\]\)/) || [0, ''])[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]));
const ctActions = new Set([...(content.match(/const ACTIONS = new Set\(\[([^\]]*)\]\)/) || [0, ''])[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]));
const promptLine = (background.match(/^click dblclick.*$/m) || [''])[0].split(/\s+/).filter(Boolean);
const promptSet = new Set(promptLine);
check('动作集合 background == content', bgActions.size === ctActions.size && [...bgActions].every((a) => ctActions.has(a)), `bg=${[...bgActions]} ct=${[...ctActions]}`);
check('动作集合 全部出现在提示词', [...bgActions].every((a) => promptSet.has(a)), `缺: ${[...bgActions].filter((a) => !promptSet.has(a))}`);

// 2) 失败码：content 定义的必须在提示词手册里
const prompt = background.slice(background.indexOf('const ACTION_PROTOCOL'), background.indexOf('chrome.sidePanel'));
const codes = new Set([...content.matchAll(/errorResult\('([A-Z_]+)'/g)].map((m) => m[1]));
codes.delete('SKIPPED_AFTER_NAVIGATION');
const missing = [...codes].filter((c) => !prompt.includes(c));
check('content 全部失败码都在提示词排障手册', missing.length === 0, `缺: ${missing.join(', ')}`);

// 3) 两端 STRUCTURAL_FAILURES 必须一致
const ctStructural = new Set([...(content.match(/STRUCTURAL_FAILURES = new Set\(\[([\s\S]*?)\]\)/) || [0, ''])[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]));
const bgStructural = new Set([...(background.match(/STRUCTURAL_FAILURES = new Set\(\[([\s\S]*?)\]\)/) || [0, ''])[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]));
const onlyOne = [...ctStructural].filter((c) => !bgStructural.has(c)).concat([...bgStructural].filter((c) => !ctStructural.has(c)));
check('STRUCTURAL_FAILURES 两端一致', onlyOne.length === 0, `不一致: ${onlyOne.join(', ')}`);

// 4) snapshotMeta 字段：content 产出 vs background 消费（含简写属性）
const produced = new Set([...(content.match(/const snapshotMeta = \{([\s\S]*?)\n\s{4}\};/)?.[1] || '')
  .matchAll(/^\s{6}(\w+)\s*[,:]/gm)].map((m) => m[1]));
const consumed = new Set([...background.matchAll(/meta\.(\w+)/g)].map((m) => m[1]));
const unusedField = [...produced].filter((f) => !consumed.has(f));
check('snapshotMeta 字段都被 background 消费', unusedField.length === 0, `未被消费: ${unusedField.join(', ')}`);
const missingField = [...consumed].filter((f) => !produced.has(f));
check('background 不读取 content 不产出的字段', missingField.length === 0, `多读: ${missingField.join(', ')}`);

// 5) targetMeta 字段产出 vs 消费
const metaProduced = new Set([...(content.match(/targetMeta\[id\] = \{([\s\S]*?)\n\s{6}\};/)?.[1] || '').matchAll(/^\s{8}(\w+)\s*[,:]/gm)].map((m) => m[1]));
const metaConsumed = new Set([...background.matchAll(/meta\?\.(inForm|submitsForm|sensitive)/g)].map((m) => m[1]));
const deadMeta = [...metaProduced].filter((f) => !metaConsumed.has(f));
check('targetMeta 无冗余字段（只放 background 真读的）', deadMeta.length === 0, `冗余: ${deadMeta.join(', ')}`);

// 6) 常量不得跨文件重复硬编码
for (const [label, name] of [['MAX_TARGETS', 'MAX_TARGETS'], ['IMAGE_MIN_EDGE', 'IMAGE_MIN_EDGE'], ['TYPE_SAFE_CHARS', 'TYPE_SAFE_CHARS'], ['VALUE_MAX_CHARS', 'VALUE_MAX_CHARS'], ['TYPE_MAX_CHARS', 'TYPE_MAX_CHARS']]) {
  const inContent = (content.match(new RegExp(`const ${name} = \\d+`)) || []).length;
  const inBg = (background.match(new RegExp(`const ${name} = \\d+`)) || []).length;
  check(`${name} 只在一处定义`, inContent + inBg === 1, `content=${inContent} background=${inBg}`);
}

// 7) 预算链条一致性
const textBudget = Number((content.match(/DEFAULT_TEXT_BUDGET = (\d+)/) || [])[1]);
const targetBudget = Number((content.match(/DEFAULT_TARGET_BUDGET = (\d+)/) || [])[1]);
const trimLimit = Number((background.match(/latestObservation, limit = (\d+)/) || [])[1]);
check('正文预算 <= 上下文裁剪上限', textBudget <= trimLimit, `textBudget=${textBudget} trim=${trimLimit}`);
check('目标预算 >= 正文预算', targetBudget >= textBudget, `target=${targetBudget} text=${textBudget}`);

// 8) 敏感值不得出现在任何回显路径
const leakPaths = ['displayAction', 'instructionHistory', 'summarizeResults', 'addTools'].filter((fn) => {
  const idx = background.indexOf(fn) >= 0 ? background.indexOf(fn) : sidepanel.indexOf(fn);
  if (idx < 0) return false;
  const chunk = (background + sidepanel).slice(idx, idx + 800);
  return /value:\s*(action\.value|\(action\.value)\s*[,}]/.test(chunk) && !/actionIsSensitive/.test(chunk);
});
check('敏感值不会绕过脱敏进入回显', leakPaths.length === 0, leakPaths.join(', '));

// 9) ViasCore 导出全部被使用
const coreExports = [...(core.match(/Object\.freeze\(\{([^}]*)\}\)/) || [0, ''])[1].split(',').map((s) => s.trim()).filter(Boolean)];
const testSources = fs.readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.js')).map((f) => read(path.join('tests', f))).join('\n');
const unusedExports = coreExports.filter((name) => !new RegExp(`ViasCore\\.${name}\\b`).test(background + sidepanel + options) && !new RegExp(`\\bcore\\.${name}\\b`).test(testSources));
check('ViasCore 导出全部被使用', unusedExports.length === 0, `未使用: ${unusedExports.join(', ')}`);

// 10) 取消/停止链路三处齐全
for (const [label, file] of [['sidepanel', sidepanel], ['background', background], ['content', content]]) {
  check(`${label} 有取消路径`, /abort|Abort|cancel/.test(file));
}

console.log(problems ? `\n${problems} 项契约不一致` : '\n契约全部一致');
process.exit(problems ? 1 : 0);