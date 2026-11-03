// ============================================================
// 跨平台环境解析（所有浏览器类脚本共用）
//
// 解决的问题：
//   原版把 profile 路径和 playwright-core 位置硬编码成某台 Windows
//   机器的绝对路径（C:/Users/<某用户>/...）。换机器、换用户、换系统
//   必然跑不起来，而且报错信息指向一个不存在的目录，很难自查。
//
// 本模块提供三个能力：
//   1. resolveProfile(dirName, envVar)  → ~/.dsh/<dirName>（可环境变量覆盖）
//   2. playwrightCandidates()           → 按优先级给出 playwright-core 的可能位置
//   3. isFsPath(c)                      → 区分「文件路径」与「裸包名」
//
// 环境变量（都可选）：
//   PLAYWRIGHT_CORE_PATH   强制指定 playwright-core 的 index.js 路径
//   <SITE>_PROFILE         各站点 profile 目录，如 CNKI_PROFILE / WF_PROFILE
// ============================================================

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * profile 目录（浏览器持久化状态：登录态 / 过滑块的放行 cookie）
 * 优先级：环境变量 → ~/.dsh/<dirName>
 *
 * @param {string} dirName 例 'cnki-profile'
 * @param {string} [envVar] 例 'CNKI_PROFILE'
 * @returns {string} 绝对路径
 */
export function resolveProfile(dirName, envVar) {
  const v = envVar ? process.env[envVar] : undefined;
  if (v && v.trim()) return v.trim();
  return join(homedir(), '.dsh', dirName);
}

/**
 * 区分「文件路径」与「裸包名」。
 * 文件路径要先转成 file:// URL 才能 import；裸包名交给 Node 按 node_modules 解析。
 *
 * @param {string} c 候选字符串
 * @returns {boolean}
 */
export function isFsPath(c) {
  return (
    c.startsWith('/') ||
    /^[a-zA-Z]:[\\/]/.test(c) ||   // Windows 盘符
    c.startsWith('\\\\')            // UNC 路径
  );
}

let _pwCache = null;

/**
 * playwright-core 候选路径，按"先快后慢"排序：
 *   1. PLAYWRIGHT_CORE_PATH 环境变量
 *   2. 平台常见全局位置（不启子进程，几十微秒）
 *   3. `npm root -g` 的结果（兜底，约 0.3~1 秒，只在前面都没命中时执行）
 *
 * 返回的每一项都经过 existsSync 校验，只含真实存在的路径。
 * 调用方应把裸包名 'playwright-core' 追加在最后，覆盖「项目内 npm i」的情况。
 *
 * @returns {string[]}
 */
export function playwrightCandidates() {
  if (_pwCache) return _pwCache;

  const out = [];
  const seen = new Set();
  const push = (p) => {
    if (p && !seen.has(p) && existsSync(p)) {
      seen.add(p);
      out.push(p);
    }
  };

  // 1. 显式指定
  push(process.env.PLAYWRIGHT_CORE_PATH);

  // 2. 平台常见位置（快路径）
  const quickRoots = [];
  if (process.platform === 'win32') {
    if (process.env.APPDATA) quickRoots.push(join(process.env.APPDATA, 'npm', 'node_modules'));
  } else {
    quickRoots.push(
      '/usr/local/lib/node_modules',
      '/usr/lib/node_modules',
      join(homedir(), '.npm-global', 'lib', 'node_modules'),
    );
  }
  for (const root of quickRoots) {
    push(join(root, '@playwright', 'mcp', 'node_modules', 'playwright-core', 'index.js'));
    push(join(root, 'playwright-core', 'index.js'));
  }

  // 3. npm root -g 兜底（慢，前面没命中才值得付这个代价）
  if (out.length === 0) {
    try {
      const r = execSync('npm root -g', {
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (r) {
        push(join(r, '@playwright', 'mcp', 'node_modules', 'playwright-core', 'index.js'));
        push(join(r, 'playwright-core', 'index.js'));
      }
    } catch { /* npm 不在 PATH 时忽略，后面还有裸包名兜底 */ }
  }

  _pwCache = out;
  return out;
}
