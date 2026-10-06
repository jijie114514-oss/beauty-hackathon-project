/**
 * 评估脚本 —— 三组对比：Rule Only / LLM Only / Hybrid
 * 用法：npm run eval
 *
 * 只报告真实测试结果，不做任何人为修饰。
 * 输出：evaluation/evaluation-results.json + evaluation/REPORT.md
 *
 * 指标：
 *   · Promise Classification —— Accuracy / Precision / Recall / F1（分五类 + 宏平均）
 *   · Risk Detection         —— Precision / Recall / F1（按风险码）
 *   · Unresolved Detection   —— Accuracy / F1
 *   · Escalation Root Cause  —— Accuracy
 *   · 成本                   —— 每模式调用次数与 Token 用量
 */

process.env.TZ ||= 'Asia/Shanghai';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const base = path.join(ROOT, 'server');

const { analyze } = await import(`${base}/agents/orchestrator.js`);
const { runPromiseClassificationBatch } = await import(`${base}/semantic/index.js`);
const { updateSettings, getSettings, getStats, resetStats } = await import(`${base}/llm.js`);
const { clearMemoryCache } = await import(`${base}/agents/serviceMemory.js`);
const { clearClassifyMemo } = await import(`${base}/agents/promise.js`);
const { clearToolLog } = await import(`${base}/tools/index.js`);
const store = await import(`${base}/store.js`);
const { at } = await import(`${base}/seed.js`);

const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, 'evaluation', 'dataset.json'), 'utf8'));

/* 允许只跑指定模式：EVAL_MODES=llm_only,hybrid npm run eval */
const MODES = (process.env.EVAL_MODES || 'rule_only,llm_only,hybrid').split(',').map((s) => s.trim()).filter(Boolean);

/* ═══════════════ 场景注入 ═══════════════ */

function injectScenario(sc) {
  const c = sc.consumer;
  store.addConsumer({
    id: c.id, name: c.name, level: c.level, phone: '000****0000', city: c.city,
    registeredAt: at(-120, '10:00'), skinProfile: c.skinProfile, tags: c.tags || [],
    note: `评估样本 ${sc.id}`,
  });

  for (const o of sc.orders || []) {
    store.addOrder({
      id: o.id, consumerId: c.id, type: o.type || 'sales',
      items: [{ product: o.product, sku: o.sku, shade: o.shade, qty: 1, price: o.amount }],
      amount: o.amount,
      createdAt: at(o.deliveredDay - 2, '10:00'), paidAt: at(o.deliveredDay - 2, '10:01'),
      shippedAt: at(o.deliveredDay - 1, '09:00'), deliveredAt: at(o.deliveredDay, '15:00'),
      payStatus: 'paid', shipStatus: 'delivered',
      logistics: { carrier: '顺丰速运', trackingNo: `SF${o.id}`, status: 'delivered', lastUpdate: at(o.deliveredDay, '15:00'), lastNode: '已签收' },
      refundStatus: o.refundStatus || 'none',
      refundedAt: o.refundedDay != null ? at(o.refundedDay, '12:00') : undefined,
      reshipStatus: 'none',
      address: `${c.city} · ${c.name}`,
    });
  }

  for (const t of sc.tickets || []) {
    store.addTicket({
      id: t.id, consumerId: c.id, orderId: sc.orders?.[0]?.id || null,
      type: t.type, title: t.title, status: t.status,
      priority: 'P2', owner: '客服-评估',
      createdAt: at(t.day, '15:00'), updatedAt: at(t.day, '16:00'),
      result: t.result || null,
      incidentLogged: t.incidentLogged,
      records: [{ at: at(t.day, '15:00'), actor: '客服-评估', note: t.result || t.title }],
    });
  }

  for (const s of sc.sessions || []) {
    store.addSession({
      id: `S_${sc.id}_${s.day}_${s.hour}`, consumerId: c.id, channel: 'app', agentName: s.agent,
      startedAt: at(s.day, s.hour), endedAt: at(s.day, s.hour), isCurrent: false,
      messages: s.messages.map(([role, hhmm, text], i) => ({ id: `m${i}`, role, at: at(s.day, hhmm), text })),
    });
  }

  for (const e of sc.system_events || []) {
    store.addSystemEvent({
      id: `SYS_${sc.id}`, consumerId: c.id, at: at(e.day, e.hour),
      type: e.type, title: e.title, detail: e.detail, relatedOrder: sc.orders?.[0]?.id || null,
    });
  }

  store.addSession({
    id: `S_${sc.id}_current`, consumerId: c.id, channel: 'app', agentName: '客服-（待接入）',
    startedAt: at(0, '16:00'), endedAt: null, isCurrent: true,
    messages: [{ id: 'm1', role: 'consumer', at: at(0, '16:00'), text: sc.current }],
  });
}

