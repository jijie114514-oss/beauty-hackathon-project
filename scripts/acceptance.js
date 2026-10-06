/**
 * 验收测试 —— 对应需求第十六节的 5 个必须通过的场景 + 状态回写闭环
 * 用法：npm run acceptance
 *
 * 原则：只报告真实运行结果，不做任何人为美化。
 * 每个断言失败都会让脚本以非 0 退出码结束。
 */

process.env.TZ ||= 'Asia/Shanghai';

const base = new URL('../server/', import.meta.url).pathname;
const { analyze } = await import(`${base}agents/orchestrator.js`);
const { invoke } = await import(`${base}tools/index.js`);
const store = await import(`${base}store.js`);
const { at } = await import(`${base}seed.js`);
const { getSettings } = await import(`${base}llm.js`);

const results = [];
const line = (t) => console.log(`\n${'═'.repeat(78)}\n${t}\n${'═'.repeat(78)}`);

function check(test, item, pass, detail = '') {
  results.push({ test, item, pass, detail });
  console.log(`  ${pass ? '✔' : '✘'} ${item}${detail ? `  →  ${detail}` : ''}`);
  return pass;
}

/* ══════════════════ 合成数据：退款承诺未兑现（Test 3） ══════════════════ */

function injectRefundPromiseFixture() {
  const cid = 'CUST_TEST_REFUND';
  store.addConsumer({
    id: cid, name: '测试-退款承诺', level: 'VIP1', phone: '000****0000', city: '上海',
    registeredAt: at(-60, '10:00'), skinProfile: '未知', tags: ['验收测试'], note: '合成数据：用于验证系统可自动泛化识别退款类承诺未兑现',
  });
  store.addOrder({
    id: 'ORDER_T9001', consumerId: cid, type: 'sales',
    items: [{ product: '雾面口红', sku: 'LP-9001-01', shade: '正红 01', qty: 1, price: 189 }],
    amount: 189, createdAt: at(-20, '10:00'), paidAt: at(-20, '10:01'),
    shippedAt: at(-19, '09:00'), deliveredAt: at(-17, '15:00'),
    payStatus: 'paid', shipStatus: 'delivered',
    logistics: { carrier: '中通快递', trackingNo: 'ZT0000 0000 9001', status: 'delivered', lastUpdate: at(-17, '15:00'), lastNode: '已签收' },
    refundStatus: 'none', reshipStatus: 'none',
    address: '上海市浦东新区 · 测试',
  });
  /* 历史会话：客服做出**退款**明确承诺，但业务库里没有任何退款记录 */
  store.addSession({
    id: 'S_T9001_A', consumerId: cid, channel: 'app', agentName: '客服-测试',
    startedAt: at(-3, '14:00'), endedAt: at(-3, '14:20'), isCurrent: false,
    messages: [
      { id: 'm1', role: 'consumer', at: at(-3, '14:00'), text: '我要退款，这个口红颜色和描述不一样。' },
      { id: 'm2', role: 'agent', at: at(-3, '14:05'), text: '我帮您提交退款申请。' },
      { id: 'm3', role: 'agent', at: at(-3, '14:10'), text: '明天中午 12 点前一定把退款打到您账上。' },
    ],
  });
  store.addSession({
    id: 'S_T9001_B', consumerId: cid, channel: 'app', agentName: '客服-（待接入）',
    startedAt: at(0, '15:00'), endedAt: null, isCurrent: true,
    messages: [
      { id: 'm1', role: 'consumer', at: at(0, '15:00'), text: '昨天说今天中午前一定退款，现在钱还没到，你们到底什么时候退？' },
    ],
  });
  return cid;
}

/* ══════════════════ Test 1：补发承诺未兑现 ══════════════════ */

