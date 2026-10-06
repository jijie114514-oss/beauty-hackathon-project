/**
 * Business Validator —— 业务事实核验
 * ------------------------------------------------------------------
 * 本模块是「规则改造为 Validator」的核心落点。
 *
 * 铁律：**模型不判断数据库事实。**
 *   LLM 可以识别出「客服承诺了补发」并抽出 deadline；
 *   但「到底有没有真的补发」必须由这里回查业务库决定。
 *
 * 泛化设计：主题 → 工具的映射来自 schema.SUBJECT_TO_TOOL。
 *   新增一种承诺类型（如「承诺送小样」）只需在映射表里加一行，
 *   本文件与任何 Agent 都不需要改代码。
 */

import { SUBJECT_TO_TOOL, EVENT_TYPE, EVENT_STATUS } from '../schema.js';
import { invoke, TOOL_META } from '../tools/index.js';

const nowMsOf = (ctx) => new Date(ctx.now).getTime();

/**
 * 核验单条承诺事件。
 * @returns {{status:string, checks:Array, conclusion:string, blockers:Array}}
 */
export function validatePromise(event, ctx) {
  const sd = event.structured_data;
  const subject = sd.action;
  const toolName = SUBJECT_TO_TOOL[subject];
  const madeMs = new Date(event.time).getTime();
  const dueMs = sd.deadline ? new Date(sd.deadline).getTime() : null;
  const nowMs = nowMsOf(ctx);
  const overdue = dueMs !== null && nowMs > dueMs;

  /* 无对应业务表的承诺（如「稍后回复您」）—— 不可核验 */
  if (!toolName) {
    return {
      status: EVENT_STATUS.UNKNOWN,
      checks: [{
        source: 'system',
        label: '可核验性',
        value: '该承诺属于沟通类承诺，业务库中无对应可核验字段',
        pass: false,
      }],
      conclusion: '沟通类承诺无法通过订单 / 工单数据核验，需人工确认。',
      blockers: [],
    };
  }

  /* 声明式调用：主题决定查哪张表 */
  const params = {
    consumerId: ctx.consumer.id,
    orderId: sd.target_order || ctx.orders[0]?.id || null,
    sku: sd.target_sku || null,
    since: event.time,
  };
  const res = invoke(toolName, params);
  const r = res.result || {};

  const checks = [{
    source: toolName.includes('order') || toolName.includes('reshipment') ? 'order' : 'ticket',
    label: `${TOOL_META[toolName]?.label || toolName}（承诺之后）`,
    value: r.summary || (res.ok ? '已查询' : res.error),
    pass: Boolean(r.exists),
    raw: r,
  }];

  if (!res.ok) {
    return {
      status: overdue ? EVENT_STATUS.UNFULFILLED : EVENT_STATUS.PENDING,
      checks,
      conclusion: `业务系统查询失败（${res.error}），无法确认${overdue ? '承诺是否兑现' : '履约状态'}。`,
      blockers: overdue ? ['业务数据不可用，需人工核查'] : [],
    };
  }

  if (r.exists) {
    const done = r.state === 'completed';
    return {
      status: done ? EVENT_STATUS.FULFILLED : EVENT_STATUS.IN_PROGRESS,
      fulfilledAt: r.at || null,
      checks,
      conclusion: done
        ? `${r.summary}，承诺已兑现。`
        : `${r.summary}，履约进行中。`,
      blockers: [],
    };
  }

  return {
    status: overdue ? EVENT_STATUS.UNFULFILLED : EVENT_STATUS.PENDING,
    fulfilledAt: null,
    checks,
    conclusion: overdue
      ? `承诺时限（${sd.deadline_label || '未明确'}）已过，但业务库中不存在对应的${subjectLabel(subject)}记录。`
      : `承诺时限（${sd.deadline_label || '未明确'}）未到，业务库中暂未出现对应记录。`,
    blockers: overdue ? [`${subjectLabel(subject)}未执行`] : [],
  };
}

const SUBJECT_LABEL = {
  reshipment: '补发单',
  gift: '赠品补发',
  refund: '退款',
  coupon: '优惠券发放',
  compensation: '补偿发放',
};
const subjectLabel = (s) => SUBJECT_LABEL[s] || '业务记录';

/**
 * 对整份 Service Memory 做业务核验。
 * 会**就地改写**承诺事件的 status / verification，并回填 target_order。
 */
export function validateMemory(memory, ctx) {
  const checks = [];
  let unfulfilledPromise = null;

  /* 主题优先级：补发/赠品 > 退款 > 优惠券。同优先级取**最近一条**（更贴近本次进线）。 */
  const RANK = { reshipment: 3, gift: 3, refund: 2, coupon: 1, compensation: 1 };

  for (const e of memory.events) {
    if (e.type !== EVENT_TYPE.SERVICE_PROMISE) continue;

    /* 回填目标订单：LLM 可能没给出，用该消费者的订单补齐 */
    if (!e.structured_data.target_order) {
      const wrong = ctx.orders.find((o) => o.receivedSku && o.receivedSku !== o.items?.[0]?.sku);
      const target = wrong || ctx.orders.find((o) => o.type !== 'reshipment') || ctx.orders[0];
      e.structured_data.target_order = target?.id || null;
      if (!e.structured_data.target_sku) e.structured_data.target_sku = target?.items?.[0]?.sku || null;
    }

    const v = validatePromise(e, ctx);
    e.status = v.status;
    e.verification = { checks: v.checks, conclusion: v.conclusion, blockers: v.blockers, fulfilledAt: v.fulfilledAt || null };

    /* 严重度由核验结果决定 —— 未兑现才是 HIGH，不能让承诺事件永远停留在 LOW */
    e.meta.severity = v.status === EVENT_STATUS.UNFULFILLED ? 'HIGH'
      : v.status === EVENT_STATUS.IN_PROGRESS ? 'MEDIUM'
        : v.status === EVENT_STATUS.PENDING ? 'MEDIUM'
          : 'LOW';

    for (const c of v.checks) checks.push({ ...c, event_id: e.event_id });

    if (v.status === EVENT_STATUS.UNFULFILLED) {
      const rank = RANK[e.structured_data.action] || 0;
      const cur = unfulfilledPromise ? (RANK[unfulfilledPromise.structured_data.action] || 0) : -1;
      if (rank > cur || (rank === cur && String(e.time) > String(unfulfilledPromise.time))) {
        unfulfilledPromise = e;
      }
    }
  }

  return { checks, unfulfilledPromise };
}

/**
 * 收集「业务真实状态」摘要，供 LLM 归因时参考（模型只能读，不能改）。
 */
export function businessState(ctx) {
  const out = [];
  for (const o of ctx.orders) {
    out.push({
      label: `订单 ${o.id}`,
      value: `type=${o.type}｜ship=${o.shipStatus}｜refund=${o.refundStatus}｜reship=${o.reshipStatus}${o.receivedSku ? `｜received=${o.receivedSku}` : ''}`,
      pass: o.reshipStatus !== 'none' || o.refundStatus === 'done',
    });
  }
  for (const t of ctx.tickets) {
    out.push({
      label: `工单 ${t.id}`,
      value: `${t.type}｜${t.status}${t.incidentLogged === false ? '｜未登记事件' : ''}`,
      pass: t.status === 'RESOLVED',
    });
  }
  return out;
}
