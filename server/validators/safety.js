/**
 * Safety & Policy Validator —— 确定性安全规则
 * ------------------------------------------------------------------
 * 这些判断**永远**不由模型做。理由：一旦模型误判，后果是不可逆的
 * （错误退款、错误承诺、医学建议、合规风险）。
 *
 * 覆盖（对应需求 4.2）：
 *   敏感美妆事件 / 退款权限 / 补发权限 / 优惠券额度 /
 *   自动升级条件 / 人工确认 / 数据缺失时禁止虚构
 */

import { EVENT_TYPE, EVENT_STATUS } from '../schema.js';
import * as LEX from '../semantic/lexicon.js';

const DAY = 24 * 3600 * 1000;

/* ═══════════════ 政策阈值（集中一处，便于审计） ═══════════════ */

export const POLICIES = {
  /** 单笔优惠券/补偿上限（元），超过需上级审批 */
  couponAutoLimit: 50,
  /** 退款金额超过该值需二次确认 */
  refundReviewLimit: 500,
  /** 近 N 天内进线 ≥ N 次视为重复进线 */
  repeatContactWindowDays: 7,
  repeatContactThreshold: 2,
  /** 近 N 天内退款 ≥ N 笔视为异常退款 */
  abnormalRefundWindowDays: 30,
  abnormalRefundThreshold: 2,
  /** 必须人工确认的写操作 */
  writeActionsRequiringConfirmation: [
    'request_refund', 'request_reshipment', 'add_compensation',
    'escalate_case', 'record_sensitive_incident', 'create_ticket', 'update_ticket', 'close_ticket',
  ],
  /** 命中即自动建议升级的风险码 */
  autoEscalateRisks: ['sensitive_beauty', 'public_complaint'],
  /** 敏感场景强制声明 */
  sensitiveDisclaimer: '系统不做任何医学诊断，仅做事件登记与流程引导。',
};

/* ═══════════════ 护栏 ═══════════════ */

/**
 * 评估安全护栏。
 * @returns {{blockProductRecommendation:boolean, requireHumanEscalation:boolean,
 *            requireConfirmationForWriteActions:boolean, requireSafetyFlow:boolean,
 *            disclaimers:string[], notes:string[], triggeredBy:string[]}}
 */
export function evaluateGuardrails({ memory, need, ctx }) {
  const notes = [];
  const triggeredBy = [];

  const sensitiveEvents = memory.events.filter(
    (e) => e.type === EVENT_TYPE.SENSITIVE_BEAUTY_INCIDENT && e.status !== EVENT_STATUS.RESOLVED,
  );
  const isSensitive = need.sensitive?.isSensitive || sensitiveEvents.length > 0;

  const complaintHits = LEX.PUBLIC_COMPLAINT_WORDS.filter((w) => (memory.current_need?.raw_message || '').includes(w));
  const thirdParty = complaintHits.filter((w) => LEX.THIRD_PARTY_PLATFORMS.includes(w));

  const highRisks = memory.risk_flags.filter((r) => r.level === 'HIGH');

  const blockProductRecommendation = isSensitive;
  if (blockProductRecommendation) {
    triggeredBy.push('sensitive_beauty');
    notes.push('已检测到产品不适相关风险：本次会话禁止进行任何常规产品推荐。');
  }
  if (thirdParty.length) {
    triggeredBy.push('public_complaint');
    notes.push(`已检测到公开平台曝光倾向（${thirdParty.join('、')}）：需在本次会话内给出确定结论，并考虑主动升级。`);
  }

  const requireHumanEscalation =
    isSensitive ||
    thirdParty.length > 0 ||
    highRisks.some((r) => POLICIES.autoEscalateRisks.includes(r.code));

  return {
    blockProductRecommendation,
    requireSafetyFlow: isSensitive,
    requireHumanEscalation,
    requireConfirmationForWriteActions: true,
    disclaimers: isSensitive ? [POLICIES.sensitiveDisclaimer] : [],
    notes,
    triggeredBy,
  };
}

/* ═══════════════ 写操作权限校验 ═══════════════ */

/**
 * 校验一次写操作是否被允许。
 * 数据缺失时**禁止虚构** —— 这里直接拒绝，而不是让模型猜一个值。
 */
