/**
 * Service Event Schema —— 系统中央数据层的唯一契约
 * ------------------------------------------------------------------
 * 设计立场：
 *   业务状态**不允许**塞进自由文本。所有跨数据源的事实都必须被投影成
 *   结构化的 Service Event，由它承载「谁、什么时候、承诺了什么、时限、
 *   目标对象、证据、置信度」。后续所有 Agent（Escalation / Risk / Planner /
 *   Reply）只读 Service Memory，不再各自回头解析原始聊天。
 *
 * 这一层是「LLM 语义抽取」与「规则 Validator」之间的交换格式：
 *   LLM 产出 events → Validator 用业务数据核验 events → 下游消费核验结果。
 */

/* ═══════════════ 枚举定义 ═══════════════ */

export const EVENT_TYPE = {
  USER_ISSUE: 'user_issue',
  SERVICE_PROMISE: 'service_promise',
  ESTIMATED_TIMELINE: 'estimated_timeline',
  SERVICE_ACTION: 'service_action',
  REFUND: 'refund',
  RESHIPMENT: 'reshipment',
  COMPLAINT: 'complaint',
  SENSITIVE_BEAUTY_INCIDENT: 'sensitive_beauty_incident',
  LOGISTICS_ISSUE: 'logistics_issue',
  WRONG_ITEM: 'wrong_item',
  WRONG_SKU: 'wrong_sku',
  UNRESOLVED_ISSUE: 'unresolved_issue',
  RESOLUTION: 'resolution',
};

export const EVENT_TYPES = Object.values(EVENT_TYPE);

/** 事件状态机。pending 表示「等时限」，unfulfilled 只能由 Validator 写入。 */
export const EVENT_STATUS = {
  INFO: 'info',
  OPEN: 'open',
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  UNFULFILLED: 'unfulfilled',
  FULFILLED: 'fulfilled',
  RESOLVED: 'resolved',
  UNKNOWN: 'unknown',
};
export const EVENT_STATUSES = Object.values(EVENT_STATUS);

/** 只有这几个状态会被计为「未解决」 */
export const UNRESOLVED_STATUSES = [
  EVENT_STATUS.OPEN,
  EVENT_STATUS.PENDING,
  EVENT_STATUS.IN_PROGRESS,
  EVENT_STATUS.UNFULFILLED,
  EVENT_STATUS.UNKNOWN,
];

export const SOURCE = { CHAT: 'chat', ORDER: 'order', TICKET: 'ticket', SYSTEM: 'system' };
export const SOURCES = Object.values(SOURCE);

export const CONFIDENCE = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };
export const CONFIDENCES = Object.values(CONFIDENCE);

/** 承诺/动作的业务主题 —— 决定 Validator 去查哪张表 */
export const SUBJECT = {
  RESHIPMENT: 'reshipment',
  REFUND: 'refund',
  COUPON: 'coupon',
  GIFT: 'gift',
  COMPENSATION: 'compensation',
  CONTACT: 'contact',
  OTHER: 'other',
};
export const SUBJECTS = Object.values(SUBJECT);

/** 主题 → Validator 应调用的业务工具（声明式映射，新增主题无需改流程代码） */
export const SUBJECT_TO_TOOL = {
  [SUBJECT.RESHIPMENT]: 'check_reshipment',
  [SUBJECT.GIFT]: 'check_reshipment',
  [SUBJECT.REFUND]: 'check_refund',
  [SUBJECT.COUPON]: 'check_coupon',
  [SUBJECT.COMPENSATION]: 'check_coupon',
  [SUBJECT.CONTACT]: null,
  [SUBJECT.OTHER]: null,
};

/* ═══════════════ 事件构造与校验 ═══════════════ */

let seq = 0;
const nextEventId = () => `EVT_${String(++seq).padStart(4, '0')}`;
export const resetEventSeq = () => { seq = 0; };

const clampEnum = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/**
 * 构造一个规范化的 Service Event。
 * 任何来源（LLM 抽取 / 规则兜底 / 数据投影）产出的东西都必须过这里，
 * 保证下游拿到的是同一套字段与同一套枚举。
 */
export function makeEvent(input = {}) {
  const structured = input.structured_data && typeof input.structured_data === 'object'
    ? { ...input.structured_data }
    : {};

  return {
    event_id: input.event_id || nextEventId(),
    type: clampEnum(input.type, EVENT_TYPES, EVENT_TYPE.USER_ISSUE),
    subtype: input.subtype || null,
    time: input.time || null,
    at: input.time || null, // 前端兼容别名
    source: clampEnum(input.source, SOURCES, SOURCE.SYSTEM),
    source_id: input.source_id || null,
    status: clampEnum(input.status, EVENT_STATUSES, EVENT_STATUS.INFO),
    confidence: clampEnum(input.confidence, CONFIDENCES, CONFIDENCE.MEDIUM),
    evidence: input.evidence || '',
    structured_data: {
      action: structured.action || null,
      deadline: structured.deadline || null,
      deadline_label: structured.deadline_label || null,
      target_order: structured.target_order || null,
      target_sku: structured.target_sku || null,
      target_ticket: structured.target_ticket || null,
      amount: structured.amount ?? null,
      symptoms: Array.isArray(structured.symptoms) ? structured.symptoms : [],
      reason: structured.reason || null,
    },
    /* 由 Validator 回填 —— LLM 无权写入 */
    verification: input.verification || null,
    /* 语义层的原始输出，便于审计「模型说了什么」 */
    raw: input.raw || null,
    meta: input.meta || {},
    /* 前端兼容别名（旧版事件用的是扁平 title/detail） */
    title: (input.meta && input.meta.title) || input.title || input.type,
    detail: (input.meta && input.meta.detail) || input.detail || input.evidence || '',
  };
}

