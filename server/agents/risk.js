/**
 * Risk Agent —— 服务风险识别
 * ------------------------------------------------------------------
 * 本轮改造：风险识别的**主输入变成 Service Events**，不再是关键词。
 *   - 「未兑现承诺」由 Business Validator 的核验结果驱动（不是看有没有"承诺"两个字）
 *   - 「重复进线」「异常退款」由事件统计驱动（不是正则扫全量文本）
 *   - 只有「舆情倾向」属于确定性安全规则，保留关键词判定
 *
 * 判断主体集中在 validators/safety.js，本文件只做编排与形状适配。
 */

import { deriveRiskFlags, evaluateGuardrails, POLICIES } from '../validators/safety.js';

export function riskAgent(ctx, memory, need, validators) {
  const derived = deriveRiskFlags({ memory, need, ctx, validators });
  const guardrails = evaluateGuardrails({ memory, need, ctx });

  /* 把风险旗标写回中央数据层 —— 下游（Planner / Case）只读 Memory */
  memory.risk_flags = derived.risk_flags;

  return {
    risks: derived.risk_flags,
    overall: derived.overall,
    overallLabel: derived.overallLabel,
    guardrails,
    policies: POLICIES,
    disclaimer: derived.disclaimer,
  };
}
