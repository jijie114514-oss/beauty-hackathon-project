/* ==========================================================================
   Service Memory Copilot —— 客服工作台主逻辑
   ========================================================================== */

import { api } from './api.js';
import {
  h, raw, esc, fmtDate, fmtTime, fmtDateTime, dayHeading, dayLabel,
  toast, openModal, riskBadgeClass, srcLabel,
} from './format.js';

/* ── 全局状态 ─────────────────────────────────────────────── */
const state = {
  consumers: [],
  currentId: null,
  brief: null,
  toolLog: {},          // consumerId -> [ { at, actionTitle, calls:[...] } ]
  executed: {},         // consumerId -> Set(actionTitle)
  replyEditing: false,
  replyText: null,
  collapsed: { promise: false },
  busy: false,
  engine: null,
};

const $ = (id) => document.getElementById(id);

/* ══════════════════════════════════════════════════════════
   启动
   ══════════════════════════════════════════════════════════ */
async function boot() {
  try {
    state.engine = await api.health();
  } catch (e) {
    $('engineText').textContent = '服务未启动';
    toast('无法连接后端服务，请先执行 npm start', 'err');
    return;
  }
  renderEngine();

  state.consumers = await api.consumers();
  const urlId = new URLSearchParams(location.search).get('consumer');
  const preferred =
    (urlId && state.consumers.find((c) => c.id === urlId)?.id) ||
    state.consumers.find((c) => c.rootCause === 'unfulfilled_promise')?.id ||
    state.consumers[0]?.id;

  await selectConsumer(preferred);
  bindGlobal();
}

function renderEngine() {
  const llm = state.engine?.llm;
  const on = llm?.enabled;
  $('engineDot').className = `engine-dot ${on ? 'llm' : ''}`;
  $('engineText').textContent = on ? `Agent 引擎：规则 + ${llm.model}` : 'Agent 引擎：确定性规则引擎';
}

function bindGlobal() {
  $('btnReset').addEventListener('click', async () => {
    await api.reset();
    state.toolLog = {};
    state.executed = {};
    state.consumers = await api.consumers();
    await selectConsumer(state.currentId);
    toast('Mock 数据已重置', 'ok');
  });

  $('btnSend').addEventListener('click', sendMessage);
  $('msgInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  $('consumerList').addEventListener('click', (e) => {
    const item = e.target.closest('[data-cid]');
    if (item) selectConsumer(item.dataset.cid);
  });

  // 事件委托：面板折叠 / 动作执行 / 回复决策
  $('copilotPanel').addEventListener('click', onCopilotClick);
}

/* ══════════════════════════════════════════════════════════
   数据加载
   ══════════════════════════════════════════════════════════ */
async function selectConsumer(id) {
  if (!id) return;
  state.currentId = id;
  state.replyEditing = false;
  state.replyText = null;
  $('copilotPanel').innerHTML = h`<div class="skeleton">正在恢复服务记忆…</div>`;
  renderConsumerList();

  try {
    state.brief = await api.analyze(id);
  } catch (e) {
    $('copilotPanel').innerHTML = h`<div class="skeleton">分析失败：${e.message}</div>`;
    return;
  }
  renderAll();
}

async function refreshConsumers() {
  state.consumers = await api.consumers();
}

function renderAll() {
  renderConsumerList();
  renderChat();
  renderCustomerPanel();
  renderCaseBar();
  renderCopilot();
}

/* ══════════════════════════════════════════════════════════
   ① 消费者列表
   ══════════════════════════════════════════════════════════ */
function renderConsumerList() {
  const list = state.consumers;
  $('consumerCount').textContent = `共 ${list.length} 位`;

  $('consumerList').innerHTML = list
    .map((c) => {
      const risk = riskBadgeClass(c.riskLevel);
      const active = c.id === state.currentId ? ' active' : '';
      const tags = [];
      if (c.unfulfilledPromises > 0) tags.push(h`<span class="badge high">未兑现承诺 ${c.unfulfilledPromises}</span>`);
      if (c.contactsRecent >= 2) tags.push(h`<span class="badge mid">近 7 天进线 ${c.contactsRecent} 次</span>`);
      if (c.guardrails?.blockProductRecommendation) tags.push(h`<span class="badge high">禁推</span>`);
      if (!tags.length) tags.push(h`<span class="badge ${risk}">${c.riskLabel}</span>`);

      return h`
        <button class="consumer-item${active}" data-cid="${c.id}">
          <div class="ci-top">
            <span class="ci-name">${c.name}</span>
            <span class="ci-lv">${c.level}</span>
            <span class="badge ${risk}" style="margin-left:auto">${c.riskLabel}</span>
          </div>
          <div class="ci-msg">${c.lastMessage}</div>
          <div class="ci-tags">${raw(tags.join(''))}</div>
        </button>`;
    })
    .join('');
}

