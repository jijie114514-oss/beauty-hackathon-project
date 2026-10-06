/**
 * Action Agent —— Next Best Action（Agent Planner）
 * ------------------------------------------------------------------
 * 本轮改造：**删除场景 A/B/C/D/E 的 if-else 分支。**
 *
 * 改为「声明式动作注册表」：
 *   每条动作只声明「什么事实成立时适用」（when）与「要调什么工具」（tools）。
 *   规划器收集所有命中项 → 按优先级排序 → 取前 3 → 过安全权限校验。
 *
 * 因此 Case A（退款承诺未兑现）/ Case B（优惠券未到账）等新场景
 * **不需要新增任何代码分支** —— 它们由 SUBJECT → 执行工具 的映射自动覆盖。
 *
 * 规划器只负责推荐。所有写操作（退款 / 补发 / 优惠券 / 升级 / 补偿）
 * 一律 requiresConfirmation = true，最终决定权在人工客服手里。
 */

import { EVENT_TYPE, EVENT_STATUS, SUBJECT } from '../schema.js';
import { runActionPlanning } from '../semantic/index.js';
import { checkWritePermission, POLICIES } from '../validators/safety.js';
import { TOOL_SPECS } from '../tools/index.js';

/**
 * 业务主题 → 实际执行工具（声明式映射）
 * 这是让「退款承诺未兑现」「优惠券未到账」等场景自动泛化的关键：
 * 新增一种承诺类型，只要在这里加一行。
 */
export const SUBJECT_EXECUTE_TOOL = {
  [SUBJECT.RESHIPMENT]: 'request_reshipment',
  [SUBJECT.GIFT]: 'request_reshipment',
  [SUBJECT.REFUND]: 'request_refund',
  [SUBJECT.COUPON]: 'add_compensation',
  [SUBJECT.COMPENSATION]: 'add_compensation',
};

const mk = (a) => ({
  requiresConfirmation: a.kind === 'write',
  ...a,
});

/* ═══════════════ 事实收集 ═══════════════ */

function buildFacts(ctx, memory, need, validators, riskResult) {
  const unresolved = memory.unresolved_issues;
  const byKind = (k) => unresolved.find((u) => u.kind === k);

  const unfulfilled = validators.unfulfilledPromise || null;
  const originOrder = ctx.orders.find((o) => o.receivedSku && o.receivedSku !== o.items?.[0]?.sku)
    || ctx.orders.find((o) => o.type !== 'reshipment')
    || ctx.orders[0]
    || null;

  const openTickets = ctx.tickets.filter((t) => t.status === 'OPEN' || t.status === 'PROCESSING');
  const reshipOrders = ctx.orders.filter((o) => o.type === 'reshipment');
  const pendingRefund = ctx.orders.find((o) => o.refundStatus === 'processing') || null;

  const closableTickets = openTickets.filter((t) =>
    reshipOrders.some((o) => o.parentOrderId === t.orderId && new Date(o.createdAt) >= new Date(t.createdAt)));

  const sensitiveEvent = memory.events.find(
    (e) => e.type === EVENT_TYPE.SENSITIVE_BEAUTY_INCIDENT && e.status !== EVENT_STATUS.RESOLVED,
  );
  const incidentLogged = ctx.tickets.find((t) => t.type === 'sensitive_incident' || t.incidentLogged === true);
  const escalated = ctx.tickets.find((t) => t.type === 'escalation');

  const cur = ctx.sessions.find((s) => s.isCurrent);
  const lastConsumer = cur ? cur.messages.filter((m) => m.role === 'consumer').slice(-1)[0] : null;
  const sessionReplied = !lastConsumer || cur.messages.some((m) => m.role === 'agent' && m.at > lastConsumer.at);

  return {
    ctx, memory, need, validators, riskResult,
    unresolved, byKind,
    unfulfilled, originOrder, openTickets, reshipOrders, pendingRefund,
    closableTickets, sensitiveEvent, incidentLogged, escalated, sessionReplied,
    guardrails: riskResult.guardrails,
    sku: originOrder?.items?.[0]?.sku || null,
    shade: originOrder?.items?.[0]?.shade || '',
    hasBlocking: unresolved.length > 0 || !sessionReplied,
  };
}