/* ═══════════════ 指标计算 ═══════════════ */

const safeDiv = (a, b) => (b === 0 ? 0 : a / b);

function prf(tp, fp, fn) {
  const p = safeDiv(tp, tp + fp);
  const r = safeDiv(tp, tp + fn);
  return { precision: +p.toFixed(4), recall: +r.toFixed(4), f1: +(safeDiv(2 * p * r, p + r)).toFixed(4), tp, fp, fn };
}

function classificationMetrics(pairs, labels) {
  const per = {};
  let macroP = 0; let macroR = 0; let macroF = 0;
  for (const L of labels) {
    let tp = 0; let fp = 0; let fn = 0;
    for (const { expected, got } of pairs) {
      if (expected === L && got === L) tp += 1;
      else if (expected !== L && got === L) fp += 1;
      else if (expected === L && got !== L) fn += 1;
    }
    per[L] = prf(tp, fp, fn);
    macroP += per[L].precision; macroR += per[L].recall; macroF += per[L].f1;
  }
  const correct = pairs.filter((p) => p.expected === p.got).length;
  return {
    accuracy: +safeDiv(correct, pairs.length).toFixed(4),
    macro: { precision: +(macroP / labels.length).toFixed(4), recall: +(macroR / labels.length).toFixed(4), f1: +(macroF / labels.length).toFixed(4) },
    perClass: per,
    total: pairs.length,
    correct,
  };
}

/* ═══════════════ 单模式评估 ═══════════════ */

