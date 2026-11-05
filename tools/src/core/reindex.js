/**
 * 重建坐标牌。
 *
 * 牌是种子的投影，所以任何时候都能从原件（tree.seeds + 种子正文）重新算出。
 * 这个模块只做三件事：读 → 算 → 变了才写。
 *
 * 两条纪律：
 *   1. 不刷新 updated —— 派生写入不是「改动」。
 *   2. 不写事件账本 —— 重建不是知识事件，记进去会把账本变成流水账。
 */
import { readTree, listTrees, getTreeSeeds, writeTree } from './tree.js';
import { buildIndex } from './plaque.js';

/** 逐字段比较，refs 按顺序比 —— 顺序本身就是坐标的一部分。 */
function sameIndex(a, b) {
  if (!a || !b) return a === b;
  if (a.domain !== b.domain || a.artifact !== b.artifact || a.size !== b.size) return false;
  if (a.refs.length !== b.refs.length) return false;
  for (let i = 0; i < a.refs.length; i += 1) {
    if (a.refs[i].seed !== b.refs[i].seed || a.refs[i].section !== b.refs[i].section) {
      return false;
    }
  }
  return true;
}

/**
 * 重建一棵树的坐标牌。
 * @param {string} treeId
 * @param {{dryRun?:boolean}} [opts]
 * @returns {Promise<{id:string, changed:boolean, before:object|null, after:object}>}
 */
export async function reindexTree(treeId, opts = {}) {
  const tree = await readTree(treeId);
  if (!tree) throw new Error(`找不到大树：${treeId}`);

  const seeds = await getTreeSeeds(treeId);
  const after = buildIndex(tree, seeds);
  const changed = !sameIndex(tree.index, after);

  if (changed && !opts.dryRun) {
    await writeTree({ ...tree, index: after }, { touch: false });
  }

  return { id: tree.id, changed, before: tree.index, after };
}

/**
 * 重建全部项目大树的坐标牌。会话树是原料，不重建（也不会进目录）。
 * @param {{dryRun?:boolean}} [opts]
 * @returns {Promise<{updated:number, unchanged:number, items:Array}>}
 */
export async function reindexAll(opts = {}) {
  const trees = (await listTrees()).filter((tree) => tree.kind !== 'session');
  const items = [];
  for (const tree of trees) {
    items.push(await reindexTree(tree.id, opts));
  }
  const updated = items.filter((item) => item.changed).length;
  return { updated, unchanged: items.length - updated, items };
}