export function checkWritePermission(toolName, params, { ctx, memory, guardrails }) {
  const needsConfirm = POLICIES.writeActionsRequiringConfirmation.includes(toolName);
  const deny = (reason) => ({ allowed: false, requiresConfirmation: needsConfirm, reason });

  if (toolName === 'request_reshipment') {
    if (!params.orderId) return deny('缺少目标订单号，无法创建补发单（禁止虚构订单）。');
    if (!params.sku) return deny('缺少补发 SKU，无法创建补发单（禁止虚构商品）。');
  }
  if (toolName === 'request_refund') {
    if (!params.orderId) return deny('缺少目标订单号，无法发起退款（禁止虚构订单）。');
    const order = ctx.orders.find((o) => o.id === params.orderId);
    if (!order) return deny(`订单 ${params.orderId} 不存在，拒绝执行。`);
    if (order.refundStatus === 'done') return deny(`订单 ${params.orderId} 已完成退款，无需重复操作。`);
    const amount = params.amount == null ? order.amount : Number(params.amount);
    return {
      allowed: true,
      requiresConfirmation: true,
      reason: amount > POLICIES.refundReviewLimit
        ? `退款金额 ¥${amount} 超过 ¥${POLICIES.refundReviewLimit} 自动审批阈值，需上级复核。`
        : `退款 ¥${amount} 需人工确认后执行。`,
      requiresReview: amount > POLICIES.refundReviewLimit,
    };
  }
  if (toolName === 'add_compensation') {
    const amount = Number(params.amount ?? 0);
    if (amount > POLICIES.couponAutoLimit) {
      return deny(`补偿金额 ¥${amount} 超过自动上限 ¥${POLICIES.couponAutoLimit}，需上级审批，Agent 不得直接发放。`);
    }
  }
  if (toolName === 'record_sensitive_incident') {
    return {
      allowed: true,
      requiresConfirmation: true,
      reason: '产品不适事件登记需人工确认。',
      disclaimer: POLICIES.sensitiveDisclaimer,
    };
  }

  return { allowed: true, requiresConfirmation: needsConfirm, reason: needsConfirm ? '写操作需人工确认后执行。' : '只读查询，可直接执行。' };
}

/* ═══════════════ 风险识别（从事件派生） ═══════════════ */

/**
 * 风险识别的**主输入是 Service Events**，而不是关键词。
 * 关键词只用于「舆情倾向」这一项确定性安全规则。
 */
