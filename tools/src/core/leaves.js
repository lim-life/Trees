import fs from 'node:fs/promises';
import { ensureDirs, getPath } from './paths.js';

/**
 * 格式化当前本地时间为 YYYY-MM-DD HH:mm 字符串
 * @returns {string}
 */
function formatTimestamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}`;
}

/**
 * 记录一条落叶日志（无复用价值的杂事）。
 * 自动确保森林目录存在。
 *
 * @param {string} description 事件描述
 * @returns {Promise<void>}
 */
export async function logLeaf(description) {
  // 确保森林目录结构存在
  await ensureDirs();
  const leafPath = getPath('leaves');
  // 格式：YYYY-MM-DD HH:mm  <描述>  无复用价值
  const line = `${formatTimestamp()}  ${description}  无复用价值\n`;
  await fs.appendFile(leafPath, line, 'utf-8');
}

/**
 * 获取最近的落叶记录（最多 limit 条）。
 * 空库友好：文件不存在时返回空数组。
 *
 * @param {number} [limit=20] 返回条目数上限
 * @returns {Promise<string[]>} 最近记录的数组，每项为完整行（不含换行符）
 */
export async function listLeaves(limit = 20) {
  try {
    const leafPath = getPath('leaves');
    const raw = await fs.readFile(leafPath, 'utf-8');
    const lines = raw.split('\n').filter((line) => line.trim() !== '');
    // 如果行数超过限制，仅返回最后 limit 条
    return lines.slice(-limit);
  } catch {
    // 文件不存在或读取失败
    return [];
  }
}