/* ══════════════════════════════════════════════════════════
   ② 聊天区
   ══════════════════════════════════════════════════════════ */
function renderChat() {
  const b = state.brief;
  if (!b) return;

  const now = b.meta.generatedAt;
  $('chatAvatar').textContent = b.consumer.name.slice(0, 1);
  $('chatName').textContent = `${b.consumer.name} · ${b.consumer.level}`;
  const cur = b.context.sessions.find((s) => s.isCurrent);
  $('chatChannel').textContent = cur ? `当前会话 · APP 在线客服` : '暂无进行中的会话';

  const sessions = [...b.context.sessions].sort((x, y) => (x.startedAt < y.startedAt ? -1 : 1));
  const html = [];

  let lastDay = null;
  for (const s of sessions) {
    const head = dayHeading(s.startedAt, now);
    if (head !== lastDay) {
      html.push(h`<div class="day-divider">${head}</div>`);
      lastDay = head;
    }
    html.push(
      h`<div class="tl-date" style="text-align:center;color:var(--ink-4);font-size:10.5px">
        ${s.isCurrent ? '当前会话' : '历史会话'} · ${s.agentName} · ${fmtTime(s.startedAt)}
      </div>`,
    );
    for (const m of s.messages) {
      const isAgent = m.role === 'agent';
      const draft = m.decision === 'edit' ? ' draft' : '';
      html.push(
        h`<div class="msg ${isAgent ? 'agent' : 'consumer'}">
            <div class="meta">${isAgent ? (m.operator || s.agentName) : b.consumer.name} · ${fmtTime(m.at)}</div>
            <div class="bubble${draft}">${m.text}</div>
            ${m.decision === 'edit' ? raw('<div class="tagline">客服修改后发送</div>') : ''}
            ${m.decision === 'adopt' ? raw('<div class="tagline">采用 AI 建议回复</div>') : ''}
          </div>`,
      );
    }
  }

  $('chatBody').innerHTML = html.join('');
  $('chatBody').scrollTop = $('chatBody').scrollHeight;
}

