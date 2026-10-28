/**
 * 统计 —— 全部由事件账本和种子字段算出，不调用模型。
 *
 * 这是"分配"的前置：先让每一笔可统计，再谈怎么发。
 * 只读、纯函数，方便测试和以后在 daemon 里复用。
 */

/**
 * @param {{seeds?:Array, trees?:Array, events?:Array}} input
 * @returns {object}
 */
export function summarize(input = {}) {
  const seeds = Array.isArray(input.seeds) ? input.seeds : [];
  const trees = Array.isArray(input.trees) ? input.trees : [];
  const events = Array.isArray(input.events) ? input.events : [];

  const byState = {};
  const byPlanter = {};
  const perSeed = {};
  let watered = 0;
  let failed = 0;

  for (const seed of seeds) {
    byState[seed.state] = (byState[seed.state] || 0) + 1;
    const planter = seed.planter || '(unknown)';
    byPlanter[planter] = (byPlanter[planter] || 0) + 1;
    watered += Number(seed.watered) || 0;
    failed += Number(seed.failed) || 0;
    perSeed[seed.id] = {
      title: seed.title,
      state: seed.state,
      watered: Number(seed.watered) || 0,
      failed: Number(seed.failed) || 0,
      call_value: Number(seed.call_value) || 0,
      planted: 0,
      used: 0,
    };
  }

  const byType = {};
  for (const event of events) {
    byType[event.type] = (byType[event.type] || 0) + 1;
    if (!event.seed || !perSeed[event.seed]) continue;
    if (event.type === 'plant') perSeed[event.seed].planted += 1;
    if (event.type === 'water') perSeed[event.seed].used += 1;
  }

  return {
    seeds: { total: seeds.length, byState, watered, failed },
    trees: { total: trees.length },
    events: { total: events.length, byType },
    planters: byPlanter,
    perSeed,
  };
}
