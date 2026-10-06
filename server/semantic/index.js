/**
 * Semantic Router —— 语义任务调度
 * ------------------------------------------------------------------
 * 系统里**所有**语义理解都必须经过这里，不允许 Agent 自己判断用不用模型。
 *
 * 三种模式（对应评估实验的三组对比）：
 *   rule_only  → 全部走确定性引擎（规则基线，零 Key 可跑）
 *   llm_only   → 全部走 LLM，失败即失败，不回落（评估模型真实水平）
 *   hybrid     → LLM 优先，失败/未配置回落确定性引擎（生产默认）
 *
 * 每个任务的返回值都带 source 字段，说明这次判断到底由谁做出：
 *   'llm' | 'deterministic'
 * 这个字段会一路透传到前端与评估报告，保证「可解释」。
 */

import { isLLMEnabled, getMode, TASK, chatCached, getStats, resetStats, estimateTokens } from '../llm.js';
import { PROMPTS } from './prompts.js';
import * as det from './deterministic.js';
import { makeEvent, EVENT_TYPES, EVENT_TYPE, SUBJECTS } from '../schema.js';

export { getStats as getSemanticStats, resetStats as resetSemanticStats, estimateTokens };

const trace = [];
export const getTrace = () => trace.slice(-100);
export const clearTrace = () => { trace.length = 0; };

function record(task, source, extra = {}) {
  const entry = { at: new Date().toISOString(), task, source, ...extra };
  trace.push(entry);
  return entry;
}

/**
 * 统一执行器：按模式决定走 LLM 还是确定性引擎。
 * @param {string} task TASK.*
 * @param {object} args
 * @param {string} args.user LLM 的 user 输入
 * @param {Function} args.deterministic 确定性实现，返回结果对象
 * @param {Function} [args.parse] 把 LLM 原始 JSON 转成与 deterministic 同构的结果
 * @param {number} [args.maxTokens]
 */
async function run(task, { user, deterministic, parse, maxTokens = 1200 }) {
  const mode = getMode();
  const prompt = PROMPTS[task];

  const useLLM = mode !== 'rule_only' && isLLMEnabled();
  if (!useLLM) {
    const value = deterministic();
    record(task, 'deterministic', { reason: mode === 'rule_only' ? 'mode=rule_only' : 'llm_unavailable' });
    return { value, source: 'deterministic', mode };
  }

  try {
    const r = await chatCached({
      task,
      system: `${prompt.system}\n\n输出 JSON 结构：\n${prompt.schema}`,
      user,
      json: true,
      maxTokens,
    });
    const value = parse ? parse(r.value) : r.value;
    record(task, 'llm', { cacheHit: r.cacheHit, inputTokens: r.usage?.input, outputTokens: r.usage?.output, latencyMs: r.latencyMs });
    return { value, source: 'llm', mode, usage: r.usage, cacheHit: r.cacheHit, latencyMs: r.latencyMs };
  } catch (err) {
    if (mode === 'llm_only') {
      record(task, 'llm', { error: String(err.message || err) });
      throw err;
    }
    const value = deterministic();
    record(task, 'deterministic', { reason: `llm_error: ${String(err.message || err).slice(0, 80)}` });
    return { value, source: 'deterministic-fallback', mode, error: String(err.message || err) };
  }
}

/* ═══════════════ 1. 事件抽取 ═══════════════ */

