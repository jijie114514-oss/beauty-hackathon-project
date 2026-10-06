/**
 * Tool 层 —— Mock Business APIs
 * ------------------------------------------------------------------
 * 这里是「Agent 执行层」。AI 的 Next Best Action 只有经过人工客服确认后，
 * 才会调用这里的工具。每个工具都会**真实改变**内存数据库状态，
 * 并返回 effects（状态变更摘要），供前端展示「工单状态更新 / Service Memory 重算」。
 *
 * 关键原则：确定性数据只由 Tool 提供，模型不参与生成。
 */

import * as store from '../store.js';

const ts = () => new Date().toISOString();

/* ── 工具调用日志（可观测性：Agent 到底调了什么、返回了什么） ── */
const callLog = [];
const MAX_LOG = 500;
function logCall(entry) {
  callLog.push({ at: ts(), ...entry });
  if (callLog.length > MAX_LOG) callLog.shift();
}
export const getToolLog = (n = 100) => callLog.slice(-n);
export const clearToolLog = () => { callLog.length = 0; };

/* ── 库存（Mock 仓储） ─────────────────────────────────────── */
const INVENTORY = {
  'FD-1024-01': { name: '轻雾持妆粉底液 · 冷调象牙白 01', stock: 42, warehouse: '华东仓（杭州）' },
  'FD-1024-02': { name: '轻雾持妆粉底液 · 暖调自然色 02', stock: 6, warehouse: '华东仓（杭州）' },
  'FD-1024-03': { name: '轻雾持妆粉底液 · 自然偏粉 03', stock: 0, warehouse: '华东仓（杭州）' },
  'FD-2201-03': { name: '丝绒雾感粉底液 · 自然色 03', stock: 0, warehouse: '华南仓（广州）' },
  'CC-3310-02': { name: '柔光遮瑕膏 · 自然色 02', stock: 88, warehouse: '华东仓（杭州）' },
  'GIFT-BRUSH-01': { name: '赠品 · 粉底刷', stock: 210, warehouse: '华东仓（杭州）' },
};

/* ── 履约时效（Mock 承运商 SLA） ───────────────────────────── */
const FULFILLMENT = {
  sameCity: { label: '同城当日达', cutoff: '17:00', eta: '今日 21:00 前' },
  intraProvince: { label: '省内次日达', cutoff: '18:00', eta: '次日 12:00 前' },
  crossProvince: { label: '跨省次日达（空运）', cutoff: '15:00', eta: '次日 18:00 前' },
  standard: { label: '标准快递', cutoff: '20:00', eta: '2-3 天' },
};

const ok = (tool, params, result, effects = []) => ({
  ok: true,
  tool,
  params,
  result,
  effects,
  at: ts(),
});

const fail = (tool, params, message) => ({
  ok: false,
  tool,
  params,
  error: message,
  effects: [],
  at: ts(),
});

/* ═══════════════════════════════════════════════════════════
 * 查询类工具（只读）
 * ═══════════════════════════════════════════════════════════ */

export function check_order({ orderId }) {
  const order = store.getOrder(orderId);
  if (!order) return fail('check_order', { orderId }, `未找到订单 ${orderId}`);
  return ok(
    'check_order',
    { orderId },
    {
      orderId: order.id,
      type: order.type,
      items: order.items,
      amount: order.amount,
      payStatus: order.payStatus,
      shipStatus: order.shipStatus,
      refundStatus: order.refundStatus,
      reshipStatus: order.reshipStatus,
      receivedSku: order.receivedSku || null,
      createdAt: order.createdAt,
      deliveredAt: order.deliveredAt || null,
    },
  );
}

export function check_inventory({ sku, qty = 1 }) {
  const item = INVENTORY[sku];
  if (!item) return fail('check_inventory', { sku }, `SKU ${sku} 不在库存系统中`);
  const available = item.stock >= qty;
  return ok(
    'check_inventory',
    { sku, qty },
    {
      sku,
      name: item.name,
      stock: item.stock,
      warehouse: item.warehouse,
      available,
      shortfall: available ? 0 : qty - item.stock,
    },
    available
      ? []
      : [{ target: 'inventory', field: 'availability', to: `库存不足（仅 ${item.stock} 件）` }],
  );
}

