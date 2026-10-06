/**
 * Agent Orchestrator —— 新数据流编排
 * ------------------------------------------------------------------
 * 本轮改造后的链路（对应需求最高优先级目标）：
 *
 *   LLM 语义理解 → Service Memory 结构化 → Evidence/Rule Validator
 *   → Tool 查询 → Agent 规划 → 人工确认 → Tool 执行 → 状态回写
 *
 * 各能力之间存在明确的数据依赖，因此是「单 Orchestrator + 多能力模块」，
 * 而不是多 Agent 并行 —— 强行拆分只会增加无意义复杂度。
 */

import * as store from '../store.js';
import { refreshMemory } from '../schema.js';
import { getSettings, getStats } from '../llm.js';
import { getTrace, clearTrace } from '../semantic/index.js';

import { promiseAgent, attachVerification } from './promise.js';
import { intentAgent } from './intent.js';
import { serviceMemoryAgent } from './serviceMemory.js';
import { validateMemory } from '../validators/business.js';
import { riskAgent } from './risk.js';
import { escalationAgent } from './escalation.js';
import { actionAgent } from './action.js';
import { replyAgent } from './reply.js';
import { caseTracker } from './caseTracker.js';
import { getMemoryCacheStats as memStats } from './serviceMemory.js';

export async function analyze({ consumerId, message = null }) {
  const ctx = store.contextOf(consumerId);
  if (!ctx) throw new Error(`未找到消费者 ${consumerId}`);

  const currentMessage =
    message ||
    (() => {
      const s = store.currentSessionOf(consumerId);
      const last = s?.messages.filter((m) => m.role === 'consumer').slice(-1)[0];
      return last ? last.text : '';
    })();

  const t0 = Date.now();
  clearTrace();

  /* 1) 话术分类（LLM 语义判断，规则兜底） */
  const promiseRaw = await promiseAgent(ctx);

  /* 2) 当前诉求（LLM 语义理解；情绪等级由确定性规则锁定） */
  const intent = await intentAgent(ctx, currentMessage);

  /* 3) 中央数据层：事件抽取 + 缓存 */
  const { memory, extractionSource, cacheHit } = await serviceMemoryAgent(ctx, currentMessage, {
    promiseResult: promiseRaw,
    need: intent,
  });

  /* 4) 业务核验（规则 Validator，模型不参与判断数据库事实） */
  const validations = validateMemory(memory, ctx);

  /* 5) 核验后重算未解决项 —— 保证「已兑现的承诺」不再出现在未解决列表里 */
  refreshMemory(memory);

  /* 6) 承诺视图回填核验结果 */
  const promises = attachVerification(promiseRaw, memory);

  /* 7) 风险识别（事件驱动 + 确定性安全规则） */
  const risk = riskAgent(ctx, memory, intent, validations);

  /* 8) 升级归因（LLM 归因，注册表兜底） */
  const escalation = await escalationAgent(ctx, memory, intent, validations);

  /* 9) Agent 规划（LLM 规划，声明式注册表兜底；写操作强制人工确认） */
  const actionPlan = await actionAgent(ctx, memory, intent, validations, risk, escalation);

  /* 10) 建议回复（LLM 生成，通用事实槽位兜底） */
  const reply = await replyAgent(ctx, memory, intent, validations, actionPlan, escalation);

  /* 11) 闭环追踪（5 态状态机） */
  const kase = caseTracker(ctx, memory, intent, validations, risk);
  kase.rootCause = escalation.rootCause;
  kase.rootCauseLabel = escalation.rootCauseLabel;
  kase.currentIssue = escalation.currentIssue;
  kase.currentAction = actionPlan.actions[0]?.title || null;

  /* 中央数据层回填下游结果，保证「只读 Memory」也能拿到完整视图 */
  memory.risk_flags = risk.risks;
  memory.recommended_actions = actionPlan.actions.map((a) => ({ id: a.id, title: a.title, kind: a.kind, requiresConfirmation: a.requiresConfirmation }));

  return {
    meta: {
      consumerId,
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - t0,
      engine: describeEngine(),
      llm: getSettings(),
      semanticTrace: getTrace(),
      memoryCache: { hit: cacheHit, ...memStats() },
      extractionSource,
      pipeline: [
        'LLM 语义抽取（事件 / 承诺 / 诉求）',
        'Service Memory 结构化',
        'Evidence Validator（业务核验）',
        'Safety Validator（安全与权限）',
        'Risk Agent（事件驱动）',
        'Escalation Reasoning',
        'Agent Planner',
        'Reply Generation',
        'Case Tracker（5 态）',
      ],
    },
    consumer: ctx.consumer,
    context: {
      orders: ctx.orders,
      tickets: ctx.tickets,
      sessions: ctx.sessions,
      systemEvents: ctx.systemEvents,
    },
    serviceMemory: memory,
    validations,
    promises,
    intent,
    risk,
    escalation,
    actionPlan,
    reply,
    case: kase,
  };
}

function describeEngine() {
  const s = getSettings();
  if (s.mode === 'rule_only') return 'rule-only（确定性语义引擎）';
  if (!s.enabled) return 'rule-only（未配置模型，自动降级）';
  if (s.mode === 'llm_only') return `llm-only（${s.model}）`;
  return `hybrid（${s.model} + 确定性兜底）`;
}

