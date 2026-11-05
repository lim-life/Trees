/**
 * 配置 —— 模型地址、模型名、key、植树人、自动开关。
 *
 * **配置是「这台机器」的，不是「这片森林」的。**
 * 早期它住在 `forest/config.json` 里，后果是：把森林拷到别处（备份、换机器、
 * 临时测试）时，模型配置不会跟过去，而所有 AI 功能会静默降级 —— 看起来一切正常。
 *
 * 查找顺序（后者覆盖前者）：
 *   1. `<TREES_HOME>/config.json`        旧位置，仍然读，兼容已有森林
 *   2. `~/.trees/config.json`            机器级，**写入落在这里**
 *   3. `TREES_CONFIG`                    显式指定某个文件，优先级最高
 *
 * ⚠️ 文件里可能有 API key，明文。所以：
 *   - 写在 `~/.trees/`，不随森林走，也不进 git
 *   - 权限按"只有你能读"写（Unix 上是 0600）
 *   - 也可以用 `apiKeyEnv` 指定从哪个环境变量读 key，文件里就不存 key
 */
import { readFile, writeFile, mkdir, chmod, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getForestRoot } from './paths.js';

/** 机器级配置目录（日志也在这里）。 */
export function configHome() {
  return process.env.TREES_CONFIG_HOME || path.join(os.homedir(), '.trees');
}

/** 机器级配置文件。 */
export function machineConfigPath() {
  return path.join(configHome(), 'config.json');
}

/** 旧位置：森林里的 config.json。 */
export function legacyConfigPath() {
  return path.join(getForestRoot(), 'config.json');
}

/**
 * 所有配置来源，按「后者覆盖前者」的顺序。
 * @returns {Promise<Array<{path:string, role:string, exists:boolean}>>}
 */
export async function configSources() {
  const explicit = String(process.env.TREES_CONFIG || '').trim();
  const list = [
    { path: legacyConfigPath(), role: 'forest（旧位置）' },
    { path: machineConfigPath(), role: 'machine（机器级）' },
  ];
  if (explicit) list.push({ path: explicit, role: 'TREES_CONFIG（显式）' });

  for (const item of list) {
    item.exists = await stat(item.path).then((s) => s.isFile()).catch(() => false);
  }
  return list;
}

/**
 * 写入位置：显式指定优先，否则机器级。
 * @returns {string}
 */
export function configPath() {
  const explicit = String(process.env.TREES_CONFIG || '').trim();
  return explicit || machineConfigPath();
}

async function readJson(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 读生效配置：所有来源按顺序合并。哪个文件都没有就返回 {} —— 空库友好，不报错。
 * @returns {Promise<object>}
 */
export async function readConfig() {
  let merged = {};
  for (const source of await configSources()) {
    if (source.exists) merged = { ...merged, ...(await readJson(source.path)) };
  }
  return merged;
}

/**
 * 写配置（跟生效配置合并）。写入位置见 configPath()。
 * 因为合并的是**生效**配置，第一次写会把旧位置的键一并搬进机器级文件 —— 这正是想要的迁移。
 * @param {object} patch
 * @returns {Promise<string>} 配置文件的绝对路径
 */
export async function writeConfig(patch) {
  const file = configPath();
  await mkdir(path.dirname(file), { recursive: true });
  const merged = { ...(await readConfig()), ...patch };
  await writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await chmod(file, 0o600);   // Windows 上会忽略，Unix 上确保只有本人能读
  } catch { /* 忽略：有些文件系统不支持 */ }
  return file;
}

/** 删掉某个键（值传 undefined 时）。写回 configPath()。 */
export async function unsetConfig(keys) {
  const cfg = await readConfig();
  for (const k of keys) delete cfg[k];
  const file = configPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return file;
}

/**
 * 把旧位置（森林里）的配置搬到机器级位置。
 * **旧文件保留不删** —— 搬错了还能退回去。
 * @returns {Promise<{moved:boolean, from:string, to:string, reason?:string}>}
 */
export async function migrateConfig() {
  const from = legacyConfigPath();
  const to = machineConfigPath();
  const hasLegacy = await stat(from).then((s) => s.isFile()).catch(() => false);
  if (!hasLegacy) return { moved: false, from, to, reason: '旧位置没有配置文件' };

  const hasTarget = await stat(to).then((s) => s.isFile()).catch(() => false);
  const legacy = await readJson(from);
  const existing = hasTarget ? await readJson(to) : {};
  // 已有的机器级配置优先，旧文件只补空缺
  const merged = { ...legacy, ...existing };
  await mkdir(path.dirname(to), { recursive: true });
  await writeFile(to, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { await chmod(to, 0o600); } catch { /* 忽略 */ }

  return { moved: true, from, to, reason: hasTarget ? '已合并到已有的机器级配置' : '' };
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
