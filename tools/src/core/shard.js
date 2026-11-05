/**
 * 分片索引 —— 让召回不用把全库每个种子文件都读一遍。
 *
 * 问题的形状：`recall` 现在 `listSeeds()` 读所有文件。24 颗种子的代价是 24 次读盘，
 * 5000 颗就是 5000 次。这不是优化问题，是一堵墙。
 *
 * 做法：把「选谁」需要的最小信息抽成一个索引文件（id / 标题 / 标签 / 领域 / 状态 / 浇水），
 * 先在这个索引上粗排，只对候选的那几十颗去读正文细排。
 *
 *   N 次读盘  →  1 次读索引 + K 次读种子（K = limit × 6，通常 20~30）
 *
 * 索引是**派生数据**：坏了、旧了都能重建，永远不能拿它当真相。
 * 所以它带 count 和 built_at，数量对不上就整份作废、回退全库扫描。
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getForestRoot, listFiles } from './paths.js';
import { listSeeds } from './seed.js';
import { listEvents } from './events.js';

/** 索引格式版本；结构变了就升它，旧文件直接作废。 */
export const SHARD_VERSION = 1;

/** 索引文件放哪。 */
export function shardPath() {
  return path.join(getForestRoot(), 'shards.json');
}

/**
 * 把浇水事件按「种子 × 领域」聚成 { 领域: {w: 成功次数, f: 失败次数} }。
 *
 * 为什么必须分领域：一颗种子的领域标签是**先验**，它在这个领域到底行不行是**实证**。
 * 只按标签算，等于让一次分类决定它一辈子的权重 —— 系统里不允许有永久惩罚。
 *
 * @returns {Promise<Map<string, object>>}
 */
async function domainStats() {
  const events = await listEvents({ limit: Number.MAX_SAFE_INTEGER });
  const stats = new Map();
  for (const event of events) {
    if (event.type !== 'water' && event.type !== 'fail') continue;
    const domain = String(event.domain || '');
    if (!domain || domain === 'unknown') continue;
    if (!stats.has(event.seed)) stats.set(event.seed, {});
    const perSeed = stats.get(event.seed);
    if (!perSeed[domain]) perSeed[domain] = { w: 0, f: 0 };
    if (event.type === 'water') perSeed[domain].w += 1;
    else perSeed[domain].f += 1;
  }
  return stats;
}

/** 索引里每颗种子只留「粗排够用」的字段，绝不存正文。 */
function entryOf(seed, stats) {
  return {
    id: seed.id,
    title: seed.title,
    labels: seed.labels || [],
    domain: seed.domain || 'other',
    state: seed.state,
    watered: seed.watered,
    failed: seed.failed,
    planter: seed.planter,
    confidence: seed.confidence,
    from_tree: seed.from_tree,
    // 在哪些领域真的被验证过 —— 召回时用来覆盖「领域标签」这个先验
    domain_stats: stats || {},
  };
}

/**
 * 重建索引。
 * @returns {Promise<{count:number, domains:Record<string, number>}>}
 */
export async function buildShards() {
  const [seeds, stats] = await Promise.all([listSeeds({}), domainStats()]);
  const domains = {};
  const entries = seeds.map((seed) => {
    const entry = entryOf(seed, stats.get(seed.id));
    domains[entry.domain] = (domains[entry.domain] || 0) + 1;
    return entry;
  });

  const data = {
    version: SHARD_VERSION,
    built_at: new Date().toISOString(),
    count: entries.length,
    domains,
    entries,
  };

  const file = shardPath();
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data)}\n`, 'utf8');
  await rename(tmp, file);
  return { count: entries.length, domains };
}

/**
 * 读索引。**不保证新鲜** —— 调用方必须用 isFresh 校验，否则会漏掉新种子。
 * @returns {Promise<object|null>}
 */
export async function readShards() {
  try {
    const data = JSON.parse(await readFile(shardPath(), 'utf8'));
    return data && data.version === SHARD_VERSION && Array.isArray(data.entries) ? data : null;
  } catch {
    return null;
  }
}

/**
 * 数量对得上就算新鲜。用 readdir 数文件，不读内容 —— 这是它便宜的原因。
 * @param {object|null} data
 * @returns {Promise<boolean>}
 */
export async function isFresh(data) {
  if (!data) return false;
  try {
    const [seeds, box] = await Promise.all([listFiles('seeds'), listFiles('box')]);
    return data.count === seeds.length + box.length;
  } catch {
    return false;
  }
}

/**
 * 拿一份**可用的**索引；不新鲜就返回 null，让调用方回退全库。
 * @returns {Promise<object|null>}
 */
export async function freshShards() {
  const data = await readShards();
  return (await isFresh(data)) ? data : null;
}
