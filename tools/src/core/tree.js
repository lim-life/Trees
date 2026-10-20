import {
  readFile,
  writeFile,
  rename,
  link,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getPath, ensureDirs, listFiles } from './paths.js';
import { parse, stringify } from './frontmatter.js';
import { readSeed, writeSeed } from './seed.js';

/**
 * @typedef {object} Branch
 * @property {string} branch_id
 * @property {string} [model]
 * @property {string} [role]
 * @property {string} [output]
 * @property {number} [cost]
 * @property {'good'|'mixed'|'bad'} [outcome]
 * @property {string[]} [seeds_planted]
 */

/**
 * @typedef {object} Tree
 * @property {string} id
 * @property {string} title
 * @property {string} type
 * @property {string} created YYYY-MM-DD，本地日期。
 * @property {string} updated YYYY-MM-DD，本地日期。
 * @property {string|null} forest_id
 * @property {string} root_path
 * @property {Branch[]} branches
 * @property {string[]} seeds
 * @property {string} body Markdown 正文，不写入 frontmatter。
 */

const SECTIONS_BY_KIND = {
  project: ['项目做了什么', '关键决策', '复用说明'],
  session: ['本次做了什么', '关键决策', '下一步'],
};
const OUTCOMES = new Set(['good', 'mixed', 'bad']);
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** @type {Promise<void>} */
let mutationQueue = Promise.resolve();