export function deriveRiskFlags({ memory, need, ctx, validators }) {
  const flags = [];
  const nowMs = new Date(ctx.now).getTime();
  const LEVEL = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  const push = (code, label, level, reason, evidence) => flags.push({ code, label, level, reason, evidence });

  /* 1. 重复进线 —— 由 contact 事件统计 */
  const contacts = memory.events
    .filter((e) => e.type === EVENT_TYPE.USER_ISSUE && e.source === 'chat' && e.meta.title)
    .filter((e) => String(e.meta.title).includes('进线'))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const recent = contacts.filter((e) => nowMs - new Date(e.time).getTime() <= POLICIES.repeatContactWindowDays * DAY);
  if (recent.length >= POLICIES.repeatContactThreshold) {
    const spanDays = Math.max(1, Math.round((nowMs - new Date(recent[0].time).getTime()) / DAY));
    push('repeat_contact', '重复进线', recent.length >= 3 ? 'HIGH' : 'MEDIUM',
      `该消费者在近 ${spanDays} 天内共进线 ${recent.length} 次，说明前次处理未真正解决问题。`,
      recent.map((e) => ({ source: 'chat', ref: e.source_id, text: e.evidence })));
  }

  /* 2. 未兑现承诺 —— 由 Validator 结果驱动，不由关键词驱动 */
  if (validators.unfulfilledPromise) {
    const e = validators.unfulfilledPromise;
    push('unfulfilled_promise', '未兑现承诺', 'HIGH',
      '客服曾做出明确承诺，但业务数据中不存在对应的完成记录。这是当前问题的核心风险。',
      [{ source: 'chat', ref: e.source_id, text: e.evidence },
        ...(e.verification?.checks || []).map((c) => ({ source: c.source, ref: c.label, text: c.value, pass: c.pass }))]);
  }

  /* 3. 情绪升级 —— 由当前诉求与历史基线比较 */
  if (need.emotion.escalated) {
    const delta = LEX.EMOTION_RANK[need.emotion.level] - LEX.EMOTION_RANK[need.emotion.baseline];
    push('emotion_escalation', '情绪升级', delta >= 2 ? 'HIGH' : 'MEDIUM',
      `当前消息情绪等级为「${need.emotion.level}」，高于历史基线「${need.emotion.baseline}」，说明负面情绪在累积。`,
      [{ source: 'chat', ref: '当前会话', text: memory.current_need?.raw_message || '' }]);
  }

  /* 4. 舆情 / 投诉 —— 确定性安全规则（保留关键词） */
  const msg = memory.current_need?.raw_message || '';
  const hits = LEX.PUBLIC_COMPLAINT_WORDS.filter((w) => msg.includes(w));
  const thirdParty = hits.filter((w) => LEX.THIRD_PARTY_PLATFORMS.includes(w));
  const priorComplaint = memory.events.find(
    (e) => e.source === 'chat' && !String(e.source_id).includes('当前') && LEX.PUBLIC_COMPLAINT_WORDS.some((w) => String(e.evidence).includes(w)),
  );
  if (hits.length) {
    push('public_complaint', '投诉 / 舆情风险', thirdParty.length ? 'HIGH' : 'MEDIUM',
      thirdParty.length
        ? `消费者已明确提及第三方公开平台「${thirdParty.join('、')}」，存在舆情扩散风险，需按高优先级处理。`
        : `消费者提及投诉类表达「${hits.join('、')}」，需在本次会话内给出确定结论。`,
      [{ source: 'chat', ref: '当前会话', text: msg }]);
  } else if (priorComplaint) {
    push('public_complaint', '投诉 / 舆情风险', 'MEDIUM',
      '该消费者历史上曾使用投诉类表达，本次虽未再次提及，但存在复燃可能。',
      [{ source: 'chat', ref: priorComplaint.source_id, text: priorComplaint.evidence }]);
  }

  /* 5. 异常退款 —— 由 refund 事件统计 */
  const refunds = memory.events.filter(
    (e) => e.type === EVENT_TYPE.REFUND && e.subtype !== 'none' &&
      nowMs - new Date(e.time).getTime() <= POLICIES.abnormalRefundWindowDays * DAY,
  );
  if (refunds.length >= POLICIES.abnormalRefundThreshold) {
    push('abnormal_refund', '异常退款', refunds.length >= 3 ? 'HIGH' : 'MEDIUM',
      `近 ${POLICIES.abnormalRefundWindowDays} 天内该消费者共发生 ${refunds.length} 笔退款，高于正常复购用户的售后频次，需关注是否存在重复售后或异常退款模式。`,
      refunds.map((e) => ({ source: 'order', ref: e.source_id, text: e.evidence })));
  }

  /* 6. 美妆敏感 —— 事件驱动 */
  const sensitiveEvents = memory.events.filter((e) => e.type === EVENT_TYPE.SENSITIVE_BEAUTY_INCIDENT);
  const unlogged = sensitiveEvents.filter((e) => e.subtype === 'unlogged');
  if (need.sensitive?.isSensitive || sensitiveEvents.length) {
    const level = need.sensitive?.isSensitive && sensitiveEvents.length ? 'HIGH' : 'MEDIUM';
    push('sensitive_beauty', '美妆敏感风险（疑似产品不适）', level,
      level === 'HIGH'
        ? '消费者当前再次描述使用后皮肤不适，且历史上已存在同类售后记录 —— 说明该问题从未被正式登记与闭环，本次必须进入安全处理流程。'
        : '消费者描述使用后皮肤不适，需按安全处理流程处理，并登记事件。',
      [
        ...(need.sensitive?.isSensitive ? [{ source: 'chat', ref: '当前会话', text: msg }] : []),
        ...sensitiveEvents.map((e) => ({ source: 'ticket', ref: e.source_id, text: e.evidence })),
        ...memory.events.filter((e) => e.subtype === 'product_push').map((e) => ({ source: 'system', ref: e.source_id, text: e.evidence })),
      ]);
    if (unlogged.length) {
      flags.push({
        code: 'unlogged_incident',
        label: '产品不适事件未登记',
        level: 'HIGH',
        reason: '历史同类反馈仅按常规售后办理退款，未登记为产品不适事件，导致推荐系统仍在推送同类产品。',
        evidence: unlogged.map((e) => ({ source: 'ticket', ref: e.source_id, text: e.evidence })),
      });
    }
  }

  const overall = flags.reduce((acc, f) => (LEVEL[f.level] > LEVEL[acc] ? f.level : acc), 'LOW');

  return {
    risk_flags: flags.sort((a, b) => LEVEL[b.level] - LEVEL[a.level]),
    overall,
    overallLabel: overall === 'HIGH' ? '高风险' : overall === 'MEDIUM' ? '中风险' : '低风险',
    disclaimer: '风险等级为规则化分级（LOW / MEDIUM / HIGH），不输出概率或百分比。',
  };
}
