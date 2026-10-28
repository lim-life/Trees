/**
 * 配置 —— 存在数据目录里的一个 `config.json`。
 *
 * 为什么要落盘：**「自然生长」是定时任务跑的，它读不到你在终端里 export 的变量。**
 * 所以模型地址、模型名、key 这些得有个地方存着，任务启动时自己去读。
 *
 * 查找顺序（后面的覆盖前面的）：
 *   1. `<TREES_HOME>/config.json`
 *   2. 环境变量
 *
 * ⚠️ 这个文件里可能有你的 API key，明文。所以：
 *   - 它被 .gitignore 排除了，别提交
 *   - 权限按"只有你能读"写（Unix 上是 0600）
 *   - 也可以用 `apiKeyEnv` 指定从哪个环境变量读 key，文件里就不存 key
 */
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getForestRoot } from './paths.js';

/** 配置文件放哪。 */
export function configPath() {
  return path.join(getForestRoot(), 'config.json');
}

/**
 * 读配置。文件不存在就返回 {} —— 空库友好，不报错。
 * @returns {Promise<object>}
 */
export async function readConfig() {
  try {
    const raw = await readFile(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 写配置（跟已有的合并）。
 * @param {object} patch
 * @returns {Promise<string>} 配置文件的绝对路径
 */
export async function writeConfig(patch) {
  const dir = getForestRoot();
  await mkdir(dir, { recursive: true });
  const merged = { ...(await readConfig()), ...patch };
  const file = configPath();
  await writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await chmod(file, 0o600);   // Windows 上会忽略，Unix 上确保只有本人能读
  } catch { /* 忽略：有些文件系统不支持 */ }
  return file;
}

/** 删掉某个键（值传 undefined 时）。 */
export async function unsetConfig(keys) {
  const cfg = await readConfig();
  for (const k of keys) delete cfg[k];
  const dir = getForestRoot();
  await mkdir(dir, { recursive: true });
  await writeFile(configPath(), `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return configPath();
}

/**
 * 本地植树人身份（规则 7）。
 * 顺序：config.planter → TREES_PLANTER → 操作系统用户名 → 'local'。
 * 身份只用于召回排序与归属，不做资格审核。
 * @returns {Promise<string>}
 */
export async function getPlanter() {
  const cfg = await readConfig();
  const fromConfig = String(cfg.planter || '').trim();
  if (fromConfig) return fromConfig;

  const fromEnv = String(process.env.TREES_PLANTER || '').trim();
  if (fromEnv) return fromEnv;

  try {
    return os.userInfo().username || 'local';
  } catch {
    return 'local';
  }
}
