/**
 * 导入（Import）—— 把一棵别人发布的树收进来。
 *
 * 与 `share` 对称：share 只复制被选中的一棵树和它的种子，import 只接受这种包。
 *
 * 四条硬规矩（少一条就会污染本地库）：
 *   1. 逐文件核对 sha256 —— 半截文件、手改过的文件一律拒收，整包不导入
 *   2. 按 content_hash 去重 —— 不按标题，标题会改
 *   3. 重新分配 seed id / tree id —— 两边的 0001 不是一回事
 *   4. 标 origin=external，confidence 走 0.5 默认；planter 跟人走
 *      （不能沿用本机配置，否则别人的经验会被算成自己的满分经验）
 *
 * 纯本地文件操作：不联网、不改发布包、不删除任何东西。
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parse } from './frontmatter.js';
import { contentHash } from './content.js';
import { createSeed, listSeeds } from './seed.js';
import { createTree, readTree, linkSeed } from './tree.js';
import { reindexTree } from './reindex.js';

export const SHARE_FORMAT_PREFIX = 'trees-share/';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function short(hash) {
  return String(hash || '').slice(0, 8);
}

async function readOrNull(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 导入一个发布包目录。任何校验失败都整包中止 —— 不做「部分导入」。
 *
 * @param {string} dir 发布包目录（含 manifest.json）
 * @param {{dryRun?:boolean}} [opts]
 * @returns {Promise<{dir:string, treeId:string|null, imported:Array, skipped:Array,
 *                    verified:number, dryRun:boolean}>}
 */
export async function importBundle(dir, opts = {}) {
  const dryRun = opts.dryRun === true;
  const manifestPath = path.join(dir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`读不到发布包：${manifestPath}（${err.message}）`);
  }

  if (typeof manifest?.format !== 'string' || !manifest.format.startsWith(SHARE_FORMAT_PREFIX)) {
    throw new Error(`不是 Trees 发布包：format=${manifest?.format ?? '缺失'}`);
  }
  if (!manifest.tree || typeof manifest.tree.id !== 'string' || !Array.isArray(manifest.seeds)) {
    throw new Error('manifest 不完整：缺 tree.id 或 seeds');
  }

  // 1. 逐文件校验。任何一条对不上就整包拒绝 —— 不留下半套数据。
  const verified = [];
  for (const entry of manifest.seeds) {
    if (!entry || !/^seed-\d{4,}$/.test(entry.id || '')) {
      throw new Error(`manifest 里的种子 id 不合法：${entry?.id}`);
    }
    const file = path.join(dir, `${entry.id}.md`);
    const text = await readOrNull(file);
    if (text === null) throw new Error(`发布包缺文件：${entry.id}.md`);
    const actual = sha256(text);
    if (actual !== entry.sha256) {
      throw new Error(`${entry.id}.md 校验失败：manifest ${short(entry.sha256)}… ≠ 实际 ${short(actual)}…`);
    }
    verified.push({ entry, text });
  }

  const treeFile = path.join(dir, `${manifest.tree.id}.md`);
  const treeText = await readOrNull(treeFile);
  if (treeText === null) throw new Error(`发布包缺文件：${manifest.tree.id}.md`);
  const treeActual = sha256(treeText);
  if (treeActual !== manifest.tree.sha256) {
    throw new Error(`${manifest.tree.id}.md 校验失败：manifest ${short(manifest.tree.sha256)}… ≠ 实际 ${short(treeActual)}…`);
  }

  // 2. 按 content_hash 去重（本地已有同内容种子 → 复用它的 id）
  const local = await listSeeds({});
  const byHash = new Map();
  for (const seed of local) {
    if (seed.content_hash) byHash.set(seed.content_hash, seed.id);
  }

  const imported = [];
  const skipped = [];
  for (const { entry, text } of verified) {
    const { data, content } = parse(text);
    const title = String(data.title || '');
    const hash = typeof data.content_hash === 'string' && data.content_hash
      ? data.content_hash
      : contentHash(title, content);

    if (byHash.has(hash)) {
      skipped.push({ sourceId: entry.id, localId: byHash.get(hash), title, reason: 'content_hash' });
      continue;
    }

    // 3 + 4. 新 id、external、planter 跟人走；本地使用痕迹清零（那些不是本机的证据）
    if (dryRun) {
      imported.push({ sourceId: entry.id, id: '(dry-run)', title, planter: entry.planter || manifest.planter || '' });
      byHash.set(hash, '(dry-run)');
      continue;
    }

    const seed = await createSeed({
      title,
      labels: Array.isArray(data.labels) ? data.labels : [],
      body: content,
      state: 'buried',
      watered: 0,
      failed: 0,
      last_watered: null,
      planter: entry.planter || manifest.planter || '',
      origin: 'external',
      content_hash: hash,
      evidence: data.evidence,
      evidence_level: data.evidence_level,
      bloodline: data.bloodline,
      requires: data.requires,
      derived_from: data.derived_from,
      external_ids: {
        imported_from: `${manifest.planter || 'unknown'}/${entry.id}`,
      },
    });
    imported.push({ sourceId: entry.id, id: seed.id, title, planter: seed.planter });
    byHash.set(hash, seed.id);
  }

  // 大树也要换 id：对方的 id 在本机可能已经存在
  const baseId = manifest.tree.id;
  let treeId = baseId;
  for (let i = 2; await readTree(treeId); i++) treeId = `${baseId}-ext${i}`;

  if (!dryRun) {
    const { data: treeData, content: treeBody } = parse(treeText);
    await createTree({
      id: treeId,
      title: String(treeData.title || manifest.tree.title || treeId),
      type: String(treeData.type || ''),
      labels: Array.isArray(treeData.labels) ? treeData.labels : [],
      curator_note: String(treeData.curator_note || ''),
      curator_note_source: String(treeData.curator_note_source || 'imported'),
      planter: manifest.planter || '',
      visibility: 'private',
      body: treeBody,
    });

    // 重复的种子也要挂上 —— 这棵树对本地仍然是完整的
    const linked = [...imported.map((x) => x.id), ...skipped.map((x) => x.localId)];
    for (const id of linked) {
      if (id && !id.startsWith('(')) await linkSeed(treeId, id);
    }
    await reindexTree(treeId);
  }

  return {
    dir,
    treeId: dryRun ? null : treeId,
    imported,
    skipped,
    verified: verified.length + 1,
    dryRun,
  };
}