async function sendMessage() {
  const input = $('msgInput');
  const text = input.value.trim();
  if (!text || state.busy) return;
  input.value = '';
  setBusy(true);
  try {
    state.brief = await api.sendMessage(state.currentId, text);
    await refreshConsumers();
    state.replyEditing = false;
    state.replyText = null;
    renderAll();
    toast('已重新拉取全部历史数据并完成分析', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    setBusy(false);
  }
}

/* ══════════════════════════════════════════════════════════
   ③ 消费者服务信息
   ══════════════════════════════════════════════════════════ */
function renderCustomerPanel() {
  const b = state.brief;
  if (!b) return;
  const c = b.consumer;
  const now = b.meta.generatedAt;

  /* Basic Info */
  const basic = h`
    <div class="kv"><span class="k">姓名</span><span class="v">${c.name}</span></div>
    <div class="kv"><span class="k">等级</span><span class="v">${c.level}</span></div>
    <div class="kv"><span class="k">手机</span><span class="v">${c.phone}</span></div>
    <div class="kv"><span class="k">城市</span><span class="v">${c.city}</span></div>
    <div class="kv"><span class="k">肤质</span><span class="v">${c.skinProfile || '—'}</span></div>
    <div class="kv"><span class="k">标签</span><span class="v">${c.tags.join(' · ')}</span></div>
    <div class="kv"><span class="k">备注</span><span class="v" style="color:var(--ink-3)">${c.note}</span></div>`;

  /* Orders */
  const orders = b.context.orders
    .map((o) => {
      const chips = [];
      const label = { paid: '已支付', shipped: '已发货', delivered: '已签收', created: '已创建' };
      chips.push(h`<span class="badge neutral">${o.type === 'reshipment' ? '补发单' : '销售单'}</span>`);
      chips.push(h`<span class="badge low">${label[o.shipStatus] || o.shipStatus}</span>`);
      if (o.refundStatus === 'processing') chips.push(h`<span class="badge mid">退款处理中</span>`);
      if (o.refundStatus === 'done') chips.push(h`<span class="badge neutral">已退款</span>`);
      if (o.reshipStatus === 'shipped') chips.push(h`<span class="badge brand">已补发</span>`);
      if (o.reshipStatus === 'created') chips.push(h`<span class="badge brand">补发单已创建</span>`);
      if (o.reshipStatus === 'none' && o.type !== 'reshipment') chips.push(h`<span class="badge neutral">无补发记录</span>`);

      const wrong =
        o.receivedSku && o.receivedSku !== o.items?.[0]?.sku
          ? h`<div class="oc-meta" style="color:var(--high)">⚠ 实收 ${o.receivedShade}（${o.receivedSku}），与下单不一致</div>`
          : '';

      return h`
        <div class="order-card">
          <div class="oc-top">
            <span class="oc-id">${o.id}</span>
            <span style="margin-left:auto;font-size:11px;color:var(--ink-3)">¥${o.amount}</span>
          </div>
          <div class="oc-item">${o.items[0].product}｜${o.items[0].shade}｜SKU ${o.items[0].sku}</div>
          <div class="oc-meta">下单 ${fmtDate(o.createdAt)}${o.deliveredAt ? ` · 签收 ${fmtDate(o.deliveredAt)}` : ''}${o.logistics ? ` · ${o.logistics.trackingNo}` : ''}</div>
          ${raw(wrong)}
          <div class="chips">${raw(chips.join(''))}</div>
        </div>`;
    })
    .join('');

  /* Service Timeline */
  const tl = [];
  let lastDay = null;
  for (const e of b.serviceMemory.timeline) {
    const head = dayHeading(e.at, now);
    if (head !== lastDay) {
      tl.push(h`<div class="tl-date" style="margin:9px 0 5px;font-weight:650;color:var(--ink-3)">${head}</div>`);
      lastDay = head;
    }
    tl.push(
      h`<div class="tl-item src-${e.source} ${e.status === 'unresolved' ? 'unresolved' : e.status === 'resolved' ? 'resolved' : ''}">
          <div class="tl-date">${fmtTime(e.at)} · <span class="tl-src ${e.source}">${srcLabel[e.source]}</span></div>
          <div class="tl-title">${e.title}${e.status === 'unresolved' ? raw(' <span class="badge high">未解决</span>') : ''}</div>
          <div class="tl-detail">${e.detail}</div>
        </div>`,
    );
  }

  $('customerPanel').innerHTML = h`
    <div class="section-title">Basic Info</div>
    ${raw(basic)}

    <div class="section-title">Orders <span style="font-weight:400;color:var(--ink-4)">${b.context.orders.length}</span></div>
    ${raw(orders)}

    <div class="section-title">Service Timeline <span style="font-weight:400;color:var(--ink-4)">${b.serviceMemory.timeline.length} 个服务事件</span></div>
    <div class="timeline">${raw(tl.join(''))}</div>
  `;
}

/* ══════════════════════════════════════════════════════════
   ④ Case 状态条
   ══════════════════════════════════════════════════════════ */
function renderCaseBar() {
  const b = state.brief;
  if (!b) return;
  const st = b.case.status;
  /* 状态流由后端下发（case.statusFlow），前端不再硬编码状态集合 */
  const flow = b.case.statusFlow || ['OPEN', 'ALERTED', 'PROCESSING', 'WAITING', 'RESOLVED'];
  const cur = flow.indexOf(st);
  const step = (name, idx) => {
    const cls = idx < cur ? 'done' : idx === cur ? 'on' : '';
    return h`<span class="case-step ${cls}">${name}</span>`;
  };
  const flowHtml = flow
    .map((s, i) => (i ? '<span style="color:var(--ink-4)">→</span>' : '') + step(s, i))
    .join('');
  const guard = b.risk.guardrails;
  const badgeCls = st === 'RESOLVED' ? 'low' : st === 'OPEN' ? 'mid' : 'brand';

  $('caseBar').innerHTML = h`
    <div class="case-flow">${raw(flowHtml)}</div>
    <span class="badge ${badgeCls}">${b.case.statusLabel}</span>
    <span class="badge neutral">承诺 ${b.case.promiseState.label}</span>
    ${guard.blockProductRecommendation ? raw('<span class="badge high">⛔ 禁用产品推荐</span>') : ''}
    <span style="margin-left:auto;color:var(--ink-4)">闭环进度 ${b.case.progress.passed}/${b.case.progress.total}</span>
  `;
}

/* ══════════════════════════════════════════════════════════
   ⑤ AI Copilot
   ══════════════════════════════════════════════════════════ */
const PANELS = [
  { key: 'what', idx: '1', zh: 'What happened', en: '历史关键事件' },
  { key: 'promise', idx: '2', zh: 'Promise Tracking', en: '客服承诺追踪' },
  { key: 'unresolved', idx: '3', zh: 'Unresolved', en: '尚未解决的问题' },
  { key: 'escalation', idx: '4', zh: 'Why escalating', en: '当前问题为什么升级' },
  { key: 'risk', idx: '5', zh: 'Risk', en: '风险提示与证据' },
  { key: 'action', idx: '6', zh: 'Next Best Action', en: '推荐下一步操作' },
  { key: 'reply', idx: '7', zh: 'Suggested Reply', en: '建议回复' },
];

function panel(key, badgeHtml, bodyHtml) {
  const meta = PANELS.find((p) => p.key === key);
  const collapsed = state.collapsed[key] ? ' collapsed' : '';
  return h`
    <div class="panel${collapsed}" data-panel="${key}">
      <div class="panel-head" data-toggle="${key}">
        <span class="idx">${meta.idx}</span>
        <span>${meta.zh}</span>
        <span class="en">${meta.en}</span>
        <span class="right">${raw(badgeHtml || '')}<span class="chev">▼</span></span>
      </div>
      <div class="panel-body">${raw(bodyHtml)}</div>
    </div>`;
}

function evidenceBlock(list) {
  if (!list || !list.length) return '';
  const rows = list
    .slice(0, 6)
    .map((e) => {
      const cls = e.pass === true ? 'pass' : e.pass === false ? 'fail' : '';
      return h`<div class="ev-item">
          <div class="ev-ref">${e.ref || e.label || ''}</div>
          <div class="ev-text ${cls}">${e.text || e.value || ''}</div>
        </div>`;
    })
    .join('');
  return h`<div class="evidence">${raw(rows)}</div>`;
}

function renderCopilot() {
  const b = state.brief;
  if (!b) return;

  $('copilotEngine').textContent = b.meta.engine.startsWith('hybrid') ? '规则 + LLM' : '确定性规则引擎';
  $('copilotMeta').textContent = `${b.meta.latencyMs}ms · ${b.meta.pipeline.length} 个 Agent 模块`;

  const parts = [];
  parts.push(panelWhat(b));
  parts.push(panelPromise(b));
  parts.push(panelUnresolved(b));
  parts.push(panelEscalation(b));
  parts.push(panelRisk(b));
  parts.push(panelAction(b));
  parts.push(panelReply(b));

  $('copilotPanel').innerHTML = parts.join('');
}

/* ── 1. What happened ─────────────────────────────────────── */
function panelWhat(b) {
  const lines = b.serviceMemory.narrative.map((t) => h`<p>${t}</p>`).join('');
  const ev = b.serviceMemory.events;
  const key = ev
    .filter((e) => ['wrong_item_received', 'promise_made', 'promise_unfulfilled', 'promise_fulfilled', 'product_push', 'reshipment_created'].includes(e.type))
    .slice(-5)
    .map(
      (e) => h`<div class="tl-item src-${e.source} ${e.status === 'unresolved' ? 'unresolved' : e.status === 'resolved' ? 'resolved' : ''}" style="padding-bottom:8px">
          <div class="tl-date">${fmtDateTime(e.at)} · <span class="tl-src ${e.source}">${srcLabel[e.source]}</span></div>
          <div class="tl-title" style="font-size:12px">${e.title}</div>
          <div class="tl-detail">${e.detail}</div>
        </div>`,
    )
    .join('');

  const body = h`
    <div class="narrative">${raw(lines)}</div>
    <div class="section-title">关键事件</div>
    <div class="timeline">${raw(key)}</div>`;

  const badge = h`<span class="badge neutral">${b.serviceMemory.counts.events} 个事件</span>`;
  return panel('what', badge, body);
}

/* ── 2. Promise Tracking ──────────────────────────────────── */
function panelPromise(b) {
  const s = b.promises.stats;
  const badge = b.promises.unfulfilled.length
    ? h`<span class="badge high">未兑现 ${b.promises.unfulfilled.length}</span>`
    : h`<span class="badge low">均已兑现</span>`;

  const promiseCards = b.promises.promises
    .map((p) => {
      const cls = p.status === 'UNFULFILLED' ? 'unfulfilled' : p.status === 'FULFILLED' ? 'fulfilled' : '';
      const badgeCls =
        p.status === 'UNFULFILLED' ? 'high' : p.status === 'FULFILLED' ? 'low' : p.status === 'UNKNOWN' ? 'neutral' : 'mid';
      return h`
        <div class="promise-card ${cls}">
          <div class="pc-top" style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <span class="badge brand">${p.subjectLabel}</span>
            <span class="badge ${badgeCls}">${p.statusLabel}</span>
            ${p.deadline ? raw(h`<span class="badge neutral">时限 ${p.deadline.absoluteLabel}</span>`) : ''}
          </div>
          <div class="pc-quote">「${p.quote}」</div>
          <div class="pc-meta">${p.agentName} · ${fmtDateTime(p.at)} · ${p.channel === 'app' ? 'APP 在线客服' : p.channel}</div>
          <div class="pc-verify">核验：${p.verify?.conclusion || ''}</div>
          ${raw(evidenceBlock((p.verify?.checks || []).map((c) => ({ ref: c.label, text: c.value, pass: c.pass }))))}
        </div>`;
    })
    .join('');

  const utteranceRows = b.promises.utterances
    .slice(0, 10)
    .map((u) => {
      const cls =
        u.category === 'PROMISE' ? 'high' : u.category === 'ESTIMATE' ? 'mid' : u.category === 'ACTION' ? 'brand' : 'neutral';
      return h`
        <div class="utterance-row">
          <span class="badge ${cls} cat">${u.categoryLabel}</span>
          <div>
            <div class="txt">${u.quote}</div>
            <div class="why">${u.classifierReason}</div>
          </div>
        </div>`;
    })
    .join('');

  const body = h`
    <div class="callout info">
      只有「明确承诺」才进入承诺追踪。系统把客服话术分为四类并逐一给出判定依据：
      明确承诺 <b>${s.promise}</b> ｜ 预计 <b>${s.estimate}</b> ｜ 执行动作 <b>${s.action}</b> ｜ 普通解释 <b>${s.explanation}</b>。
      承诺兑现与否一律回查订单 / 工单数据，不由模型推测。
    </div>
    ${b.promises.promises.length ? raw(promiseCards) : raw('<div class="empty">该消费者历史会话中未识别出明确承诺</div>')}
    <div class="section-title">话术分类明细</div>
    ${raw(utteranceRows)}`;

  return panel('promise', badge, body);
}

/* ── 3. Unresolved ────────────────────────────────────────── */
function panelUnresolved(b) {
  const list = b.serviceMemory.unresolved;
  const badge = list.length ? h`<span class="badge high">${list.length} 项</span>` : h`<span class="badge low">无</span>`;

  const checks = b.case.checks
    .map(
      (c) => h`<div class="utterance-row">
        <span class="badge ${c.pass ? 'low' : 'high'} cat">${c.pass ? '✔' : '✘'}</span>
        <div>
          <div class="txt"><b>${c.item}</b> → ${c.statusLabel}</div>
          ${c.detail ? raw(h`<div class="why">${c.detail}</div>`) : ''}
        </div>
      </div>`,
    )
    .join('');

  const body = h`
    ${list.length
      ? raw(
          list
            .map(
              (u) => h`
        <div class="unresolved-item ${u.severity === 'MEDIUM' ? 'medium' : ''}">
          <div class="ui-top">
            <span class="badge ${riskBadgeClass(u.severity)}">${u.severity}</span>
            <span class="ui-title">${u.title}</span>
          </div>
          <div class="ui-detail">${u.detail}</div>
          <div class="ui-ev">${raw(evidenceBlock(u.evidence))}</div>
        </div>`,
            )
            .join(''),
        )
      : raw('<div class="empty">没有检测到尚未解决的问题</div>')}

    <div class="section-title">闭环检查 · Resolution Check</div>
    ${raw(checks)}
    <div class="progress-track"><div class="progress-fill" style="width:${b.case.progress.total ? Math.round((b.case.progress.passed / b.case.progress.total) * 100) : 100}%"></div></div>
    <div class="reply-meta">${b.case.progress.passed}/${b.case.progress.total} 项已闭环 · ${b.case.nextStep}</div>`;

  return panel('unresolved', badge, body);
}

/* ── 4. Why escalating ────────────────────────────────────── */
function panelEscalation(b) {
  const e = b.escalation;
  const badge = h`<span class="badge ${e.confidence.level === 'HIGH' ? 'high' : 'mid'}">根因置信度 ${e.confidence.level}</span>`;

  const compareRows = e.comparison
    .map(
      (c) => h`
      <tr>
        <td class="dim">${c.dimension}</td>
        <td class="belief">${c.consumerBelief}</td>
        <td class="truth">${c.systemTruth}${c.gap ? raw(' <span class="gap-mark">≠</span>') : ''}</td>
      </tr>`,
    )
    .join('');

  const body = h`
    <div class="kv"><span class="k">当前问题</span><span class="v"><b>${e.currentIssue}</b></span></div>
    <div class="kv"><span class="k">升级原因</span><span class="v"><b style="color:var(--high)">${e.rootCauseLabel}</b></span></div>
    <div class="narrative" style="margin-top:8px">${e.summary.replace(/\*\*/g, '')}</div>

    ${
      e.comparison.length
        ? raw(h`
      <div class="section-title">认知落差对照</div>
      <table class="compare">
        <thead><tr><th>维度</th><th>消费者认知</th><th>系统真实状态</th></tr></thead>
        <tbody>${raw(compareRows)}</tbody>
      </table>`)
        : ''
    }

    <div class="section-title">证据链</div>
    ${raw(evidenceBlock(e.evidence))}
    <div class="reply-meta">判定依据：${e.confidence.reason}</div>`;

  return panel('escalation', badge, body);
}

/* ── 5. Risk ──────────────────────────────────────────────── */
function panelRisk(b) {
  const r = b.risk;
  const badge = h`<span class="badge ${riskBadgeClass(r.overall)}">${r.overallLabel}</span>`;

  const guard = r.guardrails;
  const guardHtml = guard.blockProductRecommendation || guard.requireHumanEscalation
    ? h`
      <div class="guardrail">
        <div class="gr-title">⛔ 已触发安全护栏</div>
        <div class="gr-body">
          ${guard.blockProductRecommendation ? '本次会话禁止进行任何常规产品推荐。<br/>' : ''}
          ${guard.requireHumanEscalation ? '该会话需要人工升级接管。<br/>' : ''}
          ${guard.notes.join('<br/>')}
        </div>
      </div>`
    : '';

  const items = r.risks.length
    ? r.risks
        .map(
          (x) => h`
        <div class="risk-item ${x.level === 'HIGH' ? 'high' : x.level === 'MEDIUM' ? 'mid' : ''}">
          <div class="ri-top">
            <span class="badge ${riskBadgeClass(x.level)}">${x.level}</span>
            <span class="ri-label">${x.label}</span>
          </div>
          <div class="ri-reason">${x.reason}</div>
          ${raw(evidenceBlock(x.evidence))}
        </div>`,
        )
        .join('')
    : h`<div class="empty">未识别到风险项</div>`;

  const body = h`
    ${raw(guardHtml)}
    ${raw(items)}
    <div class="reply-meta">${r.disclaimer}</div>`;

  return panel('risk', badge, body);
}

/* ── 6. Next Best Action ──────────────────────────────────── */
function panelAction(b) {
  const plan = b.actionPlan;
  const done = state.executed[state.currentId] || new Set();
  const badge = h`<span class="badge brand">${plan.actions.length} 个动作</span>`;

  const banner = plan.banner
    ? h`<div class="callout high"><b>${plan.banner.text}</b><br/>${plan.banner.source}</div>`
    : '';

  const items = plan.actions.length
    ? plan.actions
        .map((a) => {
      const isDone = done.has(a.title);
      const tools = a.tools
        .map((t) => h`<span class="tool-chip ${a.kind === 'write' ? 'write' : ''}">${t.name}</span>`)
        .join('');
      return h`
        <div class="action-item ${isDone ? 'done' : ''}">
          <div class="ai-top">
            <span class="ai-no">${isDone ? '✓' : a.priority}</span>
            <div style="flex:1">
              <div class="ai-title">${a.title}</div>
              <div class="ai-reason"><b>为什么：</b>${a.reason}</div>
              ${
                a.riskIfSkipped
                  ? raw(h`<div class="ai-reason" style="color:var(--high)"><b>不做的后果：</b>${a.riskIfSkipped}</div>`)
                  : ''
              }
              ${
                a.disclaimer
                  ? raw(h`<div class="action-note">${a.disclaimer}</div>`)
                  : ''
              }
              ${
                a.conditional
                  ? raw(h`<div class="action-note">执行条件：${a.conditional}</div>`)
                  : ''
              }
              <div class="ai-row">
                ${raw(tools)}
                <span class="badge ${a.kind === 'write' ? 'violet' : 'neutral'}">${a.kind === 'write' ? '写操作 · 需人工确认' : '只读查询'}</span>
                <button class="btn ${a.kind === 'write' ? 'primary' : ''} sm" data-run="${a.id}" style="margin-left:auto">
                  ${a.kind === 'write' ? '确认执行' : '执行查询'}
                </button>
              </div>
              <div class="reply-meta">预期结果：${a.expectedOutcome}</div>
            </div>
          </div>
          ${raw(renderToolLog(state.currentId, a.title))}
        </div>`;
        })
        .join('')
    : h`<div class="callout" style="border-color:var(--low-line);background:var(--low-bg);color:#1f5c3d">
        <b>本 Case 已闭环</b><br/>所有未解决问题均已处理完毕，无需进一步动作。消费者若再次进线，系统会重新进入 Service Memory 分析流程。
      </div>`;

  const body = h`${raw(banner)}${raw(items)}`;
  return panel('action', badge, body);
}

function renderToolLog(consumerId, actionTitle) {
  const logs = (state.toolLog[consumerId] || []).filter((l) => l.actionTitle === actionTitle);
  if (!logs.length) return '';
  return logs
    .map(
      (l) => h`
      <div class="tool-result">
        <div class="tr-name">Agent 执行 · ${fmtTime(l.at)}</div>
        ${raw(
          l.calls
            .map(
              (c) => h`
          <div style="margin-top:5px">
            <span class="badge ${c.ok ? 'low' : 'high'}">${c.ok ? '成功' : '失败'}</span>
            <span class="tr-name">${c.name}</span>
            <pre>${c.ok ? JSON.stringify(c.result, null, 2) : c.error}</pre>
            ${raw(renderEffects(c.effects))}
          </div>`,
            )
            .join(''),
        )}
      </div>`,
    )
    .join('');
}

function renderEffects(effects) {
  if (!effects || !effects.length) return '';
  return h`<div class="effects">${raw(
    effects
      .map(
        (e) => h`<div class="effect-row">
          <span class="arrow">→</span>
          <span>${e.target}${e.id ? ` ${e.id}` : ''} · ${e.field} 更新为 <b>${e.to}</b></span>
        </div>`,
      )
      .join(''),
  )}</div>`;
}

/* ── 7. Suggested Reply ───────────────────────────────────── */
function panelReply(b) {
  const r = b.reply;
  const editing = state.replyEditing;
  const text = state.replyText ?? r.text;
  const badge = h`<span class="badge ${r.source === 'llm' ? 'violet' : 'neutral'}">${r.source === 'llm' ? 'LLM 润色' : '规则生成'}</span>`;

  const body = h`
    <div class="callout">
      AI <b>不会直接发送消息</b>。请先核对事实，再选择采用、修改或拒绝。
    </div>
    <div class="reply-box ${editing ? 'editing' : ''}">
      ${editing ? raw(h`<textarea id="replyEdit">${text}</textarea>`) : text}
    </div>
    <div class="reply-actions">
      ${
        editing
          ? raw(h`<button class="btn primary sm" data-reply="save">保存并作为客服回复发送</button>
                 <button class="btn sm" data-reply="cancel">取消修改</button>`)
          : raw(h`<button class="btn primary sm" data-reply="adopt">采用回复</button>
                 <button class="btn sm" data-reply="edit">修改</button>
                 <button class="btn danger sm" data-reply="reject">拒绝</button>`)
      }
    </div>
    <div class="section-title">生成依据（每句话都可回溯到数据源）</div>
    ${raw(evidenceBlock(r.facts.map((f) => ({ ref: `[${srcLabel[f.source] || f.source}] ${f.ref}`, text: f.text }))))}
    <div class="section-title">生成约束</div>
    ${raw(r.forbidden.map((f) => h`<div class="utterance-row"><span class="badge neutral cat">约束</span><div class="txt">${f}</div></div>`).join(''))}`;

  return panel('reply', badge, body);
}

/* ══════════════════════════════════════════════════════════
   交互
   ══════════════════════════════════════════════════════════ */
function onCopilotClick(e) {
  const toggle = e.target.closest('[data-toggle]');
  if (toggle && !e.target.closest('button')) {
    const key = toggle.dataset.toggle;
    state.collapsed[key] = !state.collapsed[key];
    renderCopilot();
    return;
  }

  const run = e.target.closest('[data-run]');
  if (run) {
    const action = state.brief.actionPlan.actions.find((a) => a.id === run.dataset.run);
    if (action) requestAction(action);
    return;
  }

  const replyBtn = e.target.closest('[data-reply]');
  if (replyBtn) handleReply(replyBtn.dataset.reply);
}

function setBusy(v) {
  state.busy = v;
  const btn = $('btnSend');
  if (btn) {
    btn.disabled = v;
    btn.innerHTML = v ? raw('<span class="spinner"></span> 分析中…') : '发送并重新分析';
  }
}

/* ── 执行动作 ─────────────────────────────────────────────── */
function requestAction(action) {
  if (action.requiresConfirmation) {
    const toolRows = action.tools
      .map(
        (t) => h`<div class="tool-result">
          <div class="tr-name">${t.name}</div>
          <pre>${JSON.stringify(t.params, null, 2)}</pre>
        </div>`,
      )
      .join('');
    openModal({
      title: action.title,
      subtitle: '该操作会改变业务系统状态，需要你确认后才会执行。',
      body: h`
        <div class="callout high">
          这是写操作，AI 不会自动执行。确认后系统将真实修改订单 / 工单状态，并重新计算 Service Memory。
        </div>
        <div class="narrative" style="margin-bottom:8px"><b>为什么：</b>${action.reason}</div>
        ${action.riskIfSkipped ? raw(h`<div class="narrative" style="margin-bottom:8px;color:var(--high)"><b>不做的后果：</b>${action.riskIfSkipped}</div>`) : ''}
        ${action.disclaimer ? raw(h`<div class="callout">${action.disclaimer}</div>`) : ''}
        <div class="section-title">将调用以下工具</div>
        ${raw(toolRows)}`,
      confirmText: '确认执行',
      onConfirm: () => executeAction(action),
    });
  } else {
    executeAction(action);
  }
}

async function executeAction(action) {
  setBusy(true);
  try {
    const calls = action.tools.map((t) => ({ name: t.name, params: t.params }));
    const res = await api.runBatch(calls, state.currentId);

    state.toolLog[state.currentId] = state.toolLog[state.currentId] || [];
    state.toolLog[state.currentId].unshift({
      at: new Date().toISOString(),
      actionTitle: action.title,
      calls: res.results.map((r) => ({
        name: r.tool,
        ok: r.ok,
        result: r.result,
        error: r.error,
        effects: r.effects,
      })),
    });
    state.executed[state.currentId] = state.executed[state.currentId] || new Set();
    state.executed[state.currentId].add(action.title);

    state.brief = res.brief;
    await refreshConsumers();
    renderAll();

    const okCount = res.results.filter((r) => r.ok).length;
    toast(`已执行 ${okCount}/${res.results.length} 个工具，Service Memory 已重新计算`, okCount ? 'ok' : 'err');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    setBusy(false);
  }
}

/* ── Human-in-the-loop ────────────────────────────────────── */
async function handleReply(kind) {
  if (kind === 'edit') {
    state.replyEditing = true;
    state.replyText = state.brief.reply.text;
    renderCopilot();
    const ta = $('replyEdit');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    return;
  }
  if (kind === 'cancel') {
    state.replyEditing = false;
    renderCopilot();
    return;
  }
  if (kind === 'save') {
    const ta = $('replyEdit');
    const text = ta ? ta.value.trim() : state.replyText;
    if (!text) { toast('回复内容不能为空', 'err'); return; }
    await submitReply('edit', text);
    return;
  }
  if (kind === 'adopt') {
    await submitReply('adopt', state.brief.reply.text);
    return;
  }
  if (kind === 'reject') {
    await submitReply('reject', '');
  }
}

async function submitReply(decision, text) {
  setBusy(true);
  try {
    state.brief = await api.replyDecision(state.currentId, decision, text);
    state.replyEditing = false;
    state.replyText = null;
    renderAll();
    toast(
      decision === 'adopt' ? '已采用 AI 建议回复并发送' : decision === 'edit' ? '已发送修改后的回复' : '已拒绝该建议回复',
      decision === 'reject' ? '' : 'ok',
    );
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    setBusy(false);
  }
}

/* ── 启动 ─────────────────────────────────────────────────── */
boot();
