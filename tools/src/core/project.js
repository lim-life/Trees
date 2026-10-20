/**
 * 项目链（Project chain）—— 会话树之间的接续、合并与播种。
 *
 * 一条链是一串会话树：a → b → c，靠 `continues_from` 指针连接。
 * 链本身不是项目；**只有项目完成、链合并成项目大树时，才第一次播种**。
 * 项目没完成之前，会话树只是原料，不产生任何种子。
 *
 * 旁支（没有子节点、也没被选进合并链的会话）默认休眠：
 * 要它的经验就 `plantBranch`，不要就 `recycleBranch`。
 */
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { readTree, writeTree, listTrees, createTree, deleteTree } from './tree.js';
import { readSeed, writeSeed } from './seed.js';
import { plantFromMaterial } from './plant.js';

/** 钥匙格式：s- + 8 位无歧义字符。 */
export const KEY_RE = /^s-[2-9A-HJ-NP-Z]{8}$/;

/** 项目链最多取多少字交给播种模型。 */
export const MAX_CHAIN_MATERIAL = 60000;

/** 取树正文里某一段；找不到返回空串。 */
function sectionText(body, title) {
  const text = String(body || '');
  const m = new RegExp(`^##\\s*${title}\\s*$`, 'm').exec(text);
  if (!m) return '';
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^##\s*\S/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/** 一个会话节点交给播种模型的文本。 */
function sessionMaterial(tree) {
  const done = sectionText(tree.body, '本次做了什么') || String(tree.body || '').trim();
  const decisions = sectionText(tree.body, '关键决策');
  const next = sectionText(tree.body, '下一步');
  return [
    `## 会话 ${tree.id}（${tree.created}）`,
    tree.title,
    done && `做了什么：${done}`,
    decisions && `关键决策：${decisions}`,
    next && `当时未完成：${next}`,
  ].filter(Boolean).join('\n');
}

/**
 * 沿 continues_from 往回走，返回从最早到最新的会话链。
 * @param {string} key
 * @returns {Promise<object[]>}
 */
export async function resolveChain(key) {
  const chain = [];
  const seen = new Set();
  let id = key;
  while (id) {
    if (seen.has(id)) throw new Error(`会话链成环：${id}`);
    seen.add(id);
    const tree = await readTree(id);
    if (!tree) throw new Error(`找不到会话：${id}`);
    if (tree.kind !== 'session') throw new Error(`${id} 不是会话树`);
    chain.unshift(tree);
    id = tree.continues_from;
  }
  return chain;
}

/**
 * 判断链的末端是否满足"项目完成、可以合并"。
 *
 * 条件：最新会话 complete、没有未完成事项、没有子会话，
 * 并且（用户明确说过完成，或上一次会话也是 complete）。
 *
 * @param {string} tipKey
 * @returns {Promise<{ready:boolean, reason:string, chain?:string[]}>}
 */
export async function evaluateChain(tipKey) {
  const chain = await resolveChain(tipKey);
  const tip = chain[chain.length - 1];

  if (tip.merged_into) return { ready: false, reason: '已经合并过' };

  const all = await listTrees();
  if (all.some((t) => t.continues_from === tip.id)) {
    return { ready: false, reason: '还有后续会话，说明项目没结束' };
  }
  if ((tip.open_threads || []).length) {
    return { ready: false, reason: `还有未完成：${tip.open_threads.join('、')}` };
  }
  if (tip.project_status !== 'complete') {
    return { ready: false, reason: 'AI 判断项目还在进行' };
  }

  const prev = chain[chain.length - 2];
  if (!tip.explicit_complete && prev?.project_status !== 'complete') {
    return { ready: false, reason: '还只是一次「完成」判断，等下一次会话确认' };
  }

  return {
    ready: true,
    reason: tip.status_reason || '完成条件满足',
    chain: chain.map((t) => t.id),
  };
}

/**
 * 合并一条链，得到项目大树，并**在此时首次播种**。
 *
 * 只合并被选中的这条链；旁支不参与。原件（会话树）保留，只标 merged_into。
 *
 * @param {string} tipKey
 * @param {{id?:string, title?:string, fromBranch?:string, callModel?:Function,
 *          maxSeeds?:number, allowIncomplete?:boolean}} [opts]
 * @returns {Promise<object>}
 */
export async function finishProject(tipKey, opts = {}) {
  const chain = await resolveChain(tipKey);
  const tip = chain[chain.length - 1];

  if (!opts.allowIncomplete) {
    const verdict = await evaluateChain(tipKey);
    if (!verdict.ready) throw new Error(`项目还没到可以合并的状态：${verdict.reason}`);
  }
  if (chain.some((t) => t.merged_into)) {
    throw new Error('这条链里已经有会话被合并过');
  }

  const id = opts.id || `proj-${tip.id.slice(2)}`;
  if (await readTree(id)) throw new Error(`项目树 ${id} 已经存在`);

  const root = chain[0].root_path || '';
  const title = opts.title
    || `${path.basename(root) || '项目'}（已完成）`;

  const project = await createTree({
    id,
    title,
    type: '项目',
    kind: 'project',
    root_path: root,
    merged_sessions: chain.map((t) => t.id),
    seeds: [],
    body: [
      '## 项目做了什么',
      ...chain.map((t) => `- ${t.created} ${t.title}`),
      '',
      '## 关键决策',
      chain.map((t) => sectionText(t.body, '关键决策')).filter(Boolean).join('\n\n') || '（见各会话节点）',
      '',
      '## 复用说明',
      `由会话链 ${chain.map((t) => t.id).join(' → ')} 合并而来。原件保留，trees unfinish ${id} 可拆回。`,
      '',
    ].join('\n'),
  });

  for (const t of chain) {
    await writeTree({ ...t, merged_into: id });
  }

  // ★ 第一次播种：从整条链的材料里提取，只播这一次
  let seeds = 0;
  let leaves = 0;
  let plantError = null;
  try {
    const material = chain.map(sessionMaterial).join('\n\n').slice(0, MAX_CHAIN_MATERIAL);
    const result = await plantFromMaterial({
      material,
      source: `项目链 ${chain.map((t) => t.id).join(' → ')}`,
      treeId: id,
      allowExisting: true,
      rootPath: root,
      fromBranch: opts.fromBranch || '',
      maxSeeds: opts.maxSeeds ?? 10,
      callModel: opts.callModel,
    });
    seeds = (result.created || []).length;
    leaves = (result.leaves || []).length;
  } catch (err) {
    plantError = err.message;
  }

  return { ...project, chain: chain.map((t) => t.id), seeds, leaves, plantError };
}

/**
 * 重新播种一个已经合并的项目（合并时模型失败、或想重提时用）。
 * @param {string} projectId
 * @param {{fromBranch?:string, callModel?:Function, maxSeeds?:number}} [opts]
 * @returns {Promise<{seeds:number, leaves:number}>}
 */
export async function plantProject(projectId, opts = {}) {
  const project = await readTree(projectId);
  if (!project || project.kind !== 'project') throw new Error(`找不到项目树：${projectId}`);

  const chain = [];
  for (const id of project.merged_sessions || []) {
    const tree = await readTree(id);
    if (tree) chain.push(tree);
  }
  if (!chain.length) throw new Error('这个项目没有可用的会话材料');

  const material = chain.map(sessionMaterial).join('\n\n').slice(0, MAX_CHAIN_MATERIAL);
  const result = await plantFromMaterial({
    material,
    source: `项目 ${projectId}`,
    treeId: projectId,
    allowExisting: true,
    rootPath: project.root_path || '',
    fromBranch: opts.fromBranch || '',
    maxSeeds: opts.maxSeeds ?? 10,
    callModel: opts.callModel,
  });
  return { seeds: (result.created || []).length, leaves: (result.leaves || []).length };
}

/**
 * 拆回项目树：恢复会话链，种子挂回最后一个会话，删除项目树。
 * 原件都在，拆回不会丢经验。
 * @param {string} projectId
 * @returns {Promise<{restored:string[], seeds:number}>}
 */
export async function unfinishProject(projectId) {
  const project = await readTree(projectId);
  if (!project) throw new Error(`找不到项目树：${projectId}`);
  if (project.kind !== 'project') throw new Error(`${projectId} 不是项目树`);

  const sessions = project.merged_sessions || [];
  const tip = sessions[sessions.length - 1] || '';

  for (const id of sessions) {
    const tree = await readTree(id);
    if (tree) await writeTree({ ...tree, merged_into: null });
  }
  for (const seedId of project.seeds || []) {
    const seed = await readSeed(seedId);
    if (seed && seed.from_tree === projectId) {
      await writeSeed({ ...seed, from_tree: tip });
    }
  }

  await deleteTree(projectId);
  return { restored: sessions, seeds: (project.seeds || []).length };
}

/**
 * 把一条旁支单独播种成一个小项目树（低期待，但仍按正常种子生命周期走）。
 * @param {string} key
 * @param {{id?:string, fromBranch?:string, callModel?:Function, maxSeeds?:number}} [opts]
 * @returns {Promise<object>}
 */
export async function plantBranch(key, opts = {}) {
  const session = await readTree(key);
  if (!session || session.kind !== 'session') throw new Error(`找不到会话：${key}`);

  const id = opts.id || `branch-${key.slice(2)}`;
  if (await readTree(id)) throw new Error(`旁支树 ${id} 已经存在`);

  const tree = await createTree({
    id,
    title: `旁支 · ${session.title}`,
    type: '旁支',
    kind: 'project',
    root_path: session.root_path || '',
    merged_sessions: [key],
    body: [
      '## 项目做了什么',
      `从已放弃的会话 ${key} 单独提炼。`,
      '',
      '## 关键决策',
      sectionText(session.body, '关键决策') || '（见会话节点）',
      '',
      '## 复用说明',
      '旁支经验未必经过完整验证，使用时注意边界。',
      '',
    ].join('\n'),
  });
  await writeTree({ ...session, merged_into: id });

  let seeds = 0;
  let plantError = null;
  try {
    const result = await plantFromMaterial({
      material: sessionMaterial(session),
      source: `旁支 ${key}`,
      treeId: id,
      allowExisting: true,
      rootPath: session.root_path || '',
      fromBranch: opts.fromBranch || '',
      maxSeeds: opts.maxSeeds ?? 4,
      callModel: opts.callModel,
    });
    seeds = (result.created || []).length;
  } catch (err) {
    plantError = err.message;
  }

  return { ...tree, seeds, plantError };
}

/**
 * 旁支回收：标记休眠。不删原件，也不播种；之后仍可 plantBranch。
 * @param {string} key
 * @returns {Promise<object>}
 */
export async function recycleBranch(key) {
  const session = await readTree(key);
  if (!session || session.kind !== 'session') throw new Error(`找不到会话：${key}`);
  if (session.merged_into) throw new Error('这个会话已经合并进项目，不能当旁支回收');
  return writeTree({ ...session, dormant: true });
}

// ───────────────────────── 接续钥匙 ─────────────────────────

/** 项目目录里的接续点文件。 */
export function lastKeyPath(cwd) {
  return path.join(cwd, '.trees', 'last-key');
}

/**
 * 从 cwd 往上找 `.trees/last-key`。
 * @param {string} [cwd]
 * @returns {Promise<string|null>}
 */
export async function findLastKey(cwd = process.cwd()) {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 24; i++) {
    try {
      const raw = await readFile(path.join(dir, '.trees', 'last-key'), 'utf8');
      const key = raw.trim();
      if (KEY_RE.test(key)) return key;
    } catch { /* 继续往上找 */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 记录当前项目的接续点。
 * @param {string} cwd
 * @param {string} key
 */
export async function writeLastKey(cwd, key) {
  const file = lastKeyPath(cwd);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${key}\n`, 'utf8');
}

/** 清掉接续点（项目完成后调用）。 */
export async function clearLastKey(cwd) {
  try { await unlink(lastKeyPath(cwd)); } catch { /* 本来就没有 */ }
}
