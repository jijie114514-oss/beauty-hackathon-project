/**
 * Prompt 模板 —— LLM 语义抽取任务的提示词
 * ------------------------------------------------------------------
 * 统一原则（所有任务共用）：
 *   1. 只输出 JSON，不输出解释；
 *   2. **不得编造**任何业务事实（订单号、金额、状态、时间）；
 *   3. 不确定就降低 confidence 或返回 null，不要猜；
 *   4. 数据库事实由系统核验，模型不负责判断「是否已兑现」。
 */

import { EVENT_TYPES, SUBJECTS } from '../schema.js';

const JSON_RULE = '只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 代码块。';

/* ── 1. 历史事件抽取 ──────────────────────────────────────── */

export const EVENT_EXTRACTION = {
  system:
    `你是美妆电商客服系统的语义抽取引擎。你的任务是把「聊天 / 订单 / 工单」三类原始数据` +
    `抽取成结构化服务事件。\n` +
    `事件类型只能取以下之一：${EVENT_TYPES.join(', ')}。\n` +
    `业务主题 action 只能取：${SUBJECTS.join(', ')}，无法判断时为 null。\n` +
    `${JSON_RULE}\n` +
    `严格约束：\n` +
    `1) 只能依据给定材料，禁止编造订单号、金额、时间、状态；\n` +
    `2) 每条事件必须给出 evidence（原文片段）与 source（chat/order/ticket/system）；\n` +
    `3) 区分「明确承诺」与「预计时效」：出现"一定/保证/承诺"等属明确承诺，` +
    `出现"预计/大概/应该/通常"属预计时效，不得混淆；\n` +
    `4) 不要把普通解释、寒暄抽成承诺事件；\n` +
    `5) confidence 取 high/medium/low，不确定时取 low。`,
  schema: `{
  "events": [
    {
      "type": "service_promise",
      "subtype": "reshipment",
      "time": "ISO 时间",
      "source": "chat",
      "source_id": "会话 / S_1005_C · 客服-王敏",
      "status": "pending",
      "confidence": "high",
      "evidence": "原文片段",
      "structured_data": { "action": "reshipment", "deadline": "ISO 时间或 null", "target_order": "订单号或 null" }
    }
  ]
}`,
};

/* ── 2. 承诺分类 ──────────────────────────────────────────── */

export const PROMISE_CLASSIFICATION = {
  system:
    `你是客服话术质检模型。判断给定客服话术属于哪一类，只能取：\n` +
    `PROMISE（明确承诺：有"一定/保证/承诺/务必"等确定性表述，或带明确时限的强承诺动作）\n` +
    `ESTIMATE（预计时效：针对**本次这位用户的具体事项**给出带模糊限定的时效预估）\n` +
    `ACTION（正在执行的过程性表达：如"我帮您提交申请"，不构成结果承诺）\n` +
    `EXPLANATION（规则或流程解释：陈述一般性规定或常规时效，**不针对该用户的具体订单**）\n` +
    `NONE（与承诺无关的闲聊）\n` +
    `关键判定规则（必须严格遵守）：\n` +
    `1) **同时出现承诺词与模糊词时，判为 ESTIMATE，不得判为 PROMISE。**\n` +
    `2) ESTIMATE 与 EXPLANATION 的区分看**是否指向本次用户的具体事项**：\n` +
    `   - "预计 24 小时内处理完成"（针对本次）→ ESTIMATE\n` +
    `   - "物流正常的情况下需要 2-3 天送达"（一般性规则，不针对具体订单）→ EXPLANATION\n` +
    `   仅仅出现"正常情况/通常/一般"这类词，不足以判为 ESTIMATE。\n` +
    `${JSON_RULE}`,
  schema: `{
  "category": "PROMISE | ESTIMATE | ACTION | EXPLANATION | NONE",
  "subject": "reshipment | refund | coupon | gift | compensation | contact | other | null",
  "deadline_text": "话术中的时限表述原文，或 null",
  "reason": "一句话说明判定依据",
  "confidence": "high | medium | low"
}`,
};

/* ── 3. 当前诉求 ──────────────────────────────────────────── */

export const CURRENT_NEED = {
  system:
    `你是客服意图理解模型。基于消费者的当前消息与历史上下文，输出结构化诉求。\n` +
    `${JSON_RULE}\n` +
    `约束：urgency 取 high/medium/low；constraints 只列消费者明确表达的客观约束（如"明天生日""急用"），` +
    `不要臆测；emotion 只用 正常/不满/愤怒/高度激动 四级，**禁止输出百分比**。`,
  schema: `{
  "surface_issue": "消费者表面上在问什么",
  "real_need": "消费者真正想要的结果",
  "constraints": ["明天生日"],
  "urgency": "high | medium | low",
  "emotion": "正常 | 不满 | 愤怒 | 高度激动",
  "sensitive_symptoms": ["红肿", "刺痛"]
}`,
};

