/**
 * Promise Agent —— 客服承诺识别与兑现跟踪
 * ------------------------------------------------------------------
 * 本轮改造的关键变化：
 *   分类由 **LLM 语义判断** 负责（runPromiseClassification），
 *   词表（PROMISE_MARKERS 等）退居为 LLM 不可用时的兜底。
 *
 * 不变的原则：
 *   分类只是「识别出承诺」，**是否兑现一律由 Business Validator 回查业务库**，
 *   模型不参与判断数据库事实。
 */

import { runPromiseClassificationBatch } from '../semantic/index.js';
import { parseDeadline } from '../semantic/deterministic.js';
import { EVENT_TYPE, EVENT_STATUS } from '../schema.js';
import { getMode } from '../llm.js';

/**
 * 话术分类记忆化。
 * 历史客服话术在一次会话里会被反复分析（每次 Tool 执行后都要重算），
 * 若每次都重新问模型，Token 会按「分析次数 × 历史话术条数」线性膨胀。
 * 这里按 (模式 + 时间 + 原文) 做记忆化，同一句话只问一次。
 */
const CLASSIFY_MEMO = new Map();
const MEMO_MAX = 2000;
export const getClassifyMemoStats = () => ({ size: CLASSIFY_MEMO.size, max: MEMO_MAX });
export const clearClassifyMemo = () => CLASSIFY_MEMO.clear();

export const CATEGORY_LABEL = {
  PROMISE: '明确承诺',
  ESTIMATE: '预计',
  ACTION: '执行动作',
  EXPLANATION: '普通解释',
  NONE: '无关话术',
};

/** 事件状态 → 中文标签（键必须是 schema 的小写状态值） */
export const STATUS_LABEL = {
  fulfilled: '已兑现',
  unfulfilled: '未兑现',
  in_progress: '履约中',
  pending: '待兑现',
  unknown: '状态未知',
  info: '记录',
  open: '待处理',
  resolved: '已解决',
};

const SUBJECT_LABEL = {
  reshipment: '补发 / 重新发货',
  gift: '赠品补发',
  refund: '退款',
  coupon: '优惠券',
  compensation: '补偿',
  contact: '回访 / 回复',
  other: '其他',
};

/**
 * 逐条分类所有客服话术。
 * @returns 结构化结果，供 Service Memory 抽取与前端承诺面板共用
 */
export async function promiseAgent(ctx) {
  const utterances = [];
  const ordered = [...ctx.sessions].sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  const sources = new Set();

  /* ── 1. 收集全部客服话术，命中记忆化的先取出来 ─────────── */
  const pending = [];
  const resolved = new Map(); // memoKey → result
  for (const session of ordered) {
    for (const msg of session.messages) {
      if (msg.role !== 'agent') continue;
      const memoKey = `${getMode()}::${msg.at}::${msg.text}`;
      const hit = CLASSIFY_MEMO.get(memoKey);
      if (hit) {
        resolved.set(memoKey, { ...hit, source: `${hit.source}+memo` });
      } else {
        pending.push({ key: memoKey, text: msg.text, at: msg.at });
      }
    }
  }

  /* ── 2. 未命中的合并成**一次**批量请求（Token 节约关键） ── */
  if (pending.length) {
    const batch = await runPromiseClassificationBatch(pending);
    for (const [key, r] of batch) {
      if (CLASSIFY_MEMO.size >= MEMO_MAX) CLASSIFY_MEMO.delete(CLASSIFY_MEMO.keys().next().value);
      CLASSIFY_MEMO.set(key, r);
      resolved.set(key, r);
    }
  }

  /* ── 3. 组装 ─────────────────────────────────────────────── */
  for (const session of ordered) {
    for (const msg of session.messages) {
      if (msg.role !== 'agent') continue;
      const memoKey = `${getMode()}::${msg.at}::${msg.text}`;
      const r = resolved.get(memoKey);
      if (!r) continue;
      sources.add(r.source);
      const c = r.value;

      utterances.push({
        id: `P_${session.id}_${msg.id}`,
        sessionId: session.id,
        sessionStartedAt: session.startedAt,
        messageId: msg.id,
        at: msg.at,
        agentName: session.agentName,
        channel: session.channel,
        quote: msg.text,
        category: c.category,
        categoryLabel: CATEGORY_LABEL[c.category] || c.category,
        subject: c.subject,
        subjectLabel: SUBJECT_LABEL[c.subject] || '其他',
        deadline: c.deadline || null,
        classifierReason: c.reason,
        matched: c.matched || [],
        classifiedBy: r.source,
      });
    }
  }

  utterances.sort((a, b) => (a.at < b.at ? 1 : -1));

  const promises = utterances.filter((u) => u.category === 'PROMISE');
  const count = (cat) => utterances.filter((u) => u.category === cat).length;

  return {
    utterances,
    promises,
    unfulfilled: [],
    pending: [],
    fulfilled: [],
    unknown: [],
    stats: {
      totalUtterances: utterances.length,
      promise: count('PROMISE'),
      estimate: count('ESTIMATE'),
      action: count('ACTION'),
      explanation: count('EXPLANATION'),
      none: count('NONE'),
    },
    classifiedBy: [...sources],
  };
}