/** 消费者列表（带一句话状态，供左侧列表使用） */
export async function listConsumers() {
  const out = [];
  const nowMs = new Date(store.now()).getTime();
  const WEEK = 7 * 24 * 3600 * 1000;

  for (const c of store.consumers()) {
    const brief = await analyze({ consumerId: c.id });
    const contactSessions = brief.context.sessions.filter((s) => s.messages.some((m) => m.role === 'consumer'));
    const recent = contactSessions.filter((s) => nowMs - new Date(s.startedAt).getTime() <= WEEK);

    out.push({
      id: c.id,
      name: c.name,
      level: c.level,
      city: c.city,
      tags: c.tags,
      lastMessage: brief.intent.currentMessage,
      riskLevel: brief.risk.overall,
      riskLabel: brief.risk.overallLabel,
      caseStatus: brief.case.status,
      caseStatusLabel: brief.case.statusLabel,
      rootCause: brief.escalation.rootCause,
      rootCauseLabel: brief.escalation.rootCauseLabel,
      unresolvedCount: brief.serviceMemory.unresolved_issues.length,
      unfulfilledPromises: brief.promises.unfulfilled.length,
      contacts: contactSessions.length,
      contactsRecent: recent.length,
      emotion: brief.intent.emotion.level,
      guardrails: brief.risk.guardrails,
      owner: brief.case.owner,
      currentAction: brief.case.currentAction,
    });
  }
  return out;
}

/** Risk Center 聚合视图 —— 读取与工作台同一套 Case 状态 */
export async function scanAll() {
  const list = await listConsumers();

  const cases = [];
  const unresolvedPromises = [];
  const escalated = [];
  const repeatContacts = [];

  for (const item of list) {
    const brief = await analyze({ consumerId: item.id });
    const c = brief.case;

    cases.push({
      caseId: c.id,
      consumerId: item.id,
      consumerName: item.name,
      status: c.status,
      statusLabel: c.statusLabel,
      riskLevel: c.riskLevel,
      riskReasons: c.riskReasons,
      rootCauseLabel: c.rootCauseLabel,
      currentIssue: c.currentIssue,
      owner: c.owner,
      currentAction: c.currentAction,
      progress: c.progress,
      nextStep: c.nextStep,
      lastMessage: item.lastMessage,
      guardrails: item.guardrails,
      evidence: (brief.escalation.evidence || []).slice(0, 4),
      updatedAt: c.updatedAt,
    });

    for (const p of brief.promises.unfulfilled) {
      unresolvedPromises.push({
        consumerId: item.id,
        consumerName: item.name,
        promiseId: p.id,
        quote: p.quote,
        agentName: p.agentName,
        madeAt: p.at,
        dueAt: p.deadline?.dueAt || null,
        deadlineLabel: p.deadline?.absoluteLabel || p.deadline?.label || '未明确',
        subjectLabel: p.subjectLabel,
        conclusion: p.verify?.conclusion || '',
        evidence: (p.verify?.checks || []).map((x) => `${x.label}：${x.value}`),
      });
    }

    for (const t of brief.context.tickets) {
      if (t.type === 'escalation') {
        escalated.push({
          consumerId: item.id, consumerName: item.name, ticketId: t.id,
          title: t.title, status: t.status, owner: t.owner, createdAt: t.createdAt,
          reason: (t.records || [])[0]?.note || '',
        });
      }
    }

    if (item.contactsRecent >= 2) {
      repeatContacts.push({
        consumerId: item.id,
        consumerName: item.name,
        contacts: item.contactsRecent,
        contactsTotal: item.contacts,
        emotion: item.emotion,
        riskLevel: item.riskLevel,
        lastMessage: item.lastMessage,
        rootCauseLabel: item.rootCauseLabel,
      });
    }
  }

  const highRisk = cases.filter((c) => c.riskLevel === 'HIGH');

  return {
    generatedAt: new Date().toISOString(),
    engine: describeEngine(),
    llmStats: getStats(),
    memoryCache: memStats(),
    stats: {
      totalConsumers: list.length,
      highRisk: highRisk.length,
      unresolvedPromises: unresolvedPromises.length,
      repeatContacts: repeatContacts.length,
      escalated: escalated.length,
      sensitive: list.filter((c) => c.guardrails.blockProductRecommendation).length,
      byStatus: cases.reduce((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc; }, {}),
    },
    cases,
    highRisk: highRisk.map((c) => ({
      consumerId: c.consumerId,
      consumerName: c.consumerName,
      riskLevel: c.riskLevel,
      risks: c.riskReasons,
      escalation: { currentIssue: c.currentIssue, rootCauseLabel: c.rootCauseLabel, summary: c.rootCauseLabel },
      currentMessage: c.lastMessage,
      caseStatus: c.status,
      guardrails: c.guardrails,
    })),
    unresolvedPromises,
    repeatContacts,
    escalated,
    consumers: list,
  };
}

/** 单条 Case 详情（Risk Center 点击进入） */
export async function getCase(consumerId) {
  const brief = await analyze({ consumerId });
  return {
    case: brief.case,
    consumer: brief.consumer,
    risk: { overall: brief.risk.overall, risks: brief.risk.risks, guardrails: brief.risk.guardrails },
    escalation: brief.escalation,
    unresolvedIssues: brief.serviceMemory.unresolved_issues,
    promises: { promises: brief.promises.promises, unfulfilled: brief.promises.unfulfilled },
    actionPlan: brief.actionPlan,
    timeline: brief.serviceMemory.events,
  };
}
