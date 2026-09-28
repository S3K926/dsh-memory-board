/**
 * lib/panel-state.js —— 面板自己选的位置：`~/.dsh/memory-panel.json` 的读写。
 *
 * 为什么要单独一份文件：这份 json 属于插件，不属于用户的档案——认档案只认特征文件
 * （身份.md + 日记.md + 生长\状态.md），认「面板选过哪个位置」只认这里的 root 字段。
 * 它必须待在依赖图的最底层：lib/fs-guards.js 的 resolveRoot() 要拿它当第一优先级，
 * 所以这里**不 import fs-guards**（否则成环），原子写自己实现一份（临时文件 + rename）。
 *
 * 三条硬规矩：
 *   ①读：没这个文件 / 坏 json / 读不动，一律当「没选过」返回 { ok:false, reason }，
 *     绝不抛 —— 认根是只读路径，不能被一个坏 json 打断（面板还得能打开、能重新选）。
 *   ②写：失败只返回 { ok:false, reason }，绝不抛，也绝不半途而废（先写临时文件再 rename）；
 *     目录不存在就先建（新机器上 ~/.dsh 可能都还没有）。
 *   ③路径每次用 os.homedir() 现算，不在模块层缓存（自检会把家目录指到临时目录）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PANEL_STATE_FILE } from './constants.js';
import { toCrlf } from './util.js';

// ─────────────────────────────────────────────────────────────── 路径

/**
 * Harness 家目录：`$DSH_HOME` 优先，缺省才回落 `~/.dsh`。
 * 为什么：便携部署（U 盘随身版）与多实例场景下家目录不在 `~/.dsh`；
 * 写死会把面板状态留在宿主机家目录，换台机器就"忘了之前选的档案"。
 * 仍然每次现算（自检会把家目录指到临时目录）。
 */
function harnessHome() {
  const override = process.env.DSH_HOME;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return os.homedir();
}

/** 状态文件绝对路径：`$DSH_HOME/memory-panel.json`（没设 DSH_HOME 时 = `~/.dsh/memory-panel.json`）。 */
function panelStateFile() {
  return path.join(harnessHome(), PANEL_STATE_FILE);
}

// ─────────────────────────────────────────────────────────────── 读

/**
 * 只读这份状态文件。
 * @param file 换成别的路径（自检用）；正式路径走 panelStateFile()
 * @returns { ok, file, root, device, updatedAt, reason? }；ok=false 时 root 一律 null
 */
function readPanelState(file = panelStateFile()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = error && error.code ? error.code : null;
    return { ok: false, reason: code === 'ENOENT' ? 'absent' : 'unreadable', file, root: null, device: null, updatedAt: null };
  }
  let data;
  try {
    const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // 使用者手改时可能存成带 BOM
    data = JSON.parse(stripped);
  } catch {
    return { ok: false, reason: 'invalid', file, root: null, device: null, updatedAt: null };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'invalid', file, root: null, device: null, updatedAt: null };
  }
  return {
    ok: true,
    file,
    root: typeof data.root === 'string' && data.root.trim() !== '' ? data.root.trim() : null,
    device: typeof data.device === 'string' && data.device.trim() !== '' ? data.device.trim() : null,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
  };
}

// ─────────────────────────────────────────────────────────────── 写

/**
 * 写这份状态文件（原子写：临时文件 + rename）。
 * @returns { ok:true, file, root, device, updatedAt, bytes } 或 { ok:false, reason, file }
 */
function writePanelState({ root, device = null, updatedAt = new Date().toISOString(), file = panelStateFile() } = {}) {
  if (typeof root !== 'string' || root.trim() === '') return { ok: false, reason: 'root-required', file };
  const payload = {
    root: root.trim(),
    device: typeof device === 'string' && device.trim() !== '' ? device.trim() : null,
    updatedAt,
  };
  const text = toCrlf(`${JSON.stringify(payload, null, 2)}\n`); // 跟插件别处落盘一个口味：CRLF、UTF-8 无 BOM
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, text, { encoding: 'utf8' });
    fs.renameSync(temp, file);
    return { ok: true, file, root: payload.root, device: payload.device, updatedAt: payload.updatedAt, bytes: Buffer.byteLength(text, 'utf8') };
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* 清不掉临时文件不算写失败，报原错 */
    }
    return { ok: false, reason: 'write-failed', file, error: error && error.message ? error.message : String(error) };
  }
}

/**
 * 记住一个位置：认领已有档案、铺底成功都走这里。
 * device 没显式给就沿用状态文件里原有的（铺底时路由会把新设备名传进来）。
 */
function rememberRoot({ root, device = null, file = panelStateFile(), updatedAt = new Date().toISOString() } = {}) {
  const previous = readPanelState(file);
  const finalDevice = typeof device === 'string' && device.trim() !== '' ? device.trim() : previous.device;
  return writePanelState({ root, device: finalDevice, updatedAt, file });
}

// ─────────────────────────────────────────────────────────────── 对外导出

export {
  panelStateFile,
  readPanelState,
  writePanelState,
  rememberRoot,
};