/**
 * 最小 LLM 调用层 —— 够用就好。
 *
 * 只认 **OpenAI 兼容**的接口（`POST /chat/completions`），因为几乎所有供应商都提供这个形状：
 * OpenAI、DeepSeek、Moonshot、通义、智谱、Ollama、各种中转站……
 * 所以谁也不绑死，部署的人手头有什么便宜的就配什么。
 *
 * 这一层是唯一允许联网的地方。core/ 里的东西一律不碰网络 ——
 * 把本地的经验库和"对外请求"分开，别人跑测试时才不会莫名其妙花钱。
 *
 * 配置（环境变量，全都有默认值或可缺省）：
 *   TREES_LLM_BASE_URL   例: https://api.deepseek.com/v1
 *   TREES_LLM_API_KEY    必填，没配就报错（不偷偷用谁的 key）
 *   TREES_LLM_MODEL      例: deepseek-chat、gemini-3.8-flash
 *   TREES_LLM_TIMEOUT_MS 默认 60000
 *
 * 走代理：Node 24+ 支持 `NODE_USE_ENV_PROXY=1` 让 fetch 认 HTTPS_PROXY。
 * 更早的版本请用直连的供应商，或自己套一层。
 */

import { readConfig } from '../core/config.js';

/** 只看环境变量（同步，便于测试）。没配全就返回 null。 */
export function readLlmConfig(env = process.env) {
  const baseUrl = (env.TREES_LLM_BASE_URL || '').replace(/\/+$/, '');
  const apiKey = env.TREES_LLM_API_KEY || '';
  const model = env.TREES_LLM_MODEL || '';
  const timeoutMs = Number(env.TREES_LLM_TIMEOUT_MS) || 60000;
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl, apiKey, model, timeoutMs };
}

/**
 * 配置文件 + 环境变量，合并后返回（环境变量优先）。
 *
 * 定时任务读不到你在终端 export 的变量，所以「自然生长」跑的时候靠的是
 * `<TREES_HOME>/config.json` 里那份。
 *
 * @param {object} [env]
 * @returns {Promise<object|null>}
 */
export async function loadLlmConfig(env = process.env) {
  const file = await readConfig();
  const apiKey = env.TREES_LLM_API_KEY
    || (file.apiKeyEnv ? env[file.apiKeyEnv] : '')
    || file.apiKey
    || '';
  const merged = {
    baseUrl: (env.TREES_LLM_BASE_URL || file.baseUrl || '').replace(/\/+$/, ''),
    apiKey,
    model: env.TREES_LLM_MODEL || file.model || '',
    timeoutMs: Number(env.TREES_LLM_TIMEOUT_MS) || Number(file.timeoutMs) || 60000,
  };
  if (!merged.baseUrl || !merged.apiKey || !merged.model) return null;
  return merged;
}

/**
 * 发一次对话请求。
 *
 * @param {{messages:Array<{role:string,content:string}>, maxTokens?:number,
 *          config?:object, env?:object, fetchImpl?:Function}} opts
 * @returns {Promise<{text:string, usage:object|null, model:string}>}
 */
/** 把 SSE 数据流读成完整文本，并记录结束标记 finish_reason。 */
async function readSse(res, fallbackModel) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finish = null;
  let usage = null;
  let model = fallbackModel;

  const consume = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let obj;
    try { obj = JSON.parse(payload); } catch { return; }
    if (obj.model) model = obj.model;
    if (obj.usage) usage = obj.usage;
    const choice = (obj.choices || [])[0];
    if (!choice) return;
    if (typeof choice.delta?.content === 'string') text += choice.delta.content;
    if (choice.finish_reason) finish = choice.finish_reason;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      consume(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer) consume(buffer);
  return { text, finish, usage, model };
}

/**
 * 发一次对话请求。默认走流式，并校验结束标记 ——
 * 非流式长请求很容易被中转站掐断，收到半截却不知道（见种子 seed-0004）。
 *
 * @param {{messages:Array<{role:string,content:string}>, maxTokens?:number,
 *          config?:object, env?:object, fetchImpl?:Function, stream?:boolean}} opts
 * @returns {Promise<{text:string, usage:object|null, model:string}>}
 */
export async function chat(opts) {
  const cfg = opts.config ?? await loadLlmConfig(opts.env);
  if (!cfg) {
    throw new Error(
      '没有配置模型。设好这三个环境变量再跑：\n'
      + '  TREES_LLM_BASE_URL  TREES_LLM_API_KEY  TREES_LLM_MODEL\n'
      + '（用你手头最便宜的那个就行，学习这活不需要贵模型）'
    );
  }

  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('当前 Node 没有全局 fetch，需要 Node >= 18');
  }

  const stream = opts.stream !== false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await doFetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? 4000,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`模型接口返回 ${res.status}：${body.slice(0, 300)}`);
    }

    if (!stream || !res.body) {
      const data = await res.json();
      const choice = (data.choices || [])[0] || {};
      if (choice.finish_reason === 'length') {
        throw new Error('模型输出被截断（finish_reason=length）—— 调大 maxTokens 或把任务拆小');
      }
      return {
        text: choice.message?.content ?? '',
        usage: data.usage ?? null,
        model: data.model ?? cfg.model,
      };
    }

    const out = await readSse(res, cfg.model);
    if (out.finish === 'length') {
      throw new Error('模型输出被截断（finish_reason=length）—— 调大 maxTokens 或把任务拆小');
    }
    if (!out.finish) {
      throw new Error('流式响应没有结束标记（finish_reason）—— 连接可能被中转站掐断，请重试');
    }
    return { text: out.text, usage: out.usage, model: out.model };
  } finally {
    clearTimeout(timer);
  }
}

/** 当前配置的摘要（给 `trees dream --config` 用，不打印 key）。 */
export async function describeConfig(env = process.env) {
  const cfg = await loadLlmConfig(env);
  if (!cfg) {
    return {
      configured: false,
      hint: 'TREES_LLM_BASE_URL / TREES_LLM_API_KEY / TREES_LLM_MODEL 三个都要设',
    };
  }
  return {
    configured: true,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey ? `已设置（${cfg.apiKey.length} 字符）` : '未设置',
  };
}
