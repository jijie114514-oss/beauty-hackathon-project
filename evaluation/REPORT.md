# 评估报告 · Service Memory Copilot

生成时间：2026-10-06T10:31:18.442Z
模型：qwen-plus
数据集：25 条话术样本 + 15 条场景样本

> 本报告只包含真实运行结果，未做任何人为修饰。

## 总览

| 模式 | 话术分类 Accuracy | 分类宏 F1 | 风险宏 F1 | 根因 Accuracy | 未解决项 Accuracy | 场景失败 | 误报数 | Token | 调用次数 |
|---|---|---|---|---|---|---|---|---|---|
| rule_only | 100.0% | 0.8 | 1 | 100.0% | 100.0% | 0 | 0 | 0 | 0 |
| llm_only | 0.0% | 0 | 1 | 100.0% | 100.0% | 0 | 0 | 51686 | 81 |
| hybrid | 100.0% | 0.8 | 1 | 100.0% | 100.0% | 0 | 0 | 25646 | 38 |

## 话术分类 · 分类别指标

| 模式 | 类别 | Precision | Recall | F1 | 支持数 |
|---|---|---|---|---|---|
| rule_only | PROMISE | 1 | 1 | 1 | 10 |
| rule_only | ESTIMATE | 1 | 1 | 1 | 5 |
| rule_only | ACTION | 1 | 1 | 1 | 5 |
| rule_only | EXPLANATION | 1 | 1 | 1 | 5 |
| llm_only | PROMISE | 0 | 0 | 0 | 10 |
| llm_only | ESTIMATE | 0 | 0 | 0 | 5 |
| llm_only | ACTION | 0 | 0 | 0 | 5 |
| llm_only | EXPLANATION | 0 | 0 | 0 | 5 |
| hybrid | PROMISE | 1 | 1 | 1 | 10 |
| hybrid | ESTIMATE | 1 | 1 | 1 | 5 |
| hybrid | ACTION | 1 | 1 | 1 | 5 |
| hybrid | EXPLANATION | 1 | 1 | 1 | 5 |

## 风险识别 · 按风险码

| 模式 | 风险码 | Precision | Recall | F1 |
|---|---|---|---|---|
| rule_only | repeat_contact | 1 | 1 | 1 |
| rule_only | sensitive_beauty | 1 | 1 | 1 |
| llm_only | repeat_contact | 1 | 1 | 1 |
| llm_only | sensitive_beauty | 1 | 1 | 1 |
| hybrid | repeat_contact | 1 | 1 | 1 |
| hybrid | sensitive_beauty | 1 | 1 | 1 |

## 错例明细

### rule_only

- 话术分类错例：0 条
- 场景执行失败（模型未产出可用结果）：0 条
- 根因错例：0 条
- 未解决项错例：0 条
- 误报（不该报警却报了）：0 条
- 护栏未触发：0 条 []
- 必需动作缺失：0 条 []

### llm_only

