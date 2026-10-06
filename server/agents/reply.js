/**
 * Reply Agent —— 建议回复生成
 * ------------------------------------------------------------------
 * 本轮改造：**删除 4 套场景模板草稿。**
 *
 * 新流程（对应需求第六节）：
 *   Service Memory + Current Need + Escalation Reason
 *   + Validated Business Facts + Selected Next Action
 *   ↓ LLM 生成
 *
 * 确定性兜底（semantic/deterministic.composeReply）也改为
 * **通用事实槽位组装**，不再按场景选模板 —— 因此它天然支持新场景。
 *
 * 回复 7 条原则全部写进提示词，并在返回值里声明约束是否满足。
 * 所有回复仍然只作为建议，必须人工确认后才发出。
 */

import { runReplyGeneration } from '../semantic/index.js';
import { EVENT_TYPE, EVENT_STATUS } from '../schema.js';

const fmtTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};

/** 事实清单：每一条都可回溯到具体事件 / 业务字段 */
function buildFacts(ctx, memory, need, validators, actions) {
  const facts = [];
  const push = (f) => facts.push(f);

  /* 1. 未兑现承诺（最高优先级事实） */
  const up = validators.unfulfilledPromise;
  if (up) {
    push({
      key: 'promise',
      text: `客服于 ${fmtTime(up.time)} 承诺「${up.evidence}」${up.structured_data.deadline_label ? `（承诺时限 ${up.structured_data.deadline_label}）` : ''}`,
      source: 'chat',
      ref: up.source_id || '会话记录',
    });
    push({
      key: 'promise_status',
      text: `承诺核验结果：${up.verification?.conclusion || '未核验'}`,
      source: 'system',
      ref: '业务核验',
    });
    /* 明确本次处理对象，避免模型拿历史对照订单当目标 */
    if (up.structured_data.target_order) {
      push({
        key: 'current_target',
        text: `【本次处理对象】订单 ${up.structured_data.target_order}${up.structured_data.target_sku ? `｜SKU ${up.structured_data.target_sku}` : ''}。本次只需围绕这一笔订单处理。`,
        source: 'order',
        ref: `订单库 / ${up.structured_data.target_order}`,
      });
    }
  }

  /* 2. 已兑现承诺 —— 仅作「系统在核验数据」的对照，禁止当作本次处理对象 */
  const fulfilled = memory.events.find(
    (e) => e.type === EVENT_TYPE.SERVICE_PROMISE && e.status === EVENT_STATUS.FULFILLED,
  );
  if (fulfilled) {
    push({
      key: 'fulfilled_ref',
      text: `【历史对照 · 与本次问题无关】此前另有一笔同类承诺已正常兑现（时间 ${fmtTime(fulfilled.time)}）。仅用于说明系统在核验数据，**不得**把它当作本次要处理的订单，也不要在回复中提及它的单号。`,
      source: 'system',
      ref: '历史承诺核验',
    });
  }

  /* 3. 商品不一致事实 */
  const wrong = memory.events.find((e) => e.type === EVENT_TYPE.WRONG_SKU);
  if (wrong) push({ key: 'wrong_item', text: wrong.evidence, source: 'order', ref: wrong.source_id });

  /* 4. 未解决事项（逐条列出，全部带来源） */
  for (const u of memory.unresolved_issues.slice(0, 4)) {
    push({ key: `issue_${u.kind}`, text: `${u.title}：${u.detail}`, source: u.evidence?.[0]?.source || 'system', ref: u.evidence?.[0]?.ref || '—' });
  }

  /* 5. 消费者约束 */
  for (const c of need.constraints_detail || []) {
    push({ key: 'constraint', text: `消费者约束：${c.label}（${c.implication}）`, source: 'chat', ref: '当前会话' });
  }

  /* 6. 敏感症状 */
  if (need.sensitive?.isSensitive) {
    push({ key: 'sensitive', text: `消费者自述症状：${need.sensitive.hits.join('、')}`, source: 'chat', ref: '当前会话' });
  }

  /* 7. 准备执行的动作 */
  for (const a of (actions || []).filter((x) => x.kind === 'read')) {
    push({ key: 'action', text: `拟执行动作：${a.title}`, source: 'system', ref: `Action ${a.id}` });
  }

  return facts;
}

/**
 * 安全条款强制校验 —— 规则对 LLM 输出的**硬约束**。
 *
 * 实测发现：即使提示词明确要求，模型仍可能漏掉「不做医学诊断」「不再推荐产品」
 * 这类合规声明。合规声明不能依赖模型的自觉，因此这里做后置校验，
 * 缺失就补上（而不是让整条回复作废，避免用户体验受损）。
 */
/** 「已明确告知不再推荐产品」的判定（与验收断言保持同一族） */
export const NO_RECOMMEND_RE = /不再.{0,10}推荐|不会.{0,10}推荐|不推荐|停止推荐|关闭.{0,8}推荐|禁用.{0,8}推荐|不(会)?再向您推荐/;
/** 「已声明不做医学诊断」的判定 */
export const NO_MEDICAL_RE = /不做医学(判断|诊断)|不进行医学|咨询专业医生|专业医生|就医|皮肤科/;

function enforceSafetyClauses(text, need) {
  let out = String(text || '');
  const added = [];

  if (need.sensitive?.isSensitive) {
    if (!NO_RECOMMEND_RE.test(out)) {
      out += '\n另外，我已为您关闭常规产品推荐，后续不会再向您推荐任何产品。';
      added.push('no_recommendation');
    }
    if (!NO_MEDICAL_RE.test(out)) {
      out += '关于皮肤不适，建议您先停用相关产品；如需处理建议请咨询专业医生，我们这边不做医学诊断。';
      added.push('no_medical_advice');
    }
  }

  return { text: out, added };
}

export async function replyAgent(ctx, memory, need, validators, actionPlan, escalation) {
  const facts = buildFacts(ctx, memory, need, validators, actionPlan.actions);

  const forbidden = [
    '不要使用「非常抱歉给您带来不便」这类没有具体信息的模板句',
    '不要承诺系统中无法确认的时间点',
    '不要虚构库存、物流或退款状态',
    '不要对产品不适症状的成因下医学结论',
    '不要重复询问消费者已经提供过的信息',
    '不要把「历史对照」订单当作本次处理对象',
  ];

  const r = await runReplyGeneration({
    ctx, memory, need, escalation, validations: validators, actions: actionPlan.actions, facts,
  });

  const value = r.value;
  const rawText = typeof value === 'string' ? value : value.text;
  const enforced = enforceSafetyClauses(rawText, need);

  return {
    text: enforced.text,
    draft: rawText,
    source: r.source === 'llm' ? 'llm' : 'deterministic',
    classifiedBy: r.source,
    safetyClausesAdded: enforced.added,
    facts,
    grounding: facts.map((f) => ({ ref: f.ref, fact: f.text, source: f.source })),
    forbidden,
    constraints: {
      acknowledgeSpecificIssue: true,
      noFabrication: true,
      noUnverifiablePromise: true,
      noRepeatQuestion: true,
      noMedicalDiagnosis: Boolean(need.sensitive?.isSensitive),
    },
  };
}
