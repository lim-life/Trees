import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

/** @type {string | undefined} */
let _forestRoot;

/**
 * 从 start 往上找「仓库根」（同时有 .git 和 forest）。
 * 这修的是一个真实事故：在 tools/ 里跑 CLI 时，
 * cwd/forest = tools/forest（空），配置和种子全读不到。
 */
function findRepoForest(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, '.git')) && existsSync(path.join(dir, 'forest'))) {
      return path.join(dir, 'forest');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 机器级默认森林：找不到项目自带的森林时用它。
 * 这样在任意新项目目录里跑 CLI 都接到同一个库，而不是悄悄建一个空库
 * （空库里没有种子，看起来就像「什么都没发生」）。
 * @returns {string}
 */
export function homeForest() {
  return path.join(os.homedir(), '.trees', 'forest');
}

/**
 * 获取森林根目录的绝对路径。
 * 顺序：TREES_HOME → 最近的仓库根 forest → 已存在的 cwd/forest → ~/.trees/forest。
 * 注意 cwd/forest 只认「已经存在」的：跑到陌生目录时回退到机器级库，
 * 而不是凭空创建一个空森林。
 * @returns {string} 森林根目录绝对路径
 */
export function getForestRoot() {
  if (_forestRoot) return _forestRoot; // 缓存避免重复处理

  const fromEnv = process.env.TREES_HOME;
  if (fromEnv) {
    _forestRoot = path.resolve(fromEnv);
  } else {
    const local = path.resolve(process.cwd(), 'forest');
    _forestRoot = findRepoForest(process.cwd())
      ?? (existsSync(local) ? local : homeForest());
  }
  return _forestRoot;
}

/**
 * 根据种类获取对应的文件或文件夹绝对路径。
 * @param {'trees' | 'seeds' | 'box' | 'leaves' | 'index'} kind
 * @returns {string}
 * @throws {Error} 当 kind 不合法时抛出异常
 */
export function getPath(kind) {
  const root = getForestRoot();
  switch (kind) {
    case 'trees':
      return path.join(root, 'trees');
    case 'seeds':
      return path.join(root, 'seeds');
    case 'box':
      return path.join(root, 'box');
    case 'leaves':
      // leaves.log 是文件
      return path.join(root, 'leaves.log');
    case 'index':
      return path.join(root, 'index.md');
    default:
      throw new Error(`Unknown kind: ${kind}`);
  }
}

/**
 * 幂等创建所有必要的目录（forest、trees、seeds、box），
 * 如果任一目录被新建则返回 true，否则返回 false。
 * @returns {Promise<boolean>} 是否创建了至少一个新目录
 */
export async function ensureDirs() {
  const root = getForestRoot();
  const dirs = [
    root,
    path.join(root, 'trees'),
    path.join(root, 'seeds'),
    path.join(root, 'box'),
  ];

  let created = false;
  for (const dir of dirs) {
    try {
      await fs.access(dir);
    } catch {
      // 目录不存在，递归创建
      await fs.mkdir(dir, { recursive: true });
      created = true;
    }
  }
  return created;
}

/**
 * 列出某个种类目录下所有 .md 文件的名称（不含扩展名）。
 * 空库友好：目录不存在或没有匹配文件时返回空数组。
 * @param {'trees' | 'seeds' | 'box'} kind
 * @returns {Promise<string[]>}
 */
export async function listFiles(kind) {
  try {
    const dir = getPath(kind);
    const entries = await fs.readdir(dir);
    return entries
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.basename(f, '.md'));
  } catch {
    // 目录不存在或读取失败，返回空数组
    return [];
  }
}