- 话术分类错例：25 条
  - `undefined` 「明天中午 12 点前一定给您重新补发正确的颜色。」 期望 PROMISE，实际 undefined
  - `undefined` 「我保证今天之内把退款给您处理好。」 期望 PROMISE，实际 undefined
  - `undefined` 「我答应您，明天一定给您答复。」 期望 PROMISE，实际 undefined
  - `undefined` 「明天就给您补发一个新的粉底刷。」 期望 PROMISE，实际 undefined
  - `undefined` 「今天内一定帮您把优惠券补上。」 期望 PROMISE，实际 undefined
  - `undefined` 「48 小时内给您重新寄出正确的色号。」 期望 PROMISE，实际 undefined
  - `undefined` 「您放心，我承诺明天上午一定把物流单号发您。」 期望 PROMISE，实际 undefined
  - `undefined` 「务必在今天 18 点前给您退款到账。」 期望 PROMISE，实际 undefined
  - `undefined` 「我肯定给您补发，明天中午之前一定送到。」 期望 PROMISE，实际 undefined
  - `undefined` 「今天就给您安排补发，绝不拖延。」 期望 PROMISE，实际 undefined
  - `undefined` 「预计 24 小时内处理完成。」 期望 ESTIMATE，实际 undefined
  - `undefined` 「大概明天就能到您那边。」 期望 ESTIMATE，实际 undefined
  - `undefined` 「应该这两天就会给您发出。」 期望 ESTIMATE，实际 undefined
  - `undefined` 「正常情况下明天就能补发出去。」 期望 ESTIMATE，实际 undefined
  - `undefined` 「尽量今天帮您处理，争取明天发出。」 期望 ESTIMATE，实际 undefined
  - `undefined` 「我帮您提交补发申请。」 期望 ACTION，实际 undefined
  - `undefined` 「我这就去核实一下库存情况。」 期望 ACTION，实际 undefined
  - `undefined` 「已经为您提交退款申请了。」 期望 ACTION，实际 undefined
  - `undefined` 「我帮您反馈给仓库那边核实。」 期望 ACTION，实际 undefined
  - `undefined` 「正在为您查询订单的物流状态。」 期望 ACTION，实际 undefined
  - `undefined` 「物流正常的情况下需要 2-3 天送达。」 期望 EXPLANATION，实际 undefined
  - `undefined` 「根据规定，拆封后的化妆品不支持无理由退货。」 期望 EXPLANATION，实际 undefined
  - `undefined` 「退款到账时间以银行处理为准。」 期望 EXPLANATION，实际 undefined
  - `undefined` 「这款是干皮友好型，遮瑕力中等偏上。」 期望 EXPLANATION，实际 undefined
  - `undefined` 「因为仓库拣货失误，所以给您发错了色号。」 期望 EXPLANATION，实际 undefined
  - ⚠ 批量分类整体失败：This operation was aborted
- 场景执行失败（模型未产出可用结果）：0 条
- 根因错例：0 条
- 未解决项错例：0 条
- 误报（不该报警却报了）：0 条
- 护栏未触发：0 条 []
- 必需动作缺失：0 条 []

### hybrid

- 话术分类错例：0 条
- 场景执行失败（模型未产出可用结果）：0 条
- 根因错例：0 条
- 未解决项错例：0 条
- 误报（不该报警却报了）：0 条
- 护栏未触发：0 条 []
- 必需动作缺失：0 条 []

## 成本明细

| 模式 | 输入 tokens | 输出 tokens | 合计 | 调用 | 缓存命中 | 失败 | 累计延迟(ms) |
|---|---|---|---|---|---|---|---|
| rule_only | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| llm_only | 43887 | 7799 | 51686 | 81 | 0 | 1 | 202365 |
| hybrid | 21333 | 4313 | 25646 | 38 | 0 | 44 | 109171 |

### 按任务拆分（各模式）

**rule_only**

| 任务 | 调用 | 输入 tokens | 输出 tokens | 延迟(ms) |
|---|---|---|---|---|

**llm_only**

| 任务 | 调用 | 输入 tokens | 输出 tokens | 延迟(ms) |
|---|---|---|---|---|
| promise_classification | 6 | 3048 | 617 | 16872 |
| current_need | 15 | 3679 | 1030 | 27688 |
| event_extraction | 15 | 9946 | 555 | 18050 |
| escalation_reasoning | 15 | 8105 | 1545 | 39373 |
| action_planning | 15 | 13017 | 2397 | 57972 |
| reply_generation | 15 | 6092 | 1655 | 42410 |

**hybrid**

| 任务 | 调用 | 输入 tokens | 输出 tokens | 延迟(ms) |
|---|---|---|---|---|
| promise_classification | 7 | 4608 | 1938 | 45260 |
| current_need | 7 | 1783 | 474 | 13725 |
| event_extraction | 6 | 3901 | 42 | 2991 |
| escalation_reasoning | 6 | 3558 | 663 | 16538 |
| action_planning | 6 | 5116 | 542 | 13957 |
| reply_generation | 6 | 2367 | 654 | 16700 |
