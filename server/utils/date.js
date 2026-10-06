/**
 * 时间格式化工具
 * 统一以 Asia/Shanghai 呈现，避免 ISO(UTC) 直接暴露给客服看。
 */
const TZ = 'Asia/Shanghai';

const pad = (n) => String(n).padStart(2, '0');

function parts(iso) {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t) => f.find((x) => x.type === t)?.value || '00';
  return {
    y: get('year'),
    m: get('month'),
    d: get('day'),
    h: get('hour') === '24' ? '00' : get('hour'),
    mi: get('minute'),
  };
}

/** 10月6日 */
export const fmtDate = (iso) => {
  if (!iso) return '';
  const p = parts(iso);
  return `${Number(p.m)}月${Number(p.d)}日`;
};

/** 10月6日 12:00 */
export const fmtDateTime = (iso) => {
  if (!iso) return '';
  const p = parts(iso);
  return `${Number(p.m)}月${Number(p.d)}日 ${pad(p.h)}:${pad(p.mi)}`;
};

/** 12:00 */
export const fmtTime = (iso) => {
  if (!iso) return '';
  const p = parts(iso);
  return `${pad(p.h)}:${pad(p.mi)}`;
};

/** 2026-10-06 12:00 */
export const fmtStamp = (iso) => {
  if (!iso) return '';
  const p = parts(iso);
  return `${p.y}-${p.m}-${p.d} ${pad(p.h)}:${pad(p.mi)}`;
};

const dayKey = (iso) => {
  const p = parts(iso);
  return `${p.y}-${p.m}-${p.d}`;
};

/** 今天 / 昨天 / N天前（配合绝对日期使用） */
export function dayLabel(iso, nowIso = new Date().toISOString()) {
  if (!iso) return '';
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

/** 分组用的日期标题：今天 · 10月6日 */
export function dayHeading(iso, nowIso) {
  const label = dayLabel(iso, nowIso);
  const date = fmtDate(iso);
  return label === date ? date : `${label} · ${date}`;
}

/** 距现在多少小时（用于"超时 X 小时"） */
export const hoursSince = (iso, nowIso = new Date().toISOString()) =>
  Math.max(0, Math.round((new Date(nowIso) - new Date(iso)) / 3600000));