export async function runEventExtraction(ctx, preclassified = null) {
  const deterministic = () => det.extractEvents(ctx, preclassified);
  /* 会话侧事件一律由话术分类结果投影（权威来源），LLM 抽取只负责订单 / 工单 / 系统侧 */
  const chatEvents = () => det.extractEvents(ctx, preclassified).filter((e) => e.source === 'chat');

  /* 给模型一份紧凑的原始材料，避免把整个 ctx 序列化进去。
     会话原文不再重复喂给模型 —— 客服话术的分类已由上游任务完成，
     这既保证了两处判断的一致性，也显著降低 Token 消耗。 */
  const material = {
    订单: ctx.orders.map((o) => ({
      id: o.id, type: o.type, items: o.items, amount: o.amount,
      createdAt: o.createdAt, deliveredAt: o.deliveredAt,
      shipStatus: o.shipStatus, refundStatus: o.refundStatus, reshipmentStatus: o.reshipStatus,
      receivedSku: o.receivedSku || null,
    })),
    工单: ctx.tickets.map((t) => ({
      id: t.id, type: t.type, title: t.title, status: t.status,
      createdAt: t.createdAt, result: t.result, incidentLogged: t.incidentLogged ?? null,
      records: (t.records || []).map((r) => ({ at: r.at, actor: r.actor, note: r.note })),
    })),
    系统事件: ctx.systemEvents.map((e) => ({ id: e.id, at: e.at, type: e.type, detail: e.detail })),
    当前时间: ctx.now,
  };

  return run(TASK.EVENT_EXTRACTION, {
    user:
      `请从以下「订单 / 工单 / 系统事件」材料中抽取服务事件。\n` +
      `注意：客服话术（service_promise / estimated_timeline / service_action）与消费者进线（user_issue）` +
      `已由上游任务完成分类，**不需要你重复抽取**，请只关注订单、工单、系统数据。\n` +
      JSON.stringify(material),
    deterministic,
    maxTokens: 2200,
    parse: (raw) => {
      const list = Array.isArray(raw?.events) ? raw.events : [];
      const fromLLM = list
        .filter((e) => EVENT_TYPES.includes(e.type))
        /* 丢弃模型对会话侧事件的判断，改由分类结果投影，避免两处判断打架 */
        .filter((e) => e.source !== 'chat' && !['service_promise', 'estimated_timeline', 'service_action'].includes(e.type))
        .map((e) => makeEvent({
          type: e.type,
          subtype: e.subtype || null,
          time: e.time,
          source: e.source,
          source_id: e.source_id,
          status: e.status,
          confidence: e.confidence,
          evidence: e.evidence,
          structured_data: {
            action: SUBJECTS.includes(e.structured_data?.action) ? e.structured_data.action : null,
            deadline: e.structured_data?.deadline || null,
            target_order: e.structured_data?.target_order || null,
            target_sku: e.structured_data?.target_sku || null,
          },
          raw: { via: 'llm' },
          meta: { title: e.evidence?.slice(0, 40) || e.type, detail: e.evidence || '', severity: 'MEDIUM' },
        }));

      const merged = [...fromLLM, ...chatEvents()];

      /* 安全兜底：敏感美妆事件属于合规底线，**不允许因模型漏抽而消失**。
         确定性投影是字段驱动的，比模型可靠，因此这里做一次并集补齐。 */
      const detAll = det.extractEvents(ctx, preclassified);
      for (const e of detAll) {
        if (e.type !== EVENT_TYPE.SENSITIVE_BEAUTY_INCIDENT) continue;
        const exists = merged.some((x) => x.type === e.type && x.source_id === e.source_id);
        if (!exists) merged.push(e);
      }

      if (!merged.length) throw new Error('LLM_EMPTY_EVENTS');
      return merged;
    },
  });
}

/* ═══════════════ 2. 承诺分类 ═══════════════ */

export async function runPromiseClassification(text, atISO) {
  return run(TASK.PROMISE_CLASSIFICATION, {
    user: `客服话术：「${text}」\n这句话的发生时间：${atISO}`,
    deterministic: () => detClassify(text, atISO),
    maxTokens: 400,
    parse: (raw) => parseClassification(raw, text, atISO),
  });
}