export function check_logistics({ orderId }) {
  const order = store.getOrder(orderId);
  if (!order) return fail('check_logistics', { orderId }, `未找到订单 ${orderId}`);
  if (!order.logistics) {
    return fail('check_logistics', { orderId }, `订单 ${orderId} 尚无物流记录（可能未发货）`);
  }
  return ok('check_logistics', { orderId }, { orderId, ...order.logistics });
}

/** 计算某 SKU 到某城市的最快履约方式 */
export function estimate_fulfillment({ sku, city, sameCity = false }) {
  const item = INVENTORY[sku];
  const plan = sameCity ? FULFILLMENT.sameCity : FULFILLMENT.intraProvince;
  return ok('estimate_fulfillment', { sku, city }, {
    sku,
    city,
    plan: plan.label,
    cutoff: plan.cutoff,
    eta: plan.eta,
    stock: item ? item.stock : 0,
    warehouse: item ? item.warehouse : '未知',
  });
}

export function get_ticket_history({ consumerId, type }) {
  let list = store.ticketsOf(consumerId);
  if (type) list = list.filter((t) => t.type === type);
  return ok(
    'get_ticket_history',
    { consumerId, type: type || null },
    {
      count: list.length,
      tickets: list.map((t) => ({
        id: t.id,
        type: t.type,
        title: t.title,
        status: t.status,
        createdAt: t.createdAt,
        result: t.result,
        incidentLogged: t.incidentLogged ?? null,
      })),
    },
  );
}

/* ── 承诺核验类查询（Validator 专用） ──────────────────────
 * 这三个工具是「LLM 抽取承诺 → 规则核验事实」链路的关键一环：
 * 模型只负责说「客服承诺了什么」，是否真的发生由这里回答。
 * 统一返回 { exists, state, at, summary }，便于 Validator 泛化处理。
 */

const sinceOf = (since) => (since ? new Date(since).getTime() : 0);

/** 查该消费者在某个时间点之后是否真的存在补发单 */
export function check_reshipment({ consumerId, orderId = null, sku = null, since = null }) {
  const after = sinceOf(since);
  const candidates = store
    .ordersOf(consumerId)
    .filter((o) => o.type === 'reshipment')
    .filter((o) => new Date(o.createdAt).getTime() >= after - 60_000);

  /* 精确匹配优先；精确匹配为空时退回「该时间点之后的任意补发单」，
     避免因为 LLM 没给出目标订单号 / SKU 而误判为「未兑现」。 */
  const exact = candidates
    .filter((o) => (orderId ? o.parentOrderId === orderId : true))
    .filter((o) => (sku ? o.items?.[0]?.sku === sku : true));
  const list = exact.length ? exact : candidates;

  if (!list.length) {
    return ok('check_reshipment', { consumerId, orderId, sku, since }, {
      exists: false,
      state: 'missing',
      at: null,
      summary: '订单库中不存在对应的补发单（reshipStatus = none）',
      scannedOrders: store.ordersOf(consumerId).length,
    });
  }

  const o = list[0];
  const completed = o.reshipStatus === 'shipped' || o.reshipStatus === 'done' || o.shipStatus === 'delivered';
  return ok('check_reshipment', { consumerId, orderId, sku, since }, {
    exists: true,
    state: completed ? 'completed' : 'in_progress',
    at: o.createdAt,
    orderId: o.id,
    reshipStatus: o.reshipStatus,
    trackingNo: o.logistics?.trackingNo || null,
    summary: completed
      ? `补发单 ${o.id} 已创建并发出（${o.logistics?.trackingNo || '单号待分配'}）`
      : `补发单 ${o.id} 已创建，正在履约中`,
    orders: list.map((x) => x.id),
  });
}

