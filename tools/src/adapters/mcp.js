/**
 * MCP 适配器 —— 让任何支持 MCP 的编辑器直接用到这个库。
 *
 * **不用官方 SDK。** MCP 就是 JSON-RPC 2.0 跑在 stdio 上，实现一个够用的子集
 * 比引一个依赖便宜得多，而且「零依赖」是这个项目还没被抄走的少数特点之一。
 *
 * 只暴露两个工具，不做四十个命令的包装：
 *   recall  接任务前先调，把该用的种子捞进上下文
 *   water   真的用过并验证后才调，这是唯一的成长信号
 *
 * 为什么只有两个：模型不会主动调用一个它不认识的工具。工具越少、说明越清楚，
 * 被用对的概率越高。其余的（plant / synthesize / share）都是人的判断，不该给模型。
 *
 * 协议版本按需回显客户端要求的版本，不硬编码 —— 各宿主差异很大。
 */
import readline from 'node:readline';
import { recall } from '../core/recall.js';
import { waterSeed } from '../core/seed.js';
import { getForestRoot } from '../core/paths.js';
import { currentProject } from '../core/project.js';
import { DOMAINS } from '../core/plaque.js';

/** 服务名，宿主里显示的就是它。 */
export const SERVER_NAME = 'trees';
/** 我们自己实现的协议版本；客户端要别的版本就照它说的回。 */
export const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

const INSTRUCTIONS = [
  '这是一个「经验库」，里面是按项目沉淀下来、被实际验证过的判断。',
  '',
  '**开始一个任务之前，先调用 recall**，把 task 用一句话描述清楚。',
  '召回的种子带着「判据 / 做法 / 不适用」三段：判据决定该不该用，不适用决定什么时候别用 —— 两条都要看。',
  '',
  '**只有真的用了、并且验证有效，才调用 water（ok=true）**；用了但没用，调用 water（ok=false）。',
  '只是看一眼、觉得有道理，不要浇水 —— 检索不是证据。',
  '',
  '库里没有相关经验时 recall 会返回空，这是正常的，直接开始干活。',
].join('\n');

/** 两个工具的定义。inputSchema 用 JSON Schema 的极简子集。 */
export const TOOLS = [
  {
    name: 'recall',
    description: '接任务前调用：根据任务描述召回相关的经验种子（判据/做法/不适用）。只读，不改任何东西。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '用一句话描述你接下来要做的事' },
        limit: { type: 'number', description: '最多几颗，默认 5' },
      },
      required: ['task'],
    },
  },
  {
    name: 'water',
    description: '用上了某颗种子并且验证有效（或无效）后调用。这是经验生长的唯一信号：检索不算，用了才算。',
    inputSchema: {
      type: 'object',
      properties: {
        seed_id: { type: 'string', description: '种子 id，形如 seed-0007' },
        ok: { type: 'boolean', description: '用了有效为 true（默认），用了但没用为 false' },
      },
      required: ['seed_id'],
    },
  },
];

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * 执行一次工具调用。纯函数以外只读写库，不碰网络。
 * @param {string} name
 * @param {object} args
 * @returns {Promise<object>}
 */
export async function callTool(name, args = {}) {
  if (name === 'recall') {
    const task = String(args.task || '').trim();
    if (!task) return errorResult('task 不能为空：用一句话描述你要做的事');

    const result = await recall(task, {
      limit: Number(args.limit) > 0 ? Number(args.limit) : undefined,
    });

    if (!result.picks.length) {
      const divergent = (result.divergent || []).map((d) => `${d.id} ${d.title}`).join('\n');
      return textResult([
        `库里没有和「${task}」相关的经验（共 ${result.total} 颗）。直接开始干活。`,
        divergent ? `\n也许相关但不该直接套用：\n${divergent}` : '',
      ].join(''));
    }

    const body = result.picks.map((p) => p.text).join('\n\n');
    const divergent = (result.divergent || []).map((d) => `${d.id} ${d.title}`).join('\n');
    return textResult([
      `召回 ${result.picks.length} 颗（约 ${result.tokens} token）：`,
      '',
      body,
      '',
      divergent ? `其他可能相关的：\n${divergent}` : '',
      '',
      '用上了并且验证有效 → 调 water(seed_id)。只是看了一眼不算。',
    ].join('\n'));
  }

  if (name === 'water') {
    const id = String(args.seed_id || '').trim();
    if (!id) return errorResult('seed_id 不能为空，形如 seed-0007');
    const ok = args.ok !== false;

    // 使用上下文：显式传的优先，否则看当前目录属于哪个项目，再没有就 unknown
    const project = await currentProject(process.cwd());
    const domain = DOMAINS.includes(args.domain)
      ? args.domain
      : (project?.index?.domain || 'unknown');

    const seed = await waterSeed(id, ok, { domain, tree: project?.id || '' });
    if (!seed) return errorResult(`没有这颗种子：${id}`);

    return textResult(ok
      ? `💧 ${seed.id} 浇水成功（第 ${seed.watered} 次），状态 ${seed.state}`
      : `💧 ${seed.id} 记了一次失败（第 ${seed.failed} 次）—— 下次该补「不适用」的边界`);
  }

  return errorResult(`没有这个工具：${name}`);
}

/**
 * 处理一条 JSON-RPC 消息。
 * @param {object} message
 * @returns {Promise<object|null>} 需要回复时返回响应对象；通知返回 null
 */
export async function handleMessage(message) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }

  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: '0.4.0' },
          instructions: INSTRUCTIONS,
        },
      };

    case 'notifications/initialized':
    case 'initialized':
      return null;

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        const result = await callTool(name, args);
        return { jsonrpc: '2.0', id, result };
      } catch (error) {
        return { jsonrpc: '2.0', id, result: errorResult(`执行失败：${error.message}`) };
      }
    }

    default:
      if (isNotification) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

/**
 * 启动 stdio 服务。
 * 约定：stdout 只走协议，日志一律走 stderr —— 混了宿主就解析不了。
 */
export async function runMcpServer() {
  process.stderr.write(`${SERVER_NAME} MCP server 已启动 · 库：${getForestRoot()}\n`);

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  // 串行处理，避免两条请求同时写库
  let queue = Promise.resolve();

  rl.on('line', (line) => {
    const raw = line.trim();
    if (!raw) return;

    queue = queue.then(async () => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        process.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' },
        })}\n`);
        return;
      }

      const response = await handleMessage(message);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }).catch((error) => {
      process.stderr.write(`处理失败：${error.message}\n`);
    });
  });

  await new Promise((resolve) => rl.on('close', resolve));
  await queue;
}
