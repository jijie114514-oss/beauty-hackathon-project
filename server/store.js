/**
 * 内存数据层（Mock Database）
 * ------------------------------------------------------------------
 * 提供一个极简的「可变更」数据存储，模拟真实业务系统：
 * - 订单库 / 工单库 / 会话库 / 系统事件
 * - Tool 层对它的每一次写操作都会真实改变状态，从而让
 *   「Agent 执行 → 业务状态变化 → Service Memory 重算」这条链路可被观察。
 */

import { buildSeed, DEMO_NOW } from './seed.js';

let db = buildSeed();
let seq = 1;

export const now = () => DEMO_NOW;

export function reset() {
  db = buildSeed();
  seq = 1;
}

export function nextId(prefix) {
  seq += 1;
  return `${prefix}_${String(seq).padStart(4, '0')}`;
}

export const all = () => db;

export const consumers = () => db.consumers;
export const orders = () => db.orders;
export const tickets = () => db.tickets;
export const sessions = () => db.sessions;
export const systemEvents = () => db.systemEvents;

export const getConsumer = (id) => db.consumers.find((c) => c.id === id) || null;
export const getOrder = (id) => db.orders.find((o) => o.id === id) || null;
export const getTicket = (id) => db.tickets.find((t) => t.id === id) || null;
export const getSession = (id) => db.sessions.find((s) => s.id === id) || null;

export const ordersOf = (consumerId) =>
  db.orders.filter((o) => o.consumerId === consumerId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

export const ticketsOf = (consumerId) =>
  db.tickets.filter((t) => t.consumerId === consumerId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

export const sessionsOf = (consumerId) =>
  db.sessions.filter((s) => s.consumerId === consumerId).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));

export const systemEventsOf = (consumerId) =>
  db.systemEvents.filter((e) => e.consumerId === consumerId);

export const currentSessionOf = (consumerId) =>
  db.sessions.find((s) => s.consumerId === consumerId && s.isCurrent) || null;

/** 消费者全景上下文 —— 后续所有 Agent 的唯一数据入口 */
export function contextOf(consumerId) {
  const consumer = getConsumer(consumerId);
  if (!consumer) return null;
  return {
    consumer,
    orders: ordersOf(consumerId),
    tickets: ticketsOf(consumerId),
    sessions: sessionsOf(consumerId),
    systemEvents: systemEventsOf(consumerId),
    now: DEMO_NOW.toISOString(),
  };
}

/** 取该消费者「最近一次」的会话消息（当前会话优先） */
export function currentMessagesOf(consumerId) {
  const s = currentSessionOf(consumerId);
  return s ? s.messages : [];
}

export function appendMessage(consumerId, message) {
  let s = currentSessionOf(consumerId);
  if (!s) {
    s = {
      id: nextId('S'),
      consumerId,
      channel: 'app',
      agentName: '客服-（待接入）',
      startedAt: new Date().toISOString(),
      endedAt: null,
      isCurrent: true,
      messages: [],
    };
    db.sessions.push(s);
  }
  s.messages.push(message);
  return s;
}

export function updateOrder(id, patch) {
  const o = getOrder(id);
  if (!o) return null;
  Object.assign(o, patch);
  return o;
}

export function updateTicket(id, patch) {
  const t = getTicket(id);
  if (!t) return null;
  Object.assign(t, patch);
  return t;
}

export function addTicket(ticket) {
  db.tickets.push(ticket);
  return ticket;
}

export function addOrder(order) {
  db.orders.push(order);
  return order;
}

/* ── 评估 / 验收用：注入合成数据（不污染 seed） ─────────────── */

export function addConsumer(consumer) {
  db.consumers.push(consumer);
  return consumer;
}

export function addSession(session) {
  db.sessions.push(session);
  return session;
}

export function addSystemEvent(event) {
  db.systemEvents.push(event);
  return event;
}