/* ═══════════════ 动作注册表（声明式） ═══════════════ */

const REGISTRY = [
  /* ── 1. 未兑现承诺：先核验，再执行，最后兜底升级 ─────────── */
  {
    id: 'verify_before_execute',
    when: (f) => Boolean(f.unfulfilled),
    make: (f) => mk({
      id: 'A1', priority: 1, kind: 'read',
      title: '核查库存与最快履约方式',
      reason: `历史客服已明确承诺${f.unfulfilled.raw?.subjectLabel || '履约'}，在给出任何回复前必须先确认真实可执行性，否则第二次失信会把问题从「延迟」升级为「服务失信」。`,
      tools: [
        ...(f.sku ? [{ name: 'check_inventory', params: { sku: f.sku, qty: 1 } }] : []),
        ...(f.sku ? [{ name: 'estimate_fulfillment', params: { sku: f.sku, city: f.ctx.consumer.city, sameCity: false } }] : []),
        { name: 'check_order', params: { orderId: f.originOrder?.id } },
      ],
      expectedOutcome: f.sku ? `确认 ${f.sku} 是否可立即发出，以及能否在消费者时间约束前送达。` : '确认履约可行性。',
      evidence: [
        { source: 'chat', ref: f.unfulfilled.source_id, text: f.unfulfilled.evidence },
        { source: 'chat', ref: '当前会话', text: f.memory.current_need?.raw_message || '' },
      ],
      riskIfSkipped: '若库存不足仍直接承诺，将产生第二次未兑现承诺，舆情风险显著上升。',
    }),
  },
  {
    id: 'execute_promised_action',
    when: (f) => Boolean(f.unfulfilled && SUBJECT_EXECUTE_TOOL[f.unfulfilled.structured_data.action]),
    make: (f) => {
      const subject = f.unfulfilled.structured_data.action;
      const tool = SUBJECT_EXECUTE_TOOL[subject];
      const params = tool === 'request_reshipment'
        ? { orderId: f.originOrder?.id, sku: f.sku, shade: f.shade, qty: 1, priority: 'urgent', reason: `${f.unfulfilled.raw?.subjectLabel || '履约'}承诺未兑现，本次加急执行`, consumerId: f.ctx.consumer.id }
        : tool === 'request_refund'
          ? { orderId: f.originOrder?.id, reason: '客服承诺退款未兑现，本次执行', consumerId: f.ctx.consumer.id }
          : { consumerId: f.ctx.consumer.id, orderId: f.originOrder?.id, kind: 'coupon', amount: 30, note: `${f.unfulfilled.raw?.subjectLabel || '补偿'}承诺未兑现` };
      return mk({
        id: 'A2', priority: 2, kind: 'write',
        title: `执行未兑现的${f.unfulfilled.raw?.subjectLabel || '履约'}承诺`,
        reason: `承诺已超时未执行，且消费者存在明确的时间约束，需要通过立即履约来修复信任。`,
        tools: [{ name: tool, params }],
        expectedOutcome: '业务状态真实变更，Service Memory 会自动重算。',
        evidence: [{ source: 'chat', ref: f.unfulfilled.source_id, text: f.unfulfilled.evidence }],
        riskIfSkipped: '问题将持续停留在未解决状态，消费者极可能直接转向公开平台投诉。',
      });
    },
  },
  {
    id: 'escalate_if_blocked',
    when: (f) => Boolean(f.unfulfilled && f.guardrails.requireHumanEscalation),
    make: (f) => mk({
      id: 'A3', priority: 3, kind: 'write',
      title: '升级人工处理并评估补偿',
      reason: '当前已触发高风险条件，一旦确认无法按时履约，需要立即升级并主动补偿，避免舆情扩散。',
      conditional: '仅当第 1 步核查结果显示无法按时履约时执行',
      tools: [
        { name: 'escalate_case', params: { consumerId: f.ctx.consumer.id, orderId: f.originOrder?.id, level: 'L2', reason: `${f.unfulfilled.raw?.subjectLabel || '承诺'}未兑现 + 高风险条件触发`, target: '资深客服组' } },
        { name: 'add_compensation', params: { consumerId: f.ctx.consumer.id, orderId: f.originOrder?.id, kind: 'coupon', amount: 50, note: '履约失信致歉补偿' } },
      ],
      expectedOutcome: '由资深客服组接管，并发放补偿以降低舆情风险。',
      evidence: (f.riskResult.risks || []).filter((r) => r.level === 'HIGH').flatMap((r) => r.evidence).slice(0, 2),
      riskIfSkipped: '高风险会话若无人升级接管，将直接暴露为公开投诉。',
    }),
  },

  /* ── 2. 敏感美妆事件：登记 → 升级 → 收口 ─────────────────── */
  {
    id: 'sensitive_pull_history',
    when: (f) => Boolean(f.guardrails.blockProductRecommendation && !f.incidentLogged),
    make: (f) => mk({
      id: 'B1', priority: 1, kind: 'read',
      title: '调取历史售后记录与商品信息',
      reason: '消费者再次描述使用后皮肤不适，需先确认历史反馈是否被正式登记。这一步是判断「新问题」还是「历史遗留问题」的关键。',
      tools: [
        { name: 'get_ticket_history', params: { consumerId: f.ctx.consumer.id } },
        { name: 'check_order', params: { orderId: f.originOrder?.id } },
      ],
      expectedOutcome: '确认历史同类反馈是否存在、是否已登记为产品不适事件。',
      evidence: (f.sensitiveEvent ? [{ source: 'ticket', ref: f.sensitiveEvent.source_id, text: f.sensitiveEvent.evidence }] : []),
      riskIfSkipped: '若把重复出现的不适反馈当作新问题处理，将再次走完退款流程而不闭环，问题必然复发。',
    }),
  },
  {
    id: 'sensitive_record_incident',
    when: (f) => Boolean(f.guardrails.blockProductRecommendation && !f.incidentLogged),
    make: (f) => mk({
      id: 'B2', priority: 2, kind: 'write',
      title: '登记疑似产品不适事件',
      reason: '历史反馈未被正式登记，导致推荐系统仍向该消费者推送同类产品。必须补登记，才能阻断后续自动推荐。',
      tools: [{
        name: 'record_sensitive_incident',
        params: {
          consumerId: f.ctx.consumer.id,
          orderId: f.originOrder?.id,
          sku: f.sku,
          symptoms: f.need.sensitive?.hits || [],
          note: '消费者再次反馈同类不适，历史反馈未登记。',
        },
      }],
      expectedOutcome: '事件登记完成，系统标记该消费者为敏感肌关注，后续会话禁用常规产品推荐。',
      evidence: [{ source: 'ticket', ref: f.sensitiveEvent?.source_id || '—', text: f.sensitiveEvent?.evidence || '' }],
      riskIfSkipped: '不登记则推荐系统无法识别该消费者，同类推送会持续发生，形成投诉循环。',
      disclaimer: POLICIES.sensitiveDisclaimer,
    }),
  },
  {
    id: 'sensitive_escalate',
    when: (f) => Boolean(f.guardrails.blockProductRecommendation && !f.escalated),
    make: (f) => mk({
      id: 'B3', priority: 3, kind: 'write',
      title: '按安全流程升级人工处理',
      reason: '产品不适属于高敏感场景，需由具备资质的团队按业务规则处理，客服侧仅做安抚与流程引导。',
      tools: [{
        name: 'escalate_case',
        params: { consumerId: f.ctx.consumer.id, orderId: f.originOrder?.id, level: 'L2', reason: '疑似产品不适事件，需按安全处理流程跟进', target: '产品安全与质量组' },
      }],
      expectedOutcome: '由产品安全与质量组接管，客服侧停止产品推荐。',
      evidence: [{ source: 'chat', ref: '当前会话', text: f.memory.current_need?.raw_message || '' }],
      riskIfSkipped: '高敏感场景若无人工升级接管，存在合规与品牌风险。',
      disclaimer: POLICIES.sensitiveDisclaimer,
    }),
  },

  /* ── 3. 敏感事件收口 ─────────────────────────────────────── */
  {
    id: 'sensitive_wrapup',
    when: (f) => Boolean(f.guardrails.blockProductRecommendation && f.incidentLogged && f.escalated),
    make: (f) => mk({
      id: 'B4', priority: 1, kind: 'write',
      title: '关闭客服侧工单，标记问题闭环',
      reason: '事件已登记并升级至产品安全团队，客服侧职责已履行完毕，可进入闭环收口。',
      tools: [{
        name: 'close_ticket',
        params: {
          ticketId: f.incidentLogged.id,
          result: `疑似产品不适事件已登记（${f.incidentLogged.id}）并升级至 ${f.escalated.owner}，客服侧处理完毕。`,
        },
      }],
      expectedOutcome: '工单状态变为 RESOLVED，Case 进入 RESOLVED 闭环。',
      evidence: [{ source: 'ticket', ref: `工单库 / ${f.incidentLogged.id}`, text: '事件已登记' }],
      riskIfSkipped: '工单长期挂起，事件无法沉淀为服务记忆，同类问题可能再次复发。',
      disclaimer: POLICIES.sensitiveDisclaimer,
    }),
  },

  /* ── 4. 退款未到账 ───────────────────────────────────────── */
  {
    id: 'refund_check',
    when: (f) => Boolean(f.pendingRefund && !f.unfulfilled),
    make: (f) => mk({
      id: 'C1', priority: 1, kind: 'read',
      title: '查询退款处理进度',
      reason: '消费者已多次追问退款到账时间，必须先拿到真实的退款单状态，避免再次给出模糊答复。',
      tools: [
        { name: 'check_refund', params: { consumerId: f.ctx.consumer.id, orderId: f.pendingRefund.id } },
        { name: 'get_ticket_history', params: { consumerId: f.ctx.consumer.id, type: 'refund' } },
      ],
      expectedOutcome: `确认订单 ${f.pendingRefund.id} 退款单当前所处环节与预计到账时间。`,
      evidence: [{ source: 'order', ref: `订单库 / ${f.pendingRefund.id}`, text: `refundStatus=processing` }],
      riskIfSkipped: '继续模糊答复会进一步消耗信任，该消费者已出现重复进线特征。',
    }),
  },
  {
    id: 'refund_expedite',
    when: (f) => Boolean(f.pendingRefund && !f.unfulfilled && f.openTickets.length),
    make: (f) => mk({
      id: 'C2', priority: 2, kind: 'write',
      title: '加急退款并向消费者同步进度',
      reason: '退款长期停留在处理中，需要主动加急并给出明确时间点，而不是继续让用户等待。',
      conditional: '仅当查询结果显示已超出承诺处理时效时执行',
      tools: [{
        name: 'update_ticket',
        params: { ticketId: f.openTickets[0].id, status: 'PROCESSING', note: '已联系财务加急处理退款，并向消费者同步进度。' },
      }],
      expectedOutcome: '退款进入加急通道，客服可向消费者给出确定答复。',
      evidence: f.openTickets.flatMap((t) => (t.records || []).slice(-1)).map((r) => ({ source: 'ticket', ref: r.actor, text: r.note })),
      riskIfSkipped: '退款持续拖延将叠加异常退款与舆情双重风险。',
    }),
  },

  /* ── 5. 已履约待收口 ─────────────────────────────────────── */
  {
    id: 'wrapup_verify',
    when: (f) => f.closableTickets.length > 0 && f.unresolved.length <= f.closableTickets.length,
    make: (f) => mk({
      id: 'D1', priority: 1, kind: 'read',
      title: '复核补发单与物流状态',
      reason: '补发单已创建，需要向消费者确认物流单号与预计送达时间，避免出现「已处理但用户不知道」的信息差。',
      tools: [
        { name: 'check_reshipment', params: { consumerId: f.ctx.consumer.id, orderId: f.closableTickets[0].orderId } },
        { name: 'check_logistics', params: { orderId: f.reshipOrders.find((o) => o.parentOrderId === f.closableTickets[0].orderId)?.id } },
      ],
      expectedOutcome: '拿到可向消费者同步的物流信息。',
      evidence: [{ source: 'ticket', ref: `工单库 / ${f.closableTickets[0].id}`, text: f.closableTickets[0].title }],
      riskIfSkipped: '消费者无法确认处理结果，可能再次进线。',
    }),
  },
  {
    id: 'wrapup_close',
    when: (f) => Boolean(f.closableTickets.length && f.sessionReplied),
    make: (f) => mk({
      id: 'D2', priority: 2, kind: 'write',
      title: '关闭工单并标记问题已解决',
      reason: '未解决问题已在业务系统中落地，可以进入闭环收口。',
      tools: [{
        name: 'close_ticket',
        params: { ticketId: f.closableTickets[0].id, result: '补发已发出，未兑现承诺已修复，问题闭环。' },
      }],
      expectedOutcome: '工单状态变为 RESOLVED，Case 进入 RESOLVED 闭环。',
      evidence: [{ source: 'order', ref: '订单库', text: '已创建补发单并发出' }],
      riskIfSkipped: '问题虽已解决但工单长期挂起，统计口径失真，且无法沉淀为服务记忆。',
    }),
  },

  /* ── 6. 常规咨询兜底 ─────────────────────────────────────── */
  {
    id: 'routine_check',
    when: (f) => f.unresolved.length === 0,
    make: (f) => mk({
      id: 'E1', priority: 1, kind: 'read',
      title: '核对订单与商品信息后作答',
      reason: '常规咨询，先核对消费者已购商品与订单状态，避免给出与其实际情况不符的建议。',
      tools: [
        { name: 'check_order', params: { orderId: f.ctx.orders[0]?.id } },
        { name: 'get_ticket_history', params: { consumerId: f.ctx.consumer.id } },
      ],
      expectedOutcome: '确认商品信息后给出针对性建议。',
      evidence: [{ source: 'chat', ref: '当前会话', text: f.memory.current_need?.raw_message || '' }],
      riskIfSkipped: '可能出现答非所问，但风险等级较低。',
    }),
  },
];