function today() {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function isValidId(id) {
  return typeof id === 'string'
    && id.length <= 200
    && /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(id)
    && !RESERVED_NAME.test(id);
}

function assertId(id) {
  if (!isValidId(id)) {
    throw new TypeError('树 id 必须是非空的字母或数字短横线名称，且不能是系统保留名');
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(value, name, fallback = '') {
  const result = value ?? fallback;
  if (typeof result !== 'string') {
    throw new TypeError(`${name} 必须是字符串`);
  }
  return result;
}

function dateField(value, name, fallback) {
  const result = value ?? fallback;
  if (typeof result !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(result)) {
    throw new TypeError(`${name} 必须是 YYYY-MM-DD 日期`);
  }

  const timestamp = Date.parse(`${result}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)
      || new Date(timestamp).toISOString().slice(0, 10) !== result) {
    throw new TypeError(`${name} 不是有效日期`);
  }
  return result;
}

function stringArray(value, name) {
  const result = value ?? [];
  if (!Array.isArray(result)
      || result.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new TypeError(`${name} 必须是非空字符串数组`);
  }
  return [...new Set(result)];
}

function normalizeBranch(branch) {
  if (!isRecord(branch)) {
    throw new TypeError('分支必须是对象');
  }
  if (typeof branch.branch_id !== 'string' || !branch.branch_id.trim()) {
    throw new TypeError('branch_id 必须是非空字符串');
  }

  const result = { branch_id: branch.branch_id };

  for (const key of ['model', 'role', 'output']) {
    if (branch[key] !== undefined) {
      result[key] = stringField(branch[key], key);
    }
  }

  if (branch.cost !== undefined) {
    if (typeof branch.cost !== 'number'
        || !Number.isFinite(branch.cost)
        || branch.cost < 0) {
      throw new TypeError('分支 cost 必须是非负有限数值');
    }
    result.cost = branch.cost;
  }

  if (branch.outcome !== undefined) {
    if (!OUTCOMES.has(branch.outcome)) {
      throw new TypeError('分支 outcome 只能是 good、mixed 或 bad');
    }
    result.outcome = branch.outcome;
  }

  if (branch.seeds_planted !== undefined) {
    result.seeds_planted = stringArray(branch.seeds_planted, 'seeds_planted');
  }

  return result;
}

function ensureSections(body, kind = 'project') {
  let result = stringField(body, 'body');

  for (const section of SECTIONS_BY_KIND[kind] || SECTIONS_BY_KIND.project) {
    const heading = new RegExp(`^##[ \\t]+${section}[ \\t]*\\r?$`, 'm');
    if (!heading.test(result)) {
      result = `${result.trimEnd()}${result.trim() ? '\n\n' : ''}## ${section}\n`;
    }
  }

  return result.endsWith('\n') ? result : `${result}\n`;
}

function normalizeTree(fields) {
  if (!isRecord(fields)) {
    throw new TypeError('大树必须是对象');
  }
  assertId(fields.id);

  const forestId = fields.forest_id ?? null;
  if (forestId !== null) assertId(forestId);
  if (forestId === fields.id) {
    throw new Error('森林关系不能指向自己');
  }

  const branches = fields.branches ?? [];
  if (!Array.isArray(branches)) {
    throw new TypeError('branches 必须是数组');
  }

  const normalizedBranches = branches.map(normalizeBranch);
  const branchIds = normalizedBranches.map((branch) => branch.branch_id);
  if (new Set(branchIds).size !== branchIds.length) {
    throw new Error('同一棵树的 branch_id 不能重复');
  }

  const date = today();

  const continuesFrom = fields.continues_from ?? null;
  if (continuesFrom !== null) assertId(continuesFrom);
  const mergedInto = fields.merged_into ?? null;
  if (mergedInto !== null) assertId(mergedInto);

  const projectStatus = ['complete', 'ongoing', 'unknown'].includes(fields.project_status)
    ? fields.project_status
    : 'unknown';
  const kind = fields.kind === 'session' ? 'session' : 'project';

  return {
    id: fields.id,
    title: stringField(fields.title, 'title'),
    type: stringField(fields.type, 'type'),
    kind,
    created: dateField(fields.created, 'created', date),
    updated: dateField(fields.updated, 'updated', date),
    forest_id: forestId,
    root_path: stringField(fields.root_path, 'root_path'),
    branches: normalizedBranches,
    seeds: stringArray(fields.seeds, 'seeds'),
    // 会话链：指向上一个会话；合并后 merged_into 指向项目树
    continues_from: continuesFrom,
    merged_into: mergedInto,
    project_status: projectStatus,
    status_reason: stringField(fields.status_reason, 'status_reason'),
    open_threads: stringArray(fields.open_threads, 'open_threads'),
    explicit_complete: fields.explicit_complete === true,
    merged_sessions: stringArray(fields.merged_sessions, 'merged_sessions'),
    dormant: fields.dormant === true,
    body: ensureSections(fields.body, kind),
  };
}

/**
 * 同一进程内串行执行读改写，避免并发添加分支或挂种子时丢失更新。
 * 多进程写入仍需调用方提供外部互斥。
 * @template T
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
function mutate(operation) {
  const pending = mutationQueue.then(operation);
  mutationQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

async function persist(tree, exclusive = false) {
  await ensureDirs();

  const directory = getPath('trees');
  const destination = path.join(directory, `${tree.id}.md`);
  const temporary = path.join(directory, `.${tree.id}.${randomUUID()}.tmp`);
  const { body, ...data } = tree;

  try {
    await writeFile(temporary, stringify(data, body), {
      encoding: 'utf8',
      flag: 'wx',
    });

    if (exclusive) {
      // 硬链接使创建操作同时满足完整发布和禁止覆盖已有档案。
      try {
        await link(temporary, destination);
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw new Error(`大树“${tree.id}”已存在，不能重复创建`, { cause: error });
        }
        throw error;
      }
    } else {
      // 同目录重命名，避免读者看到只写了一半的 Markdown。
      await rename(temporary, destination);
    }
  } finally {
    // 清理失败不能把已经成功发布的数据误报为写入失败。
    await unlink(temporary).catch(() => undefined);
  }

  return tree;
}

/**
 * 创建大树并落盘；已有同名大树时拒绝覆盖。
 * @param {Partial<Tree> & {id: string}} fields 大树字段，正文通过 body 提供。
 * @returns {Promise<Tree>} 实际保存的大树。
 */
export async function createTree(fields) {
  return mutate(async () => persist(normalizeTree(fields), true));
}

/**
 * 读取大树；文件缺失、不可读或数据无效时返回 null。
 * @param {string} id 大树 id。
 * @returns {Promise<Tree|null>}
 */
export async function readTree(id) {
  if (!isValidId(id)) return null;

  try {
    const markdown = await readFile(path.join(getPath('trees'), `${id}.md`), 'utf8');
    const { data, content } = parse(markdown);

    if (!isRecord(data) || (data.id !== undefined && data.id !== id)) {
      return null;
    }

    return normalizeTree({ ...data, id, body: content });
  } catch {
    return null;
  }
}

/**
 * 写回大树，自动将 updated 更新为本地今天，不修改传入对象。
 * @param {Tree} tree 大树对象。
 * @returns {Promise<Tree>} 实际保存的大树。
 */
export async function writeTree(tree) {
  return mutate(async () => {
    if (!isRecord(tree)) {
      throw new TypeError('大树必须是对象');
    }
    return persist(normalizeTree({ ...tree, updated: today() }));
  });
}

/**
 * 列出所有可读取的大树，按 id 排序。
 * @param {void} [unused] 无参数。
 * @returns {Promise<Tree[]>} 空库或目录不可读时返回空数组。
 */
export async function listTrees() {
  let ids;
  try {
    ids = await listFiles('trees');
  } catch {
    return [];
  }

  const trees = [];
  for (const id of ids.sort()) {
    const tree = await readTree(id);
    if (tree) trees.push(tree);
  }
  return trees;
}

/**
 * 添加 AI 分支；缺少 branch_id 时使用现有最大 b 编号加一。
 * @param {string} treeId 大树 id。
 * @param {Partial<Branch>} branch 分支字段。
 * @returns {Promise<Tree|null>} 更新后的大树；大树不可读时返回 null。
 */
export async function addBranch(treeId, branch) {
  return mutate(async () => {
    const tree = await readTree(treeId);
    if (!tree) return null;
    if (!isRecord(branch)) {
      throw new TypeError('分支必须是对象');
    }

    let branchId = branch.branch_id;
    if (branchId === undefined || branchId === null || branchId === '') {
      let maximum = 0n;
      for (const existing of tree.branches) {
        const match = /^b(\d+)$/.exec(existing.branch_id);
        if (match) {
          const number = BigInt(match[1]);
          if (number > maximum) maximum = number;
        }
      }
      branchId = `b${maximum + 1n}`;
    }

    const next = normalizeTree({
      ...tree,
      updated: today(),
      branches: [...tree.branches, { ...branch, branch_id: branchId }],
    });

    return persist(next);
  });
}

/**
 * 将种子挂到大树，去重并同步种子的 from_tree。
 * @param {string} treeId 大树 id。
 * @param {string} seedId 种子 id。
 * @returns {Promise<Tree|null>} 更新后的大树；大树不可读时返回 null。
 */
export async function linkSeed(treeId, seedId) {
  return mutate(async () => {
    const tree = await readTree(treeId);
    if (!tree) return null;

    const seed = await readSeed(seedId);
    if (!seed) {
      throw new Error(`种子“${seedId}”不存在或不可读取，无法挂到大树`);
    }

    const next = normalizeTree({
      ...tree,
      updated: today(),
      seeds: [...tree.seeds, seedId],
    });

    await writeSeed({ ...seed, from_tree: treeId });

    try {
      return await persist(next);
    } catch (error) {
      // 两个文件无法一起原子提交；树写失败时尽力恢复种子原有归属。
      try {
        await writeSeed(seed);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `挂载种子“${seedId}”失败，且恢复种子归属失败，请检查两侧关联`,
        );
      }
      throw error;
    }
  });
}

/**
 * 删除一棵树。只用于合成产物（项目树）——原件（会话树、种子）永不因合成被删除。
 * @param {string} id
 * @returns {Promise<boolean>} 删除成功返回 true
 */
export async function deleteTree(id) {
  if (!isValidId(id)) return false;
  try {
    await unlink(path.join(getPath('trees'), `${id}.md`));
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取大树 seeds 数组中的种子，跳过缺失或不可读取的文件。
 * @param {string} treeId 大树 id。
 * @returns {Promise<Array<NonNullable<Awaited<ReturnType<typeof readSeed>>>>>>}
 */
export async function getTreeSeeds(treeId) {
  const tree = await readTree(treeId);
  if (!tree) return [];

  const seeds = [];
  for (const id of tree.seeds) {
    try {
      const seed = await readSeed(id);
      if (seed) seeds.push(seed);
    } catch {
      // 单个种子损坏或不可读，不影响读取其余经验。
    }
  }

  return seeds;
}