/** 查该消费者在某个时间点之后是否真的有退款记录 */
export function check_refund({ consumerId, orderId = null, since = null }) {
  const after = sinceOf(since);
  const all = store.ordersOf(consumerId).filter((o) => (orderId ? o.id === orderId : true));

  const done = all.filter(
    (o) => o.refundStatus === 'done' && o.refundedAt && new Date(o.refundedAt).getTime() >= after - 60_000,
  );
  if (done.length) {
    return ok('check_refund', { consumerId, orderId, since }, {
      exists: true,
      state: 'completed',
      at: done[0].refundedAt,
      orderId: done[0].id,
      amount: done[0].amount,
      summary: `退款 ¥${done[0].amount} 已于 ${done[0].refundedAt.slice(0, 10)} 完成（${done[0].id}）`,
      orders: done.map((x) => x.id),
    });
  }

  const processing = all.filter((o) => o.refundStatus === 'processing');
  if (processing.length) {
    return ok('check_refund', { consumerId, orderId, since }, {
      exists: true,
      state: 'in_progress',
      at: processing[0].refundRequestedAt || processing[0].createdAt,
      orderId: processing[0].id,
      amount: processing[0].amount,
      summary: `退款 ¥${processing[0].amount} 处理中（${processing[0].id}），尚未到账`,
      orders: processing.map((x) => x.id),
    });
  }

  return ok('check_refund', { consumerId, orderId, since }, {
    exists: false,
    state: 'missing',
    at: null,
    summary: '订单库中不存在对应的退款记录（refundStatus = none）',
  });
}

/** 查该消费者在某个时间点之后是否真的发放过优惠券 / 补偿 */
export function check_coupon({ consumerId, since = null }) {
  const after = sinceOf(since);
  const list = store
    .ticketsOf(consumerId)
    .filter((t) => t.type === 'compensation')
    .filter((t) => new Date(t.createdAt).getTime() >= after - 60_000);

  if (!list.length) {
    return ok('check_coupon', { consumerId, since }, {
      exists: false,
      state: 'missing',
      at: null,
      summary: '工单库中不存在对应的补偿 / 优惠券发放记录',
    });
  }
  return ok('check_coupon', { consumerId, since }, {
    exists: true,
    state: 'completed',
    at: list[0].createdAt,
    ticketId: list[0].id,
    summary: `补偿已发放（工单 ${list[0].id}）：${list[0].result || ''}`,
    tickets: list.map((t) => t.id),
  });
}

/* ═══════════════════════════════════════════════════════════
 * 写操作工具（改变业务状态）
 * ═══════════════════════════════════════════════════════════ */

export function create_ticket({
  consumerId,
  orderId = null,
  type = 'other',
  title = '客服创建工单',
  priority = 'P2',
  note = '',
  owner = '客服-当前坐席',
}) {
  const ticket = store.addTicket({
    id: store.nextId('TK'),
    consumerId,
    orderId,
    type,
    title,
    status: 'OPEN',
    priority,
    owner,
    createdAt: ts(),
    updatedAt: ts(),
    result: null,
    records: [{ at: ts(), actor: owner, note: note || '工单已创建。' }],
  });
  return ok(
    'create_ticket',
    { consumerId, orderId, type, priority },
    { ticketId: ticket.id, status: ticket.status, type: ticket.type, title: ticket.title },
    [
      { target: 'ticket', id: ticket.id, field: 'status', to: 'OPEN' },
      { target: 'case', field: 'status', to: 'PROCESSING' },
    ],
  );
}

export function update_ticket({ ticketId, status, note = '', actor = '客服-当前坐席', result = null }) {
  const ticket = store.getTicket(ticketId);
  if (!ticket) return fail('update_ticket', { ticketId }, `未找到工单 ${ticketId}`);
  ticket.records = ticket.records || [];
  ticket.records.push({ at: ts(), actor, note: note || `工单状态更新为 ${status}` });
  ticket.status = status;
  ticket.updatedAt = ts();
  if (result) ticket.result = result;
  return ok(
    'update_ticket',
    { ticketId, status },
    { ticketId, status: ticket.status, result: ticket.result },
    [{ target: 'ticket', id: ticketId, field: 'status', to: status }],
  );
}

export function close_ticket({ ticketId, result = '问题已解决，工单关闭。', actor = '客服-当前坐席' }) {
  return update_ticket({ ticketId, status: 'RESOLVED', note: result, actor, result });
}

/**
 * 创建补发单 —— Demo 的核心写操作。
 * 成功后会真实写入一张 type=reshipment 的订单，并联动原订单的 reshipStatus。
 */
