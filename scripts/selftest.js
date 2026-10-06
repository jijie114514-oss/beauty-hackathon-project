/**
 * 端到端自检脚本：不启动 HTTP 服务，直接在进程内跑完整 Agent 链路。
 * 用法：npm run selftest
 */
process.env.TZ ||= 'Asia/Shanghai';

const { analyze, scanAll } = await import('../server/agents/orchestrator.js');
const { invoke } = await import('../server/tools/index.js');
const { fmtStamp } = await import('../server/utils/date.js');
const store = await import('../server/store.js');

const line = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);

function dumpBrief(b, title) {
  line(`${title}  ·  ${b.consumer.name}（${b.consumer.id}）`);
  console.log('引擎：', b.meta.engine, `｜耗时 ${b.meta.latencyMs}ms`);
  console.log('当前消息：', b.intent.currentMessage);

  console.log('\n【Service Memory · 时间线】');
  for (const e of b.serviceMemory.timeline) {
    console.log(`  ${fmtStamp(e.at)}  [${e.source.padEnd(6)}] ${e.title}${e.status === 'unresolved' ? '   ⚠' : ''}`);
  }

  console.log('\n【Promise Tracking · 话术四分类】');
  console.log('  统计：', JSON.stringify(b.promises.stats));
  for (const u of b.promises.utterances.slice(0, 8)) {
    console.log(`  [${u.categoryLabel}] ${u.quote.slice(0, 40)}…`);
    console.log(`      └ ${u.classifierReason}`);
  }
  console.log('\n  被追踪的承诺：');
  for (const p of b.promises.promises) {
    console.log(`  • ${p.subjectLabel}｜${p.deadline ? p.deadline.label : '无时限'}｜状态：${p.statusLabel}`);
    console.log(`    原文：${p.quote}`);
    console.log(`    核验：${p.verify.conclusion}`);
  }

  console.log('\n【未解决项】');
  for (const u of b.serviceMemory.unresolved) console.log(`  • [${u.severity}] ${u.kindLabel}：${u.title}`);

  console.log('\n【Intent】');
  console.log('  Surface  :', b.intent.surfaceIssue.text);
  console.log('  Real Need:', b.intent.realNeed.text);
  console.log('  Constraints:', b.intent.constraints.map((c) => `${c.label} → ${c.implication}`).join('；') || '无');
  console.log('  Emotion  :', b.intent.emotion.level, `（基线 ${b.intent.emotion.baseline}，升级：${b.intent.emotion.escalated}）`);

  console.log('\n【Escalation Reasoning】');
  console.log('  当前问题：', b.escalation.currentIssue);
  console.log('  升级原因：', b.escalation.rootCauseLabel);
  console.log('  说明：', b.escalation.summary);
  for (const c of b.escalation.comparison) {
    console.log(`  ⚖ ${c.dimension}\n      消费者认知：${c.consumerBelief}\n      系统真相  ：${c.systemTruth}`);
  }

  console.log('\n【Risk】', b.risk.overall, b.risk.overallLabel);
  for (const r of b.risk.risks) {
    console.log(`  • ${r.label} [${r.level}] — ${r.reason}`);
    for (const e of r.evidence.slice(0, 3)) console.log(`      证据 · [${e.source}] ${e.ref}：${String(e.text).slice(0, 60)}`);
  }
  if (b.risk.guardrails.blockProductRecommendation) {
    console.log('  ⛔ 护栏：禁止常规产品推荐 / 需安全流程 / 需人工升级');
  }

  console.log('\n【Next Best Action】');
  for (const a of b.actionPlan.actions) {
    console.log(`  ${a.priority}. ${a.title} ${a.requiresConfirmation ? '（需人工确认）' : '（只读）'}`);
    console.log(`     为什么：${a.reason}`);
    console.log(`     调用：${a.tools.map((t) => `${t.name}(${JSON.stringify(t.params)})`).join(' → ')}`);
  }

  console.log('\n【Suggested Reply】');
  console.log(b.reply.text.split('\n').map((l) => '  ' + l).join('\n'));
  console.log('\n  依据（grounding）：');
  for (const f of b.reply.facts) console.log(`   · [${f.source}] ${f.text}`);

  console.log('\n【Case 闭环】');
  console.log(`  状态：${b.case.statusLabel}`);
  console.log(`  承诺态：${b.case.promiseState.label}`);
  console.log(`  进度：${b.case.progress.passed}/${b.case.progress.total} 已闭环`);
  for (const c of b.case.checks) console.log(`   ${c.pass ? '✔' : '✘'} ${c.item} → ${c.statusLabel}`);
}

/* ═══════════ 场景一：未兑现承诺 ═══════════ */
const b1 = await analyze({ consumerId: 'CUST_8821' });
dumpBrief(b1, '场景一 · 历史承诺未兑现（补发）');

