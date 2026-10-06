/**
 * Service Memory Agent —— 中央数据层构建
 * ------------------------------------------------------------------
 * 职责（本轮改造后的定位）：
 *   1. 调用语义层把「原始多源数据」抽取成结构化 Service Events；
 *   2. 用 schema.buildServiceMemory 组装成中央数据层对象；
 *   3. **缓存**：同一份原始上下文只抽取一次，后续 Agent 只读 Memory。
 *      —— 这是本项目最主要的 Token 节约机制。
 *
 * 它不再自己解析聊天，也不再自己写业务规则。
 */

import { createHash } from 'node:crypto';
import { buildServiceMemory, makeEvent, EVENT_TYPE, EVENT_STATUS, SOURCE, CONFIDENCE } from '../schema.js';
import { runEventExtraction } from '../semantic/index.js';
import { getMode } from '../llm.js';
import { fmtDateTime } from '../utils/date.js';

/* ── 记忆缓存：Raw History → 一次抽取 → 复用 ─────────────── */
const MEMORY_CACHE = new Map();
const CACHE_MAX = 200;

export const getMemoryCacheStats = () => ({ size: MEMORY_CACHE.size, max: CACHE_MAX });
export const clearMemoryCache = () => MEMORY_CACHE.clear();

/**
 * 上下文指纹：只要订单 / 工单 / 会话 / 系统事件任一发生变化，指纹就变。
 * 这样「Tool 执行 → 业务状态变化」会自动让缓存失效并触发重算，
 * 而重复分析同一个未变化的会话则完全命中缓存、零 Token 消耗。
 */
function fingerprint(ctx) {
  const raw = JSON.stringify({
    c: ctx.consumer.id,
    o: ctx.orders.map((o) => [o.id, o.shipStatus, o.refundStatus, o.reshipStatus]),
    t: ctx.tickets.map((t) => [t.id, t.status, t.incidentLogged ?? null, (t.records || []).length]),
    s: ctx.sessions.map((s) => [s.id, s.messages.length, s.messages.map((m) => m.id).join('')]),
    e: ctx.systemEvents.map((e) => e.id),
  });
  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

/**
 * 构建中央数据层。
 * @param {object} ctx store.contextOf(consumerId)
 * @param {string} currentMessage 当前消费者消息
 * @param {object} [deps] 由 orchestrator 注入的下游结果（risk / actions），用于回填
 */
export async function serviceMemoryAgent(ctx, currentMessage, deps = {}) {
  const fp = fingerprint(ctx);
  const cacheKey = `${ctx.consumer.id}::${fp}::${getMode()}`;

  let extraction;
  let cacheHit = false;
  if (MEMORY_CACHE.has(cacheKey)) {
    extraction = MEMORY_CACHE.get(cacheKey);
    cacheHit = true;
  } else {
    extraction = await runEventExtraction(ctx, deps.promiseResult?.utterances || null);
    if (MEMORY_CACHE.size >= CACHE_MAX) MEMORY_CACHE.delete(MEMORY_CACHE.keys().next().value);
    MEMORY_CACHE.set(cacheKey, extraction);
  }

  const events = [...extraction.value];

  /**
   * 安全兜底：消费者**本次**消息里自述使用后不适时，必须产生一条敏感事件。
   *
   * 为什么需要：敏感事件此前只从「历史工单」投影而来，导致**首次**反馈不适的
   * 消费者不会产生任何未解决项，根因被误判为常规咨询，安全流程也不会有未解决项可收口。
   * 这是合规底线，因此不依赖模型是否抽到，直接由规则补齐。
   */
  if (deps.need?.sensitive?.isSensitive) {
    const hasOpen = events.some(
      (e) => e.type === EVENT_TYPE.SENSITIVE_BEAUTY_INCIDENT && e.status !== EVENT_STATUS.RESOLVED,
    );
    if (!hasOpen) {
      events.push(makeEvent({
        type: EVENT_TYPE.SENSITIVE_BEAUTY_INCIDENT,
        subtype: 'current_report',
        time: ctx.now,
        source: SOURCE.CHAT,
        source_id: '当前会话',
        status: EVENT_STATUS.OPEN,
        confidence: CONFIDENCE.HIGH,
        evidence: `消费者自述使用后不适：${deps.need.sensitive.hits.join('、')}。原文：${currentMessage || ''}`,
        structured_data: { symptoms: deps.need.sensitive.hits, target_order: ctx.orders[0]?.id || null },
        meta: {
          title: '本次反馈疑似产品不适（未登记）',
          detail: `消费者自述${deps.need.sensitive.hits.join('、')}，尚未登记为产品不适事件，需按安全流程处理。`,
          severity: 'HIGH',
        },
      }));
    }
  }

  const memory = buildServiceMemory({
    caseId: `CASE_${ctx.consumer.id}`,
    customerId: ctx.consumer.id,
    now: ctx.now,
    events,
    currentNeed: {
      raw_message: currentMessage || '',
      surface_issue: deps.need?.surface_issue || null,
      real_need: deps.need?.real_need || null,
      constraints: deps.need?.constraints || [],
      urgency: deps.need?.urgency || null,
    },
    riskFlags: deps.riskFlags || [],
    recommendedActions: deps.recommendedActions || [],
    narrative: [],
    llmTrace: { extraction_source: extraction.source, memory_cache_hit: cacheHit },
  });

  memory.narrative = buildNarrative(ctx, memory);
  memory.counts = {
    events: memory.events.length,
    unresolved: memory.unresolved_issues.length,
    high: memory.unresolved_issues.filter((u) => u.severity === 'HIGH').length,
  };

  return { memory, extractionSource: extraction.source, cacheHit };
}

/** 面向人工客服的自然语言叙事 —— 由事件推导，不含场景专用文案 */
function buildNarrative(ctx, memory) {
  const lines = [];
  const contacts = memory.events.filter(
    (e) => e.type === EVENT_TYPE.USER_ISSUE && String(e.meta.title || '').includes('进线'),
  );
  if (contacts.length > 1) {
    lines.push(`该消费者历史共进线 ${contacts.length} 次，最近一次为当前会话。`);
  }

  const wrong = memory.events.find((e) => e.type === EVENT_TYPE.WRONG_SKU);
  if (wrong) lines.push(`${fmtDateTime(wrong.time)}：${wrong.evidence}。`);

  const push = memory.events.find((e) => e.subtype === 'product_push');
  if (push) lines.push(`${fmtDateTime(push.time)} 系统侧事件：${push.evidence}`);

  const promises = memory.events.filter((e) => e.type === EVENT_TYPE.SERVICE_PROMISE);
  for (const p of promises.slice(-3)) {
    lines.push(
      `客服于 ${fmtDateTime(p.time)} 承诺${p.raw?.subjectLabel || p.subtype || ''}` +
      `（时限：${p.structured_data.deadline_label || '未明确'}）：${p.evidence}`,
    );
  }
  const un = promises.find((p) => p.status === EVENT_STATUS.UNFULFILLED);
  if (un) lines.push(`核验结果：${un.verification?.conclusion}`);

  const ok = promises.find((p) => p.status === EVENT_STATUS.FULFILLED);
  if (ok) lines.push(`（对照）该消费者此前同类承诺已正常兑现：${ok.evidence}`);

  return lines;
}