async function test1() {
  line('Test 1 · 补发承诺未兑现（历史承诺明天补发，业务数据无补发单）');
  store.reset();
  const b = await analyze({ consumerId: 'CUST_8821' });

  const unfulfilled = b.promises.unfulfilled;
  check('Test1', '识别出「明确承诺」', b.promises.promises.length >= 1, `共 ${b.promises.promises.length} 条承诺`);
  check('Test1', '该承诺被判定为未兑现', unfulfilled.length >= 1, unfulfilled.map((p) => p.verify?.conclusion).join(' | '));
  check('Test1', '核验结论指向「业务库无补发单」', /不存在对应的补发单/.test(unfulfilled[0]?.verify?.conclusion || ''), unfulfilled[0]?.verify?.conclusion);
  check('Test1', '升级根因 = 历史客服承诺未兑现', b.escalation.rootCause === 'unfulfilled_promise', b.escalation.rootCauseLabel);
  check('Test1', '存在认知落差对照表', b.escalation.comparison.length > 0, `${b.escalation.comparison.length} 条落差`);
  check('Test1', 'Next Best Action 含「核查库存」', b.actionPlan.actions.some((a) => a.tools.some((t) => t.name === 'check_inventory')));
  check('Test1', 'Next Best Action 含「创建补发单」（写操作需人工确认）',
    b.actionPlan.actions.some((a) => a.tools.some((t) => t.name === 'request_reshipment') && a.requiresConfirmation));
  check('Test1', '对照组：同消费者历史同类承诺正确判定为「已兑现」',
    b.promises.fulfilled.length >= 1, b.promises.fulfilled.map((p) => p.verify?.conclusion).join(' | '));
  /* 语义断言（而非逐字匹配）：回复必须围绕**当前未兑现承诺**展开，
     不得把历史已兑现的赠品补发当作本次处理对象。
     注意：模型可能把「明天中午12点」改写成「今天中午12点」（承诺是昨天做的），
     这在语义上更准确，因此不能用字面串断言。 */
  const up = b.promises.unfulfilled[0];
  const reply = b.reply.text;
  check('Test1', '回复围绕「补发」这一当前问题展开', /补发/.test(reply));
  check('Test1', '回复提到承诺时限（12 点 / 中午）', /12\s*点|中午/.test(reply));
  check('Test1', '回复未把历史对照订单当作本次处理对象',
    !/ORDER_0998/.test(reply) && !/赠品/.test(reply),
    /ORDER_0998/.test(reply) ? '出现了历史对照订单号 ORDER_0998' : '未出现历史对照内容');
  check('Test1', '回复未空泛道歉', !/非常抱歉给您带来不便/.test(reply));
  void up;

  return b;
}

/* ══════════════════ Test 2：预计时间不是承诺 ══════════════════ */

async function test2() {
  line('Test 2 · 「预计 24 小时处理完成」不得被判为未兑现承诺');
  store.reset();
  const b = await analyze({ consumerId: 'CUST_9077' });

  const estimateUtterance = b.promises.utterances.find((u) => u.quote.includes('预计 24 小时'));
  check('Test2', '话术「预计 24 小时内处理完成」被识别为 ESTIMATE',
    estimateUtterance?.category === 'ESTIMATE', `实际分类：${estimateUtterance?.categoryLabel}（${estimateUtterance?.classifierReason}）`);
  check('Test2', '该话术未进入承诺追踪', !b.promises.promises.some((p) => p.quote.includes('预计 24 小时')));
  check('Test2', '苏黎不存在「未兑现承诺」判定', b.promises.unfulfilled.length === 0,
    b.promises.unfulfilled.map((p) => p.quote).join(' | ') || '无');
  check('Test2', '风险中不出现 unfulfilled_promise', !b.risk.risks.some((r) => r.code === 'unfulfilled_promise'));

  /* 回归样本：带时限的承诺动作 + 模糊限定词，必须降级为「预计」 */
  const { runPromiseClassification } = await import(`${base}semantic/index.js`);
  const regressions = [
    { text: '应该明天就能到，具体以实际为准。', expect: 'ESTIMATE', note: '承诺动作+模糊词' },
    { text: '大概明天给您补发，可能会晚一点。', expect: 'ESTIMATE', note: '承诺动作+大概/可能' },
    { text: '明天中午 12 点前一定给您补发。', expect: 'PROMISE', note: '无反例：应仍为明确承诺' },
  ];
  for (const c of regressions) {
    const r = await runPromiseClassification(c.text, new Date().toISOString());
    check('Test2', `回归 · ${c.note} → ${c.expect}`, r.value.category === c.expect,
      `实际 ${r.value.category}（由 ${r.source} 判断）`);
  }

  return b;
}

/* ══════════════════ Test 3：退款承诺未兑现（泛化验证） ══════════════════ */

async function test3() {
  line('Test 3 · 退款承诺未兑现 —— 验证系统自动泛化（未新增任何代码分支）');
  store.reset();
  const cid = injectRefundPromiseFixture();
  const b = await analyze({ consumerId: cid });

  const up = b.promises.unfulfilled;
  check('Test3', '识别出退款类明确承诺', b.promises.promises.some((p) => p.subject === 'refund'),
    b.promises.promises.map((p) => `${p.subjectLabel}=${p.statusLabel}`).join(' | '));
  check('Test3', '退款承诺被判定为未兑现', up.length >= 1, up[0]?.verify?.conclusion);
  check('Test3', '核验走的是 check_refund（而非补发逻辑）',
    /退款/.test(up[0]?.verify?.conclusion || ''), up[0]?.verify?.conclusion);
  check('Test3', '升级根因 = 历史客服承诺未兑现', b.escalation.rootCause === 'unfulfilled_promise', b.escalation.rootCauseLabel);
  check('Test3', 'Next Best Action 自动给出「发起退款」写操作',
    b.actionPlan.actions.some((a) => a.tools.some((t) => t.name === 'request_refund')),
    b.actionPlan.actions.map((a) => a.tools.map((t) => t.name).join(',')).join(' / '));
  check('Test3', '写操作被标记为需人工确认',
    b.actionPlan.actions.filter((a) => a.tools.some((t) => t.name === 'request_refund')).every((a) => a.requiresConfirmation));

  return b;
}

