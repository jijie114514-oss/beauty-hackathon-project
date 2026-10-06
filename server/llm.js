/**
 * LLM 传输层 + 计量层
 * ------------------------------------------------------------------
 * 职责边界（本轮改造后的定位）：
 *   - 只负责「把请求发出去、把结果拿回来、把成本记下来」。
 *   - **不负责**决定用不用模型 —— 那是 semantic/index.js 的路由决策。
 *
 * 计量：每次调用记录 task / model / input tokens / output tokens / latency / cacheHit。
 * 缓存：以 (task + 完整输入) 的哈希为键。同一份历史上下文不重复分析，
 *       这是本项目最主要的 Token 节约机制。
 *
 * 兼容 OpenAI Chat Completions 协议：DashScope(Qwen) / vLLM / Ollama / SGLang。
 */

import { createHash } from 'node:crypto';

/* ═══════════════ 语义任务枚举 ═══════════════ */

export const TASK = {
  EVENT_EXTRACTION: 'event_extraction',
  PROMISE_CLASSIFICATION: 'promise_classification',
  CURRENT_NEED: 'current_need',
  ESCALATION_REASONING: 'escalation_reasoning',
  REPLY_GENERATION: 'reply_generation',
  ACTION_PLANNING: 'action_planning',
};
export const TASKS = Object.values(TASK);

/**
 * 语义引擎运行模式 —— 三组对比实验的开关。
 *   hybrid      LLM 优先，失败/未配置时回落确定性引擎（默认）
 *   llm_only    只用 LLM，禁止回落（用于评估 LLM 单独表现）
 *   rule_only   只用确定性引擎（用于评估规则基线，也是零 Key 演示模式）
 */
const VALID_MODES = ['hybrid', 'llm_only', 'rule_only'];

/* ═══════════════ 配置与状态 ═══════════════ */

const state = {
  enabled: false,
  baseUrl: process.env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.LLM_API_KEY || '',
  model: process.env.LLM_MODEL || 'qwen-plus',
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 20000),
  mode: VALID_MODES.includes(process.env.SEMANTIC_MODE) ? process.env.SEMANTIC_MODE : 'hybrid',
  lastError: null,
  lastLatencyMs: null,
};

if (state.apiKey) state.enabled = true;

/* ═══════════════ 计量与缓存 ═══════════════ */

const stats = {
  calls: 0,
  failures: 0,
  cacheHits: 0,
  inputTokens: 0,
  outputTokens: 0,
  latencyMs: 0,
  byTask: {},
};

const callLog = [];
const CACHE = new Map();
const CACHE_MAX = 500;

function bumpTask(task) {
  if (!stats.byTask[task]) {
    stats.byTask[task] = { calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0, cacheHits: 0, failures: 0 };
  }
  return stats.byTask[task];
}

export function getStats() {
  return {
    ...stats,
    byTask: JSON.parse(JSON.stringify(stats.byTask)),
    log: callLog.slice(-200),
    cacheSize: CACHE.size,
    mode: state.mode,
  };
}

export function resetStats() {
  stats.calls = 0;
  stats.failures = 0;
  stats.cacheHits = 0;
  stats.inputTokens = 0;
  stats.outputTokens = 0;
  stats.latencyMs = 0;
  stats.byTask = {};
  callLog.length = 0;
  CACHE.clear();
}

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);

/**
 * 粗略估算 token 数。
 * 仅在服务端**未返回** usage 时兜底使用（中文约 1 字 ≈ 0.7 token，英文约 4 字符 ≈ 1 token）。
 * 真实 token 一律以 API 返回的 usage 为准。
 */
export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk * 0.7 + rest / 4);
}

/* ═══════════════ 设置 ═══════════════ */

export function getSettings() {
  return {
    enabled: state.enabled,
    baseUrl: state.baseUrl,
    model: state.model,
    hasApiKey: Boolean(state.apiKey),
    timeoutMs: state.timeoutMs,
    mode: state.mode,
    lastError: state.lastError,
    lastLatencyMs: state.lastLatencyMs,
    calls: stats.calls,
  };
}

