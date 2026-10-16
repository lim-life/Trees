import { readTree, writeTree, listTrees } from './tree.js';

/** @typedef {import('./tree.js').Tree} Tree */

/** @type {Promise<void>} */
let linkQueue = Promise.resolve();

/**
 * 建立子树到父树的森林关系，拒绝自关联、环和不可读取的树。
 * @param {string} childTreeId 子树 id。
 * @param {string} parentTreeId 父树 id。
 * @returns {Promise<Tree>} 更新后的子树。
 */
export async function linkForest(childTreeId, parentTreeId) {
  // 防止同一进程中的交叉关联同时通过检查，例如 A→B 与 B→A。
  const pending = linkQueue.then(async () => {
    if (childTreeId === parentTreeId) {
      throw new Error(`不能把大树“${childTreeId}”关联到自己，这会形成环`);
    }

    const child = await readTree(childTreeId);
    if (!child) {
      throw new Error(`子树“${childTreeId}”不存在或不可读取，无法建立森林关系`);
    }

    const visited = new Set([childTreeId]);
    let ancestorId = parentTreeId;

    // 必须从拟关联的父树向上检查：遇到子树意味着新增边会闭合成环。
    while (ancestorId !== null) {
      if (visited.has(ancestorId)) {
        if (ancestorId === childTreeId) {
          throw new Error(
            `不能将“${childTreeId}”关联到“${parentTreeId}”：父树的祖先链包含子树，会形成环`,
          );
        }
        throw new Error(
          `不能建立森林关系：父树“${parentTreeId}”的祖先链在“${ancestorId}”处已有环`,
        );
      }

      visited.add(ancestorId);

      const ancestor = await readTree(ancestorId);
      if (!ancestor) {
        throw new Error(
          `父树或祖先树“${ancestorId}”不存在或不可读取，无法建立森林关系`,
        );
      }

      ancestorId = ancestor.forest_id;
    }

    // 检查祖先链需要多次读取，提交前重新读取子树，保留期间新增的分支与种子。
    const latestChild = await readTree(childTreeId);
    if (!latestChild) {
      throw new Error(`子树“${childTreeId}”已不存在或不可读取，无法保存森林关系`);
    }

    return writeTree({ ...latestChild, forest_id: parentTreeId });
  });

  linkQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

/**
 * 返回所属森林的完整连通树群，包括祖先、自己、后代及同族分支。
 * @param {string} treeId 任意成员树 id。
 * @returns {Promise<Tree[]>} 去重后的树群；孤树返回自身，不可读时返回空数组。
 */
export async function getForestMembers(treeId) {
  const start = await readTree(treeId);
  if (!start) return [];

  const trees = new Map(
    (await listTrees()).map((tree) => [tree.id, tree]),
  );
  trees.set(start.id, start);

  /** @type {Map<string, Set<string>>} */
  const neighbors = new Map();

  for (const id of trees.keys()) {
    neighbors.set(id, new Set());
  }

  // 把父子关系视为无向边，才能从任意成员找到整片森林，而不遗漏兄弟树。
  for (const tree of trees.values()) {
    if (tree.forest_id !== null && trees.has(tree.forest_id)) {
      neighbors.get(tree.id).add(tree.forest_id);
      neighbors.get(tree.forest_id).add(tree.id);
    }
  }

  const visited = new Set([start.id]);
  const queue = [start.id];
  const members = [];

  // 使用游标而不是 shift，避免大森林遍历退化为平方复杂度。
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    members.push(trees.get(id));

    for (const neighborId of neighbors.get(id)) {
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);
      queue.push(neighborId);
    }
  }

  return members;
}