/**
 * 必需动作（mandatory）—— 业务闭环与安全流程的硬性要求。
 *
 * 为什么需要它：真实 LLM 实测发现，把动作规划完全交给模型时，
 * 它可能漏掉「创建补发单」「关闭工单」「登记不适事件」这类**业务必需**动作，
 * 导致 Case 永远无法闭环。而这类动作恰恰是确定性注册表能保证的。
 *
 * 因此最终设计是**分层合并**：
 *   · 规则注册表 → 保证必需动作一定在（参数由规则给定，不会出错）
 *   · LLM        → 负责补充额外推理，并优化动作的标题与理由措辞
 */
const MANDATORY_IDS = new Set([
  'execute_promised_action',   // 未兑现承诺必须被执行，否则 Case 无法闭环
  'sensitive_pull_history',    // 敏感场景：先调取历史
  'sensitive_record_incident', // 安全：必须登记事件
  'sensitive_escalate',        // 安全：必须人工升级
  'sensitive_wrapup',          // 安全：客服侧收口
  'wrapup_close',              // 闭环：必须关单
]);

/* ═══════════════ 规划器 ═══════════════ */

function planDeterministic(facts) {
  const actions = [];
  for (const rule of REGISTRY) {
    if (!rule.when(facts)) continue;
    const a = rule.make(facts);
    if (!a.tools || !a.tools.length) continue;
    if (actions.some((x) => x.title === a.title)) continue;
    actions.push({ ...a, registryId: rule.id, mandatory: MANDATORY_IDS.has(rule.id) });
  }

  /* 敏感场景下，护栏动作（登记 / 升级）优先于常规履约动作 */
  const isSensitive = facts.guardrails.blockProductRecommendation;
  actions.sort((a, b) => {
    if (isSensitive) {
      const w = (x) => (x.mandatory && x.registryId.startsWith('sensitive') ? 0 : 1);
      if (w(a) !== w(b)) return w(a) - w(b);
    }
    if (a.mandatory !== b.mandatory) return a.mandatory ? -1 : 1;
    return a.priority - b.priority;
  });

  return actions.slice(0, 3).map((a, i) => ({ ...a, priority: i + 1 }));
}

