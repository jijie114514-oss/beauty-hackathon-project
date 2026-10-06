/**
 * Deterministic Semantic Engine —— 确定性语义引擎（Rule Only 基线）
 * ------------------------------------------------------------------
 * 定位：LLM 不可用时的兜底，以及评估实验中的「规则基线」。
 *
 * 硬约束（本轮改造重点）：
 *   **不得出现任何针对具体消费者 / 具体场景的分支。**
 *   所有判断必须由「事件类型 + 业务主题 + 优先级注册表」驱动，
 *   因此新增 Case C（退款承诺未兑现）、Case B（优惠券未到账）等
 *   无需修改任何代码。
 */

import {
  EVENT_TYPE, EVENT_STATUS, SOURCE, SUBJECT, CONFIDENCE, makeEvent,
} from '../schema.js';
import * as LEX from './lexicon.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/* ═══════════════ 时间解析 ═══════════════ */

/** 从文本解析承诺时限。返回 {raw,dueAt,precision,label,absoluteLabel} 或 null */
export function parseDeadline(text, baseISO) {
  const base = new Date(baseISO);
  const mk = (d, precision, label, raw) => ({
    raw,
    dueAt: d.toISOString(),
    precision,
    label,
    absoluteLabel: `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  });

  const dayMap = [
    { re: /今天|今日|当天/, offset: 0, word: '今天' },
    { re: /明天|明日|次日/, offset: 1, word: '明天' },
    { re: /后天/, offset: 2, word: '后天' },
  ];
  let dayOffset = null;
  let dayWord = '';
  for (const d of dayMap) {
    if (d.re.test(text)) { dayOffset = d.offset; dayWord = d.word; break; }
  }

  const timeMatch = text.match(/(?:中午|上午|下午|晚上)?\s*(\d{1,2})\s*[点时]\s*(?:(\d{1,2})\s*分?)?\s*(?:前|之前|以内)?/) || null;

  if (dayOffset !== null && timeMatch) {
    let hour = Number(timeMatch[1]);
    if (/下午|晚上/.test(text.slice(0, timeMatch.index + 2)) && hour < 12) hour += 12;
    const minute = timeMatch[2] ? Number(timeMatch[2]) : 0;
    const d = new Date(base);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, minute, 0, 0);
    return mk(d, 'exact', `${dayWord} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} 前`, `${dayWord} ${hour} 点前`);
  }

  const hourMatch = text.match(/(\d+|[一二两三四五六七八九十]+)\s*(?:个)?\s*小时\s*(?:内|以内|之内)/);
  if (hourMatch) {
    const n = LEX.toNumber(hourMatch[1]);
    if (n) return mk(new Date(base.getTime() + n * HOUR), 'relative', `${n} 小时内`, `${n} 小时内`);
  }
  const dayMatch = text.match(/(\d+|[一二两三四五六七八九十]+)\s*(?:个)?\s*(?:工作)?天\s*(?:内|以内|之内)/);
  if (dayMatch) {
    const n = LEX.toNumber(dayMatch[1]);
    if (n) return mk(new Date(base.getTime() + n * DAY), 'relative', `${n} 天内`, `${n} 天内`);
  }

  if (dayOffset !== null) {
    const d = new Date(base);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(20, 0, 0, 0);
    return mk(d, 'day', `${dayWord} 内`, dayWord);
  }

  if (/马上|立刻|立即|尽快|第一时间/.test(text)) {
    return mk(new Date(base.getTime() + 4 * HOUR), 'vague', '尽快（未明确时限）', '尽快');
  }

  return null;
}

/* ═══════════════ 话术分类 ═══════════════ */

export function detectSubject(text) {
  for (const rule of LEX.SUBJECT_RULES) {
    if (rule.words.some((w) => text.includes(w))) return { subject: rule.subject, label: rule.label };
  }
  return { subject: SUBJECT.OTHER, label: '其他' };
}

/**
 * 话术五分类：PROMISE / ESTIMATE / ACTION / EXPLANATION / NONE
 * 注意：NONE 表示「这句话与承诺无关」，用于避免把闲聊当承诺。
 */
export function classifyUtterance(text, baseISO) {
  const has = (list) => list.filter((w) => text.includes(w));
  const promiseHits = has(LEX.PROMISE_MARKERS);
  const commitHits = has(LEX.COMMIT_ACTIONS);
  const hedgeHits = has(LEX.HEDGE_MARKERS);
  const actionHits = has(LEX.ACTION_MARKERS);
  const explainHits = has(LEX.EXPLAIN_MARKERS);

  const deadline = parseDeadline(text, baseISO);

  if (promiseHits.length && !hedgeHits.length) {
    return { category: 'PROMISE', matched: promiseHits, reason: `出现明确承诺用语「${promiseHits.join('、')}」，且未出现模糊限定词。` };
  }
  if (promiseHits.length && hedgeHits.length) {
    return { category: 'ESTIMATE', matched: [...promiseHits, ...hedgeHits], reason: `同时出现承诺用语「${promiseHits.join('、')}」与模糊限定词「${hedgeHits.join('、')}」，降级为「预计」。` };
  }
  /* 带时限的强承诺动作 —— 但只要出现模糊限定词，同样必须降级为「预计」 */
  if (commitHits.length && !hedgeHits.length && deadline && deadline.precision !== 'vague') {
    return { category: 'PROMISE', matched: commitHits, reason: `出现带明确时限的承诺动作「${commitHits.join('、')}」（时限：${deadline.label}）。` };
  }
  if (commitHits.length && hedgeHits.length) {
    return { category: 'ESTIMATE', matched: [...commitHits, ...hedgeHits], reason: `承诺动作「${commitHits.join('、')}」与模糊限定词「${hedgeHits.join('、')}」同时出现，降级为「预计」。` };
  }
  if (hedgeHits.length) {
    return { category: 'ESTIMATE', matched: hedgeHits, reason: `出现预计/模糊用语「${hedgeHits.join('、')}」，属于时效预估而非承诺。` };
  }
  if (actionHits.length) {
    return { category: 'ACTION', matched: actionHits, reason: `属于「正在为您执行」的过程性表达「${actionHits.join('、')}」，不构成结果承诺。` };
  }
  if (explainHits.length) {
    return { category: 'EXPLANATION', matched: explainHits, reason: '属于规则/流程解释性说明，不构成承诺。' };
  }

  /* 纯寒暄 / 收尾语 → 与承诺无关 */
  const closingHits = LEX.CLOSING_MARKERS.filter((w) => text.includes(w));
  if (closingHits.length && text.length <= 30) {
    return { category: 'NONE', matched: closingHits, reason: `属于寒暄 / 收尾用语「${closingHits.join('、')}」，与承诺无关。` };
  }

  /* 其余实质表述按流程说明处理 ——
     早期版本在这里直接返回 NONE，导致「退款到账时间以银行处理为准」这类
     没有命中关键词的正常业务说明被丢弃。 */
  return {
    category: 'EXPLANATION',
    matched: [],
    reason: '未匹配到承诺、预计或执行类特征，属于一般性业务说明。',
  };
}

/* ═══════════════ 事件抽取（数据投影 + 话术分类） ═══════════════ */

const fmtSku = (s) => (s && s !== '-' ? s : '');

/**
 * 把四个数据源统一投影成 Service Event。
 * 这是「LLM 抽取」的确定性等价物：LLM 走语义理解，这里走字段 + 词表。
 *
 * @param {object} ctx
 * @param {Array} [preclassified] 由 Promise Agent 给出的客服话术分类结果。
 *        传入时直接复用，保证「承诺面板」与「Service Memory 事件」不会互相打架。
 */
export function extractEvents(ctx, preclassified = null) {
  const events = [];
  /* 订单侧已产出的事件索引：`type|orderId` —— 用于避免工单侧重复计数同一问题 */
  const emitted = new Set();

  /* 话术分类索引：sessionId:messageId → 分类结果 */
  const clsIndex = new Map();
  for (const u of preclassified || []) clsIndex.set(`${u.sessionId}:${u.messageId}`, u);

  /* ── 1. 订单侧 ───────────────────────────────────────── */
  for (const o of ctx.orders) {
    const item = o.items?.[0] || {};

    if (o.type === 'reshipment') {
      events.push(makeEvent({
        type: EVENT_TYPE.RESHIPMENT,
        subtype: o.reshipStatus === 'shipped' || o.shipStatus === 'delivered' ? 'shipped' : 'created',
        time: o.createdAt,
        source: SOURCE.ORDER,
        source_id: `订单库 / ${o.id}`,
        status: o.shipStatus === 'delivered' ? EVENT_STATUS.RESOLVED : EVENT_STATUS.IN_PROGRESS,
        confidence: CONFIDENCE.HIGH,
        evidence: `补发单 ${o.id} 已创建（${o.reshipStatus}）`,
        structured_data: { action: SUBJECT.RESHIPMENT, target_order: o.id, target_sku: item.sku },
        meta: { title: `补发单已创建 · ${o.id}`, detail: `${item.product} ${fmtSku(item.shade)} ×${item.qty}（原因：${o.reason || '补发'}）`, severity: 'LOW' },
      }));
      if (o.shipStatus === 'delivered') {
        events.push(makeEvent({
          type: EVENT_TYPE.RESOLUTION,
          subtype: 'reshipment_delivered',
          time: o.deliveredAt || o.createdAt,
          source: SOURCE.ORDER,
          source_id: `物流 / ${o.logistics?.trackingNo || o.id}`,
          status: EVENT_STATUS.RESOLVED,
          confidence: CONFIDENCE.HIGH,
          evidence: o.logistics?.lastNode || '物流显示已签收',
          structured_data: { action: SUBJECT.RESHIPMENT, target_order: o.id },
          meta: { title: `补发商品已签收 · ${o.id}`, detail: o.logistics?.lastNode || '物流显示已签收', severity: 'LOW' },
        }));
      }
      continue;
    }

    events.push(makeEvent({
      type: EVENT_TYPE.RESOLUTION,
      subtype: 'order_placed',
      time: o.createdAt,
      source: SOURCE.ORDER,
      source_id: `订单库 / ${o.id}`,
      status: EVENT_STATUS.INFO,
      confidence: CONFIDENCE.HIGH,
      evidence: `下单 ${item.product}｜SKU ${item.sku}`,
      structured_data: { target_order: o.id, target_sku: item.sku },
      meta: { title: `下单 · ${item.product}`, detail: `${fmtSku(item.shade)}｜SKU ${item.sku}｜¥${o.amount}`, severity: 'LOW' },
    }));

    if (o.receivedSku && o.receivedSku !== item.sku) {
      const covered = ctx.tickets.some((t) => t.orderId === o.id && ['wrong_item', 'reshipment'].includes(t.type));
      events.push(makeEvent({
        type: EVENT_TYPE.WRONG_SKU,
        subtype: 'received_mismatch',
        time: o.deliveredAt || o.createdAt,
        source: SOURCE.ORDER,
        source_id: `订单库 / ${o.id}`,
        /* 已有工单记录时，未解决状态由工单事件承载，避免同一问题被计两次 */
        status: covered ? EVENT_STATUS.INFO : EVENT_STATUS.OPEN,
        confidence: CONFIDENCE.HIGH,
        evidence: `下单为 ${item.shade}（${item.sku}），实收为 ${o.receivedShade}（${o.receivedSku}）`,
        structured_data: { target_order: o.id, target_sku: item.sku, action: SUBJECT.RESHIPMENT },
        meta: { title: `实收商品与订单不一致 · ${o.id}`, detail: `下单 ${item.shade}（${item.sku}），实收 ${o.receivedShade}（${o.receivedSku}）`, severity: 'HIGH' },
      }));
    }

    if (o.refundStatus === 'processing') {
      emitted.add(`refund|${o.id}`);
      events.push(makeEvent({
        type: EVENT_TYPE.REFUND,
        subtype: 'processing',
        time: o.refundRequestedAt || o.createdAt,
        source: SOURCE.ORDER,
        source_id: `订单库 / ${o.id}`,
        status: EVENT_STATUS.OPEN,
        confidence: CONFIDENCE.HIGH,
        evidence: `¥${o.amount} 退款自 ${(o.refundRequestedAt || o.createdAt).slice(0, 10)} 起处于处理中，尚未到账`,
        structured_data: { action: SUBJECT.REFUND, target_order: o.id, amount: o.amount },
        meta: { title: `退款处理中 · ${o.id}`, detail: `退款金额 ¥${o.amount}，尚未到账`, severity: 'MEDIUM' },
      }));
    } else if (o.refundStatus === 'done') {
      events.push(makeEvent({
        type: EVENT_TYPE.REFUND,
        subtype: 'done',
        time: o.refundedAt || o.createdAt,
        source: SOURCE.ORDER,
        source_id: `订单库 / ${o.id}`,
        status: EVENT_STATUS.RESOLVED,
        confidence: CONFIDENCE.HIGH,
        evidence: `退款 ¥${o.amount} 已完成`,
        structured_data: { action: SUBJECT.REFUND, target_order: o.id, amount: o.amount },
        meta: { title: `退款已完成 · ${o.id}`, detail: `退款金额 ¥${o.amount}`, severity: 'LOW' },
      }));
    }
  }

  /* ── 2. 会话侧：进线 + 客服话术分类 ───────────────────── */
  for (const s of ctx.sessions) {
    const firstConsumer = s.messages.find((m) => m.role === 'consumer');
    if (firstConsumer) {
      events.push(makeEvent({
        type: EVENT_TYPE.USER_ISSUE,
        subtype: s.isCurrent ? 'recontact' : 'contact',
        time: s.startedAt,
        source: SOURCE.CHAT,
        source_id: `会话 / ${s.id}`,
        status: EVENT_STATUS.INFO,
        confidence: CONFIDENCE.HIGH,
        evidence: firstConsumer.text,
        structured_data: {},
        meta: {
          title: s.isCurrent ? '消费者再次进线（当前会话）' : '消费者进线咨询',
          detail: firstConsumer.text.length > 46 ? `${firstConsumer.text.slice(0, 46)}…` : firstConsumer.text,
          severity: 'LOW',
        },
      }));
    }

    for (const msg of s.messages) {
      if (msg.role !== 'agent') continue;

      const pre = clsIndex.get(`${s.id}:${msg.id}`);
      const cls = pre
        ? { category: pre.category, reason: pre.classifierReason, matched: pre.matched || [] }
        : classifyUtterance(msg.text, msg.at);

      if (cls.category === 'NONE' || cls.category === 'EXPLANATION') continue;
      const subject = pre?.subject || detectSubject(msg.text).subject;
      const label = pre?.subjectLabel || detectSubject(msg.text).label;
      const deadline = pre?.deadline !== undefined
        ? pre.deadline
        : (cls.category === 'PROMISE' || cls.category === 'ESTIMATE' ? parseDeadline(msg.text, msg.at) : null);

      const isPromise = cls.category === 'PROMISE';
      const isEstimate = cls.category === 'ESTIMATE';

      events.push(makeEvent({
        type: isPromise ? EVENT_TYPE.SERVICE_PROMISE : isEstimate ? EVENT_TYPE.ESTIMATED_TIMELINE : EVENT_TYPE.SERVICE_ACTION,
        subtype: subject,
        time: msg.at,
        source: SOURCE.CHAT,
        source_id: `会话 / ${s.id} · ${s.agentName}`,
        /* 承诺先置 pending，由 Validator 依据业务数据改写为 fulfilled / unfulfilled */
        status: isPromise ? EVENT_STATUS.PENDING : EVENT_STATUS.INFO,
        confidence: CONFIDENCE.MEDIUM,
        evidence: msg.text,
        structured_data: {
          action: subject,
          deadline: deadline?.dueAt || null,
          deadline_label: deadline?.absoluteLabel || deadline?.label || null,
          target_order: null,
        },
        raw: { category: cls.category, reason: cls.reason, matched: cls.matched, subjectLabel: label },
        meta: {
          title: isPromise ? `客服承诺 · ${label}` : isEstimate ? `客服预计 · ${label}` : `客服执行动作 · ${label}`,
          detail: `「${msg.text}」${deadline ? `｜时限：${deadline.absoluteLabel}` : ''}`,
          severity: 'LOW',
          agentName: s.agentName,
          sessionId: s.id,
        },
      }));
    }
  }

  /* ── 3. 工单侧 ────────────────────────────────────────── */
  for (const t of ctx.tickets) {
    const typeMap = {
      wrong_item: EVENT_TYPE.WRONG_ITEM,
      refund: EVENT_TYPE.REFUND,
      reshipment: EVENT_TYPE.RESHIPMENT,
      sensitive_skin: EVENT_TYPE.SENSITIVE_BEAUTY_INCIDENT,
      sensitive_incident: EVENT_TYPE.SENSITIVE_BEAUTY_INCIDENT,
      compensation: EVENT_TYPE.RESOLUTION,
      escalation: EVENT_TYPE.RESOLUTION,
    };
    const evType = typeMap[t.type] || EVENT_TYPE.UNRESOLVED_ISSUE;
    const resolved = t.status === 'RESOLVED';
    /* 订单侧已就同一问题产出事件时，工单侧只作记录，避免同一问题被计两次未解决 */
    const duplicated = Boolean(t.orderId) && emitted.has(`${evType === EVENT_TYPE.REFUND ? 'refund' : evType}|${t.orderId}`);

    /* 敏感类事件：登记与否决定它是不是未解决项 */
    if (evType === EVENT_TYPE.SENSITIVE_BEAUTY_INCIDENT) {
      const logged = t.incidentLogged === true;
      events.push(makeEvent({
        type: EVENT_TYPE.SENSITIVE_BEAUTY_INCIDENT,
        subtype: logged ? 'logged' : 'unlogged',
        time: t.createdAt,
        source: SOURCE.TICKET,
        source_id: `工单库 / ${t.id}`,
        status: logged ? (resolved ? EVENT_STATUS.RESOLVED : EVENT_STATUS.IN_PROGRESS) : EVENT_STATUS.OPEN,
        confidence: CONFIDENCE.HIGH,
        evidence: `${t.title}｜状态 ${t.status}｜${t.result || '（无处理结论）'}`,
        structured_data: { target_ticket: t.id, target_order: t.orderId, symptoms: (t.records || []).map((r) => r.note).join(' ') ? [] : [] },
        meta: {
          title: `历史产品不适反馈 · ${t.id}`,
          detail: logged
            ? `事件已登记（${t.status}）。`
            : `仅按常规售后办理退款，未登记为产品不适事件 —— 推荐系统因此无法识别该消费者。`,
          severity: logged ? 'MEDIUM' : 'HIGH',
          incidentLogged: logged,
        },
      }));
      continue;
    }

    events.push(makeEvent({
      type: evType,
      subtype: t.type,
      time: t.createdAt,
      source: SOURCE.TICKET,
      source_id: `工单库 / ${t.id}`,
      status: duplicated ? EVENT_STATUS.INFO : resolved ? EVENT_STATUS.RESOLVED : (t.status === 'PROCESSING' ? EVENT_STATUS.IN_PROGRESS : EVENT_STATUS.OPEN),
      confidence: CONFIDENCE.HIGH,
      evidence: `${t.title}｜状态 ${t.status}｜${t.result || (t.records || []).slice(-1)[0]?.note || ''}`,
      structured_data: { target_ticket: t.id, target_order: t.orderId },
      meta: {
        title: `工单创建 · ${t.title}`,
        detail: `类型 ${t.type}｜状态 ${t.status}｜负责人 ${t.owner}`,
        severity: t.priority === 'P0' || t.priority === 'P1' ? 'HIGH' : 'MEDIUM',
        owner: t.owner,
      },
    }));
  }

  /* ── 4. 系统侧 ────────────────────────────────────────── */
  for (const e of ctx.systemEvents) {
    events.push(makeEvent({
      type: e.type === 'product_push' ? EVENT_TYPE.USER_ISSUE : EVENT_TYPE.RESOLUTION,
      subtype: e.type,
      time: e.at,
      source: SOURCE.SYSTEM,
      source_id: `系统事件 / ${e.id}`,
      status: EVENT_STATUS.INFO,
      confidence: CONFIDENCE.HIGH,
      evidence: e.detail,
      structured_data: { target_order: e.relatedOrder },
      meta: { title: e.title, detail: e.detail, severity: 'LOW' },
    }));
  }

  return events;
}

/* ═══════════════ 当前诉求理解 ═══════════════ */

export function inferNeed(currentMessage, ctx) {
  const text = (currentMessage || '').trim();
  const priorMessages = ctx.sessions
    .filter((s) => !s.isCurrent)
    .flatMap((s) => s.messages.filter((m) => m.role === 'consumer'));

  const constraints = [];
  for (const rule of LEX.CONSTRAINT_RULES) {
    const m = text.match(rule.re);
    if (m && !constraints.some((c) => c.label === rule.label)) {
      constraints.push({ type: 'time', label: rule.label, implication: rule.implication, evidence: m[0] });
    }
  }
  if (/再收不到我就|不然我就|否则我就/.test(text)) {
    constraints.push({ type: 'threat', label: '用户设置了后果条件', implication: '若不满足将触发升级行为（曝光 / 投诉）', evidence: (text.match(/再收不到我就[^。！？]*/) || [''])[0] });
  }

  let level = '正常';
  const matched = [];
  for (const rule of LEX.EMOTION_RULES) {
    const hits = rule.words.filter((w) => text.includes(w));
    if (hits.length) {
      matched.push(...hits);
      if (LEX.EMOTION_RANK[rule.level] > LEX.EMOTION_RANK[level]) level = rule.level;
    }
  }
  const priorLevels = priorMessages.map((m) => {
    let l = '正常';
    for (const rule of LEX.EMOTION_RULES) {
      if (rule.words.some((w) => m.text.includes(w)) && LEX.EMOTION_RANK[rule.level] > LEX.EMOTION_RANK[l]) l = rule.level;
    }
    return l;
  });
  const baseline = priorLevels.length ? priorLevels.reduce((a, b) => (LEX.EMOTION_RANK[a] >= LEX.EMOTION_RANK[b] ? a : b), '正常') : '正常';

  const sensitiveHits = LEX.SENSITIVE_WORDS.filter((w) => text.includes(w));

  const needRule = LEX.NEED_RULES.find((r) => r.re.test(text));
  const timeConstraint = constraints.find((c) => c.type === 'time');
  let realNeed = needRule ? needRule.need : '希望获得明确的处理结论';
  if (needRule && timeConstraint) realNeed = `${needRule.need}，且必须在「${timeConstraint.label}」之前完成`;
  else if (!needRule && timeConstraint) realNeed = '希望问题在明确的时间点之前得到解决';

  const surfaceIssue = needRule
    ? needRule.surface
    : text ? text.slice(0, 60) : '（暂无新消息）';

  const urgency = constraints.some((c) => c.type === 'threat') || LEX.EMOTION_RANK[level] >= 2
    ? 'high'
    : constraints.length || LEX.EMOTION_RANK[level] === 1 ? 'medium' : 'low';

  return {
    surface_issue: surfaceIssue,
    real_need: realNeed,
    constraints: constraints.map((c) => c.label),
    constraints_detail: constraints,
    urgency,
    emotion: {
      level,
      baseline,
      escalated: LEX.EMOTION_RANK[level] > LEX.EMOTION_RANK[baseline],
      matched: [...new Set(matched)],
      basis: matched.length ? `匹配到情绪特征词「${[...new Set(matched)].join('、')}」` : '未匹配到明显情绪特征词，按正常处理',
      note: '情绪为粗粒度判断，不输出概率或百分比数值。',
    },
    sensitive: { isSensitive: sensitiveHits.length > 0, hits: sensitiveHits },
    source: 'deterministic',
  };
}

/* ═══════════════ 升级归因（注册表驱动，无场景分支） ═══════════════ */

/**
 * 根因注册表 —— 按优先级排列的**声明式**规则。
 * 新增业务场景只需要往这里加一条，不需要写 if-else。
 */
const ROOT_CAUSE_REGISTRY = [
  {
    id: 'unfulfilled_promise',
    match: (f) => Boolean(f.unfulfilledPromise),
    label: (f) => `历史客服承诺未兑现（${f.unfulfilledPromise.raw?.subjectLabel || f.unfulfilledPromise.subtype}）`,
    issue: (f) => `${f.unfulfilledPromise.raw?.subjectLabel || '承诺'}未执行`,
  },
  {
    id: 'sensitive_incident',
    match: (f) => Boolean(f.unloggedSensitive),
    label: () => '历史产品不适反馈未闭环',
    issue: () => '疑似产品不适事件未被正式登记',
  },
  {
    id: 'refund_delay',
    match: (f) => Boolean(f.pendingRefund),
    label: () => '售后流程推进缓慢',
    issue: () => '退款长时间未到账',
  },
  {
    id: 'unresolved_wrong_item',
    match: (f) => Boolean(f.openWrongItem),
    label: () => '发货错误未处理完毕',
    issue: () => '商品与订单不一致尚未解决',
  },
  {
    id: 'repeat_contact',
    /**
     * 重复进线本身就是根因 —— 它意味着前一次接触没有真正解决问题，
     * **不需要**额外存在一条「正式未解决项」才算。
     * （早期版本要求 hasOpenIssue，导致「连续三次追问却无人明确答复」被误判为常规咨询。）
     */
    match: (f) => f.repeatContact,
    label: () => '前次处理未真正解决问题',
    issue: (f) => f.openIssueTitles[0] || '消费者短期内重复进线，前次答复未解决问题',
  },
  {
    id: 'new_inquiry',
    match: () => true,
    label: () => '常规咨询，无历史遗留问题',
    issue: (f) => f.surfaceIssue,
  },
];

export function reasonEscalation({ memory, need, ctx, validations }) {
  const unresolved = memory.unresolved_issues;
  const byKind = (k) => unresolved.find((u) => u.kind === k);

  /* 兼容两种 need 形状 */
  const surfaceText = need.surfaceIssue?.text || need.surface_issue || '';
  const constraintLabels = (need.constraints || []).map((c) => (typeof c === 'string' ? c : c.label)).filter(Boolean);
  const emotion = need.emotion || { level: '正常', baseline: '正常', escalated: false };

  const unfulfilledPromise = validations?.unfulfilledPromise || null;
  const unloggedSensitive = byKind(EVENT_TYPE.SENSITIVE_BEAUTY_INCIDENT);
  const pendingRefund = byKind(EVENT_TYPE.REFUND);
  const openWrongItem = byKind(EVENT_TYPE.WRONG_ITEM) || byKind(EVENT_TYPE.WRONG_SKU);

  const contactSessions = ctx.sessions.filter((s) => s.messages.some((m) => m.role === 'consumer'));
  const nowMs = new Date(ctx.now).getTime();
  const recent = contactSessions.filter((s) => nowMs - new Date(s.startedAt).getTime() <= 7 * DAY);
  const repeatContact = recent.length >= 2;

  const facts = {
    unfulfilledPromise,
    unloggedSensitive,
    pendingRefund,
    openWrongItem,
    repeatContact,
    hasOpenIssue: unresolved.length > 0,
    openIssueTitles: unresolved.map((u) => u.title),
    surfaceIssue: surfaceText,
  };

  const hit = ROOT_CAUSE_REGISTRY.find((r) => r.match(facts));

  /* 次要原因：由事实推导，不写死 */
  const secondary = [];
  if (repeatContact) secondary.push(`近 7 天内进线 ${recent.length} 次，属于重复进线`);
  if (constraintLabels.length) secondary.push(`消费者附加约束：${constraintLabels.join('、')}`);
  if (emotion.escalated) secondary.push(`当前情绪等级「${emotion.level}」高于历史基线「${emotion.baseline}」`);
  if (unloggedSensitive) secondary.push('历史产品不适反馈未登记，推荐系统仍在推送同类产品');
  if (pendingRefund && unfulfilledPromise) secondary.push('同时存在未到账退款');

  /* 证据事件 ID —— 指向具体 Service Event，可回溯 */
  const evidenceEventIds = [];
  if (unfulfilledPromise?.event_id) evidenceEventIds.push(unfulfilledPromise.event_id);
  for (const u of unresolved.slice(0, 3)) evidenceEventIds.push(u.event_id);

  /* 认知落差对照表：仅在存在「消费者认知 ≠ 系统真实状态」时生成 */
  const comparison = [];
  if (unfulfilledPromise) {
    const sd = unfulfilledPromise.structured_data;
    comparison.push({
      dimension: `${unfulfilledPromise.raw?.subjectLabel || '履约'}状态`,
      consumerBelief: `客服已承诺${sd.deadline_label ? `在 ${sd.deadline_label}` : '尽快'}完成${unfulfilledPromise.raw?.subjectLabel || ''}`,
      systemTruth: unfulfilledPromise.verification?.conclusion || '业务库中无对应完成记录',
      gap: true,
    });
  }
  if (unloggedSensitive) {
    comparison.push({
      dimension: '产品使用反馈',
      consumerBelief: '使用该产品后出现皮肤不适',
      systemTruth: '历史同类反馈仅按普通售后办理退款，未登记为产品不适事件',
      gap: true,
    });
    comparison.push({
      dimension: '推荐系统行为',
      consumerBelief: '不希望再收到同类产品推荐',
      systemTruth: '系统近期仍向其推送了同系列产品',
      gap: true,
    });
  }
  if (pendingRefund) {
    comparison.push({
      dimension: '退款进度',
      consumerBelief: '以为已经在处理中，等待到账即可',
      systemTruth: pendingRefund.detail,
      gap: true,
    });
  }

  const highConfidence = Boolean(unfulfilledPromise || unloggedSensitive);

  return {
    primary_reason: hit.id,
    rootCause: hit.id,
    rootCauseLabel: hit.label(facts),
    currentIssue: hit.issue(facts),
    secondary_reasons: secondary,
    evidence_event_ids: evidenceEventIds,
    comparison,
    confidence: {
      level: highConfidence ? 'HIGH' : unresolved.length ? 'MEDIUM' : 'HIGH',
      reason: highConfidence
        ? '承诺原文、时限与业务库核验结果三者可直接互证。'
        : unresolved.length ? '可证未解决项存在，但缺少可直接互证的承诺原文。' : '历史会话与工单均无未解决项。',
    },
    summary: `${hit.label(facts)}。${secondary.length ? '次要原因：' + secondary.join('；') + '。' : ''}`,
    isLogisticsIssue: false,
    trigger: repeatContact ? 'consumer_recontact' : 'new_inquiry',
    source: 'deterministic',
  };
}

/* ═══════════════ 回复生成（通用组装，无场景模板） ═══════════════ */

/**
 * 通用回复组装器。
 * 遵循 7 条原则，但句子由**结构化事实槽位**拼装，不含任何场景专用文案。
 */
export function composeReply({ ctx, memory, need, escalation, validations, actions }) {
  const name = ctx.consumer.name;
  const lines = [];

  /* 兼容两种 need 形状：语义层原始输出 / Intent Agent 输出 */
  const surface = need.surfaceIssue?.text || need.surface_issue || '';
  const realNeed = need.realNeed?.text || need.real_need || '';
  const constraintsDetail = (need.constraints_detail || need.constraints || []).filter((c) => c && c.label);
  const sensitive = need.sensitive || { isSensitive: false, hits: [] };

  /* 1) 接住当前处境 */
  const primary = memory.unresolved_issues[0] || null;
  const situation = surface ? surface.replace(/^消费者(在)?/, '您') : '您反馈的问题';
  lines.push(`${name}您好，您的情况我已经看过了，${situation}——不用再重复说明。`);

  /* 2) 明确具体发生了什么（来自核验事实，不是模板） */
  const up = validations?.unfulfilledPromise;
  if (up) {
    const sd = up.structured_data;
    const conclusion = String(up.verification?.conclusion || '并没有找到对应的完成记录').replace(/[。；;]\s*$/, '');
    lines.push(
      `先跟您说清楚现在的事实：${String(up.evidence).replace(/[。；;]\s*$/, '')}${sd.deadline_label ? `（承诺时限 ${sd.deadline_label}）` : ''}。` +
      `但我刚查了业务系统，${conclusion}。` +
      `也就是说，这次不是物流慢，是我们答应的事没有落地。`,
    );
  } else if (primary) {
    lines.push(`先说事实：${String(primary.detail).replace(/[。；;]\s*$/, '')}。`);
  }

  /* 3) 不重复询问已知信息 —— 明确告知已掌握的信息 */
  if (up?.structured_data?.target_order) {
    lines.push(`您这笔订单（${up.structured_data.target_order}）以及之前的沟通记录我都已经调出来了，不需要您再提供。`);
  }

  /* 4) 告诉用户当前准备做什么 */
  const firstAction = (actions || []).find((a) => a.priority === 1) || (actions || [])[0];
  if (firstAction) {
    lines.push(`我现在要做的是：${firstAction.title}。${firstAction.expectedOutcome ? `（${firstAction.expectedOutcome}）` : ''}`);
  }

  /* 5) 接住时间约束，但不制造新的无法保证的承诺 */
  const timeConstraint = constraintsDetail.find((c) => c.type === 'time');
  if (timeConstraint) {
    lines.push(`您提到「${timeConstraint.label}」，这个时间点我记下了，会按最紧的时效去推，但结果我会第一时间如实告诉您，不会先给您一个我保证不了的时间。`);
  }

  /* 6) 敏感场景：护栏 + 不做医学判断 */
  if (sensitive.isSensitive) {
    lines.push(`另外，关于您反馈的${sensitive.hits.join('、')}，我不会再向您推荐任何产品。我会把这次情况正式登记为产品不适事件，转给产品安全团队按流程跟进。`);
    lines.push(`在您皮肤还有不适的期间，建议先停用相关产品；如果需要处理建议，请咨询专业医生——我们这边不做医学判断。`);
  }

  /* 7) 收尾：不空洞道歉 */
  lines.push(`后续每一步我都会同步给您，有问题您随时说。`);

  return lines.join('\n');
}
