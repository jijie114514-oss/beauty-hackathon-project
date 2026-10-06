/**
 * Escalation Reasoning Agent —— 升级原因分析
 * ------------------------------------------------------------------
 * 本轮改造：**删除全部场景 if-else 分支与写死的 currentIssue / summary。**
 *
 * 归因逻辑变成「根因注册表 + 事实匹配」：
 *   ROOT_CAUSE_REGISTRY 里按优先级排列若干条声明式规则，
 *   每条规则只声明「什么事实成立时适用」和「对应的话术模板」。
 *   新增业务场景 = 往注册表加一条，不需要动任何流程代码。
 *
 * 归因本身可由 LLM 完成（runEscalationReasoning），但：
 *   - 证据 ID 必须是真实存在的 event_id，模型编造的会被丢弃；
 *   - 业务真实状态以 Validator 结果为准，模型不得声称。
 */

import { runEscalationReasoning } from '../semantic/index.js';
import { businessState } from '../validators/business.js';

export async function escalationAgent(ctx, memory, need, validators) {
  const r = await runEscalationReasoning({ memory, need, ctx, validations: validators });
  const e = r.value;

  /* 证据：优先用模型指认的事件，并附上业务核验结果 */
  const validIds = new Set(memory.events.map((x) => x.event_id));
  const citedEvents = (e.evidence_event_ids || [])
    .filter((id) => validIds.has(id))
    .map((id) => memory.events.find((x) => x.event_id === id))
    .filter(Boolean);

  const evidence = [];
  for (const ev of citedEvents) {
    evidence.push({ source: ev.source, ref: ev.source_id || '—', text: ev.evidence, event_id: ev.event_id });
  }
  for (const c of (validators.checks || [])) {
    evidence.push({ source: c.source, ref: c.label, text: c.value, pass: c.pass });
  }
  if (!evidence.length) {
    evidence.push({ source: 'chat', ref: '当前会话', text: memory.current_need?.raw_message || need.surface_issue });
  }

  return {
    currentIssue: e.currentIssue,
    rootCause: e.rootCause || e.primary_reason,
    rootCauseLabel: e.rootCauseLabel,
    primaryReason: e.primary_reason,
    secondaryReasons: e.secondary_reasons || [],
    summary: e.summary,
    evidence,
    evidenceEventIds: e.evidence_event_ids || [],
    comparison: e.comparison || [],
    confidence: e.confidence,
    trigger: e.trigger,
    isLogisticsIssue: false,
    businessState: businessState(ctx),
    source: e.source || r.source,
    classifiedBy: r.source,
  };
}
