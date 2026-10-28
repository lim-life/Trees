/**
 * 召回（Recall）—— 把「我现在要做什么」变成「哪几颗种子该进上下文」。
 *
 * 写入层负责让经验进库，召回层负责让经验在正确的时刻被捞出来。
 * 没有它，种子只是躺在磁盘上；有了它，第二个同类任务才用得上第一个的教训。
 *
 * 三层，和 SPEC §5 一致：
 *   1. 标签精确命中 —— 查询里直接出现种子的标签
 *   2. 语义相近     —— 中文按二字组、英文按词切，算查询被种子覆盖的比例
 *   3. 发散列表     —— 低相关的几颗，用来打开思路（不占正文预算）
 *
 * 预算：默认最多 5 颗、4000 token。超出预算的种子宁可不召回，
 * 也不能把上下文重新撑满 —— 那正是这个项目要解决的问题。
 */
import { listSeeds } from './seed.js';
import { parseSections } from './synthesize.js';
import { getPlanter } from './config.js';

/** 默认召回几颗。 */
export const DEFAULT_LIMIT = 5;
/** 默认注入预算（token）。 */
export const DEFAULT_BUDGET = 4000;
/** 默认列几颗发散的。 */
export const DEFAULT_DIVERGENT = 3;
/** 单颗种子的上限，防止一颗长种子吃光预算。 */
export const MAX_PER_SEED_TOKENS = 900;
/** 低于这个分就不算命中（标签命中可豁免）。 */
const MIN_SCORE = 0.12;
/** 每颗至少留这么多 token 才值得塞进去。 */
const MIN_PER_SEED_TOKENS = 120;

/** 中文二元组里的常见虚词，不参与匹配。 */
const CJK_STOP = new Set([
  '什么', '这个', '那个', '一个', '可以', '不是', '就是', '所以', '但是', '因为',
  '如果', '还有', '没有', '时候', '这样', '那样', '怎么', '如何', '现在', '需要',
  '而且', '或者', '以及', '这些', '那些', '我们', '你们', '他们', '自己', '已经',
]);

/**
 * 切成可比较的词元：英文按单词，中文按二字组。
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenize(text) {
  const out = new Set();
  const s = String(text || '');
  for (const m of s.matchAll(/[A-Za-z0-9_./\\-]{2,}/g)) out.add(m[0].toLowerCase());
  const runs = s.match(/[一-鿿]+/g) || [];
  for (const run of runs) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (!CJK_STOP.has(bg)) out.add(bg);
    }
  }
  return out;
}

/**
 * 查询被种子覆盖的比例（containment）。用覆盖率而不是 Jaccard：
 * 种子正文通常比查询长得多，Jaccard 会把长种子系统性压低。
 * @param {Set<string>} query
 * @param {Set<string>} target
 * @returns {number} 0~1
 */
function coverage(query, target) {
  if (!query.size) return 0;
  let hit = 0;
  for (const t of query) if (target.has(t)) hit++;
  return hit / query.size;
}

/**
 * 估算一段文本的 token 数。保守取 1.5 字符/token，中文和代码混杂时不会低估太多。
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 1.5);
}

/**
 * 给一颗种子打分。
 *
 * 权重：正文覆盖率 0.50 / 标题覆盖率 0.25 / 标签命中 0.18 / 资历加成 ≤0.08。
 * 资历只是打破平局用，不能让一颗老种子压过真正相关的新种子。
 *
 * @param {object} seed
 * @param {string} query
 * @returns {{seed:object, score:number, textCoverage:number, titleCoverage:number, matchedLabels:string[]}}
 */
export function scoreSeed(seed, query, planter = '') {
  const q = tokenize(query);
  const qLower = String(query || '').toLowerCase();
  const title = tokenize(seed.title);
  const full = tokenize(`${seed.title || ''}\n${(seed.labels || []).join(' ')}\n${seed.body || ''}`);

  const matchedLabels = (seed.labels || []).filter((label) => {
    const l = String(label).toLowerCase();
    return qLower.includes(l) || q.has(l);
  });

  const textCoverage = coverage(q, full);
  const titleCoverage = coverage(q, title);
  const labelScore = Math.min(1, matchedLabels.length / 2);
  const seniority = Math.min(0.08, (Number(seed.watered) || 0) * 0.01);

  // 规则 7：自己的树权重 1.0；别人的树按 confidence 降权。
  // 只影响排序，不改 watered / state / last_watered。
  const owner = String(seed.planter || '');
  const weight = (!owner || !planter || owner === planter)
    ? 1
    : Math.max(0.1, Number(seed.confidence) || 0.5);

  return {
    seed,
    score: (0.5 * textCoverage + 0.25 * titleCoverage + 0.18 * labelScore + seniority) * weight,
    textCoverage,
    titleCoverage,
    matchedLabels,
    weight,
  };
}

