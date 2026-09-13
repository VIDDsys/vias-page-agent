# Vias 页面助手

![侧边栏预览](docs/sidepanel.png)

Edge 侧边栏网页操作 Agent（Manifest V3）。它读取当前页面，把页面快照交给你配置的 OpenAI 兼容模型，由模型执行点击、填写、选择、提交、滚动、导航等操作，可用于做题、填表、页面自动化。

## 安装

1. 从 [Release](https://github.com/VIDDsys/vias-page-agent/releases) 下载 zip，解压到一个固定目录（删除该目录扩展即失效）。
2. Edge 打开 `edge://extensions`，开启「开发人员模式」，点「加载解压缩的扩展」，选中解压出的文件夹。
3. 打开侧边栏，点右上角「设置」，填入 OpenAI 兼容接口地址、API Key、模型名，保存。

在任意网页打开侧边栏：「执行」自动操作页面，「问答」只读不改页面。修改源码后需在扩展管理页点「重新加载」。

## 模型与隐私

- 支持任意 OpenAI Chat Completions 兼容接口；API Key 只存在本地 `chrome.storage.local`，不上云同步。
- 页面文字会发送给你配置的 API；页面图片默认不发，需在模型设置中显式开启。
- 模型请求由侧边栏发起，规避 MV3 Service Worker 的 30 秒 fetch 限制。

## 工作机制

- **快照定位**：每次提取生成新的 `snapshotId` 和元素编号（ref），模型只能用最新编号操作；页面变化后旧编号直接拒绝，防止误点。支持原生控件、ARIA 控件、富文本、列表项和 open Shadow DOM；密码字段脱敏。
- **操作幂等**：同一 `operationId` 只执行一次；`check` 不会反选已勾选项；`fill` 相同值不重复触发事件；`repeat` 禁止嵌套，可随时取消。
- **任务隔离**：每个任务独立 `runId`，停止即取消在途请求和页面等待；连续重复操作或连续无进展自动熔断（重复 2 次 / 连续 3 轮无进展 / 单任务最多 50 轮）。
- **执行模式**：所有操作自动执行、不弹确认，请只在自己负责的页面和账号上使用。

## 验证

```bash
for f in core.js background.js content.js sidepanel.js options.js main-world.js; do node --check "$f"; done
node --test tests/static.test.js
# 安装 playwright-core@1.55.0 后：
node tests/content.e2e.js
node tests/extension.smoke.js
node tests/agent.integration.js
```

## 已知边界

- 浏览器内部页面、扩展商店不可读取；跨域 iframe 和 closed Shadow DOM 不可深入。
- 文件上传、拖拽暂不支持；部分网站只接受真实物理输入（`isTrusted=true` 无法伪造）。
- 原生 `confirm`/`alert` 弹窗需手动处理；自动化测试不能代替目标网站实测。