/** 单条确定性分类（供批量兜底复用） */
function detClassify(text, atISO) {
  const cls = det.classifyUtterance(text, atISO);
  const { subject } = det.detectSubject(text);
  const deadline = cls.category === 'PROMISE' || cls.category === 'ESTIMATE' ? det.parseDeadline(text, atISO) : null;
  return { category: cls.category, subject, deadline_text: deadline?.raw || null, deadline, reason: cls.reason, matched: cls.matched, confidence: 'medium' };
}

function parseClassification(raw, text, atISO) {
  const allowed = ['PROMISE', 'ESTIMATE', 'ACTION', 'EXPLANATION', 'NONE'];
  if (!allowed.includes(raw?.category)) throw new Error('LLM_BAD_CATEGORY');
  const subject = SUBJECTS.includes(raw.subject) ? raw.subject : det.detectSubject(text).subject;
  const deadline = (raw.category === 'PROMISE' || raw.category === 'ESTIMATE') ? det.parseDeadline(text, atISO) : null;
  return {
    category: raw.category,
    subject,
    deadline_text: raw.deadline_text || null,
    deadline,
    reason: raw.reason || '',
    matched: [],
    confidence: raw.confidence || 'medium',
  };
}

/**
 * 批量话术分类 —— **Token 节约的关键优化**。
 * 逐条分类会让调用次数随历史话术条数线性增长（一次分析 8 条 → 8 次请求）。
 * 这里合并成 1 次请求，输入共用同一份系统提示词，输出是一个数组。
 *
 * @param {Array<{key:string, text:string, at:string}>} items
 * @returns {Promise<Map<string, {value:object, source:string}>>}
 */
export async function runPromiseClassificationBatch(items) {
  const out = new Map();
  if (!items.length) return out;

  const mode = getMode();
  const useLLM = mode !== 'rule_only' && isLLMEnabled();

  const fallbackAll = () => {
    for (const it of items) out.set(it.key, { value: detClassify(it.text, it.at), source: 'deterministic' });
  };

  if (!useLLM) {
    fallbackAll();
    record(TASK.PROMISE_CLASSIFICATION, 'deterministic', { reason: mode === 'rule_only' ? 'mode=rule_only' : 'llm_unavailable', batch: items.length });
    return out;
  }

  const prompt = PROMPTS[TASK.PROMISE_CLASSIFICATION];
  const user =
    `请对以下 ${items.length} 条客服话术逐条分类，按输入顺序返回：\n` +
    JSON.stringify(items.map((it, i) => ({ idx: i, text: it.text, at: it.at }))) +
    `\n\n输出 JSON：{"results":[{"idx":0,"category":"...","subject":"...","deadline_text":"...","reason":"...","confidence":"..."}]}`;

  try {
    const r = await chatCached({
      task: TASK.PROMISE_CLASSIFICATION,
      system: `${prompt.system}\n\n输出 JSON 结构：\n{"results":[${prompt.schema.replace(/\{|\}/g, '').trim()}]}`,
      user,
      json: true,
      maxTokens: 300 + items.length * 160,
    });
    const list = Array.isArray(r.value?.results) ? r.value.results : [];
    if (!list.length) throw new Error('LLM_EMPTY_BATCH');
    const byIdx = new Map(list.map((x) => [Number(x.idx), x]));
    for (let i = 0; i < items.length; i += 1) {
      const raw = byIdx.get(i);
      const it = items[i];
      if (!raw) {
        out.set(it.key, { value: detClassify(it.text, it.at), source: 'deterministic-fallback' });
        continue;
      }
      try {
        out.set(it.key, { value: parseClassification(raw, it.text, it.at), source: 'llm' });
      } catch {
        out.set(it.key, { value: detClassify(it.text, it.at), source: 'deterministic-fallback' });
      }
    }
    record(TASK.PROMISE_CLASSIFICATION, 'llm', { batch: items.length, cacheHit: r.cacheHit, inputTokens: r.usage?.input, outputTokens: r.usage?.output, latencyMs: r.latencyMs });
    return out;
  } catch (err) {
    if (mode === 'llm_only') {
      record(TASK.PROMISE_CLASSIFICATION, 'llm', { batch: items.length, error: String(err.message || err) });
      throw err;
    }
    fallbackAll();
    record(TASK.PROMISE_CLASSIFICATION, 'deterministic', { batch: items.length, reason: `llm_error: ${String(err.message || err).slice(0, 80)}` });
    return out;
  }
}