export function request_reshipment({
  orderId,
  sku,
  shade = '',
  qty = 1,
  priority = 'normal',
  reason = '仓库发错货',
  consumerId = null,
  carrier = '顺丰速运',
}) {
  const origin = store.getOrder(orderId);
  if (!origin) return fail('request_reshipment', { orderId, sku }, `未找到原订单 ${orderId}`);

  const item = INVENTORY[sku];
  if (!item) return fail('request_reshipment', { orderId, sku }, `SKU ${sku} 不存在`);
  if (item.stock < qty) {
    return fail(
      'request_reshipment',
      { orderId, sku },
      `库存不足：${item.name} 当前仅 ${item.stock} 件，无法创建补发单`,
    );
  }

  const urgent = priority === 'urgent';
  const reship = store.addOrder({
    id: store.nextId('ORDER'),
    consumerId: consumerId || origin.consumerId,
    type: 'reshipment',
    parentOrderId: orderId,
    items: [{ product: item.name.split(' · ')[0], sku, shade, qty, price: 0 }],
    amount: 0,
    createdAt: ts(),
    paidAt: ts(),
    shippedAt: ts(),
    deliveredAt: null,
    payStatus: 'paid',
    shipStatus: urgent ? 'shipped' : 'created',
    logistics: urgent
      ? {
          carrier,
          trackingNo: `SF${Math.floor(1e11 + Math.random() * 8e11)}`,
          status: 'shipped',
          lastUpdate: ts(),
          lastNode: '已揽收，加急件优先派送',
          eta: '今日 21:00 前送达',
        }
      : null,
    refundStatus: 'none',
    reshipStatus: urgent ? 'shipped' : 'created',
    priority: urgent ? 'urgent' : 'normal',
    reason,
    address: origin.address,
  });

  item.stock -= qty;
  store.updateOrder(orderId, { reshipStatus: urgent ? 'shipped' : 'created' });

  // 联动：把该消费者的补发类工单推进为 PROCESSING
  const related = store
    .ticketsOf(origin.consumerId)
    .filter((t) => t.type === 'wrong_item' || t.type === 'reshipment')
    .filter((t) => t.status === 'OPEN' || t.status === 'PROCESSING');
  const touched = [];
  for (const t of related) {
    t.status = 'PROCESSING';
    t.updatedAt = ts();
    t.records.push({
      at: ts(),
      actor: '系统',
      note: `补发单 ${reship.id} 已创建（${urgent ? '加急' : '普通'}），物流单号 ${reship.logistics?.trackingNo || '待分配'}。`,
    });
    touched.push(t.id);
  }

  return ok(
    'request_reshipment',
    { orderId, sku, qty, priority },
    {
      reshipOrderId: reship.id,
      status: reship.reshipStatus,
      eta: reship.logistics?.eta || '按标准时效发出',
      trackingNo: reship.logistics?.trackingNo || null,
      remainingStock: item.stock,
      linkedTickets: touched,
    },
    [
      { target: 'order', id: orderId, field: 'reshipStatus', to: reship.reshipStatus },
      { target: 'order', id: reship.id, field: 'status', to: 'created' },
      ...touched.map((id) => ({ target: 'ticket', id, field: 'status', to: 'PROCESSING' })),
    ],
  );
}

export function request_refund({
  orderId,
  amount = null,
  reason = '客服发起退款',
  mode = 'refund_only',
  actor = '客服-当前坐席',
}) {
  const order = store.getOrder(orderId);
  if (!order) return fail('request_refund', { orderId }, `未找到订单 ${orderId}`);
  if (order.refundStatus === 'done') {
    return fail('request_refund', { orderId }, `订单 ${orderId} 已完成退款，无需重复操作`);
  }
  const finalAmount = amount == null ? order.amount : amount;
  store.updateOrder(orderId, {
    refundStatus: 'processing',
    refundRequestedAt: ts(),
  });
  const ticket = store.addTicket({
    id: store.nextId('TK'),
    consumerId: order.consumerId,
    orderId,
    type: 'refund',
    title: `退款申请 · ${mode === 'refund_only' ? '仅退款' : '退货退款'}`,
    status: 'PROCESSING',
    priority: 'P2',
    owner: actor,
    createdAt: ts(),
    updatedAt: ts(),
    result: null,
    records: [
      { at: ts(), actor, note: `发起退款 ¥${finalAmount}，原因：${reason}。` },
      { at: ts(), actor: '系统', note: '退款单已提交财务，预计 48 小时内到账。' },
    ],
  });
  return ok(
    'request_refund',
    { orderId, amount: finalAmount, mode },
    { orderId, refundStatus: 'processing', ticketId: ticket.id, eta: '48 小时内到账' },
    [
      { target: 'order', id: orderId, field: 'refundStatus', to: 'processing' },
      { target: 'ticket', id: ticket.id, field: 'status', to: 'PROCESSING' },
    ],
  );
}

