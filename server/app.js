/**
 * Service Memory Copilot —— HTTP 服务（零依赖）
 * ------------------------------------------------------------------
 * 启动：node server/index.js  （或 npm start）
 * 默认端口 8787，可用 PORT 环境变量覆盖。
 *
 * 同时承担两个职责：
 *   1. 静态托管 web/ 下的前端
 *   2. 提供 REST API，把 Agent 编排层与 Tool 层暴露出去
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as store from './store.js';
import { getSettings, updateSettings, getStats } from './llm.js';
import { invoke, TOOL_META, TOOL_SPECS, getToolLog } from './tools/index.js';
import { analyze, listConsumers, scanAll, getCase } from './agents/orchestrator.js';
import { getMemoryCacheStats } from './agents/serviceMemory.js';
import { getTrace } from './semantic/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(__dirname, '..', 'web');
const PORT = Number(process.env.PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ── Human-in-the-loop 决策记录（内存） ───────────────────── */
const decisions = [];

/* ── 工具函数 ─────────────────────────────────────────────── */
const sendJSON = (res, code, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 4 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/risk-center') rel = '/risk-center.html';

  const filePath = path.join(WEB_ROOT, rel);
  if (!filePath.startsWith(WEB_ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

/* ── 路由 ─────────────────────────────────────────────────── */
async function handleAPI(req, res, urlPath, query) {
  const method = req.method.toUpperCase();
  const seg = urlPath.replace(/^\/api\/?/, '').split('/').filter(Boolean);

  /* GET /api/health */
  if (seg[0] === 'health') {
    return sendJSON(res, 200, {
      ok: true,
      service: 'Service Memory Copilot',
      version: '0.1.0',
      now: store.now().toISOString(),
      llm: getSettings(),
      tools: Object.keys(TOOL_META),
      consumers: store.consumers().length,
    });
  }

  /* GET|POST /api/settings */
  if (seg[0] === 'settings') {
    if (method === 'GET') return sendJSON(res, 200, { ok: true, settings: getSettings() });
    const body = await readBody(req);
    return sendJSON(res, 200, { ok: true, settings: updateSettings(body) });
  }

  /* POST /api/reset */
  if (seg[0] === 'reset' && method === 'POST') {
    store.reset();
    return sendJSON(res, 200, { ok: true, message: 'Mock 数据已重置为初始状态。' });
  }

  /* GET /api/tools */
  if (seg[0] === 'tools' && seg.length === 1 && method === 'GET') {
    return sendJSON(res, 200, { ok: true, tools: TOOL_META });
  }

  /* POST /api/tools/:name  |  POST /api/tools/batch */
  if (seg[0] === 'tools' && method === 'POST') {
    const body = await readBody(req);

    if (seg[1] === 'batch') {
      const calls = Array.isArray(body.calls) ? body.calls : [];
      const results = calls.map((c) => invoke(c.name, c.params));
      const consumerId = body.consumerId;
      const brief = consumerId ? await analyze({ consumerId }) : null;
      return sendJSON(res, 200, { ok: results.every((r) => r.ok), results, brief });
    }

    const name = seg[1];
    if (!name) return sendJSON(res, 400, { ok: false, error: '缺少工具名' });
    const result = invoke(name, body.params || body);
    const consumerId = body.consumerId || result?.params?.consumerId;
    const brief = consumerId ? await analyze({ consumerId }) : null;
    return sendJSON(res, result.ok ? 200 : 400, { ok: result.ok, result, brief });
  }

  /* GET /api/consumers */
  if (seg[0] === 'consumers' && seg.length === 1 && method === 'GET') {
    return sendJSON(res, 200, { ok: true, consumers: await listConsumers() });
  }

  /* GET /api/consumers/:id/context */
  if (seg[0] === 'consumers' && seg[2] === 'context' && method === 'GET') {
    const ctx = store.contextOf(seg[1]);
    if (!ctx) return sendJSON(res, 404, { ok: false, error: '未找到消费者' });
    return sendJSON(res, 200, { ok: true, context: ctx });
  }

  /* POST /api/copilot/analyze  |  POST /api/copilot/message */
  if (seg[0] === 'copilot' && method === 'POST') {
    const body = await readBody(req);
    const consumerId = body.consumerId;
    if (!consumerId) return sendJSON(res, 400, { ok: false, error: '缺少 consumerId' });

    if (seg[1] === 'message') {
      const text = String(body.text || '').trim();
      if (!text) return sendJSON(res, 400, { ok: false, error: '消息内容为空' });
      const session = store.appendMessage(consumerId, {
        id: `m${Date.now()}`,
        role: 'consumer',
        at: new Date().toISOString(),
        text,
      });
      const brief = await analyze({ consumerId, message: text });
      return sendJSON(res, 200, { ok: true, sessionId: session.id, brief });
    }

    if (seg[1] === 'analyze') {
      const brief = await analyze({ consumerId, message: body.message || null });
      return sendJSON(res, 200, { ok: true, brief });
    }

    /* POST /api/copilot/reply-decision —— Human-in-the-loop */
    if (seg[1] === 'reply-decision') {
      const decision = body.decision;
      const text = String(body.text || '').trim();
      if (!['adopt', 'edit', 'reject'].includes(decision)) {
        return sendJSON(res, 400, { ok: false, error: 'decision 必须为 adopt / edit / reject' });
      }
      const record = {
        id: `RD_${Date.now()}`,
        at: new Date().toISOString(),
        decision,
        text,
        operator: body.operator || '客服-当前坐席',
      };
      if (decision !== 'reject' && text) {
        store.appendMessage(consumerId, {
          id: `m${Date.now()}`,
          role: 'agent',
          at: record.at,
          text,
          operator: record.operator,
          decision,
        });
      }
      decisions.unshift(record);
      const brief = await analyze({ consumerId });
      return sendJSON(res, 200, { ok: true, record, brief });
    }
  }

  /* GET /api/llm/stats —— Token 用量与语义任务轨迹 */
  if (seg[0] === 'llm' && seg[1] === 'stats' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, stats: getStats(), memoryCache: getMemoryCacheStats(), trace: getTrace() });
  }

  /* GET /api/tools/log —— 工具调用日志 */
  if (seg[0] === 'tools' && seg[1] === 'log' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, log: getToolLog(200) });
  }

  /* GET /api/tools/specs */
  if (seg[0] === 'tools' && seg[1] === 'specs' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, specs: TOOL_SPECS, meta: TOOL_META });
  }

  /* GET /api/cases/:consumerId —— 单条 Case 详情 */
  if (seg[0] === 'cases' && seg[1] && method === 'GET') {
    try {
      return sendJSON(res, 200, { ok: true, ...(await getCase(seg[1])) });
    } catch (e) {
      return sendJSON(res, 404, { ok: false, error: String(e.message || e) });
    }
  }

  /* GET /api/cases */
  if (seg[0] === 'cases' && method === 'GET') {
    const rc = await scanAll();
    return sendJSON(res, 200, { ok: true, cases: rc.cases, stats: rc.stats, engine: rc.engine });
  }

  /* GET /api/risk-center */
  if (seg[0] === 'risk-center' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, ...(await scanAll()) });
  }

  /* GET /api/decisions */
  if (seg[0] === 'decisions' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, decisions });
  }

  return sendJSON(res, 404, { ok: false, error: `未知 API：${urlPath}` });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  try {
    if (url.pathname.startsWith('/api')) {
      await handleAPI(req, res, url.pathname, url.searchParams);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error('[error]', err);
    if (!res.headersSent) sendJSON(res, 500, { ok: false, error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  const s = getSettings();
  console.log('');
  console.log('  ╭──────────────────────────────────────────────────────────╮');
  console.log('  │  Service Memory Copilot · AI 客服共情助手                 │');
  console.log('  ╰──────────────────────────────────────────────────────────╯');
  console.log(`  ▸ 客服工作台   http://localhost:${PORT}/`);
  console.log(`  ▸ Risk Center  http://localhost:${PORT}/risk-center`);
  console.log(`  ▸ API 健康检查 http://localhost:${PORT}/api/health`);
  console.log('');
  console.log(`  ▸ Agent 引擎   ${s.enabled ? `hybrid（规则 + ${s.model}）` : 'deterministic-rules（确定性规则引擎）'}`);
  if (!s.enabled) {
    console.log('    如需接入开源大模型（如 Qwen），设置环境变量后重启：');
    console.log('      LLM_API_KEY=sk-xxx LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 LLM_MODEL=qwen-plus');
  }
  console.log('');
});