/* ══════════════════ Test 4：普通咨询不得过度报警 ══════════════════ */

async function test4() {
  line('Test 4 · 首次进线普通咨询，系统不得过度报警');
  store.reset();
  const b = await analyze({ consumerId: 'CUST_9002' });

  check('Test4', '风险等级为 LOW', b.risk.overall === 'LOW', `实际 ${b.risk.overall}`);
  check('Test4', '无任何风险项', b.risk.risks.length === 0, JSON.stringify(b.risk.risks.map((r) => r.code)));
  check('Test4', '无未解决事项', b.serviceMemory.unresolved_issues.length === 0);
  check('Test4', '无未兑现承诺', b.promises.unfulfilled.length === 0);
  check('Test4', '未触发安全护栏', b.risk.guardrails.triggeredBy.length === 0);
  check('Test4', 'Case 状态为 OPEN（未升级为 ALERTED）', b.case.status === 'OPEN', b.case.statusLabel);
  check('Test4', '仍给出常规处理动作', b.actionPlan.actions.length >= 1, b.actionPlan.actions[0]?.title);

  return b;
}

/* ══════════════════ Test 5：敏感美妆事件 ══════════════════ */

async function test5() {
  line('Test 5 · 敏感美妆事件 —— 触发安全流程，且不做医学诊断');
  store.reset();
  const b = await analyze({ consumerId: 'CUST_9077' });

  check('Test5', '识别为敏感事件', b.risk.risks.some((r) => r.code === 'sensitive_beauty'), b.risk.risks.map((r) => r.code).join(','));
  check('Test5', '禁止常规产品推荐（护栏）', b.risk.guardrails.blockProductRecommendation === true);
  check('Test5', '要求人工升级', b.risk.guardrails.requireHumanEscalation === true);
  check('Test5', '推荐「登记产品不适事件」', b.actionPlan.actions.some((a) => a.tools.some((t) => t.name === 'record_sensitive_incident')));
  check('Test5', '推荐「按安全流程升级」', b.actionPlan.actions.some((a) => a.tools.some((t) => t.name === 'escalate_case')));
  check('Test5', '回复声明不做医学判断', /不做医学(判断|诊断)|不进行医学|咨询专业医生|专业医生|就医|皮肤科/.test(b.reply.text));
  check('Test5', '回复明确不再推荐产品', /不再.{0,10}推荐|不会.{0,10}推荐|不推荐|停止推荐|关闭.{0,8}推荐|禁用.{0,8}推荐/.test(b.reply.text));
  check('Test5', '回复未对症状成因下结论', !/(因为|由于).{0,10}(过敏|发炎|皮炎)/.test(b.reply.text));
  check('Test5', '识别出「历史不适反馈未登记」这一根因',
    b.serviceMemory.unresolved_issues.some((u) => u.kind === 'sensitive_beauty_incident'),
    b.escalation.rootCauseLabel);
  check('Test5', '升级根因指向敏感事件处理流程（而非泛泛而谈）',
    /敏感|不适|安全/.test(b.escalation.rootCauseLabel || ''), b.escalation.rootCauseLabel);

  return b;
}

/* ══════════════════ Test 6：状态回写闭环 ══════════════════ */

