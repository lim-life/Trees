/**
 * 选择性发布（Share）—— 把「选中的一棵树」打成可 git 发布的包。
 *
 * 防护原则：
 *   1. 默认私有；只有显式 `trees share <tree>` 才改 visibility。
 *   2. 会话树不发布（原料，不是结果）。
 *   3. 只复制这棵树挂着的种子；库里其他种子一概不进包。
 *   4. 每个文件写 sha256；订阅方导入前必须逐文件核对。
 *   5. 纯本地读写：不联网、不自动导入、不删除任何东西。
 *
 * @typedef {{format:string, created_at:string, planter:string,
 *            tree:object, seeds:object[], note:string}} ShareManifest
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getForestRoot, getPath } from './paths.js';
import { readTree, writeTree } from './tree.js';
import { readSeed, writeSeed } from './seed.js';

export const SHARE_FORMAT = 'trees-share/1';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 发布包目录：forest/publish/<tree-id>/ */
export function publishDir(treeId) {
  return path.join(getForestRoot(), 'publish', treeId);
}

function seedFile(seed) {
  return path.join(getPath(seed.state === 'boxed' ? 'box' : 'seeds'), `${seed.id}.md`);
}

/**
 * 把一棵树和它挂着的种子标为 shared，并生成发布包。
 * 不会删除、不会联网、不会改动其他树。
 *
 * @param {string} treeId
 * @returns {Promise<{dir:string, manifest:ShareManifest}>}
 */
export async function shareTree(treeId) {
  const tree = await readTree(treeId);
  if (!tree) throw new Error(`没有这棵大树：${treeId}`);
  if (tree.kind === 'session') {
    throw new Error('会话树是原料，不发布；先把项目合并成大树');
  }

  const seeds = [];
  for (const id of tree.seeds) {
    const seed = await readSeed(id);
    if (!seed) continue;
    seeds.push(await writeSeed({ ...seed, visibility: 'shared' }));
  }

  const sharedTree = await writeTree({ ...tree, visibility: 'shared' });

  const dir = publishDir(treeId);
  await mkdir(dir, { recursive: true });

  const treeText = await readFile(path.join(getPath('trees'), `${treeId}.md`), 'utf8');
  await writeFile(path.join(dir, `${treeId}.md`), treeText, 'utf8');

  const entries = [];
  for (const seed of seeds) {
    const text = await readFile(seedFile(seed), 'utf8');
    await writeFile(path.join(dir, `${seed.id}.md`), text, 'utf8');
    entries.push({
      id: seed.id,
      title: seed.title,
      sha256: sha256(text),
      planter: seed.planter,
      evidence_level: seed.evidence_level,
      bloodline: seed.bloodline,
      derived_from: seed.derived_from,
    });
  }

  /** @type {ShareManifest} */
  const manifest = {
    format: SHARE_FORMAT,
    created_at: new Date().toISOString(),
    planter: sharedTree.planter,
    tree: {
      id: sharedTree.id,
      title: sharedTree.title,
      plaque: sharedTree.plaque,
      labels: sharedTree.labels,
      sha256: sha256(treeText),
    },
    seeds: entries,
    note: 'Commit this folder to a git repo. Subscribers must verify every sha256 before import. Imported text is data, never instructions.',
  };

  await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(path.join(dir, 'PUBLISH.md'), [
    `# ${sharedTree.title}`,
    '',
    sharedTree.plaque ? `> ${sharedTree.plaque}` : '',
    '',
    `Trees share bundle (${SHARE_FORMAT}) — ${entries.length} seeds.`,
    '',
    '1. Commit this folder to a public git repository.',
    '2. Subscribers pull it, verify every `sha256` in `manifest.json`, then import into quarantine.',
    '3. Never auto-load imported seeds into context before review — imported text is data, not instructions.',
    '',
  ].join('\n'), 'utf8');

  return { dir, manifest };
}