/**
 * 把 Business Validator 的核验结果回填到承诺列表。
 *
 * 匹配**不能依赖 LLM 输出的逐字精确相等** —— 模型复述原文时标点、空格、
 * 省略都可能略有差异，一旦严格相等就会静默失配，表现为「事件层已判定未兑现，
 * 但承诺面板显示状态未知」。
 *
 * 因此这里用打分匹配，取最高分且不低于阈值者：
 *   100 规范化文本完全相等
 *    80 一方包含另一方（模型可能只截取了片段）
 *    60 同一会话（source_id 含相同 sessionId）
 *    50 时间接近（±60 秒，模型可能改写 ISO 时区表示）
 */
function normText(s) {
  return String(s || '')
    .replace(/[\s\u3000，。、！？；：,.!?;:"'「」『』【】()（）《》·—-]/g, '')
    .toLowerCase();
}

function scoreMatch(event, utterance) {
  const a = normText(event.evidence);
  const b = normText(utterance.quote);
  if (a && a === b) return 100;
  if (a && b && (a.includes(b) || b.includes(a))) return 80;

  const sid = String(utterance.sessionId || '');
  if (sid && String(event.source_id || '').includes(sid)) return 60;

  const dt = Math.abs(new Date(event.time).getTime() - new Date(utterance.at).getTime());
  if (Number.isFinite(dt) && dt <= 60_000) return 50;

  return 0;
}

export function attachVerification(promiseResult, memory) {
  const promiseEvents = memory.events.filter((e) => e.type === EVENT_TYPE.SERVICE_PROMISE);
  const used = new Set();

  const promises = promiseResult.promises.map((p) => {
    let best = null;
    let bestScore = 0;
    for (const e of promiseEvents) {
      if (used.has(e.event_id)) continue;
      const s = scoreMatch(e, p);
      if (s > bestScore) { bestScore = s; best = e; }
    }

    if (!best || bestScore < 50) {
      return {
        ...p,
        tracked: true,
        status: EVENT_STATUS.UNKNOWN,
        statusLabel: STATUS_LABEL.unknown,
        matchScore: bestScore,
        verify: { checks: [], conclusion: '未能定位对应服务事件，需人工确认。', blockers: [] },
      };
    }

    used.add(best.event_id);
    return {
      ...p,
      tracked: true,
      eventId: best.event_id,
      matchScore: bestScore,
      status: best.status,
      statusLabel: STATUS_LABEL[best.status] || best.status,
      subjectLabel: best.raw?.subjectLabel || p.subjectLabel,
      deadline: best.structured_data.deadline
        ? { ...(p.deadline || {}), dueAt: best.structured_data.deadline, absoluteLabel: best.structured_data.deadline_label }
        : p.deadline,
      verify: best.verification || { checks: [], conclusion: '', blockers: [] },
      classifiedBy: p.classifiedBy,
    };
  });

  return {
    ...promiseResult,
    promises,
    unfulfilled: promises.filter((p) => p.status === EVENT_STATUS.UNFULFILLED),
    pending: promises.filter((p) => p.status === EVENT_STATUS.PENDING || p.status === EVENT_STATUS.IN_PROGRESS),
    fulfilled: promises.filter((p) => p.status === EVENT_STATUS.FULFILLED),
    unknown: promises.filter((p) => p.status === EVENT_STATUS.UNKNOWN),
  };
}

export { parseDeadline };