line('执行 Next Best Action：只读核查');
const r1 = invoke('check_inventory', { sku: 'FD-1024-02', qty: 1 });
console.log('check_inventory →', JSON.stringify(r1.result));
const r2 = invoke('estimate_fulfillment', { sku: 'FD-1024-02', city: '杭州' });
console.log('estimate_fulfillment →', JSON.stringify(r2.result));

line('执行 Next Best Action：创建加急补发单（写操作，模拟客服确认）');
const r3 = invoke('request_reshipment', {
  orderId: 'ORDER_1024',
  sku: 'FD-1024-02',
  shade: '暖调自然色 02',
  qty: 1,
  priority: 'urgent',
  reason: '仓库发错货，客服承诺未兑现，本次加急补发',
  consumerId: 'CUST_8821',
});
console.log('request_reshipment →', JSON.stringify(r3.result, null, 2));
console.log('effects:', JSON.stringify(r3.effects));

const b1b = await analyze({ consumerId: 'CUST_8821' });
console.log('\n重算后 · 承诺状态：', b1b.promises.promises.map((p) => `${p.subjectLabel}=${p.statusLabel}`).join('，'));
console.log('重算后 · Case 状态：', b1b.case.statusLabel, `（${b1b.case.progress.passed}/${b1b.case.progress.total}）`);
console.log('重算后 · 风险等级：', b1b.risk.overall, '｜风险项：', b1b.risk.risks.map((r) => `${r.label}(${r.level})`).join('，'));
console.log('重算后 · Next Best Action：', b1b.actionPlan.actions.map((a) => a.title).join(' / '));

line('执行 Next Best Action：关闭工单，完成闭环');
const closeTarget = b1b.actionPlan.actions.find((a) => a.tools.some((t) => t.name === 'close_ticket'));
if (closeTarget) {
  const t = closeTarget.tools.find((x) => x.name === 'close_ticket');
  const r4 = invoke('close_ticket', t.params);
  console.log('close_ticket →', JSON.stringify(r4.result));
} else {
  console.log('未找到关闭动作，当前动作：', b1b.actionPlan.actions.map((a) => a.title));
}

const b1c = await analyze({ consumerId: 'CUST_8821' });
console.log('\n最终 · Case 状态：', b1c.case.statusLabel, `（${b1c.case.progress.passed}/${b1c.case.progress.total} 已闭环）`);
console.log('最终 · 未解决项：', b1c.serviceMemory.unresolved.length === 0 ? '无' : b1c.serviceMemory.unresolved.map((u) => u.title).join('，'));
console.log('最终 · 风险等级：', b1c.risk.overall);
console.log('最终 · 承诺态：', b1c.case.promiseState.label);

line('Human-in-the-loop：客服采用 AI 建议回复（模拟人工确认）');
store.appendMessage('CUST_8821', {
  id: `m${Date.now()}`,
  role: 'agent',
  at: new Date().toISOString(),
  text: b1b.reply.text,
  operator: '客服-当前坐席',
  decision: 'adopt',
});
const b1d = await analyze({ consumerId: 'CUST_8821' });
console.log('闭环终态：', b1d.case.statusLabel, `（${b1d.case.progress.passed}/${b1d.case.progress.total} 已闭环）`);
console.log('剩余动作：', b1d.actionPlan.actions.length ? b1d.actionPlan.actions.map((a) => a.title).join(' / ') : '无 · 已闭环');

/* ═══════════ 场景二：产品不适 ═══════════ */
const b2 = await analyze({ consumerId: 'CUST_9077' });
dumpBrief(b2, '场景二 · 疑似产品不适（敏感肌）');

/* ═══════════ 场景三 / 四 ═══════════ */
const b3 = await analyze({ consumerId: 'CUST_9134' });
dumpBrief(b3, '场景三 · 退款拖延 + 异常退款');
const b4 = await analyze({ consumerId: 'CUST_9002' });
dumpBrief(b4, '场景四 · 常规咨询（对照组）');

/* ═══════════ Risk Center ═══════════ */
line('Risk Center 聚合');
store.reset();
const rc = await scanAll();
console.log('统计：', JSON.stringify(rc.stats, null, 2));
console.log('\nHigh Risk Conversations：', rc.highRisk.map((h) => h.consumerName).join('、'));
console.log('Unresolved Promises：', rc.unresolvedPromises.map((p) => `${p.consumerName}·${p.subjectLabel}·${p.deadlineLabel}`).join('、'));
console.log('Repeat Contacts：', rc.repeatContacts.map((p) => `${p.consumerName}(${p.contacts}次)`).join('、'));
console.log('Escalated Cases：', rc.escalated.length);
