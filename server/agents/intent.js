/**
 * Intent Agent —— 当前诉求理解
 * ------------------------------------------------------------------
 * 本轮改造：诉求理解交给 LLM（runCurrentNeed），规则词表退为兜底。
 *
 * 唯一不让模型碰的东西：**情绪等级**。
 * 情绪等级是粗粒度分级（正常 / 不满 / 愤怒 / 高度激动），且明确禁止百分比。
 * 它由确定性词表判定，模型只能改写措辞 —— 避免模型随机给出不可复现的等级。
 */

import { runCurrentNeed } from '../semantic/index.js';

export async function intentAgent(ctx, currentMessage) {
  const r = await runCurrentNeed(currentMessage, ctx);
  const n = r.value;

  const constraints = (n.constraints_detail || []).map((c) => ({
    type: c.type,
    label: c.label,
    implication: c.implication,
    evidence: { source: 'chat', ref: '当前会话', text: c.evidence },
  }));
  /* LLM 模式下 constraints 可能是纯字符串数组，补上结构 */
  if (!constraints.length && Array.isArray(n.constraints)) {
    for (const label of n.constraints) {
      constraints.push({ type: 'time', label, implication: '存在明确的时间约束', evidence: { source: 'chat', ref: '当前会话', text: label } });
    }
  }

  const reasoning = [
    `表面问题：${n.surface_issue}`,
    `真实诉求：${n.real_need}`,
    constraints.length
      ? `关键约束：${constraints.map((c) => `${c.label} → ${c.implication}`).join('；')}`
      : '关键约束：未识别到明确的时间或场景约束',
    `情绪：${n.emotion.level}（基线 ${n.emotion.baseline}${n.emotion.escalated ? '，较历史明显升级' : '，与历史持平'}）`,
  ];
  if (n.sensitive.isSensitive) {
    reasoning.push(`⚠️ 检测到产品不适相关表述：${n.sensitive.hits.join('、')}，将触发安全处理流程。`);
  }

  return {
    currentMessage: currentMessage || '',
    surfaceIssue: {
      text: n.surface_issue,
      evidence: [{ source: 'chat', ref: '当前会话', text: currentMessage || '' }],
      basis: n.source === 'llm+deterministic' ? 'LLM 语义理解' : '确定性规则兜底',
    },
    realNeed: {
      text: n.real_need,
      evidence: [{ source: 'chat', ref: '当前会话', text: currentMessage || '' }],
      basis: n.source === 'llm+deterministic' ? 'LLM 语义理解' : '确定性规则兜底',
    },
    constraints,
    urgency: n.urgency,
    emotion: n.emotion,
    sensitive: n.sensitive,
    reasoning,
    source: n.source,
    classifiedBy: r.source,
  };
}
