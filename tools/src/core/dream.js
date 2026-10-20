/**
 * 黑夜循环（Dream）—— 让系统自己长大的那部分。
 *
 * 白天是人主导：用种子、浇种子、播种。
 * 夜里是系统自跑：挑一批种子，让 AI 去补充、修正、找旁证，写回去。
 *
 * 本文件目前只负责**挑谁**和**算预算** —— 纯本地逻辑，不调模型、不花钱。
 * 真正调模型那一步在后面接。
 *
 * ─────────────────────────────────────────────────────────
 * 两条底线（写死在代码里，不是靠自觉）
 *
 *   1. **学习不算浇水。**
 *      浇水 = 在真实项目里用了并且验证通过，是实践产生的证据。
 *      学习 = 读书补充，是认知产生的补充。
 *      如果系统能给自己浇水，那"浇水次数 = 证据"这个核心就烂了 —— 等于自己刷分。
 *
 *   2. **学习不能改资历。**
 *      `watered` / `failed` / `state` / `last_watered` 这四个字段，
 *      `applyLearning` 一律不碰。学习能让种子更**准**，但不能让它更**资深**。
 * ─────────────────────────────────────────────────────────
 */
import { readSeed, writeSeed, listSeeds, seedAge, sweepAging } from './seed.js';

/** 每晚最多学几颗。硬上限，防止一晚上烧掉一堆。 */
export const MAX_PER_NIGHT = 5;

/** 每颗种子的 token 上限。防止某颗正文特别长，一次吃掉整晚预算。 */
export const TOKENS_PER_SEED = 4000;

/** 与 SPEC 一致：180 天没浇水就入盒。 */
export const ROT_AFTER_DAYS = 180;

/** 距离入盒还剩这么多天以内 —— 算「快腐烂」，不学了。 */
export const ROTTING_MARGIN_DAYS = 30;

/** 最近这么多天内浇过的，还健康，不用学。 */
export const FRESH_DAYS = 30;

/** 只有学习能改的字段。 */
const LEARNABLE_FIELDS = ['evidence', 'body'];

/** 学习一律不许碰的字段 —— 资历只能靠真用过。 */
const FORBIDDEN_FIELDS = ['watered', 'failed', 'state', 'last_watered', 'prev_state'];