async function evaluateMode(mode) {
  updateSettings({ mode });
  clearMemoryCache();
  clearClassifyMemo();
  clearToolLog();
  resetStats();
  store.reset();

  const result = { mode, engine: getSettings().enabled ? 'llm' : 'llm-unavailable', startedAt: new Date().toISOString() };

  /* ── 1. 话术分类 ─────────────────────────────────────── */
  const items = dataset.promise_samples.map((s) => ({ key: s.id, text: s.text, at: at(-1, '12:00'), expected: s.expected_category }));
  let batch = new Map();
  let classifyError = null;
  try {
    batch = await runPromiseClassificationBatch(items.map(({ key, text, at: t }) => ({ key, text, at: t })));
  } catch (err) {
    classifyError = String(err.message || err);
  }
  const pairs = items.map((it) => ({ id: it.id, expected: it.expected, got: batch.get(it.key)?.value.category, text: it.text, note: it.note }));
  result.promiseClassification = classificationMetrics(pairs, ['PROMISE', 'ESTIMATE', 'ACTION', 'EXPLANATION', 'NONE']);
  result.promiseClassification.errors = pairs.filter((p) => p.expected !== p.got).map((p) => ({ id: p.id, text: p.text, expected: p.expected, got: p.got }));
  result.promiseClassification.batchError = classifyError;

  /* ── 2. 端到端场景 ───────────────────────────────────── */
  const scenarioResults = [];
  const riskCodes = new Set();
  for (const sc of dataset.scenarios) {
    for (const code of sc.expected.risk_codes || []) riskCodes.add(code);
  }

  for (const sc of dataset.scenarios) {
    injectScenario(sc);
    let b;
    try {
      b = await analyze({ consumerId: sc.consumer.id });
    } catch (err) {
      /* 单条场景失败不应中断整个模式 —— 如实记录为「该场景未能产出结果」 */
      scenarioResults.push({
        id: sc.id, name: sc.name, category: sc.category,
        expectedRiskCodes: sc.expected.risk_codes || [],
        gotRiskCodes: [],
        expectedRootCause: sc.expected.root_cause || (sc.category === 'normal_inquiry' ? 'new_inquiry' : null),
        gotRootCause: `ERROR: ${String(err.message || err).slice(0, 60)}`,
        rootCauseOk: false,
        unresolvedKinds: [], unresolvedOk: false,
        forbiddenHit: [], guardrailOk: false, actionOk: false,
        riskLevel: 'ERROR',
        error: String(err.message || err),
      });
      continue;
    }
    const gotRisks = b.risk.risks.map((r) => r.code);
    const gotRoot = b.escalation.rootCause;
    const expRoot = sc.expected.root_cause || (sc.category === 'normal_inquiry' ? 'new_inquiry' : null);
    const unresolvedKinds = b.serviceMemory.unresolved_issues.map((u) => u.kind);

    /* 未解决项约束 */
    let unresolvedOk = true;
    if (sc.expected.max_unresolved != null) unresolvedOk = unresolvedKinds.length <= sc.expected.max_unresolved;
    if (sc.category === 'sensitive_beauty') unresolvedOk = unresolvedOk && unresolvedKinds.includes('sensitive_beauty_incident');

    /* 必须被禁止的风险码 */
    const forbiddenHit = (sc.expected.forbid_risk_codes || []).filter((c) => gotRisks.includes(c));

    /* 护栏与动作约束 */
    const guardrailOk = sc.expected.must_block_recommendation ? b.risk.guardrails.blockProductRecommendation === true : true;
    const actionNames = b.actionPlan.actions.flatMap((a) => a.tools.map((t) => t.name));
    const actionOk = (sc.expected.require_actions || []).every((a) => actionNames.includes(a));

    scenarioResults.push({
      id: sc.id, name: sc.name, category: sc.category,
      expectedRiskCodes: sc.expected.risk_codes || [],
      gotRiskCodes: gotRisks,
      expectedRootCause: expRoot, gotRootCause: gotRoot,
      rootCauseOk: expRoot ? gotRoot === expRoot : null,
      unresolvedKinds, unresolvedOk,
      forbiddenHit, guardrailOk, actionOk,
      riskLevel: b.risk.overall,
    });
  }

  /* 风险：按码计算 PRF */
  const riskPairs = [];
  for (const sr of scenarioResults) {
    for (const code of riskCodes) {
      riskPairs.push({ expected: sr.expectedRiskCodes.includes(code) ? code : `__not_${code}`, got: sr.gotRiskCodes.includes(code) ? code : `__not_${code}` });
    }
  }
  result.riskDetection = classificationMetrics(riskPairs, [...riskCodes].map((c) => c));
  result.riskDetection.note = '按风险码逐条二分类统计（expected/got 均以 code 或 __not_code 表示）';

  /* 根因 */
  const rootPairs = scenarioResults.filter((s) => s.rootCauseOk !== null);
  result.rootCause = {
    accuracy: +safeDiv(rootPairs.filter((s) => s.rootCauseOk).length, rootPairs.length).toFixed(4),
    total: rootPairs.length,
    correct: rootPairs.filter((s) => s.rootCauseOk).length,
    errors: rootPairs.filter((s) => !s.rootCauseOk).map((s) => ({ id: s.id, expected: s.expectedRootCause, got: s.gotRootCause })),
  };

  /* 未解决项 */
  const unPairs = scenarioResults.map((s) => ({ expected: s.unresolvedOk ? 'OK' : 'BAD', got: s.unresolvedOk ? 'OK' : 'BAD' }));
  result.unresolvedDetection = {
    accuracy: +safeDiv(scenarioResults.filter((s) => s.unresolvedOk).length, scenarioResults.length).toFixed(4),
    total: scenarioResults.length,
    correct: scenarioResults.filter((s) => s.unresolvedOk).length,
    errors: scenarioResults.filter((s) => !s.unresolvedOk).map((s) => ({ id: s.id, kinds: s.unresolvedKinds })),
  };
  void unPairs;

  /* 误报（不该报警却报了） */
  result.falseAlarms = scenarioResults.filter((s) => s.forbiddenHit.length).map((s) => ({ id: s.id, codes: s.forbiddenHit }));
  result.guardrailFailures = scenarioResults.filter((s) => !s.guardrailOk).map((s) => s.id);
  result.actionFailures = scenarioResults.filter((s) => !s.actionOk).map((s) => s.id);

  /* ── 3. 成本 ─────────────────────────────────────────── */
  const st = getStats();
  result.cost = {
    calls: st.calls,
    failures: st.failures,
    cacheHits: st.cacheHits,
    inputTokens: st.inputTokens,
    outputTokens: st.outputTokens,
    totalTokens: st.inputTokens + st.outputTokens,
    latencyMs: st.latencyMs,
    byTask: st.byTask,
  };

  result.scenarios = scenarioResults;
  result.promiseSamplePairs = pairs;
  return result;
}

