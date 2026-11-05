/**
 * 漂移（Drift）—— 找出「在别的领域被反复验证」的种子。
 *
 * 这是这套系统里最不像别人的一块。别人按「最近热 / 召回次数多」加权，
 * 这里按**在哪个领域被验证**加权：
 *
 *   一颗 software 领域的种子，在 hardware 项目里被浇了三次水、来自两个不同项目
 *   —— 这不是噪声，这是新方向的苗头。
 *
 * 但也有另一种解释必须先排除：**它本来就被分错类了**。
 * 所以只有一条 event 支撑的，不算新方向，算「分类待改」。
 *
 * 判据（可测、可复算，全部来自事件账本）：
 *   new-direction  跨域成功 ≥ MIN_CROSS 次，且来自 ≥ MIN_PROJECTS 个不同项目
 *   reclassify     跨域成功 ≥ MIN_CROSS 次，但只来自 1 个项目 → 更像分类错了
 */
import { listEvents } from './events.js';
import { listSeeds } from './seed.js';

/** 判定成新方向所需的跨域成功次数。 */
export const MIN_CROSS = 3;
/** 判定成新方向所需的独立项目数。 */
export const MIN_PROJECTS = 2;

/**
 * 算一遍漂移报告。纯读，不改任何东西。
 * @returns {Promise<{newDirections:Array, reclassify:Array, crossEvents:number}>}
 */
export async function analyzeDrift() {
  const [events, seeds] = await Promise.all([
    listEvents({ limit: Number.MAX_SAFE_INTEGER }),
    listSeeds({}),
  ]);

  const byId = new Map(seeds.map((seed) => [seed.id, seed]));
  /** @type {Map<string, Map<string, Set<string>>>} seed → domain → projects */
  const cross = new Map();
  let crossEvents = 0;

  for (const event of events) {
    if (event.type !== 'water') continue;         // 失败不算迁移证据
    const domain = String(event.domain || '');
    if (!domain || domain === 'unknown') continue;
    const seed = byId.get(event.seed);
    if (!seed) continue;
    if (domain === seed.domain) continue;         // 同域，不是跨域

    crossEvents += 1;
    if (!cross.has(seed.id)) cross.set(seed.id, new Map());
    const perDomain = cross.get(seed.id);
    if (!perDomain.has(domain)) perDomain.set(domain, new Set());
    perDomain.get(domain).add(event.tree || '(未知项目)');
  }

  const newDirections = [];
  const reclassify = [];

  for (const [seedId, perDomain] of cross) {
    const seed = byId.get(seedId);
    for (const [domain, projects] of perDomain) {
      const item = {
        id: seedId,
        title: seed.title,
        from: seed.domain,
        to: domain,
        count: projects.size,   // 项目数；次数另算
        projects: [...projects],
      };
      // 次数要按事件数不是项目数，重新数一遍
      const uses = events.filter((e) => e.type === 'water' && e.seed === seedId && e.domain === domain).length;
      item.uses = uses;

      if (uses >= MIN_CROSS && projects.size >= MIN_PROJECTS) newDirections.push(item);
      else if (uses >= MIN_CROSS) reclassify.push(item);
    }
  }

  const byUses = (a, b) => b.uses - a.uses || a.id.localeCompare(b.id);
  newDirections.sort(byUses);
  reclassify.sort(byUses);

  return { newDirections, reclassify, crossEvents };
}
