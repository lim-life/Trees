/**
 * 夜间维护 —— 把散落的动作串成一条链。
 *
 * 之前这些东西都是分开的手动命令：sweep / score / dream / reindex / index。
 * 分开的后果是它们基本不会发生。这里把它们按「先修、再长、最后收拾」的顺序跑一遍：
 *
 *   1. 账本校验   —— 坏了要第一个知道
 *   2. 入盒       —— 180 天没浇水的进盒子
 *   3. 补分       —— 新种子没有 D1/D2/D4，补上（花钱）
 *   4. 学习       —— dream，只补见识，不动浇水与状态（花钱）
 *   5. 重建坐标牌 —— 确定性，免费
 *   6. 刷新目录   —— 下次开会话读到的就是新的
 *
 * 每一步互相隔离：学习失败不该连累入盒，补分没配额也不该挡住重建坐标牌。
 * 所有花钱的步骤都有硬上限，超了停，不追问。
 */
import { loadLlmConfig } from '../llm/chat.js';
import { sweepAging } from './seed.js';
import { scoreMissing, getScorerConfig } from './scorer.js';
import { runDream } from './dream.js';
import { verifyEvents } from './events.js';
import { reindexAll } from './reindex.js';
import { writeIndex } from './indexer.js';

/** 每晚最多补几颗种子的向量分。 */
export const MAX_SCORE_PER_NIGHT = 20;
/** 每晚最多学几颗种子。 */
export const MAX_DREAM_SEEDS = 5;
/** 学一颗的 token 上限。 */
export const DREAM_TOKENS_PER_SEED = 4000;

/**
 * 跑一次夜间维护。
 *
 * @param {{dryRun?:boolean, free?:boolean, maxScore?:number, maxDream?:number}} [opts]
 *   free=true 只跑不花钱的步骤（校验 / 入盒 / 坐标牌 / 目录）。
 * @returns {Promise<{steps:Array<{name:string, ok:boolean, detail:string}>, spentTokens:number, ok:boolean}>}
 */
export async function runNightly(opts = {}) {
  const dryRun = opts.dryRun === true;
  const free = opts.free === true;
  const maxScore = opts.maxScore ?? MAX_SCORE_PER_NIGHT;
  const maxDream = opts.maxDream ?? MAX_DREAM_SEEDS;

  const steps = [];
  let spentTokens = 0;

  /** 每一步单独兜底 —— 一步炸了不能把整夜带走。 */
  const step = async (name, action) => {
    try {
      const detail = await action();
      steps.push({ name, ok: true, detail: detail || '完成' });
    } catch (error) {
      steps.push({ name, ok: false, detail: error.message });
    }
  };

  // 1. 账本
  await step('账本校验', async () => {
    const r = await verifyEvents();
    if (!r.ok) throw new Error(`第 ${r.brokenAt} 条断裂：${r.reason}`);
    return `${r.count} 条完整`;
  });

  // 2. 入盒
  await step('入盒', async () => {
    if (dryRun) return 'dry-run，跳过';
    const boxed = await sweepAging();
    return boxed.length ? `${boxed.length} 颗进盒子` : '没有该入盒的';
  });

  // 3. 补分（花钱）
  await step('补向量分', async () => {
    if (free) return '--free，跳过';
    if (dryRun) return 'dry-run，跳过';
    if (!getScorerConfig(await loadConfigSafe())) {
      // 没配置不是「跳过」，是「这晚白跑」—— 必须报出来，否则备份/换机会静默失效
      throw new Error('没有配置模型：trees config --from-env 或 trees config --migrate');
    }
    const done = await scoreMissing({ limit: maxScore });
    return done.length ? `${done.length} 颗` : '没有缺分的';
  });

  // 4. 学习（花钱）
  await step('夜里学习', async () => {
    if (free) return '--free，跳过';
    if (dryRun) return 'dry-run，跳过';
    if (!(await loadLlmConfig())) {
      throw new Error('没有配置模型：trees config --from-env 或 trees config --migrate');
    }
    const r = await runDream({ maxTotalTokens: maxDream * DREAM_TOKENS_PER_SEED });
    spentTokens += r.spentTokens || 0;
    if (!r.results.length) return r.stopped || '没有该学的';
    const okCount = r.results.filter((x) => x.ok).length;
    return `${okCount}/${r.results.length} 颗，${r.spentTokens} tokens`;
  });

  // 5. 坐标牌
  await step('重建坐标牌', async () => {
    const r = await reindexAll({ dryRun });
    return dryRun ? `dry-run，会更新 ${r.updated} 棵` : `更新 ${r.updated} 棵，未变 ${r.unchanged} 棵`;
  });

  // 6. 目录
  await step('刷新目录', async () => {
    if (dryRun) return 'dry-run，跳过';
    const r = await writeIndex();
    return `${r.active} 颗活跃 / ${r.trees} 棵大树`;
  });

  return { steps, spentTokens, ok: steps.every((s) => s.ok) };
}

/** config 读不出来不该让补分这一步直接抛。 */
async function loadConfigSafe() {
  try {
    const { readConfig } = await import('./config.js');
    return await readConfig();
  } catch {
    return {};
  }
}