/**
 * 把「规则保底计划」与「LLM 计划」合并。
 *   · 保底动作的**工具与参数**一律以规则为准（不会因模型臆造而执行错误操作）
 *   · 若模型对同一工具给出了更好的标题 / 理由，采用模型的措辞
 *   · 模型提出的、保底计划未覆盖的动作，用来填充剩余名额
 */
function mergePlans(basePlan, llmPlan) {
  const merged = basePlan.map((b) => {
    const primaryTool = b.tools[0]?.name;
    const hit = (llmPlan || []).find((l) => l.tools.some((t) => t.name === primaryTool));
    if (!hit) return b;
    return {
      ...b,
      title: hit.title || b.title,
      reason: hit.reason || b.reason,
      expectedOutcome: hit.expectedOutcome || b.expectedOutcome,
      riskIfSkipped: hit.riskIfSkipped || b.riskIfSkipped,
      wordingFrom: 'llm',
    };
  });

  for (const l of llmPlan || []) {
    if (merged.length >= 3) break;
    const toolNames = l.tools.map((t) => t.name);
    const dup = merged.some((m) => m.tools.some((t) => toolNames.includes(t.name)));
    if (dup) continue;
    merged.push(l);
  }

  /* 只读查询排在写操作之前（先看清事实再动手） */
  merged.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'read' ? -1 : 1));

  return merged.slice(0, 3).map((a, i) => ({ ...a, priority: i + 1 }));
}

