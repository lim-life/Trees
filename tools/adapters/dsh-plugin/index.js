/**
 * dsh-trees —— Trees 的 DeepSeek Harness 适配器（Cordis 插件）。
 *
 * 解决两件事，对应 Claude Code 侧的两个 hook：
 *   1. 每条用户消息进来时召回一次（等价 UserPromptSubmit → trees hook-recall）
 *   2. 会话结束时归档成会话树（等价 SessionEnd → trees auto）
 *
 * 不依赖 dsh 的任何内部模块：只通过官方事件 `agent/pre-step` 和
 * `session/disposed`，其余全部走 Trees CLI。CLI 找不到/失败时静默降级，
 * 绝不阻断 DSH 的对话。
 *
 * 参考实现：@deepseek-ai/dsh-time-context（同样的 pre-step 注入形态）。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Cordis 插件名。 */
export const name = 'trees';

/** 依赖的服务：agent 注册表（pre-step 由它触发）。 */
export const inject = ['agents'];

const LOG = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.trees', 'dsh-plugin.log');

function log(line) {
  try {
    mkdirSync(path.dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${new Date().toISOString()}\t${line}\n`, 'utf8');
  } catch { /* 日志写不了不能影响对话 */ }
}

/** 把配置归一成「怎么调 CLI」。 */
function resolveCli(config = {}) {
  const cli = config.cli || process.env.TREES_CLI || 'trees';
  const home = config.home || process.env.TREES_HOME || '';
  return { cli, home };
}

/** 调 Trees CLI；失败返回 null。 */
function runCli(config, args, input) {
  const { cli, home } = resolveCli(config);
  const isJs = cli.endsWith('.js') || cli.endsWith('.mjs') || cli.endsWith('.cjs');
  const cmd = isJs ? process.execPath : cli;
  const cmdArgs = isJs ? [cli, ...args] : args;
  const env = { ...process.env };
  if (home) env.TREES_HOME = home;
  const res = spawnSync(cmd, cmdArgs, {
    input,
    encoding: 'utf8',
    env,
    timeout: config.timeoutMs ?? 10000,
    windowsHide: true,
  });
  if (res.error || res.status !== 0) {
    log(`cli fail ${args[0]}: ${res.error?.message || res.stderr?.trim() || `exit ${res.status}`}`);
    return null;
  }
  return res.stdout || '';
}

/** 把消息 content（string 或 block 数组）压成纯文本。 */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** 最近一条人类消息（排除插件注入）。 */
export function latestUserText(agent) {
  const events = agent?.session?.events || [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type !== 'user/message') continue;
    const src = e.data?.source;
    if (src && src.kind === 'plugin') continue;
    const text = textOf(e.data?.content).trim();
    if (text) return text;
  }
  return '';
}

/** 会话 log → Trees 能读的 JSONL（只保留人和 AI 的文本）。 */
export function toTranscript(events) {
  const lines = [];
  for (const e of events || []) {
    if (e?.type === 'user/message') {
      const src = e.data?.source;
      if (src && src.kind === 'plugin') continue;
      const text = textOf(e.data?.content).trim();
      if (text) lines.push(JSON.stringify({ type: 'user', message: { content: text } }));
    } else if (e?.type === 'assistant/message') {
      const text = textOf(e.data?.message?.content).trim();
      if (text) lines.push(JSON.stringify({ type: 'assistant', message: { content: text } }));
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Cordis 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{cli?:string, home?:string, limit?:number, budget?:number,
 *          recall?:boolean, record?:boolean, timeoutMs?:number}} [config]
 */
export function apply(ctx, config = {}) {
  const enableRecall = config.recall !== false;
  const enableRecord = config.record !== false;
  const limit = Number(config.limit) > 0 ? Number(config.limit) : 3;
  const budget = Number(config.budget) > 0 ? Number(config.budget) : 700;
  const seenTurn = new WeakMap();
  const recorded = new WeakSet();

  if (enableRecall) {
    ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
      const decision = await next();
      if (decision.kind === 'reject' || signal?.aborted) return decision;

      // 每轮只召回一次：用户新消息进来 → 第一个 step
      if (step !== 1) return decision;
      if (seenTurn.get(agent) === turn) return decision;
      seenTurn.set(agent, turn);

      const prompt = latestUserText(agent);
      if (prompt.length < 4) return decision;

      const out = runCli(config, ['hook-recall'], JSON.stringify({ prompt }));
      const text = String(out || '').trim();
      if (!text) return decision;

      return {
        kind: 'enter',
        messages: [...decision.messages, {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: {
            kind: 'plugin',
            plugin: name,
            form: 'snapshot',
            sections: [{ name, text }],
          },
        }],
      };
    }, { prepend: true });
  }

  if (enableRecord) {
    ctx.on('session/disposed', (session) => {
      if (!session || recorded.has(session)) return;
      recorded.add(session);

      const events = session.events;
      const transcript = toTranscript(events);
      if (transcript.trim().length < 50) return; // 太短的会话不值得调模型

      let dir = '';
      try {
        dir = mkdtempSync(path.join(tmpdir(), 'dsh-trees-'));
        const file = path.join(dir, 'session.jsonl');
        writeFileSync(file, transcript, 'utf8');
        const out = runCli(config, ['auto', '--transcript', file], undefined);
        log(`recorded ${session.id || 'session'}: ${String(out || '').trim().split('\n').pop() || 'ok'}`);
      } catch (err) {
        log(`record fail: ${err?.message || err}`);
      } finally {
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  log(`loaded recall=${enableRecall} record=${enableRecord} cli=${resolveCli(config).cli}`);
  ctx.logger?.info?.(`[trees] recall=${enableRecall} record=${enableRecord} cli=${resolveCli(config).cli}`);
}
