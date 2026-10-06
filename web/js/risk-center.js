/* ==========================================================================
   Risk Center —— 管理端聚合视图
   刻意保持简单：四类列表 + 一个统计条，不做复杂 BI Dashboard。
   点击任意条目直接进入该消费者的 Service Memory。
   ========================================================================== */

import { api } from './api.js';
import { h, raw, fmtDateTime, fmtDate, toast, riskBadgeClass } from './format.js';

const $ = (id) => document.getElementById(id);
const go = (cid) => { location.href = `/?consumer=${encodeURIComponent(cid)}`; };

async function load() {
  let d;
  try {
    d = await api.riskCenter();
  } catch (e) {
    toast('加载失败：' + e.message, 'err');
    return;
  }

  /* 统计条 */
  $('rcStats').innerHTML = h`
    <div class="stat-card high"><div class="sc-num">${d.stats.highRisk}</div><div class="sc-label">高风险会话</div></div>
    <div class="stat-card mid"><div class="sc-num">${d.stats.unresolvedPromises}</div><div class="sc-label">未兑现承诺</div></div>
    <div class="stat-card brand"><div class="sc-num">${d.stats.repeatContacts}</div><div class="sc-label">重复进线</div></div>
    <div class="stat-card"><div class="sc-num">${d.stats.escalated}</div><div class="sc-label">升级事件</div></div>
    <div class="stat-card high"><div class="sc-num">${d.stats.sensitive}</div><div class="sc-label">敏感肌 / 禁推会话</div></div>
    <div class="stat-card"><div class="sc-num">${d.stats.totalConsumers}</div><div class="sc-label">接入消费者总数</div></div>
  `;

  $('c1').innerHTML = h`<span class="badge high">${d.highRisk.length}</span>`;
  $('c2').innerHTML = h`<span class="badge high">${d.unresolvedPromises.length}</span>`;
  $('c3').innerHTML = h`<span class="badge mid">${d.repeatContacts.length}</span>`;
  $('c4').innerHTML = h`<span class="badge neutral">${d.escalated.length}</span>`;

  /* ① High Risk Conversations */
  $('listHigh').innerHTML = d.highRisk.length
    ? d.highRisk
        .map((x) => {
            const risks = x.risks
              .slice(0, 3)
              .map(
                (r) => h`<div class="ri-foot" style="margin-top:4px;display:block">
                  <span class="badge ${riskBadgeClass(r.level)}">${r.label}</span>
                  <span style="color:var(--ink-3)">${r.reason}</span>
                </div>`,
              )
              .join('');
            return h`
              <div class="rc-item" data-cid="${x.consumerId}">
                <div class="ri-head">
                  <span class="ri-name">${x.consumerName}</span>
                  <span class="badge high">${x.riskLevel}</span>
                  <span class="badge ${x.caseStatus === 'RESOLVED' ? 'low' : 'brand'}" style="margin-left:auto">${x.caseStatus}</span>
                </div>
                <div class="ri-body">
                  <div style="color:var(--ink-3);font-size:11px">当前消息</div>
                  <div>${x.currentMessage}</div>
                  <div style="margin-top:6px;color:var(--ink-3);font-size:11px">升级原因</div>
                  <div><b>${x.escalation.rootCauseLabel}</b>：${x.escalation.currentIssue}</div>
                </div>
                ${raw(risks)}
                ${x.guardrails?.blockProductRecommendation ? raw('<div class="ri-foot"><span class="badge high">⛔ 禁止产品推荐</span></div>') : ''}
              </div>`;
          })
          .join('')
    : h`<div class="empty">当前没有高风险会话</div>`;

  /* ② Unresolved Promises */
  $('listPromise').innerHTML = d.unresolvedPromises.length
    ? d.unresolvedPromises
        .map(
            (p) => h`
            <div class="rc-item" data-cid="${p.consumerId}">
              <div class="ri-head">
                <span class="ri-name">${p.consumerName}</span>
                <span class="badge brand">${p.subjectLabel}</span>
                <span class="badge high" style="margin-left:auto">未兑现</span>
              </div>
              <div class="ri-body">
                <div>「${p.quote}」</div>
                <div style="margin-top:4px;color:var(--ink-3)">
                  ${p.agentName} 于 ${fmtDateTime(p.madeAt)} 承诺 ｜ 时限 ${p.deadlineLabel}
                </div>
                <div style="margin-top:4px">${p.conclusion}</div>
              </div>
              <div class="ri-foot">
                ${raw(p.evidence.slice(0, 2).map((e) => h`<span>${e}</span>`).join(''))}
              </div>
            </div>`,
          )
          .join('')
    : h`<div class="empty">没有未兑现的客服承诺</div>`;

  /* ③ Repeat Contacts */
  $('listRepeat').innerHTML = d.repeatContacts.length
    ? d.repeatContacts
        .map(
            (c) => h`
            <div class="rc-item" data-cid="${c.consumerId}">
              <div class="ri-head">
                <span class="ri-name">${c.consumerName}</span>
                <span class="badge mid">近 7 天 ${c.contacts} 次进线</span>
                <span class="badge ${riskBadgeClass(c.riskLevel)}" style="margin-left:auto">${c.riskLevel}</span>
              </div>
              <div class="ri-body">
                <div style="color:var(--ink-3);font-size:11px">最近一次</div>
                <div>${c.lastMessage}</div>
                <div style="margin-top:5px">根因：<b>${c.rootCauseLabel || '—'}</b> ｜ 情绪：${c.emotion}</div>
              </div>
            </div>`,
          )
          .join('')
    : h`<div class="empty">没有重复进线记录</div>`;

  /* ④ Escalated Cases */
  $('listEscalated').innerHTML = d.escalated.length
    ? d.escalated
        .map(
            (e) => h`
            <div class="rc-item" data-cid="${e.consumerId}">
              <div class="ri-head">
                <span class="ri-name">${e.consumerName}</span>
                <span class="badge ${e.status === 'RESOLVED' ? 'low' : 'brand'}" style="margin-left:auto">${e.status}</span>
              </div>
              <div class="ri-body">
                <div><b>${e.title}</b></div>
                <div style="margin-top:4px">${e.reason}</div>
              </div>
              <div class="ri-foot">
                <span>工单 ${e.ticketId}</span>
                <span>负责人 ${e.owner}</span>
                <span>${fmtDateTime(e.createdAt)}</span>
              </div>
            </div>`,
          )
          .join('')
    : h`<div class="empty">暂无升级事件</div>`;

  /* 点击跳转 */
  document.querySelectorAll('.rc-item').forEach((node) => {
    node.addEventListener('click', () => go(node.dataset.cid));
  });
}

$('btnRefresh').addEventListener('click', () => {
  load();
  toast('已刷新');
});

load();