/** 安全权限校验：写操作过不了权限就降级为「需人工决策」而不是静默执行 */
function applySafety(actions, facts) {
  return actions.map((a) => {
    const out = { ...a };
    out.permissions = [];
    for (const t of a.tools) {
      const p = checkWritePermission(t.name, t.params, { ctx: facts.ctx, memory: facts.memory, guardrails: facts.guardrails });
      out.permissions.push({ tool: t.name, ...p });
      if (t.name && p.requiresConfirmation) out.requiresConfirmation = true;
    }
    const denied = out.permissions.filter((p) => !p.allowed);
    if (denied.length) {
      out.blocked = true;
      out.blockedReason = denied.map((d) => d.reason).join(' ');
    }
    return out;
  });
}

export async function actionAgent(ctx, memory, need, validators, riskResult, escalation) {
  const facts = buildFacts(ctx, memory, need, validators, riskResult);
  const basePlan = planDeterministic(facts);
  const deterministicPlan = () => basePlan;

  const r = await runActionPlanning({
    ctx,
    memory,
    need,
    validations: validators,
    guardrails: riskResult.guardrails,
    availableTools: TOOL_SPECS,
    deterministicPlan,
  });

  /* 规则保底 + 模型优化 */
  const merged = r.source === 'llm' ? mergePlans(basePlan, r.value) : basePlan;
  const actions = applySafety(merged, facts);

  const banner = riskResult.guardrails.blockProductRecommendation
    ? {
        level: 'HIGH',
        text: '已触发安全护栏：本次会话禁止进行任何常规产品推荐，需按产品不适处理流程执行。',
        source: (riskResult.risks.find((x) => x.code === 'sensitive_beauty') || {}).reason || '',
      }
    : null;

  return {
    scenario: escalation.rootCause,
    actions,
    banner,
    completed: !facts.hasBlocking,
    availableTools: TOOL_SPECS,
    /* 说明规划来源，便于前端与答辩时解释「谁决定了这一步」 */
    source: r.source === 'llm' ? 'hybrid(registry-guaranteed + llm-refined)' : 'registry',
    llmContributed: r.source === 'llm' ? actions.filter((a) => a.wordingFrom === 'llm').map((a) => a.title) : [],
    classifiedBy: r.source,
  };
}
