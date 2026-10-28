/**
 * 索引（Index）—— 森林目录的「目录页」。
 *
 * 新会话不可能把整个库读进来，但可以读一份几 KB 的目录：
 * 有哪些种子、各自什么状态、什么标签。需要细节时再用 recall 精确调取。
 *
 * 这是召回层的第二块：recall 负责「任务来了拿哪几颗」，
 * index 负责「会话一开始知道库里有什么」。两者都只读取、不改变种子。
 */
import { writeFile } from 'node:fs/promises';
import { getPath, ensureDirs } from './paths.js';
import { listSeeds } from './seed.js';
import { listTrees } from './tree.js';

/** 索引里最多列多少颗活跃种子（超出只给数量，避免索引本身撑爆上下文）。 */
export const DEFAULT_MAX_SEEDS = 120;

/**
 * 生成索引文本（不落盘）。
 *
 * @param {{maxSeeds?:number}} [opts]
 * @returns {Promise<{text:string, active:number, boxed:number, trees:number, totalSeeds:number}>}
 */
export async function renderIndex(opts = {}) {
  const maxSeeds = opts.maxSeeds ?? DEFAULT_MAX_SEEDS;
  const seeds = (await listSeeds({})).sort((a, b) => b.watered - a.watered || a.id.localeCompare(b.id));
  // 会话树是原料，不进目录；目录只展示完成的项目和种子
  const trees = (await listTrees()).filter((t) => t.kind !== 'session');
  const active = seeds.filter((s) => s.state !== 'boxed');
  const boxed = seeds.filter((s) => s.state === 'boxed');

  const lines = [
    '# Trees 索引',
    '',
    `> 自动生成，别手改（trees index）。${active.length} 颗活跃 / ${boxed.length} 颗休眠 · ${trees.length} 棵大树`,
    '',
    '## 种子',
  ];

  for (const s of active.slice(0, maxSeeds)) {
    const labels = (s.labels || []).join(', ');
    lines.push(`- ${s.id} [${s.state} 💧${s.watered}] ${s.title}${labels ? ` — ${labels}` : ''}`);
  }
  if (active.length > maxSeeds) lines.push(`- …还有 ${active.length - maxSeeds} 颗，用 trees ls 看全部`);
  if (!active.length) lines.push('- （空）');

  if (trees.length) {
    lines.push('', '## 大树');
    for (const t of trees) {
      // 规则 8：列表只显示树牌，不展开正文
      const plaque = t.plaque || t.title;
      const labels = (t.labels || []).join(', ');
      const planter = t.planter ? ` · ${t.planter}` : '';
      lines.push(`- ${t.id} ${plaque}${labels ? ` — ${labels}` : ''}${planter} (${(t.branches || []).length} 分支 / ${(t.seeds || []).length} 种子)`);
    }
  }

  if (boxed.length) {
    lines.push('', '## 盒子（休眠，trees summon 可召回）');
    for (const s of boxed) lines.push(`- ${s.id} ${s.title}`);
  }

  lines.push('', '需要细节时：trees recall "<任务描述>"', '');

  return {
    text: lines.join('\n'),
    active: active.length,
    boxed: boxed.length,
    trees: trees.length,
    totalSeeds: seeds.length,
  };
}

/**
 * 生成并写入 `forest/index.md`。
 * @param {{maxSeeds?:number}} [opts]
 * @returns {Promise<{text:string, active:number, boxed:number, trees:number, totalSeeds:number, path:string}>}
 */
export async function writeIndex(opts = {}) {
  await ensureDirs();
  const result = await renderIndex(opts);
  const file = getPath('index');
  await writeFile(file, result.text, 'utf8');
  return { ...result, path: file };
}
