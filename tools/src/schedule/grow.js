/**
 * 自然生长 —— 让 Trees 在你不用的时段自己长一会儿。
 *
 * 白天你用它，夜里它自己学。这一层负责把「夜里自己跑」这件事
 * 装到 Windows 计划任务或 Unix crontab 上，以及卸掉、查状态。
 *
 * 设计上刻意分成两半：
 *   - `buildGrowPlan()` 是**纯函数** —— 只算出"该写什么文件、该敲什么命令"，不碰系统。
 *     所以能测，也能给别人看它到底要往你电脑上写什么。
 *   - `install()/uninstall()/status()` 才真的动手。
 *
 * 装什么：一个包装脚本（把数据目录等写死进去，因为定时任务读不到你的 shell 环境变量），
 * 外加一条每天定点触发的计划任务。日志落在 `~/.trees/grow.log`。
 */
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** 计划任务的名字。 */
export const TASK_NAME = 'Trees 自然生长';

/** 默认几点跑 —— 避开整点，别跟别人的任务挤在一起。 */
export const DEFAULT_AT = '03:17';

/** 包装脚本和日志放哪。 */
export function growDir() {
  return path.join(os.homedir(), '.trees');
}

/**
 * 算出安装方案 —— 纯函数，不碰系统。
 *
 * @param {{platform?:string, nodePath?:string, cliPath?:string,
 *          treesHome?:string, at?:string, dir?:string}} opts
 * @returns {object} 方案：要写哪些文件、注册/卸载/查询各敲什么命令
 */
export function buildGrowPlan(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const nodePath = opts.nodePath ?? process.execPath;
  const cliPath = opts.cliPath;
  const treesHome = opts.treesHome;
  const at = opts.at ?? DEFAULT_AT;
  const dir = opts.dir ?? growDir();

  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at));
  if (!m) throw new Error(`时间格式不对：${at}（应该是 HH:MM，比如 03:17）`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`时间不合法：${at}`);

  if (!cliPath) throw new Error('缺少 cliPath');
  if (!treesHome) throw new Error('缺少 treesHome');

  const logPath = path.join(dir, 'grow.log');

  if (platform === 'win32') {
    const wrapperPath = path.join(dir, 'grow.cmd');
    const wrapper = [
      '@echo off',
      'rem 由 trees grow --install 生成，卸载会一并删掉',
      `set "TREES_HOME=${treesHome}"`,
      `"${nodePath}" "${cliPath}" dream --run >> "${logPath}" 2>&1`,
      '',
    ].join('\r\n');
    return {
      kind: 'schtasks',
      platform,
      at: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      wrapperPath,
      wrapper,
      logPath,
      files: [wrapperPath],
      register: { cmd: 'schtasks', args: ['/Create', '/TN', TASK_NAME, '/TR', wrapperPath, '/SC', 'DAILY', '/ST', `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, '/F'] },
      unregister: { cmd: 'schtasks', args: ['/Delete', '/TN', TASK_NAME, '/F'] },
      query: { cmd: 'schtasks', args: ['/Query', '/TN', TASK_NAME] },
    };
  }

  const wrapperPath = path.join(dir, 'grow.sh');
  const wrapper = [
    '#!/bin/sh',
    '# 由 trees grow --install 生成，卸载会一并删掉',
    `TREES_HOME="${treesHome}" exec "${nodePath}" "${cliPath}" dream --run >> "${logPath}" 2>&1`,
    '',
  ].join('\n');
  return {
    kind: 'crontab',
    platform,
    at: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    wrapperPath,
    wrapper,
    logPath,
    files: [wrapperPath],
    cronLine: `${minute} ${hour} * * * ${wrapperPath}`,
  };
}

/** 读现在的 crontab。没有 crontab 命令就返回空串。 */
function readCrontab() {
  const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : '';
}

/**
 * 装上自然生长。
 * @param {object} plan buildGrowPlan() 的结果
 * @returns {{ok:boolean, message:string}}
 */
export async function install(plan) {
  await mkdir(path.dirname(plan.wrapperPath), { recursive: true });
  await writeFile(plan.wrapperPath, plan.wrapper, { encoding: 'utf8', mode: 0o755 });
  try {
    const { chmod } = await import('node:fs/promises');
    await chmod(plan.wrapperPath, 0o755);
  } catch { /* Windows 上忽略 */ }

  if (plan.kind === 'schtasks') {
    const r = spawnSync(plan.register.cmd, plan.register.args, { encoding: 'utf8' });
    if (r.status !== 0) {
      return { ok: false, message: `注册计划任务失败：${(r.stderr || r.stdout || '').trim()}` };
    }
    return { ok: true, message: `已装上：每天 ${plan.at} 自然生长一次` };
  }

  const current = readCrontab();
  if (current.includes(plan.wrapperPath)) {
    return { ok: true, message: `已经装过了（每天 ${plan.at}）` };
  }
  const next = `${current.replace(/\n*$/, '\n')}${plan.cronLine}\n`;
  const r = spawnSync('crontab', ['-'], { input: next, encoding: 'utf8' });
  if (r.status !== 0) {
    return { ok: false, message: `写 crontab 失败：${(r.stderr || '').trim()}` };
  }
  return { ok: true, message: `已装上：每天 ${plan.at} 自然生长一次` };
}

/**
 * 卸掉自然生长。包装脚本一并删掉。
 * @param {object} plan
 * @returns {{ok:boolean, message:string}}
 */
export async function uninstall(plan) {
  if (plan.kind === 'schtasks') {
    const r = spawnSync(plan.unregister.cmd, plan.unregister.args, { encoding: 'utf8' });
    // 任务本来就不在，也算卸干净
    if (r.status !== 0 && !/找不到|cannot find|does not exist/i.test(r.stderr || r.stdout || '')) {
      return { ok: false, message: `删除计划任务失败：${(r.stderr || r.stdout || '').trim()}` };
    }
  } else {
    const current = readCrontab();
    const next = current.split('\n').filter((l) => !l.includes(plan.wrapperPath)).join('\n');
    spawnSync('crontab', ['-'], { input: `${next.replace(/\n*$/, '\n')}`, encoding: 'utf8' });
  }

  await rm(plan.wrapperPath, { force: true });
  return { ok: true, message: '已卸掉，不再自动生长' };
}

/**
 * 查状态：装没装，最近一次日志尾部。
 * @param {object} plan
 * @returns {{installed:boolean, detail:string, logTail:string|null}}
 */
export function status(plan) {
  let installed = false;
  let detail = '';

  if (plan.kind === 'schtasks') {
    const r = spawnSync(plan.query.cmd, plan.query.args, { encoding: 'utf8' });
    installed = r.status === 0;
    detail = installed ? (r.stdout || '').split('\n').filter((l) => l.includes('下次') || l.includes('Next')).join(' ').trim() : '没装';
  } else {
    const line = readCrontab().split('\n').find((l) => l.includes(plan.wrapperPath));
    installed = Boolean(line);
    detail = line || '没装';
  }

  let logTail = null;
  try {
    const log = readFileSync(plan.logPath, 'utf8');
    logTail = log.trim().split('\n').slice(-5).join('\n');
  } catch { /* 还没跑过 */ }

  return { installed, detail, logTail };
}