/**
 * 记录疑似产品不适事件。
 * 注意：这里只做「事件登记」，不做任何医学判断。
 */
export function record_sensitive_incident({
  consumerId,
  orderId = null,
  sku = null,
  symptoms = [],
  note = '',
  actor = '客服-当前坐席',
}) {
  const ticket = store.addTicket({
    id: store.nextId('TK'),
    consumerId,
    orderId,
    type: 'sensitive_incident',
    title: '疑似产品不适事件登记',
    status: 'PROCESSING',
    priority: 'P1',
    owner: actor,
    createdAt: ts(),
    updatedAt: ts(),
    result: null,
    incidentLogged: true,
    records: [
      {
        at: ts(),
        actor,
        note: `登记疑似产品不适事件。自述症状：${symptoms.join('、') || '未明确'}。${note}`,
      },
      {
        at: ts(),
        actor: '系统',
        note: '已按业务规则标记该消费者为「敏感肌关注」，后续所有会话禁用常规产品推荐，需走安全处理流程。',
      },
    ],
  });
  return ok(
    'record_sensitive_incident',
    { consumerId, orderId, sku, symptoms },
    {
      ticketId: ticket.id,
      status: ticket.status,
      guardrail: '已启用：禁用常规产品推荐 + 需人工升级',
      disclaimer: '本系统不做医学诊断，仅做事件登记与流程引导。',
    },
    [
      { target: 'ticket', id: ticket.id, field: 'status', to: 'PROCESSING' },
      { target: 'consumer', id: consumerId, field: 'guardrail', to: 'sensitive_incident_logged' },
    ],
  );
}

export function escalate_case({
  consumerId,
  orderId = null,
  level = 'L2',
  reason = '',
  target = '资深客服组',
  actor = '客服-当前坐席',
}) {
  const ticket = store.addTicket({
    id: store.nextId('TK'),
    consumerId,
    orderId,
    type: 'escalation',
    title: `升级处理 · ${level} · ${target}`,
    status: 'PROCESSING',
    priority: 'P0',
    owner: target,
    createdAt: ts(),
    updatedAt: ts(),
    result: null,
    records: [
      { at: ts(), actor, note: `发起升级。等级：${level}。原因：${reason}` },
      { at: ts(), actor: '系统', note: `已通知 ${target}，SLA 30 分钟内响应。` },
    ],
  });
  return ok(
    'escalate_case',
    { consumerId, orderId, level, target },
    { ticketId: ticket.id, level, target, slaMinutes: 30, reason },
    [
      { target: 'ticket', id: ticket.id, field: 'status', to: 'PROCESSING' },
      { target: 'case', field: 'escalated', to: true },
    ],
  );
}

export function add_compensation({
  consumerId,
  orderId = null,
  kind = 'coupon',
  amount = 30,
  note = '',
  actor = '客服-当前坐席',
}) {
  const ticket = store.addTicket({
    id: store.nextId('TK'),
    consumerId,
    orderId,
    type: 'compensation',
    title: `补偿发放 · ${kind === 'coupon' ? '优惠券' : '其他'}`,
    status: 'RESOLVED',
    priority: 'P2',
    owner: actor,
    createdAt: ts(),
    updatedAt: ts(),
    result: `已发放 ¥${amount} 补偿。${note}`,
    records: [{ at: ts(), actor, note: `发放补偿 ¥${amount}。${note}` }],
  });
  return ok(
    'add_compensation',
    { consumerId, kind, amount },
    { ticketId: ticket.id, amount, kind },
    [{ target: 'ticket', id: ticket.id, field: 'status', to: 'RESOLVED' }],
  );
}

/* ═══════════════════════════════════════════════════════════
 * 注册表
 * ═══════════════════════════════════════════════════════════ */

export const registry = {
  check_order,
  check_reshipment,
  check_refund,
  check_coupon,
  check_inventory,
  check_logistics,
  estimate_fulfillment,
  get_ticket_history,
  create_ticket,
  update_ticket,
  close_ticket,
  request_reshipment,
  request_refund,
  record_sensitive_incident,
  escalate_case,
  add_compensation,
};

