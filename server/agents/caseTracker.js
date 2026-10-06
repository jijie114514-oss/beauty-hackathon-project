/**
 * Case Tracker —— 闭环追踪（5 态状态机）
 * ------------------------------------------------------------------
 *   OPEN → ALERTED → PROCESSING → WAITING → RESOLVED
 *
 * 语义：
 *   OPEN        新进线，尚未预警、尚未处理
 *   ALERTED     已识别风险并预警，但尚未采取任何写操作
 *   PROCESSING  已执行写操作，正在推进中
 *   WAITING     客服侧可做的都做了，正在等外部（物流 / 财务 / 时限到达）
 *   RESOLVED    全部检查项通过
 *
 * 每次分析都重新执行「结果检查」，因此 Tool 执行后状态会自动流转。
 * Risk Center 读取的是同一套 Case 状态。
 */

import { CASE_STATUS, CASE_FLOW, CASE_STATUS_LABEL, EVENT_TYPE, EVENT_STATUS } from '../schema.js';
import { fmtDateTime } from '../utils/date.js';

export function caseTracker(ctx, memory, need, validators, riskResult) {
  const checks = [];

  /* ── 1. 承诺兑现检查（逐条） ─────────────────────────── */
  for (const e of memory.events.filter((x) => x.type === EVENT_TYPE.SERVICE_PROMISE)) {
    const done = e.status === EVENT_STATUS.FULFILLED;
    checks.push({
      item: `${e.raw?.subjectLabel || e.subtype}承诺（${e.meta.agentName || '客服'} · ${String(e.time).slice(0, 10)}）`,
      status: e.status,
      statusLabel: done ? '已兑现' : e.status === EVENT_STATUS.UNFULFILLED ? '未兑现' : e.status === EVENT_STATUS.IN_PROGRESS ? '履约中' : '待兑现',
      pass: done,
      detail: e.verification?.conclusion || '',
      evidence: (e.verification?.checks || []).map((c) => `${c.label}：${c.value}`),
      kind: 'promise',
    });
  }

  /* ── 2. 未关闭工单检查 ───────────────────────────────── */
  for (const u of memory.unresolved_issues) {
    if (u.kind === EVENT_TYPE.SERVICE_PROMISE) continue; // 已由上面覆盖
    if (u.kind === EVENT_TYPE.SENSITIVE_BEAUTY_INCIDENT || u.kind === EVENT_TYPE.RESOLUTION) continue; // 专项检查覆盖
    checks.push({
      item: u.title,
      status: u.severity === 'HIGH' ? 'OPEN' : 'PROCESSING',
      statusLabel: u.severity === 'HIGH' ? '高优先未解决' : '处理中',
      pass: false,
      detail: u.detail,
      evidence: (u.evidence || []).slice(0, 2).map((x) => `[${x.source}] ${x.ref}`),
      kind: 'issue',
    });
  }

  /* ── 3. 安全类专项检查 ───────────────────────────────── */
  const sensitiveRisk = (riskResult.risks || []).find((r) => r.code === 'sensitive_beauty');
  if (sensitiveRisk) {
    const logged = ctx.tickets.find((t) => t.type === 'sensitive_incident' || t.incidentLogged === true);
    const escalated = ctx.tickets.find((t) => t.type === 'escalation');
    checks.push({
      item: '疑似产品不适事件登记与收口',
      status: logged ? (logged.status === 'RESOLVED' ? 'RESOLVED' : 'PROCESSING') : 'MISSING',
      statusLabel: logged ? (logged.status === 'RESOLVED' ? '已登记并闭环' : '已登记，待收口') : '未登记',
      pass: Boolean(logged && logged.status === 'RESOLVED'),
      detail: logged
        ? `事件工单 ${logged.id} 已创建，已阻断后续自动推荐。`
        : '历史同类反馈从未被正式登记为产品不适事件，推荐系统因此仍在推送同类产品。',
      evidence: (sensitiveRisk.evidence || []).slice(0, 2).map((e) => `[${e.source}] ${e.ref}`),
      kind: 'safety',
    });
    checks.push({
      item: '高风险会话人工升级',
      status: escalated ? 'RESOLVED' : 'MISSING',
      statusLabel: escalated ? `已升级至 ${escalated.owner}` : '未升级',
      pass: Boolean(escalated),
      detail: escalated ? `升级工单 ${escalated.id} 已创建。` : '尚未按安全处理流程升级至人工团队。',
      evidence: [],
      kind: 'safety',
    });
  }

  /* ── 4. 当前会话是否已回复 ───────────────────────────── */
  const cur = ctx.sessions.find((s) => s.isCurrent);
  const consumerMsgs = cur ? cur.messages.filter((m) => m.role === 'consumer') : [];
  const lastConsumer = consumerMsgs[consumerMsgs.length - 1];
  if (cur && lastConsumer) {
    const replied = cur.messages.some((m) => m.role === 'agent' && m.at > lastConsumer.at);
    checks.push({
      item: '当前会话是否已回复消费者',
      status: replied ? 'RESOLVED' : 'OPEN',
      statusLabel: replied ? '已回复' : '待回复',
      pass: replied,
      detail: replied ? '客服已针对消费者最新消息给出回复。' : `消费者于 ${fmtDateTime(lastConsumer.at)} 的最新消息尚未得到回复。`,
      evidence: [{ ref: '当前会话', text: lastConsumer.text }],
      kind: 'session',
    });
  }

  const passed = checks.filter((c) => c.pass).length;
  const blocking = checks.filter((c) => !c.pass);

  /* ── 状态机 ──────────────────────────────────────────── */
  const hasWriteHistory = ctx.tickets.some(
    (t) => ['reshipment', 'refund', 'escalation', 'compensation', 'sensitive_incident'].includes(t.type)
      && (t.records || []).some((r) => r.actor === '系统' || r.actor === '客服-当前坐席'),
  );
  const hasHighRisk = (riskResult.risks || []).some((r) => r.level === 'HIGH');
  const openTickets = ctx.tickets.filter((t) => t.status === 'OPEN' || t.status === 'PROCESSING');

  /* 是否「只剩等待外部」：阻塞项全是时限未到的承诺或处理中的退款 */
  const onlyWaiting = blocking.length > 0 && blocking.every((b) => {
    if (b.kind !== 'promise' && b.kind !== 'issue') return false;
    return b.status === EVENT_STATUS.PENDING || b.status === EVENT_STATUS.IN_PROGRESS;
  });

  let status = CASE_STATUS.RESOLVED;
  if (blocking.length) {
    if (!hasWriteHistory) status = hasHighRisk ? CASE_STATUS.ALERTED : CASE_STATUS.OPEN;
    else if (onlyWaiting) status = CASE_STATUS.WAITING;
    else status = CASE_STATUS.PROCESSING;
  }

  /* ── 承诺态汇总 ──────────────────────────────────────── */
  const promiseEvents = memory.events.filter((e) => e.type === EVENT_TYPE.SERVICE_PROMISE);
  const cnt = (s) => promiseEvents.filter((e) => e.status === s).length;
  const promiseState = {
    total: promiseEvents.length,
    resolved: cnt(EVENT_STATUS.FULFILLED),
    pending: cnt(EVENT_STATUS.PENDING) + cnt(EVENT_STATUS.IN_PROGRESS),
    unfulfilled: cnt(EVENT_STATUS.UNFULFILLED),
    unknown: cnt(EVENT_STATUS.UNKNOWN),
    label:
      promiseEvents.length === 0
        ? '无承诺'
        : cnt(EVENT_STATUS.UNFULFILLED)
          ? 'PENDING（存在未兑现承诺）'
          : cnt(EVENT_STATUS.PENDING) + cnt(EVENT_STATUS.IN_PROGRESS)
            ? 'PROCESSING（承诺履约中）'
            : 'RESOLVED（承诺均已兑现）',
  };

  return {
    id: memory.case_id,
    consumerId: ctx.consumer.id,
    consumerName: ctx.consumer.name,
    status,
    statusLabel: CASE_STATUS_LABEL[status],
    statusFlow: CASE_FLOW, // 前端直接消费，不再硬编码三态
    openedAt: memory.events[0]?.time || ctx.now,
    updatedAt: ctx.now,
    rootCause: null,
    rootCauseLabel: null,
    currentIssue: null,
    owner: openTickets[0]?.owner || (hasWriteHistory ? '客服-当前坐席' : '未分配'),
    currentAction: null, // 由 orchestrator 回填
    riskLevel: (riskResult.risks || [])[0]?.level || 'LOW',
    riskReasons: (riskResult.risks || []).map((r) => ({ code: r.code, label: r.label, level: r.level, reason: r.reason })),
    promiseState,
    checks,
    progress: { passed, total: checks.length, blocking: blocking.map((b) => b.item) },
    nextStep: status === CASE_STATUS.RESOLVED
      ? '本 Case 的所有未解决问题均已闭环，无需进一步动作。'
      : `仍有 ${blocking.length} 项未闭环，需按 Next Best Action 推进。`,
  };
}

export const statusRank = (s) => CASE_FLOW.indexOf(s);
