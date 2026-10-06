/** 极简 API 客户端 */
const j = async (url, opts) => {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `请求失败（${res.status}）`);
  }
  return data;
};

const post = (url, body) =>
  j(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

export const api = {
  health: () => j('/api/health'),
  consumers: () => j('/api/consumers').then((d) => d.consumers),
  analyze: (consumerId, message) => post('/api/copilot/analyze', { consumerId, message }).then((d) => d.brief),
  sendMessage: (consumerId, text) => post('/api/copilot/message', { consumerId, text }).then((d) => d.brief),
  runTool: (name, params, consumerId) => post(`/api/tools/${name}`, { params, consumerId }),
  runBatch: (calls, consumerId) => post('/api/tools/batch', { calls, consumerId }),
  replyDecision: (consumerId, decision, text) =>
    post('/api/copilot/reply-decision', { consumerId, decision, text }).then((d) => d.brief),
  riskCenter: () => j('/api/risk-center'),
  reset: () => post('/api/reset'),
  settings: () => j('/api/settings').then((d) => d.settings),
  saveSettings: (patch) => post('/api/settings', patch).then((d) => d.settings),
};