/** 事件是否算「未解决」 */
export const isUnresolved = (e) => UNRESOLVED_STATUSES.includes(e.status);

/** 事件是否由承诺派生（用于承诺核验链路） */
export const isPromiseEvent = (e) => e.type === EVENT_TYPE.SERVICE_PROMISE;

export const isSafetyEvent = (e) =>
  e.type === EVENT_TYPE.SENSITIVE_BEAUTY_INCIDENT;

/* ═══════════════ Case 容器 ═══════════════ */

export const CASE_STATUS = {
  OPEN: 'OPEN',
  ALERTED: 'ALERTED',
  PROCESSING: 'PROCESSING',
  WAITING: 'WAITING',
  RESOLVED: 'RESOLVED',
};

/** 状态机顺序 —— 前端直接消费这个数组渲染进度条，不再硬编码 */
export const CASE_FLOW = [
  CASE_STATUS.OPEN,
  CASE_STATUS.ALERTED,
  CASE_STATUS.PROCESSING,
  CASE_STATUS.WAITING,
  CASE_STATUS.RESOLVED,
];

export const CASE_STATUS_LABEL = {
  OPEN: 'OPEN · 待处理',
  ALERTED: 'ALERTED · 已预警',
  PROCESSING: 'PROCESSING · 处理中',
  WAITING: 'WAITING · 等待外部',
  RESOLVED: 'RESOLVED · 已闭环',
};

/**
 * 从未解决状态的事件派生「未解决事项」。
 * 单独抽出来是因为：**业务核验会改写事件状态**（pending → unfulfilled / fulfilled），
 * 核验之后必须重算一次，否则会出现「已经兑现的承诺仍被列为未解决」。
 *
 * 另外：**「解决动作」本身不是「问题」**。
 * 补发单、解决记录、客服执行动作都代表正在推进的处理，如果把它们算成未解决项，
 * 会出现「处理得越多、未解决项越多」的反常结果，闭环永远收敛不了。
 */
const NOT_AN_ISSUE = new Set([
  EVENT_TYPE.ESTIMATED_TIMELINE, // 预计时效本身不是问题
  EVENT_TYPE.RESHIPMENT,         // 补发单是解决动作
  EVENT_TYPE.RESOLUTION,         // 解决记录
  EVENT_TYPE.SERVICE_ACTION,     // 客服执行动作
]);

export function computeUnresolved(events) {
  return events
    .filter(isUnresolved)
    .filter((e) => !NOT_AN_ISSUE.has(e.type))
    /**
     * 系统事件是「记录 / 通知」，不是「待办问题」。
     *
     * 实测教训：种子数据里有一条历史巡检通知「承诺时限已过，未发现补发订单」，
     * 模型把它抽成 logistics_issue 且状态为 open。补发单创建后这条通知已经过期，
     * 但没有任何机制让它失效，于是 Case 永远无法闭环。
     * 因此：问题一律由 chat / order / ticket 三类业务数据承载，系统侧只做记录。
     */
    .filter((e) => e.source !== SOURCE.SYSTEM)
    .map((e) => ({
      issue_id: `ISS_${e.event_id}`,
      kind: e.type,
      subtype: e.subtype,
      title: e.meta.title || e.evidence.slice(0, 40),
      detail: e.meta.detail || e.evidence,
      severity: e.meta.severity || 'MEDIUM',
      since: e.structured_data.deadline || e.time,
      event_id: e.event_id,
      evidence: [{
        source: e.source,
        ref: e.source_id || '—',
        text: e.evidence,
      }, ...(e.verification?.checks || []).map((c) => ({ source: c.source, ref: c.label, text: c.value, pass: c.pass }))],
      related: {
        order: e.structured_data.target_order,
        ticket: e.structured_data.target_ticket,
        promise: e.type === EVENT_TYPE.SERVICE_PROMISE ? e.event_id : null,
      },
    }));
}

/**
 * 核验之后重算未解决项与计数。
 * 同时刷新向后兼容字段（unresolved）。
 */
export function refreshMemory(memory) {
  const issues = computeUnresolved(memory.events);
  memory.unresolved_issues = issues;
  memory.unresolved = issues.map((u) => ({
    id: u.issue_id,
    kind: u.kind,
    kindLabel: u.title,
    severity: u.severity,
    title: u.title,
    detail: u.detail,
    since: u.since,
    evidence: u.evidence,
  }));
  memory.counts = {
    events: memory.events.length,
    unresolved: issues.length,
    high: issues.filter((u) => u.severity === 'HIGH').length,
  };
  return memory;
}

/**
 * 组装中央数据层对象。
 * 这是 orchestrator 交给下游的唯一入口。
 */
export function buildServiceMemory({ caseId, customerId, now, events, currentNeed, riskFlags, recommendedActions, narrative, llmTrace }) {
  const sorted = [...events].sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const memory = {
    case_id: caseId,
    customer_id: customerId,
    generated_at: now,
    events: sorted,
    timeline: sorted, // 向后兼容旧前端字段名
    current_need: currentNeed || null,
    unresolved_issues: [],
    unresolved: [],
    risk_flags: riskFlags || [],
    recommended_actions: recommendedActions || [],
    narrative: narrative || [],
    llm_trace: llmTrace || null,
    counts: { events: sorted.length, unresolved: 0, high: 0 },
  };
  return refreshMemory(memory);
}