/** 取正文里某一段（## 判据 / ## 做法）的文本；找不到返回空串。 */
function sectionText(body, title) {
  const text = String(body || '');
  const m = new RegExp(`^##\\s*${title}\\s*$`, 'm').exec(text);
  if (!m) return '';
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^##\s*\S/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/** 核心主张 = 判据 + 做法；正文没有结构化段落时退回全文比较。 */
function coreClaim(body) {
  const judge = sectionText(body, '判据');
  const method = sectionText(body, '做法');
  if (judge || method) return `${judge}\n${method}`;
  return String(body || '').trim();
}

/**
 * 挑出今晚该学的种子。
 *
 * 规则（按用户定的）：
 *   - 挑**最近用得少**的：距上次浇水越久越优先。常用的不用管，它自己会活。
 *   - **不挑快腐烂的**：再 ROTTING_MARGIN_DAYS 天就入盒的，说明它可能真的过时了。
 *     花预算拖它一口气不值得，不如让它自然淘汰。
 *   - 刚浇过的（FRESH_DAYS 内）也不挑 —— 它还新鲜。
 *   - 一晚最多 MAX_PER_NIGHT 颗。
 *
 * @param {{maxPerNight?:number, freshDays?:number, rotMarginDays?:number, rotAfterDays?:number}} [opts]
 * @returns {Promise<Array<{seed:object, idleDays:number}>>}
 */
export async function pickDreamSeeds(opts = {}) {
  const maxPerNight = opts.maxPerNight ?? MAX_PER_NIGHT;
  const freshDays = opts.freshDays ?? FRESH_DAYS;
  const rotMargin = opts.rotMarginDays ?? ROTTING_MARGIN_DAYS;
  const rotAfter = opts.rotAfterDays ?? ROT_AFTER_DAYS;
  const tooOld = rotAfter - rotMargin;   // 超过这个天数就是「快腐烂」，不碰

  const all = (await listSeeds({}))
    .filter((s) => s.state !== 'boxed')          // 盒里的已经休眠，不打扰
    .filter((s) => !s.synthesized_into);         // 已经被合成走的，不重复学

  const scored = [];
  for (const seed of all) {
    const idleDays = await seedAge(seed);
    if (idleDays < freshDays) continue;          // 还新鲜
    if (idleDays >= tooOld) continue;            // 快腐烂，让它自然淘汰
    scored.push({ seed, idleDays });
  }

  // 用得越少越靠前
  scored.sort((a, b) => b.idleDays - a.idleDays);
  return scored.slice(0, maxPerNight);
}

/**
 * 生成今晚的学习计划 —— 挑谁、每颗多少 token、总共多少。
 *
 * 只是计划，不调模型、不花钱。要看计划用 `trees dream`。
 *
 * @param {{maxPerNight?:number, tokensPerSeed?:number, seedIds?:string[]}} [opts]
 * @returns {Promise<object>}
 */
export async function planDream(opts = {}) {
  const tokensPerSeed = opts.tokensPerSeed ?? TOKENS_PER_SEED;

  let picks;
  let reason;
  if (opts.seedIds?.length) {
    // 手动指定就按指定的来（仍然受每晚上限约束）
    const chosen = [];
    for (const id of opts.seedIds.slice(0, MAX_PER_NIGHT)) {
      const seed = await readSeed(id);
      if (seed) chosen.push({ seed, idleDays: await seedAge(seed) });
    }
    picks = chosen;
    reason = '手动指定';
  } else {
    picks = await pickDreamSeeds(opts);
    reason = '自动挑（用得少的优先，跳过快腐烂的）';
  }

  return {
    reason,
    picks: picks.map((p) => ({
      id: p.seed.id,
      title: p.seed.title,
      idleDays: p.idleDays,
      watered: p.seed.watered,
      tokens: tokensPerSeed,
    })),
    perSeed: tokensPerSeed,
    maxPerNight: MAX_PER_NIGHT,
    totalTokens: picks.length * tokensPerSeed,
    // 明确标出来：这是纯本地计算，还没调模型
    callsModel: false,
  };
}

/**
 * 把学到的东西写回种子 —— 只准动 `evidence` 和 `body`。
 *
 * 铁律：`watered` / `failed` / `state` / `last_watered` 一律不碰。
 * 学习能让种子更准，不能让它更资深。资历只能靠真用过。
 *
 * @param {string} seedId
 * @param {{evidence?:string, body?:string}} patch
 * @returns {Promise<object>} 更新后的种子
 */
export async function applyLearning(seedId, patch = {}) {
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_FIELDS.includes(key)) {
      throw new Error(`学习不许改 ${key} —— 资历只能靠真用过，不能自己给自己刷分`);
    }
    if (!LEARNABLE_FIELDS.includes(key)) {
      throw new Error(`学习只能改 ${LEARNABLE_FIELDS.join(' / ')}，不许改 ${key}`);
    }
  }

  const seed = await readSeed(seedId);
  if (!seed) throw new Error(`找不到种子：${seedId}`);
  if (seed.state === 'boxed') throw new Error('盒子里的种子不参与黑夜循环');

  const next = { ...seed };
  if (typeof patch.evidence === 'string') next.evidence = patch.evidence;
  if (typeof patch.body === 'string') {
    // 改「判据 / 做法」等于改主张 —— 没有证据就不许改，免得夜里被模型悄悄换掉
    const coreChanged = coreClaim(patch.body) !== coreClaim(seed.body);
    if (coreChanged && !String(patch.evidence || '').trim()) {
      throw new Error('学习想改「判据 / 做法」，但没给 evidence —— 主张不能靠猜改，先说明依据');
    }
    next.body = patch.body;
  }

  // 落盘前再核一遍：这几个字段必须和原来一模一样
  for (const key of FORBIDDEN_FIELDS) {
    if (next[key] !== seed[key]) {
      throw new Error(`内部错误：${key} 被改动了（${seed[key]} → ${next[key]}）`);
    }
  }

  return writeSeed(next);
}

/**
 * 检查一笔学习是不是超预算了。
 *
 * @param {number} seedsPlanned 计划学几颗
 * @param {number} tokensPerSeed 每颗多少 token
 * @param {{maxPerNight?:number, tokensPerSeed?:number}} [budget]
 * @returns {{ok:boolean, reason:string}}
 */
export function checkBudget(seedsPlanned, tokensPerSeed, budget = {}) {
  const maxPerNight = budget.maxPerNight ?? MAX_PER_NIGHT;
  const perSeedCap = budget.tokensPerSeed ?? TOKENS_PER_SEED;

  if (seedsPlanned > maxPerNight) {
    return { ok: false, reason: `一晚最多 ${maxPerNight} 颗，这次要 ${seedsPlanned} 颗` };
  }
  if (tokensPerSeed > perSeedCap) {
    return { ok: false, reason: `每颗最多 ${perSeedCap} token，这次给到 ${tokensPerSeed}` };
  }
  return { ok: true, reason: `在预算内（${seedsPlanned} 颗 × ${tokensPerSeed}）` };
}