/**
 * 把种子正文压成注入用的最小形态：只留 判据 / 做法 / 不适用。
 * 旁证不进上下文 —— 它是回溯用的，不是当下要用的。
 *
 * @param {string} body
 * @param {number} maxTokens
 * @returns {string}
 */
export function compactBody(body, maxTokens) {
  const s = parseSections(body);
  let out = [['判据', s.判据], ['做法', s.做法], ['不适用', s.不适用]]
    .filter(([, text]) => text)
    .map(([name, text]) => `## ${name}\n${text}`)
    .join('\n\n');
  if (!out) out = String(body || '').trim();

  const maxChars = Math.max(80, Math.floor(maxTokens * 1.5));
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars).trimEnd()}\n…（已截断，完整正文看 trees show ${'<id>'}）`;
  }
  return out;
}

/** 一颗种子的注入块。 */
function renderSeed(item, maxTokens) {
  const { seed } = item;
  const body = compactBody(seed.body, maxTokens).replace('<id>', seed.id);
  return [
    `### ${seed.id} ${seed.title}`,
    `状态 ${seed.state} · 浇水 ${seed.watered} · 标签 [${(seed.labels || []).join(', ')}]`,
    body,
  ].join('\n');
}

/**
 * 召回：按任务描述挑出该进上下文的种子。
 *
 * @param {string} query 任务描述，比如「Windows 上给板子烧固件」
 * @param {{limit?:number, budget?:number, includeBoxed?:boolean, divergent?:number}} [opts]
 * @returns {Promise<{query:string, picks:Array, divergent:Array, tokens:number, budget:number, total:number}>}
 */
export async function recall(query, opts = {}) {
  const q = String(query || '').trim();
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const includeBoxed = opts.includeBoxed ?? false;
  const divergentCount = opts.divergent ?? DEFAULT_DIVERGENT;
  const all = (await listSeeds({})).filter((s) => includeBoxed || s.state !== 'boxed');

  if (!q) {
    return { query: q, picks: [], divergent: [], tokens: 0, budget, total: all.length };
  }

  const planter = await getPlanter();
  const scored = all
    .map((s) => scoreSeed(s, q, planter))
    .filter((x) => x.score >= MIN_SCORE || x.matchedLabels.length > 0)
    .sort((a, b) => (b.score - a.score) || a.seed.id.localeCompare(b.seed.id));

  const picks = [];
  let used = 0;
  for (const item of scored) {
    if (picks.length >= limit) break;
    const perSeed = Math.min(MAX_PER_SEED_TOKENS, budget - used);
    if (perSeed < MIN_PER_SEED_TOKENS) break;
    const text = renderSeed(item, perSeed);
    const tokens = estimateTokens(text);
    if (used + tokens > budget) continue;   // 这颗装不下，试试后面的短种子
    picks.push({ ...item, text, tokens });
    used += tokens;
  }

  // 发散列表：命中之后、但没进正文的那几颗；不够就从库里挑最常用的
  const pickedIds = new Set(picks.map((p) => p.seed.id));
  const rest = scored.filter((x) => !pickedIds.has(x.seed.id));
  const divergent = rest.slice(0, divergentCount).map((x) => ({
    id: x.seed.id, title: x.seed.title, labels: x.seed.labels,
  }));
  if (divergent.length < divergentCount) {
    const chosen = new Set([...pickedIds, ...divergent.map((d) => d.id)]);
    const filler = all
      .filter((s) => !chosen.has(s.id))
      .sort((a, b) => (b.watered || 0) - (a.watered || 0) || a.id.localeCompare(b.id))
      .slice(0, divergentCount - divergent.length)
      .map((s) => ({ id: s.id, title: s.title, labels: s.labels }));
    divergent.push(...filler);
  }

  return { query: q, picks, divergent, tokens: used, budget, total: all.length };
}

/**
 * 把召回结果渲染成可直接注入上下文的 Markdown（无 ANSI、无多余装饰）。
 * @param {Awaited<ReturnType<typeof recall>>} result
 * @returns {string}
 */
export function renderRecall(result) {
  if (!result.picks.length) {
    return `## Trees 相关经验\n\n没有命中任何种子（库内 ${result.total} 颗）。`;
  }
  const lines = [
    `## Trees 相关经验（${result.picks.length} 颗，约 ${result.tokens} / ${result.budget} token）`,
    '',
  ];
  for (const p of result.picks) lines.push(p.text, '');
  if (result.divergent.length) {
    lines.push('### 发散（低相关，供联想，不展开）');
    for (const d of result.divergent) lines.push(`- ${d.id} ${d.title}`);
  }
  return lines.join('\n').trim();
}