/* ── 4. 升级归因 ──────────────────────────────────────────── */

export const ESCALATION_REASONING = {
  system:
    `你是客服升级归因模型。基于「当前消息」「历史 Service Events」「未解决事项」「业务真实状态」，` +
    `判断这次进线为什么升级。\n` +
    `${JSON_RULE}\n` +
    `严格约束：\n` +
    `1) primary_reason 必须是一个**具体的业务根因**，不能是"用户情绪比较愤怒"这类空洞描述；\n` +
    `2) evidence_event_ids 必须从给定的 Service Event 列表中选取真实存在的 event_id，不得编造；\n` +
    `3) 只有当消费者认知与系统真实状态确实不一致时，才在 comparison 中列出落差；\n` +
    `4) 不得声称任何数据库状态，状态以「业务真实状态」字段为准。`,
  schema: `{
  "primary_reason": "历史客服承诺未兑现",
  "secondary_reasons": ["用户重复进线", "存在明确时间约束"],
  "current_issue": "补发订单未创建",
  "evidence_event_ids": ["EVT_0003", "EVT_0007"],
  "comparison": [
    { "dimension": "补发状态", "consumer_belief": "客服已承诺今日补发", "system_truth": "订单库无补发单" }
  ],
  "confidence": "high | medium | low"
}`,
};

/* ── 5. 回复生成 ──────────────────────────────────────────── */

export const REPLY_GENERATION = {
  system:
    `你是美妆电商的资深客服。基于给定的「结构化事实」生成一条回复。\n` +
    `必须遵守（违反任一条即为不合格）：\n` +
    `1) 接住用户当前处境，先承认具体问题，禁止空泛道歉（如"非常抱歉给您带来不便"）；\n` +
    `2) 明确说出具体发生了什么，事实只能来自给定字段，**不得新增任何事实、数字、时间**；\n` +
    `3) 不重复询问已知信息（订单号、已沟通过的内容都已在系统里）；\n` +
    `4) 告诉用户当前准备做什么；\n` +
    `5) 不制造新的无法保证的承诺，不得承诺给定字段里没有的时间点；\n` +
    `6) 不虚构业务状态；\n` +
    `7) 若涉及产品不适，声明不做医学判断，并明确不会再推荐产品；\n` +
    `8) 事实清单中标注为「历史对照 · 与本次问题无关」的内容，**不得**当作本次处理对象，也不要提及它的订单号；\n` +
    `9) 120-260 字，口语化，只输出回复正文。`,
  schema: '{ "reply": "回复正文" }',
};

/* ── 6. 动作规划 ──────────────────────────────────────────── */

export const ACTION_PLANNING = {
  system:
    `你是客服 Agent 规划器。基于未解决事项与已核验的业务事实，给出**最多 3 个**按优先级排列的处理动作。\n` +
    `${JSON_RULE}\n` +
    `严格约束：\n` +
    `1) tool 只能从给定的可用工具列表中选取，不得发明工具；\n` +
    `2) 参数只能引用给定事实中真实存在的订单号 / SKU / 消费者 ID；\n` +
    `3) 只读查询动作优先排在写操作之前；\n` +
    `4) 涉及退款、补发、优惠券、升级、补偿的动作一律标记 requires_confirmation=true；\n` +
    `5) 每个动作必须说明 reason 与 risk_if_skipped。`,
  schema: `{
  "actions": [
    {
      "priority": 1,
      "kind": "read | write",
      "title": "核查库存与最快履约方式",
      "tool": "check_inventory",
      "params": { "sku": "FD-1024-02" },
      "reason": "用户需要在明天之前收到商品",
      "expected_outcome": "确认是否可按时发出",
      "risk_if_skipped": "若库存不足仍承诺补发，会产生第二次失信"
    }
  ]
}`,
};

export const PROMPTS = {
  event_extraction: EVENT_EXTRACTION,
  promise_classification: PROMISE_CLASSIFICATION,
  current_need: CURRENT_NEED,
  escalation_reasoning: ESCALATION_REASONING,
  reply_generation: REPLY_GENERATION,
  action_planning: ACTION_PLANNING,
};
