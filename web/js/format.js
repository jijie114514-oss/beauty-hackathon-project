/* ==========================================================================
   前端公共工具：安全的 HTML 模板、时间格式化、Toast、Modal
   ========================================================================== */

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);

/** 标记一段内容为「可信 HTML」，不转义 */
export const raw = (s) => ({ __raw: String(s ?? '') });

/**
 * 安全模板字符串：默认对插值做 HTML 转义，需要插入 HTML 时显式用 raw()。
 * 用法：h`<div>${userInput}</div>` / h`<div>${raw(html)}</div>`
 */
export function h(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i += 1) {
    const v = vals[i];
    if (v && v.__raw !== undefined) out += v.__raw;
    else if (Array.isArray(v)) out += v.map((x) => (x && x.__raw !== undefined ? x.__raw : esc(x))).join('');
    else if (v === null || v === undefined || v === false) out += '';
    else out += esc(v);
    out += strings[i + 1];
  }
  return out;
}

/* ── 时间格式化（统一 Asia/Shanghai） ────────────────────── */
const TZ = 'Asia/Shanghai';
const pad = (n) => String(n).padStart(2, '0');

function p(iso) {
  const f = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const g = (t) => f.find((x) => x.type === t)?.value || '00';
  return { y: g('year'), m: g('month'), d: g('day'), h: g('hour') === '24' ? '00' : g('hour'), mi: g('minute') };
}

export const fmtDate = (iso) => (iso ? `${Number(p(iso).m)}月${Number(p(iso).d)}日` : '');
export const fmtTime = (iso) => (iso ? `${pad(p(iso).h)}:${pad(p(iso).mi)}` : '');
export const fmtDateTime = (iso) => (iso ? `${fmtDate(iso)} ${fmtTime(iso)}` : '');
export const fmtStamp = (iso) => {
  if (!iso) return '';
  const x = p(iso);
  return `${x.y}-${x.m}-${x.d} ${pad(x.h)}:${pad(x.mi)}`;
};

const dayKey = (iso) => { const x = p(iso); return `${x.y}-${x.m}-${x.d}`; };

export function dayLabel(iso, nowIso = new Date().toISOString()) {
  const a = new Date(dayKey(iso) + 'T00:00:00+08:00');
  const b = new Date(dayKey(nowIso) + 'T00:00:00+08:00');
  const diff = Math.round((b - a) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  if (diff > 2) return `${diff} 天前`;
  if (diff === -1) return '明天';
  return fmtDate(iso);
}

export const dayHeading = (iso, nowIso) => {
  const l = dayLabel(iso, nowIso);
  const d = fmtDate(iso);
  return l === d ? d : `${l} · ${d}`;
};

export const hoursBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 3600000));

/* ── UI 小工具 ───────────────────────────────────────────── */

export function toast(msg, kind = '') {
  const wrap = document.getElementById('toastWrap');
  if (!wrap) return;
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = msg;
  wrap.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 260);
  }, 2600);
}

export function openModal({ title, subtitle, body, confirmText = '确认', cancelText = '取消', danger = false, onConfirm }) {
  const root = document.getElementById('modalRoot');
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = h`
    <div class="modal">
      <div class="modal-head">
        <h3>${title}</h3>
        ${subtitle ? h`<p>${subtitle}</p>` : ''}
      </div>
      <div class="modal-body">${raw(body)}</div>
      <div class="modal-foot">
        <button class="btn" data-act="cancel">${cancelText}</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${confirmText}</button>
      </div>
    </div>`;
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'cancel') close();
    if (act === 'ok') { close(); onConfirm?.(); }
  });
  root.appendChild(overlay);
}

export const riskBadgeClass = (level) =>
  level === 'HIGH' ? 'high' : level === 'MEDIUM' ? 'mid' : 'low';

export const srcLabel = { chat: '聊天', order: '订单', ticket: '工单', system: '系统' };

/** 稳定排序：按时间升序 */
export const byTimeAsc = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