/* ═══════════════ 3. 当前诉求 ═══════════════ */

export async function runCurrentNeed(currentMessage, ctx) {
  const history = ctx.sessions
    .filter((s) => !s.isCurrent)
    .flatMap((s) => s.messages.filter((m) => m.role === 'consumer'))
    .slice(-6)
    .map((m) => m.text);

  return run(TASK.CURRENT_NEED, {
    user: `当前消息：「${currentMessage}」\n近期历史消息：${JSON.stringify(history)}\n消费者画像：${JSON.stringify({ skinProfile: ctx.consumer.skinProfile, tags: ctx.consumer.tags })}`,
    deterministic: () => det.inferNeed(currentMessage, ctx),
    maxTokens: 600,
    parse: (raw) => {
      const base = det.inferNeed(currentMessage, ctx); // 情绪等级与敏感词一律以确定性结果为准（禁止模型改等级）
      const allowedEmotion = ['正常', '不满', '愤怒', '高度激动'];
      const emotionLevel = allowedEmotion.includes(raw?.emotion) ? raw.emotion : base.emotion.level;
      return {
        ...base,
        surface_issue: raw?.surface_issue || base.surface_issue,
        real_need: raw?.real_need || base.real_need,
        constraints: Array.isArray(raw?.constraints) && raw.constraints.length ? raw.constraints : base.constraints,
        urgency: ['high', 'medium', 'low'].includes(raw?.urgency) ? raw.urgency : base.urgency,
        emotion: { ...base.emotion, level: emotionLevel },
        source: 'llm+deterministic',
      };
    },
  });
}

/* ═══════════════ 4. 升级归因 ═══════════════ */

export async function runEscalationReasoning({ memory, need, ctx, validations }) {
  return run(TASK.ESCALATION_REASONING, {
    user:
      `当前消息：「${need.surface_issue}」\n` +
      `真实诉求：${need.real_need}\n` +
      `未解决事项：${JSON.stringify(memory.unresolved_issues.map((u) => ({ id: u.issue_id, kind: u.kind, title: u.title, detail: u.detail })))}\n` +
      `Service Events：${JSON.stringify(memory.events.map((e) => ({ event_id: e.event_id, type: e.type, subtype: e.subtype, time: e.time, status: e.status, evidence: e.evidence, verification: e.verification?.conclusion || null })))}\n` +
      `业务真实状态：${JSON.stringify((validations?.checks || []).map((c) => ({ label: c.label, value: c.value })))}`,
    deterministic: () => det.reasonEscalation({ memory, need, ctx, validations }),
    maxTokens: 900,
    parse: (raw) => {
      const base = det.reasonEscalation({ memory, need, ctx, validations });
      const validIds = new Set(memory.events.map((e) => e.event_id));
      const ids = Array.isArray(raw?.evidence_event_ids) ? raw.evidence_event_ids.filter((id) => validIds.has(id)) : [];
      return {
        ...base,
        primary_reason: raw?.primary_reason || base.rootCause,
        rootCauseLabel: raw?.primary_reason || base.rootCauseLabel,
        currentIssue: raw?.current_issue || base.currentIssue,
        secondary_reasons: Array.isArray(raw?.secondary_reasons) && raw.secondary_reasons.length ? raw.secondary_reasons : base.secondary_reasons,
        /* 证据 ID 必须是真实存在的 event_id，否则丢弃 —— 防止模型编造 */
        evidence_event_ids: ids.length ? ids : base.evidence_event_ids,
        comparison: Array.isArray(raw?.comparison) && raw.comparison.length
          ? raw.comparison.map((c) => ({ dimension: c.dimension, consumerBelief: c.consumer_belief, systemTruth: c.system_truth, gap: true }))
          : base.comparison,
        summary: `${raw?.primary_reason || base.rootCauseLabel}。${(raw?.secondary_reasons || base.secondary_reasons).join('；')}`,
        source: 'llm+deterministic',
      };
    },
  });
}

