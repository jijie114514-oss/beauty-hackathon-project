/**
 * LLM 连通性与能力自检
 * 用法：npm run llm-check
 *
 * 作用：在跑真实链路之前，先用最小代价确认
 *   1) Key / Base URL / Model 是否正确；
 *   2) 服务端是否支持 JSON 输出模式（本项目所有语义任务都依赖它）；
 *   3) 一个真实语义任务（承诺分类）的判断质量如何。
 * 不会打印或外传 Key。
 */

process.env.TZ ||= 'Asia/Shanghai';

const base = new URL('../server/', import.meta.url).pathname;
const { getSettings, chat, chatJSON, getStats, resetStats, estimateTokens } = await import(`${base}llm.js`);

const line = (t) => console.log(`\n${'─'.repeat(70)}\n${t}\n${'─'.repeat(70)}`);

const s = getSettings();
line('配置');
console.log(`  Base URL : ${s.baseUrl}`);
console.log(`  Model    : ${s.model}`);
console.log(`  API Key  : ${s.hasApiKey ? '已配置（已隐藏）' : '未配置'}`);
console.log(`  Mode     : ${s.mode}`);
console.log(`  Timeout  : ${s.timeoutMs}ms`);

if (!s.hasApiKey) {
  console.log('\n✘ 未检测到 LLM_API_KEY。请在 .env 中填写后重试（参考 .env.example）。');
  process.exit(1);
}

resetStats();
let failed = 0;

/* ── 1. 基础对话 ─────────────────────────────────────────── */
line('1/3 · 基础对话');
try {
  const r = await chat({
    task: 'connectivity',
    system: '你是一个测试助手。',
    user: '请只回复两个字：连通',
    maxTokens: 20,
  });
  console.log(`  ✔ 返回：${JSON.stringify(r.text.trim())}`);
  console.log(`  ✔ 延迟：${r.latencyMs}ms｜tokens：in ${r.usage.input} / out ${r.usage.output}`);
} catch (err) {
  failed += 1;
  console.log(`  ✘ 失败：${err.message}`);
  console.log('    排查：Key 是否正确 / Base URL 是否可达 / 模型名是否存在 / 网络是否需要代理');
}

/* ── 2. JSON 模式 ────────────────────────────────────────── */
line('2/3 · JSON 输出模式（所有语义任务依赖）');
try {
  const r = await chatJSON({
    task: 'json_probe',
    system: '只输出 JSON，不要解释。',
    user: '输出 {"ok": true, "model_echo": "任意字符串"}',
    maxTokens: 60,
  });
  console.log(`  ✔ 解析成功：${JSON.stringify(r.value)}`);
  console.log(`  ✔ tokens：in ${r.usage.input} / out ${r.usage.output}`);
} catch (err) {
  failed += 1;
  console.log(`  ✘ JSON 模式不可用：${err.message}`);
  console.log('    影响：语义层会全部回落到确定性引擎，系统仍可用但不再是 LLM 驱动。');
}

/* ── 3. 真实语义任务：承诺分类 ───────────────────────────── */
line('3/3 · 真实语义任务 · 承诺分类（含易错样本）');
const cases = [
  { text: '明天中午 12 点前一定给您重新补发正确的颜色。', expect: 'PROMISE', note: '明确承诺' },
  { text: '预计 24 小时内处理完成。', expect: 'ESTIMATE', note: '预计时效 —— 易错点' },
  { text: '我帮您提交补发申请。', expect: 'ACTION', note: '执行动作' },
  { text: '物流正常的情况下需要 2-3 天送达。', expect: 'EXPLANATION', note: '流程解释' },
  { text: '应该明天就能到，具体以实际为准。', expect: 'ESTIMATE', note: '承诺词+模糊词 → 应降级' },
];

const { runPromiseClassification } = await import(`${base}semantic/index.js`);
let correct = 0;
for (const c of cases) {
  const r = await runPromiseClassification(c.text, new Date().toISOString());
  const got = r.value.category;
  const ok = got === c.expect;
  if (ok) correct += 1;
  console.log(`  ${ok ? '✔' : '✘'} [${c.note}] 期望 ${c.expect}，实际 ${got}（由 ${r.source} 判断）`);
  if (!ok) console.log(`      原文：${c.text}`);
}
console.log(`\n  分类准确率：${correct}/${cases.length}`);

/* ── 汇总 ────────────────────────────────────────────────── */
line('计量汇总');
const st = getStats();
console.log(`  调用次数   : ${st.calls}`);
console.log(`  失败次数   : ${st.failures}`);
console.log(`  输入 tokens: ${st.inputTokens}`);
console.log(`  输出 tokens: ${st.outputTokens}`);
console.log(`  累计延迟   : ${st.latencyMs}ms`);
console.log(`  按任务     : ${JSON.stringify(st.byTask)}`);

if (failed) {
  console.log(`\n✘ 有 ${failed} 项检查未通过，请先修复再跑真实链路。`);
  process.exit(1);
}
console.log('\n✔ 连通性与能力检查通过。可以执行：npm run acceptance（真实 LLM 链路）');