/* ═══════════════ 主流程 ═══════════════ */

console.log(`\n评估集：${dataset.promise_samples.length} 条话术样本 + ${dataset.scenarios.length} 条场景样本`);
console.log(`模型：${getSettings().enabled ? getSettings().model : '（未配置）'}｜模式：${MODES.join(' / ')}`);

const all = [];
for (const m of MODES) {
  if (m === 'llm_only' && !getSettings().enabled) {
    console.log(`\n跳过 llm_only（未配置模型）`);
    continue;
  }
  console.log(`\n▶ 运行模式 ${m} …`);
  try {
    const r = await evaluateMode(m);
    all.push(r);
    console.log(`  话术分类准确率 ${(r.promiseClassification.accuracy * 100).toFixed(1)}%｜风险宏 F1 ${r.riskDetection.macro.f1}｜根因准确率 ${(r.rootCause.accuracy * 100).toFixed(1)}%｜Token ${r.cost.totalTokens}`);
  } catch (err) {
    console.log(`  ✘ 模式 ${m} 运行失败：${err.message}`);
    all.push({ mode: m, failed: true, error: String(err.message || err) });
  }
}

updateSettings({ mode: 'hybrid' });
store.reset();

/* ═══════════════ 输出 ═══════════════ */

const outDir = path.join(ROOT, 'evaluation');
fs.mkdirSync(outDir, { recursive: true });

const payload = {
  generatedAt: new Date().toISOString(),
  model: getSettings().enabled ? getSettings().model : null,
  baseUrl: getSettings().baseUrl,
  dataset: { promiseSamples: dataset.promise_samples.length, scenarios: dataset.scenarios.length },
  modes: all,
};
fs.writeFileSync(path.join(outDir, 'evaluation-results.json'), JSON.stringify(payload, null, 2), 'utf8');