// ───────────────────────── 真去学习 ─────────────────────────

/** 让模型给一颗种子补课。提示词把边界写死，免得它顺手把经验改跑偏。 */
function learnPrompt(seed) {
  return [
    '你在给一个经验库「补课」。下面是一颗经验种子，它来自真实项目，已经被用过若干次。',
    '',
    '你只做两件事：',
    '1. 补充旁证 —— 给出支持或反驳这条经验的具体依据（原理、文档、你确知的实例）。',
    '   没有把握就留空，**不要编造**。',
    '2. 如果「不适用」写得不准，或「做法」有遗漏，可以修正正文。',
    '',
    '硬约束：',
    '- 不要改这条经验的核心主张。除非你确信它是错的 —— 那就在旁证里说明理由。',
    '- 不要写空话、不要凑字数、不要复述原文。',
    '- 输出**纯 JSON**，不要代码围栏，不要任何解释文字。',
    '',
    '{"evidence": "一句话旁证，没有就空串", "body": "完整的正文，保持 ## 判据 / ## 做法 / ## 不适用 三段"}',
    '',
    `当前种子：`,
    `标题：${seed.title}`,
    `标签：${(seed.labels || []).join(', ')}`,
    `正文：`,
    seed.body || '（空）',
  ].join('\n');
}

/** 从模型输出里抠出 JSON —— 它偶尔会套一层代码围栏。 */
function parseLearnOutput(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('模型没返回 JSON');
  const obj = JSON.parse(raw.slice(start, end + 1));
  const out = {};
  if (typeof obj.evidence === 'string') out.evidence = obj.evidence.trim();
  if (typeof obj.body === 'string' && obj.body.trim()) out.body = obj.body.trim();
  if (!Object.keys(out).length) throw new Error('模型返回里没有 evidence / body');
  return out;
}

/** 默认的调用方式：懒加载 llm 层。core 不直接依赖它，测试时可以整个替换。 */
async function defaultCallModel(messages, maxTokens) {
  const { chat } = await import('../llm/chat.js');
  return chat({ messages, maxTokens });
}

/**
 * 真的跑一轮学习。
 *
 * 注意这里**只动 evidence 和正文**（交给 `applyLearning` 把关），
 * watered / state / last_watered 一律不碰 —— 夜里学到的只是认知，不是资历。
 *
 * @param {{callModel?:Function, maxPerNight?:number, tokensPerSeed?:number,
 *          maxTotalTokens?:number, seedIds?:string[], dryRun?:boolean}} [opts]
 * @returns {Promise<{plan:object, results:Array, spentTokens:number, stopped:string|null}>}
 */
export async function runDream(opts = {}) {
  // 先把长期没浇水的收进盒子，再挑今晚该学的 —— 否则它们会一直留在活跃库里
  if (!opts.dryRun) await sweepAging();
  const plan = await planDream(opts);
  if (opts.dryRun || !plan.picks.length) {
    return { plan, results: [], spentTokens: 0, stopped: opts.dryRun ? 'dry-run' : '没有该学的种子' };
  }

  const callModel = opts.callModel ?? defaultCallModel;
  const totalCap = opts.maxTotalTokens ?? plan.picks.length * plan.perSeed;

  const results = [];
  let spentTokens = 0;
  let stopped = null;

  for (const pick of plan.picks) {
    if (spentTokens + plan.perSeed > totalCap) {
      stopped = `总预算用完（已花 ${spentTokens} / 上限 ${totalCap}），剩下的留到明天`;
      break;
    }

    const seed = await readSeed(pick.id);
    if (!seed) continue;

    try {
      const res = await callModel(
        [{ role: 'user', content: learnPrompt(seed) }],
        plan.perSeed,
      );
      const patch = parseLearnOutput(res.text);
      const after = await applyLearning(seed.id, patch);
      const used = res.usage?.total_tokens ?? plan.perSeed;
      spentTokens += used;
      results.push({
        id: seed.id,
        ok: true,
        applied: Object.keys(patch),
        evidence: patch.evidence || '',
        tokens: used,
        wateredAfter: after.watered,
        stateAfter: after.state,
      });
    } catch (err) {
      results.push({ id: seed.id, ok: false, error: err.message, tokens: 0 });
    }
  }

  return { plan, results, spentTokens, stopped };
}
