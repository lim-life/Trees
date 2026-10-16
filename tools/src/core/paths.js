import path from 'node:path';
import fs from 'node:fs/promises';

/** @type {string | undefined} */
let _forestRoot;

/**
 * 获取森林根目录的绝对路径。
 * 读取环境变量 TREES_HOME，若未设置则默认为当前工作目录下的 forest 文件夹。
 * @returns {string} 森林根目录绝对路径
 */
export function getForestRoot() {
  if (_forestRoot) return _forestRoot; // 缓存避免重复处理

  const fromEnv = process.env.TREES_HOME;
  if (fromEnv) {
    _forestRoot = path.resolve(fromEnv);
  } else {
    _forestRoot = path.resolve(process.cwd(), 'forest');
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