/* ── Markdown 报告 ─────────────────────────────────────── */
const L = [];
L.push('# 评估报告 · Service Memory Copilot');
L.push('');
L.push(`生成时间：${payload.generatedAt}`);
L.push(`模型：${payload.model || '未配置（仅规则基线）'}`);
L.push(`数据集：${payload.dataset.promiseSamples} 条话术样本 + ${payload.dataset.scenarios} 条场景样本`);
L.push('');
L.push('> 本报告只包含真实运行结果，未做任何人为修饰。');
L.push('');
L.push('## 总览');
L.push('');
L.push('| 模式 | 话术分类 Accuracy | 分类宏 F1 | 风险宏 F1 | 根因 Accuracy | 未解决项 Accuracy | 场景失败 | 误报数 | Token | 调用次数 |');
L.push('|---|---|---|---|---|---|---|---|---|---|');
for (const m of all) {
  if (m.failed) { L.push(`| ${m.mode} | 运行失败：${m.error} | | | | | | | | |`); continue; }
  const scErr = (m.scenarios || []).filter((s) => s.error).length;
  L.push(`| ${m.mode} | ${(m.promiseClassification.accuracy * 100).toFixed(1)}% | ${m.promiseClassification.macro.f1} | ${m.riskDetection.macro.f1} | ${(m.rootCause.accuracy * 100).toFixed(1)}% | ${(m.unresolvedDetection.accuracy * 100).toFixed(1)}% | ${scErr} | ${m.falseAlarms.length} | ${m.cost.totalTokens} | ${m.cost.calls} |`);
}
L.push('');
L.push('## 话术分类 · 分类别指标');
L.push('');
const labels = ['PROMISE', 'ESTIMATE', 'ACTION', 'EXPLANATION'];
L.push(`| 模式 | 类别 | Precision | Recall | F1 | 支持数 |`);
L.push('|---|---|---|---|---|---|');
for (const m of all) {
  if (m.failed) continue;
  for (const L2 of labels) {
    const c = m.promiseClassification.perClass[L2];
    L.push(`| ${m.mode} | ${L2} | ${c.precision} | ${c.recall} | ${c.f1} | ${c.tp + c.fn} |`);
  }
}
L.push('');
L.push('## 风险识别 · 按风险码');
L.push('');
L.push('| 模式 | 风险码 | Precision | Recall | F1 |');
L.push('|---|---|---|---|---|');
for (const m of all) {
  if (m.failed) continue;
  for (const [code, c] of Object.entries(m.riskDetection.perClass)) {
    L.push(`| ${m.mode} | ${code} | ${c.precision} | ${c.recall} | ${c.f1} |`);
  }
}
L.push('');
L.push('## 错例明细');
L.push('');
for (const m of all) {
  if (m.failed) continue;
  L.push(`### ${m.mode}`);
  L.push('');
  L.push(`- 话术分类错例：${m.promiseClassification.errors.length} 条`);
  for (const e of m.promiseClassification.errors) L.push(`  - \`${e.id}\` 「${e.text}」 期望 ${e.expected}，实际 ${e.got}`);
  if (m.promiseClassification.batchError) L.push(`  - ⚠ 批量分类整体失败：${m.promiseClassification.batchError}`);
  const scErrs = m.scenarios.filter((s) => s.error);
  L.push(`- 场景执行失败（模型未产出可用结果）：${scErrs.length} 条`);
  for (const e of scErrs) L.push(`  - \`${e.id}\` ${e.name} → ${e.error}`);
  L.push(`- 根因错例：${m.rootCause.errors.length} 条`);
  for (const e of m.rootCause.errors) L.push(`  - \`${e.id}\` 期望 ${e.expected}，实际 ${e.got}`);
  L.push(`- 未解决项错例：${m.unresolvedDetection.errors.length} 条`);
  for (const e of m.unresolvedDetection.errors) L.push(`  - \`${e.id}\` 实际 kinds=${JSON.stringify(e.kinds)}`);
  L.push(`- 误报（不该报警却报了）：${m.falseAlarms.length} 条`);
  for (const e of m.falseAlarms) L.push(`  - \`${e.id}\` 多报 ${JSON.stringify(e.codes)}`);
  L.push(`- 护栏未触发：${m.guardrailFailures.length} 条 ${JSON.stringify(m.guardrailFailures)}`);
  L.push(`- 必需动作缺失：${m.actionFailures.length} 条 ${JSON.stringify(m.actionFailures)}`);
  L.push('');
}
L.push('## 成本明细');
L.push('');
L.push('| 模式 | 输入 tokens | 输出 tokens | 合计 | 调用 | 缓存命中 | 失败 | 累计延迟(ms) |');
L.push('|---|---|---|---|---|---|---|---|');
for (const m of all) {
  if (m.failed) continue;
  L.push(`| ${m.mode} | ${m.cost.inputTokens} | ${m.cost.outputTokens} | ${m.cost.totalTokens} | ${m.cost.calls} | ${m.cost.cacheHits} | ${m.cost.failures} | ${m.cost.latencyMs} |`);
}
L.push('');
L.push('### 按任务拆分（各模式）');
L.push('');
for (const m of all) {
  if (m.failed) continue;
  L.push(`**${m.mode}**`);
  L.push('');
  L.push('| 任务 | 调用 | 输入 tokens | 输出 tokens | 延迟(ms) |');
  L.push('|---|---|---|---|---|');
  for (const [task, t] of Object.entries(m.cost.byTask)) {
    L.push(`| ${task} | ${t.calls} | ${t.inputTokens} | ${t.outputTokens} | ${t.latencyMs} |`);
  }
  L.push('');
}

fs.writeFileSync(path.join(outDir, 'REPORT.md'), L.join('\n'), 'utf8');

console.log(`\n已输出：`);
console.log(`  evaluation/evaluation-results.json`);
console.log(`  evaluation/REPORT.md`);