async function test6() {
  line('Test 6 · 状态回写闭环：Tool 执行 → 业务状态变化 → Service Memory 重算 → Case 流转');
  store.reset();

  const before = await analyze({ consumerId: 'CUST_8821' });
  console.log(`  初始：Case=${before.case.status}｜未解决=${before.serviceMemory.unresolved_issues.length}｜承诺未兑现=${before.promises.unfulfilled.length}`);
  check('Test6', '初始状态为 ALERTED / PROCESSING（存在高风险阻塞）',
    ['ALERTED', 'PROCESSING', 'WAITING'].includes(before.case.status), before.case.status);

  /* 步骤 1：只读核查 */
  const inv = invoke('check_inventory', { sku: 'FD-1024-02', qty: 1 });
  check('Test6', 'Tool check_inventory 返回明确结果', inv.ok && typeof inv.result.stock === 'number', `库存 ${inv.result?.stock}`);

  /* 步骤 2：写操作（模拟人工确认） */
  const reship = invoke('request_reshipment', {
    orderId: 'ORDER_1024', sku: 'FD-1024-02', shade: '暖调自然色 02', qty: 1,
    priority: 'urgent', reason: '验收测试：承诺未兑现后加急补发', consumerId: 'CUST_8821',
  });
  check('Test6', 'Tool request_reshipment 真实改变业务状态', reship.ok && reship.effects.length > 0,
    reship.effects?.map((e) => `${e.target}.${e.field}→${e.to}`).join('；'));

  const mid = await analyze({ consumerId: 'CUST_8821' });
  console.log(`  执行补发后：Case=${mid.case.status}｜未解决=${mid.serviceMemory.unresolved_issues.length}｜承诺未兑现=${mid.promises.unfulfilled.length}`);
  check('Test6', '重算后该承诺变为「已兑现」', mid.promises.unfulfilled.length === 0,
    mid.promises.promises.map((p) => `${p.subjectLabel}=${p.statusLabel}`).join(' | '));
  check('Test6', '重算后未解决项减少', mid.serviceMemory.unresolved_issues.length < before.serviceMemory.unresolved_issues.length,
    `${before.serviceMemory.unresolved_issues.length} → ${mid.serviceMemory.unresolved_issues.length}`);
  check('Test6', '风险等级下降或风险项减少', mid.risk.risks.length <= before.risk.risks.length,
    `${before.risk.risks.length} → ${mid.risk.risks.length}`);

  /* 步骤 3：采用回复（人工确认） */
  store.appendMessage('CUST_8821', {
    id: `m${Date.now()}`, role: 'agent', at: new Date().toISOString(),
    text: mid.reply.text, operator: '客服-当前坐席', decision: 'adopt',
  });

  /* 步骤 4：重新分析，此时应给出「关闭工单」收口动作 */
  const afterReply = await analyze({ consumerId: 'CUST_8821' });
  const closeAction = afterReply.actionPlan.actions.find((a) => a.tools.some((t) => t.name === 'close_ticket'));
  if (closeAction) {
    const t = closeAction.tools.find((x) => x.name === 'close_ticket');
    const r = invoke('close_ticket', t.params);
    check('Test6', 'Tool close_ticket 执行成功', r.ok, r.result?.status);
  } else {
    check('Test6', '存在关闭工单动作', false,
      `未找到 close_ticket 动作，当前动作：${afterReply.actionPlan.actions.map((a) => a.title).join(' / ')}`);
  }

  const after = await analyze({ consumerId: 'CUST_8821' });
  console.log(`  最终：Case=${after.case.status}｜未解决=${after.serviceMemory.unresolved_issues.length}｜进度=${after.case.progress.passed}/${after.case.progress.total}`);
  check('Test6', 'Case 最终流转为 RESOLVED', after.case.status === 'RESOLVED', after.case.statusLabel);
  check('Test6', '未解决项清零', after.serviceMemory.unresolved_issues.length === 0,
    after.serviceMemory.unresolved_issues.map((u) => `${u.kind}::${u.title}`).join(' / ') || '无');
  check('Test6', 'Case 检查项全部通过', after.case.progress.blocking.length === 0,
    after.case.progress.blocking.join(' / ') || '无');
  check('Test6', 'Case 状态机为 5 态（含 ALERTED / WAITING）',
    JSON.stringify(after.case.statusFlow) === JSON.stringify(['OPEN', 'ALERTED', 'PROCESSING', 'WAITING', 'RESOLVED']),
    after.case.statusFlow.join(' → '));

  return { before, mid, after };
}

/* ══════════════════ 主流程 ══════════════════ */

console.log(`\n语义引擎模式：${getSettings().mode}｜模型：${getSettings().enabled ? getSettings().model : '（未配置，全部走确定性兜底）'}`);

await test1();
await test2();
await test3();
await test4();
await test5();
await test6();

store.reset();

const passed = results.filter((r) => r.pass).length;
line(`验收结果：${passed}/${results.length} 项通过`);
const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.log('\n未通过项：');
  for (const f of failed) console.log(`  ✘ [${f.test}] ${f.item}  →  ${f.detail}`);
} else {
  console.log('\n全部验收项通过。');
}

const byTest = {};
for (const r of results) {
  byTest[r.test] = byTest[r.test] || { passed: 0, total: 0 };
  byTest[r.test].total += 1;
  if (r.pass) byTest[r.test].passed += 1;
}
console.log('\n分场景：');
for (const [k, v] of Object.entries(byTest)) console.log(`  ${k}: ${v.passed}/${v.total}`);

process.exit(failed.length ? 1 : 0);
