// 保留此文件仅用于向旧版安装包兼容。
// Vias 0.11.0 起不再永久改写页面的 confirm、alert 或 window.open；
// 高风险操作按用户设定的完全访问权限自动执行，新标签页由后台按 opener 关系跟随。
(() => {
  'use strict';
  window.__viasMainWorldCompatibility = true;
})();