export function updateSettings(patch = {}) {
  if (typeof patch.enabled === 'boolean') state.enabled = patch.enabled;
  if (patch.baseUrl) state.baseUrl = String(patch.baseUrl).replace(/\/$/, '');
  if (typeof patch.model === 'string' && patch.model) state.model = patch.model;
  if (typeof patch.apiKey === 'string') {
    state.apiKey = patch.apiKey;
    if (patch.apiKey) state.enabled = true;
  }
  if (typeof patch.timeoutMs === 'number') state.timeoutMs = patch.timeoutMs;
  if (VALID_MODES.includes(patch.mode)) state.mode = patch.mode;
  state.lastError = null;
  return getSettings();
}

export const isLLMEnabled = () => state.enabled && Boolean(state.apiKey);
export const getMode = () => state.mode;

/* ═══════════════ 传输 ═══════════════ */

/**
 * 底层调用。失败一律抛错，由 semantic 层决定是否回落。
 * @returns {{text:string, usage:{input:number,output:number}, latencyMs:number, model:string}}
 */
export async function chat({ system, user, json = false, maxTokens = 800, task = 'unknown' }) {
  if (!isLLMEnabled()) throw new Error('LLM_DISABLED');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), state.timeoutMs);
  const startedAt = Date.now();

  try {
    const res = await fetch(`${state.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.apiKey}`,
      },
      body: JSON.stringify({
        model: state.model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
        temperature: 0.1,
        max_tokens: maxTokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`LLM_HTTP_${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    const latencyMs = Date.now() - startedAt;

    const input = data?.usage?.prompt_tokens ?? estimateTokens(`${system || ''}${user}`);
    const output = data?.usage?.completion_tokens ?? estimateTokens(text);

    stats.calls += 1;
    stats.inputTokens += input;
    stats.outputTokens += output;
    stats.latencyMs += latencyMs;
    const t = bumpTask(task);
    t.calls += 1;
    t.inputTokens += input;
    t.outputTokens += output;
    t.latencyMs += latencyMs;

    state.lastLatencyMs = latencyMs;
    state.lastError = null;

    callLog.push({
      at: new Date().toISOString(),
      task,
      model: state.model,
      inputTokens: input,
      outputTokens: output,
      latencyMs,
      cacheHit: false,
      ok: true,
    });

    return { text, usage: { input, output }, latencyMs, model: state.model };
  } catch (err) {
    stats.failures += 1;
    bumpTask(task).failures += 1;
    state.lastError = err.name === 'AbortError' ? 'LLM_TIMEOUT' : String(err.message || err);
    callLog.push({
      at: new Date().toISOString(),
      task,
      model: state.model,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startedAt,
      cacheHit: false,
      ok: false,
      error: state.lastError,
    });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 请求 JSON 并安全解析 */
export async function chatJSON(opts) {
  const r = await chat({ ...opts, json: true });
  const cleaned = String(r.text).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('LLM_BAD_JSON');
    parsed = JSON.parse(m[0]);
  }
  return { value: parsed, usage: r.usage, latencyMs: r.latencyMs, model: r.model };
}

/**
 * 带缓存的调用。同一 (task + 输入) 不重复请求模型。
 * 这是 Token 节约机制的核心实现。
 */
export async function chatCached({ task, system, user, json = false, maxTokens = 800 }) {
  const key = `${task}::${hash(`${system || ''}\u0000${user}`)}`;
  if (CACHE.has(key)) {
    stats.cacheHits += 1;
    bumpTask(task).cacheHits += 1;
    callLog.push({ at: new Date().toISOString(), task, cacheHit: true, ok: true, inputTokens: 0, outputTokens: 0, latencyMs: 0 });
    return { ...CACHE.get(key), cacheHit: true };
  }
  const r = json ? await chatJSON({ system, user, maxTokens, task }) : await chat({ system, user, maxTokens, task });
  const normalized = json ? { value: r.value, usage: r.usage, latencyMs: r.latencyMs, model: r.model } : { value: r.text, usage: r.usage, latencyMs: r.latencyMs, model: r.model };
  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(key, normalized);
  return { ...normalized, cacheHit: false };
}

/** 向后兼容：旧的 enhance 语义 */
export async function enhance({ system, user, fallback, maxTokens = 800, task = 'unknown' }) {
  if (!isLLMEnabled()) return { value: fallback, source: 'deterministic' };
  try {
    const r = await chat({ system, user, maxTokens, task });
    const text = String(r.text || '').trim();
    if (!text) return { value: fallback, source: 'deterministic' };
    return { value: text, source: 'llm', model: state.model };
  } catch {
    return { value: fallback, source: 'deterministic' };
  }
}
