/**
 * 检索空间（Space）—— 四维结构分不是语义向量，不能直接拿文本查。
 *
 * 这里做两件事：
 *   1. 文本索引：中文二字组 / 英文词 + IDF，负责"从任务描述召回候选"
 *   2. 查询计划：管理 AI 把任务拆成 keywords + D1/D2/D4 范围，负责过滤和排序
 *
 * 四维只做过滤/排序，不做语义召回；永不单独决定真假。
 */
import { shingles } from './dedup.js';

const DEFAULT_LIMIT = 8;

function clamp01(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** 无模型时的查询计划：只取关键词，不做结构过滤。 */
export function fallbackPlan(query) {
  const keywords = [...shingles(query)].slice(0, 12);
  return {
    keywords,
    d1_min: 0, d1_max: 1,
    d2_min: 0, d2_max: 1,
    d4_max: 1,
    intent: '',
    source: 'fallback',
  };
}

export function planPrompt(query) {
  return [
    '你是检索计划器。把用户任务变成 JSON，严格输出，不要解释：',
    '{"keywords":["词1","词2"],"d1_min":0,"d1_max":1,"d2_min":0,"d2_max":1,"d4_max":1,"intent":"build"}',
    '',
    '规则：',
    '- keywords 3~8 个，保留中英文原词，不要泛词（如"帮我""如何"）',
    '- D1 抽象度：0 实操步骤，1 纯理论；范围按任务需要收窄',
    '- D2 领域：0 计算机/工程，1 人文/艺术',
    '- D4 风险：查资料/搭建可以放宽；高风险实操必须收紧',
    '- 拿不准就用 0~1 全范围',
    '',
    `## 用户任务\n${String(query || '').slice(0, 2000)}`,
  ].join('\n');
}

export function parsePlan(text, query = '') {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) return fallbackPlan(query);
  const obj = JSON.parse(raw.slice(start, end + 1));
  const keywords = Array.isArray(obj.keywords)
    ? obj.keywords.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 12)
    : [];
  if (!keywords.length) return fallbackPlan(query);
  let d1min = clamp01(obj.d1_min, 0);
  let d1max = clamp01(obj.d1_max, 1);
  let d2min = clamp01(obj.d2_min, 0);
  let d2max = clamp01(obj.d2_max, 1);
  if (d1min > d1max) [d1min, d1max] = [d1max, d1min];
  if (d2min > d2max) [d2min, d2max] = [d2max, d2min];
  return {
    keywords,
    d1_min: d1min,
    d1_max: d1max,
    d2_min: d2min,
    d2_max: d2max,
    d4_max: clamp01(obj.d4_max, 1),
    intent: String(obj.intent || '').trim(),
    source: 'model',
  };
}

export async function planQuery(query, opts = {}) {
  if (!opts.callModel) return fallbackPlan(query);
  // 推理模型的 reasoning_tokens 也吃 max_tokens；600 一定被截断
  for (const maxTokens of [3000, 6000]) {
    try {
      const res = await opts.callModel([{ role: 'user', content: planPrompt(query) }], maxTokens);
      return parsePlan(res.text, query);
    } catch (error) {
      const truncated = /finish_reason=length|截断/.test(String(error?.message || ''));
      if (!truncated) return fallbackPlan(query);
    }
  }
  return fallbackPlan(query);
}

function allowed(seed, plan) {
  const v = seed.vector;
  if (!v) return true; // 未打分的种子仍可被文本召回
  if (v.d1 < plan.d1_min || v.d1 > plan.d1_max) return false;
  if (v.d2 < plan.d2_min || v.d2 > plan.d2_max) return false;
  if (v.d4 > plan.d4_max) return false;
  return true;
}

function buildIndex(seeds) {
  const docs = seeds.map((seed) => ({
    seed,
    tokens: shingles(`${seed.title}\n${seed.body || ''}`),
  }));
  const df = new Map();
  for (const doc of docs) {
    for (const token of doc.tokens) df.set(token, (df.get(token) || 0) + 1);
  }
  const total = docs.length || 1;
  const idf = new Map([...df].map(([token, n]) => [token, Math.log((total + 1) / (n + 0.5))]));
  return { docs, idf };
}

function textScore(queryTokens, doc, idf) {
  if (!queryTokens.size) return 0;
  let sum = 0;
  let hits = 0;
  for (const token of queryTokens) {
    if (!doc.tokens.has(token)) continue;
    sum += idf.get(token) || 0.1;
    hits++;
  }
  const norm = Math.sqrt(queryTokens.size * doc.tokens.size) || 1;
  return sum / norm + Math.min(0.2, hits * 0.03);
}

/**
 * 检索：关键词/字 n-gram 召回 → 四维过滤 → 排序。
 * @param {string} query
 * @param {Array} seeds
 * @param {{plan?:object, limit?:number}} [opts]
 */
export function searchSeeds(query, seeds, opts = {}) {
  const plan = opts.plan || fallbackPlan(query);
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const queryTokens = shingles(plan.keywords.join(' ') || query);
  const { docs, idf } = buildIndex(seeds);

  const results = [];
  for (const doc of docs) {
    if (!allowed(doc.seed, plan)) continue;
    const score = textScore(queryTokens, doc, idf)
      + (Number(doc.seed.call_value) || 0) * 0.1
      + Math.min(0.1, (Number(doc.seed.watered) || 0) * 0.01);
    if (score <= 0) continue;
    results.push({
      id: doc.seed.id,
      title: doc.seed.title,
      score: Number(score.toFixed(3)),
      vector: doc.seed.vector || null,
      call_value: doc.seed.call_value,
    });
  }
  results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { plan, results: results.slice(0, limit), total: results.length };
}