/* ═══════════════ 5. 回复生成 ═══════════════ */

export async function runReplyGeneration({ ctx, memory, need, escalation, validations, actions, facts }) {
  const fallback = () => det.composeReply({ ctx, memory, need, escalation, validations, actions });

  const surface = need.surfaceIssue?.text || need.surface_issue || '';
  const realNeed = need.realNeed?.text || need.real_need || '';
  const constraintLabels = (need.constraints || []).map((c) => (typeof c === 'string' ? c : c.label)).filter(Boolean);

  return run(TASK.REPLY_GENERATION, {
    user:
      `【消费者】${ctx.consumer.name}（${ctx.consumer.level}）\n` +
      `【当前消息】${memory.current_need?.raw_message || surface}\n` +
      `【真实诉求】${realNeed}\n` +
      `【约束】${constraintLabels.join('、') || '无'}\n` +
      `【已核验事实】\n${(facts || []).map((f) => `- [${f.source}] ${f.text}`).join('\n')}\n` +
      `【升级根因】${escalation.rootCauseLabel}\n` +
      `【准备执行的动作】${(actions || []).map((a) => a.title).join(' / ') || '无'}\n` +
      `【禁止事项】不得新增事实；不得承诺字段中没有的时间；不得空泛道歉；不得做医学判断。`,
    deterministic: fallback,
    maxTokens: 800,
    parse: (raw) => {
      const text = String(raw?.reply || '').trim();
      if (!text) throw new Error('LLM_EMPTY_REPLY');
      return { text, source: 'llm' };
    },
  });
}

/* ═══════════════ 6. 动作规划 ═══════════════ */

export async function runActionPlanning({ ctx, memory, need, validations, guardrails, availableTools, deterministicPlan }) {
  return run(TASK.ACTION_PLANNING, {
    user:
      `【未解决事项】${JSON.stringify(memory.unresolved_issues.map((u) => ({ kind: u.kind, title: u.title, detail: u.detail, severity: u.severity })))}\n` +
      `【已核验业务事实】${JSON.stringify((validations?.checks || []).map((c) => ({ label: c.label, value: c.value })))}\n` +
      `【消费者诉求】${need.real_need}\n` +
      `【消费者城市】${ctx.consumer.city}\n` +
      `【可用工具】${JSON.stringify(availableTools)}\n` +
      `【安全护栏】${JSON.stringify(guardrails)}`,
    deterministic: deterministicPlan,
    maxTokens: 1200,
    parse: (raw) => {
      /* 空动作列表是**合法答案**（例如常规咨询确实无需额外动作），
         不应被当作失败 —— 否则会掩盖真正的模型能力表现。
         只有「结构不对」才抛错。 */
      if (!raw || !Array.isArray(raw.actions)) throw new Error('LLM_BAD_ACTIONS_SHAPE');
      const list = raw.actions;
      const names = new Set(availableTools.map((t) => t.name));
      const mapped = list
        .filter((a) => names.has(a.tool))
        .slice(0, 3)
        .map((a, i) => ({
          id: `A${i + 1}`,
          priority: i + 1,
          kind: a.kind === 'write' ? 'write' : 'read',
          title: a.title || a.tool,
          reason: a.reason || '',
          tools: [{ name: a.tool, params: a.params || {} }],
          expectedOutcome: a.expected_outcome || '',
          riskIfSkipped: a.risk_if_skipped || '',
          requiresConfirmation: a.kind === 'write',
          source: 'llm',
        }));
      return mapped;
    },
  });
}