/** 工具元信息，供前端展示「Agent 将要调用什么」 */
export const TOOL_META = {
  check_order: { label: '查询订单', kind: 'read' },
  check_reshipment: { label: '核验补发是否发生', kind: 'read' },
  check_refund: { label: '核验退款是否发生', kind: 'read' },
  check_coupon: { label: '核验补偿是否发放', kind: 'read' },
  check_inventory: { label: '查询库存', kind: 'read' },
  check_logistics: { label: '查询物流', kind: 'read' },
  estimate_fulfillment: { label: '计算最快履约方式', kind: 'read' },
  get_ticket_history: { label: '调取历史售后工单', kind: 'read' },
  create_ticket: { label: '创建工单', kind: 'write' },
  update_ticket: { label: '更新工单状态', kind: 'write' },
  close_ticket: { label: '关闭工单', kind: 'write' },
  request_reshipment: { label: '创建补发单', kind: 'write' },
  request_refund: { label: '发起退款', kind: 'write' },
  record_sensitive_incident: { label: '登记产品不适事件', kind: 'write' },
  escalate_case: { label: '升级处理', kind: 'write' },
  add_compensation: { label: '发放补偿', kind: 'write' },
};

/** 供 Agent Planner 使用的工具清单（声明式，含参数签名） */
export const TOOL_SPECS = [
  { name: 'check_order', kind: 'read', params: ['orderId'], desc: '查询订单状态（含退款/补发状态）' },
  { name: 'check_reshipment', kind: 'read', params: ['consumerId', 'orderId', 'sku', 'since'], desc: '核验承诺时限后是否真的存在补发单' },
  { name: 'check_refund', kind: 'read', params: ['consumerId', 'orderId', 'since'], desc: '核验承诺时限后是否真的有退款记录' },
  { name: 'check_coupon', kind: 'read', params: ['consumerId', 'since'], desc: '核验补偿/优惠券是否真的发放' },
  { name: 'check_inventory', kind: 'read', params: ['sku', 'qty'], desc: '查询 SKU 库存' },
  { name: 'check_logistics', kind: 'read', params: ['orderId'], desc: '查询物流轨迹' },
  { name: 'estimate_fulfillment', kind: 'read', params: ['sku', 'city', 'sameCity'], desc: '估算最快履约时效' },
  { name: 'get_ticket_history', kind: 'read', params: ['consumerId', 'type'], desc: '调取历史工单' },
  { name: 'create_ticket', kind: 'write', params: ['consumerId', 'orderId', 'type', 'title', 'priority', 'note'], desc: '创建工单' },
  { name: 'update_ticket', kind: 'write', params: ['ticketId', 'status', 'note'], desc: '更新工单状态' },
  { name: 'close_ticket', kind: 'write', params: ['ticketId', 'result'], desc: '关闭工单' },
  { name: 'request_reshipment', kind: 'write', params: ['orderId', 'sku', 'shade', 'qty', 'priority', 'reason', 'consumerId'], desc: '创建补发单（需人工确认）' },
  { name: 'request_refund', kind: 'write', params: ['orderId', 'amount', 'reason', 'consumerId'], desc: '发起退款（需人工确认）' },
  { name: 'record_sensitive_incident', kind: 'write', params: ['consumerId', 'orderId', 'sku', 'symptoms', 'note'], desc: '登记疑似产品不适事件（需人工确认）' },
  { name: 'escalate_case', kind: 'write', params: ['consumerId', 'orderId', 'level', 'reason', 'target'], desc: '升级处理（需人工确认）' },
  { name: 'add_compensation', kind: 'write', params: ['consumerId', 'orderId', 'kind', 'amount', 'note'], desc: '发放补偿（有额度上限）' },
];

export function invoke(name, params) {
  const fn = registry[name];
  if (!fn) {
    logCall({ tool: name, params, ok: false, error: `未知工具 ${name}` });
    return fail(name, params, `未知工具 ${name}`);
  }
  try {
    const result = fn(params || {});
    logCall({ tool: name, params, ok: result.ok, effects: result.effects || [], error: result.error || null });
    return result;
  } catch (err) {
    logCall({ tool: name, params, ok: false, error: String(err.message || err) });
    return fail(name, params, `工具执行异常：${err.message}`);
  }
}
