# Service Memory Copilot · AI 客服共情助手

> 普通客服 AI 理解用户**现在说了什么**；
> 我们的系统理解这个用户**为什么会说这句话**。

美妆电商客服场景的 AI 辅助平台。定位不是「自动客服机器人」，而是**辅助人工客服的 AI Copilot**。

---

## 架构（本轮改造后）

```
原始多源数据（聊天 / 订单 / 工单 / 系统事件）
        ↓
① LLM 语义理解          event_extraction / promise_classification / current_need
        ↓
② Service Memory 结构化  统一 Service Event Schema（中央数据层，带缓存）
        ↓
③ Evidence / Rule Validator
   ├─ business.js  业务核验：承诺是否真的兑现（回查业务库，模型不参与）
   └─ safety.js    安全规则：敏感事件 / 权限 / 额度 / 人工确认 / 禁止虚构
        ↓
④ Risk / Escalation     事件驱动风险识别 + 根因注册表归因
        ↓
⑤ Agent Planner         LLM 规划 + 声明式动作注册表兜底
        ↓
⑥ 人工确认             所有写操作 requiresConfirmation = true
        ↓
⑦ Tool 执行            真实改变内存数据库，返回 effects
        ↓
⑧ 状态回写闭环         业务状态变化 → Service Memory 重算 → Case 状态流转
```

### 判断权归属（关键设计）

| 层 | 负责 | 不负责 |
|---|---|---|
| **LLM** | 事件抽取、承诺分类、诉求理解、升级归因、回复生成、动作规划 | 判断数据库事实、决定情绪等级、决定金额与权限 |
| **规则 Validator** | 承诺是否兑现、风险等级、安全护栏、写操作权限与额度、状态机 | 语义理解 |
| **Tool** | 提供唯一可信的业务状态；所有写操作的唯一出口 | 语义判断 |

**铁律：模型不判断数据库事实。** LLM 可以识别「客服承诺了补发」并抽出 deadline，
但「到底有没有真的补发」必须由 Validator 回查业务库决定。

### 实测校准出来的四条边界（接真实模型后才暴露）

这四条不是设计时想出来的，是**接入 qwen-plus 跑真实链路后，被失败用例逼出来的**：

| # | 现象 | 修正 |
|---|---|---|
| 1 | 模型规划的动作**漏掉业务必需项**（不给「创建补发单」、不给「关闭工单」），导致 Case 永远无法闭环 | 动作规划改为**分层合并**：规则注册表保证必需动作一定在（参数由规则给定），LLM 只负责补充额外动作与优化措辞 |
| 2 | 模型把**历史对照订单**当成本次处理对象（回复里出现了无关订单号） | 事实清单显式区分「本次处理对象」与「历史对照 · 与本次问题无关」，并在提示词加禁止条款 |
| 3 | 模型**漏掉合规声明**（不做医学诊断 / 不再推荐产品） | 回复生成后做**规则后置校验**，缺失即补齐 —— 合规不能依赖模型自觉 |
| 4 | 模型把**历史系统巡检通知**抽成未解决问题，补发后该通知已过期却无法失效，闭环不收敛 | 未解决项只允许由 chat / order / ticket 三类业务数据承载；系统事件只做记录 |

**这四条共同指向同一个结论**：LLM 负责语义理解与措辞，**规则的职责是保证业务正确性不被模型的不确定性破坏**。

---

## 快速开始

```bash
cd service-memory-copilot
npm start          # 默认 http://localhost:8787
```

无需 `npm install`（零依赖，仅用 Node 内置模块）。要求 Node ≥ 20。

| 入口 | 地址 |
| --- | --- |
| 客服工作台 | http://localhost:8787/ |
| Risk Center | http://localhost:8787/risk-center |
| API 健康检查 | http://localhost:8787/api/health |
| Token 用量与任务轨迹 | http://localhost:8787/api/llm/stats |
| 工具调用日志 | http://localhost:8787/api/tools/log |

其他命令：

```bash
npm run acceptance   # 5 个验收场景 + 状态回写闭环（45 项断言）
npm run selftest     # 端到端链路可读报告
npm run eval         # 评估集三组对比（Rule Only / LLM Only / Hybrid）
```

### 接入开源大模型

```bash
LLM_API_KEY=sk-xxx \
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 \
LLM_MODEL=qwen-plus \
SEMANTIC_MODE=hybrid \
npm start
```

兼容任意 OpenAI Chat Completions 协议的服务（DashScope / vLLM / Ollama / SGLang）。

### 三种语义引擎模式

| SEMANTIC_MODE | 行为 | 用途 |
| --- | --- | --- |
| `hybrid`（默认） | LLM 优先，失败/未配置自动回落确定性引擎 | 生产 / Demo |
| `llm_only` | 只用 LLM，失败即失败不回落 | 评估模型真实水平 |
| `rule_only` | 只用确定性引擎 | 规则基线 / 零 Key 演示 |

**未配置模型时系统自动降级为 `rule_only`，Demo 永不白屏，且全部验收项依然通过。**

---

## Service Event Schema

中央数据层的唯一契约（`server/schema.js`）。

```jsonc
{
  "event_id": "EVT_0007",
  "type": "service_promise",          // 13 类之一
  "subtype": "reshipment",            // 业务主题
  "time": "2026-10-05T20:12:00+08:00",
  "source": "chat",                   // chat | order | ticket | system
  "source_id": "会话 / S_1005_C · 客服-王敏",
  "status": "unfulfilled",            // info/open/pending/in_progress/unfulfilled/fulfilled/resolved/unknown
  "confidence": "high",
  "evidence": "明天中午 12 点前一定给您重新补发正确的颜色",
  "structured_data": {
    "action": "reshipment",
    "deadline": "2026-10-06T04:00:00.000Z",
    "deadline_label": "10月6日 12:00",
    "target_order": "ORDER_1024",
    "target_sku": "FD-1024-02"
  },
  "verification": { "checks": [], "conclusion": "…" },  // 仅 Validator 可写
  "raw": { "category": "PROMISE", "reason": "…" }
}
```

**13 类事件类型**：`user_issue` `service_promise` `estimated_timeline` `service_action`
`refund` `reshipment` `complaint` `sensitive_beauty_incident` `logistics_issue`
`wrong_item` `wrong_sku` `unresolved_issue` `resolution`

业务状态**不允许**塞进自由文本 —— 全部进 `structured_data`。

---

## 核心能力

| 能力 | 说明 |
| --- | --- |
| **Service Memory** | 把四个数据源统一投影成结构化服务事件时间线，每个事件带来源、状态与可回溯证据。不是聊天摘要。 |
| **Promise Tracking** | 话术五分类（明确承诺 / 预计 / 执行动作 / 普通解释 / 无关），**只有明确承诺进追踪**；兑现与否一律回查业务库。 |
| **Unresolved Detection** | 汇总未兑现承诺、未关闭工单、未到账退款、发货错误、未登记的不适事件。 |
| **Escalation Reasoning** | 根因注册表驱动的归因，输出**认知落差对照表**（消费者认知 vs 系统真实状态）。 |
| **Risk Detection** | 六类风险，主输入是 Service Events 而非关键词；只用 LOW/MEDIUM/HIGH，不输出百分比。 |
| **Next Best Action** | 声明式动作注册表，最多 3 个按优先级排列的动作，写操作强制人工确认。 |
| **Human-in-the-loop** | AI 不发送任何消息。补发 / 退款 / 优惠券 / 升级 / 补偿必须经客服确认。 |
| **Resolution Tracking** | 5 态 Case 状态机：OPEN → ALERTED → PROCESSING → WAITING → RESOLVED。 |

### 六类风险

| code | 风险 | 判定依据 |
| --- | --- | --- |
| `repeat_contact` | 重复进线 | 进线事件统计（近 7 天 ≥ 2 次） |
| `unfulfilled_promise` | 未兑现承诺 | **Validator 核验结果**（不是关键词） |
| `emotion_escalation` | 情绪升级 | 当前情绪等级 vs 历史基线 |
| `public_complaint` | 投诉 / 舆情 | 确定性安全规则（第三方平台词表） |
| `abnormal_refund` | 异常退款 | 退款事件统计（近 30 天 ≥ 2 笔） |
| `sensitive_beauty` | 美妆敏感风险 | 敏感事件 + 当前症状表述 |

命中 `sensitive_beauty` 触发**安全护栏**：禁止一切常规产品推荐、要求走安全流程、要求人工升级，
且回复中明确声明不做医学诊断。

---

## Tool 层

**只读**：`check_order` `check_reshipment` `check_refund` `check_coupon` `check_inventory`
`check_logistics` `estimate_fulfillment` `get_ticket_history`

**写操作**：`create_ticket` `update_ticket` `close_ticket` `request_reshipment` `request_refund`
`record_sensitive_incident` `escalate_case` `add_compensation`

`check_reshipment` / `check_refund` / `check_coupon` 是 Validator 的核验入口，
统一返回 `{ exists, state, at, summary }`，让核验逻辑对业务主题完全泛化。

写操作会**真实修改内存数据库**，并返回 `effects` 供前端展示状态变更。
所有调用都会写入工具调用日志（`GET /api/tools/log`）。

---

## Token 成本机制

主要节约手段（`server/llm.js` + `server/agents/serviceMemory.js`）：

1. **Service Memory 缓存** —— 原始上下文指纹不变时，事件抽取**只跑一次**。
   后续 Agent 全部读 Memory，不再把历史聊天重新喂给模型。
2. **话术分类记忆化** —— 同一句客服话术只分类一次，不随分析次数线性膨胀。
3. **任务级缓存** —— 以 `(task + 完整输入)` 哈希为键，命中不请求模型。
4. **精确计量** —— 每次调用记录 task / model / input tokens / output tokens / latency / cacheHit，
   可在 `GET /api/llm/stats` 查看。

---

## Demo 数据与场景

四位消费者，日期全部相对「今天」动态生成。

| 消费者 | 场景 | 关键冲突 |
| --- | --- | --- |
| **林小满** `CUST_8821` | 补发承诺未兑现 | 客服昨天承诺「今天 12:00 前补发」，订单库里根本没有补发单 |
| **苏黎** `CUST_9077` | 疑似产品不适 | 历史不适反馈只走了退款、没登记事件，推荐系统还在推同系列产品 |
| **陈亦然** `CUST_9134` | 退款拖延 + 异常退款 | 30 天 3 笔退款，退款长期停在处理中 |
| **周晓** `CUST_9002` | 常规咨询（对照组） | 用于证明系统不会对正常会话过度告警 |

### 场景一 · 完整闭环

```
消费者再次进线
  ↓  语义层抽取事件（LLM 或确定性引擎）
Service Memory 恢复：错误发货 → 客服承诺 → 承诺未兑现 → 再次进线
  ↓  Business Validator 回查订单库 → 无补发单 → UNFULFILLED
  ↓  Escalation：根因 = 历史客服承诺未兑现（不是物流问题）
  ↓  Risk：未兑现承诺 HIGH / 投诉舆情 HIGH / 情绪升级 HIGH / 重复进线 MEDIUM
  ↓  Planner：① 核查库存与最快履约 ② 创建加急补发单 ③ 无法履约则升级+补偿
  ↓  客服「执行查询」→ 库存 6 件、省内次日达
  ↓  客服「确认执行」→ request_reshipment() → 生成补发单，工单推进
Service Memory 自动重算：承诺 → 已兑现；未解决项 2 → 1
  ↓  客服「采用回复」→ 建议回复进入会话
  ↓  客服「确认执行」关闭工单
Case：PROCESSING → RESOLVED（4/4 闭环）
```

**对照观察点**：同一个消费者的历史里，还有一条**已正常兑现**的承诺（8 月的赠品补发）。
系统能同时给出「已兑现」与「未兑现」两条记录 —— 这证明它是在核验数据，而不是在猜。

---

## REST API

```
GET  /api/health
GET  /api/settings              POST /api/settings              # 运行时切换模型与模式
GET  /api/consumers
GET  /api/consumers/:id/context
POST /api/copilot/analyze       { consumerId, message? }
POST /api/copilot/message       { consumerId, text }
POST /api/copilot/reply-decision{ consumerId, decision, text }   # adopt | edit | reject
POST /api/tools/:name           { params, consumerId }
POST /api/tools/batch           { calls[], consumerId }
GET  /api/tools/log                                              # 工具调用日志
GET  /api/tools/specs                                            # 工具签名（供 Planner）
GET  /api/cases                 GET /api/cases/:consumerId       # Case 列表 / 详情
GET  /api/risk-center
GET  /api/llm/stats                                              # Token 用量与语义任务轨迹
POST /api/reset
```

`analyze` 返回结构：

```jsonc
{
  "meta":          { "engine": "…", "llm": {}, "semanticTrace": [], "memoryCache": {} },
  "serviceMemory": { "events": [], "unresolved_issues": [], "risk_flags": [], "narrative": [] },
  "validations":   { "checks": [], "unfulfilledPromise": {} },
  "promises":      { "utterances": [], "promises": [], "unfulfilled": [], "stats": {} },
  "intent":        { "surfaceIssue": {}, "realNeed": {}, "constraints": [], "emotion": {} },
  "risk":          { "risks": [], "overall": "HIGH", "guardrails": {} },
  "escalation":    { "rootCause": "", "rootCauseLabel": "", "comparison": [], "evidence": [] },
  "actionPlan":    { "actions": [], "banner": null, "availableTools": [] },
  "reply":         { "text": "", "facts": [], "constraints": {} },
  "case":          { "status": "PROCESSING", "statusFlow": [], "checks": [], "progress": {} }
}
```

---

## 开发原则落地位置

| 原则 | 实现位置 |
| --- | --- |
| **LLM 语义理解优先** | `server/semantic/index.js` 是唯一语义入口，按模式路由 |
| **数据优先** | 所有判断的输入都来自 `store.contextOf(consumerId)` |
| **Evidence First** | 事件 / 风险 / 归因 / 回复全部带 `source / ref / text` |
| **模型不判断数据库事实** | `server/validators/business.js` 独占核验权 |
| **不使用伪精确评分** | 风险只用 LOW/MEDIUM/HIGH，情绪只用四级，代码中不存在百分比输出 |
| **确定性信息不交给模型** | 订单 / 工单 / 承诺兑现 / 金额权限全部走 Tool 与安全规则 |
| **写操作人工确认** | `POLICIES.writeActionsRequiringConfirmation` + `requiresConfirmation` |
| **数据缺失禁止虚构** | `checkWritePermission` 在缺参数时直接拒绝执行 |

---

## 已知边界

- 数据存在内存中，重启服务即恢复初始状态（`POST /api/reset` 可手动重置）。
- 承诺时限解析覆盖中文相对时间（今天 / 明天 / N 小时内 / N 天内 / 尽快），未覆盖跨月绝对日期与农历。
- 情绪等级由确定性词表判定（保证可复现），生产环境应替换为经过校准的分类模型。
- 未配置模型时全部任务走确定性兜底，此时 `meta.engine` 会显示 `rule-only`。
- **qwen-plus 下单次 analyze 约 7 秒/次调用、全链路 6 次调用约 40-60 秒**，实时交互体验偏慢；
  生产环境需要换更快的模型或做流式返回。
- LLM 抽取存在**非确定性**：同一份数据重复抽取可能产出略有差异的事件集合。
  目前已通过「会话侧事件由分类结果投影」+「安全事件兜底补齐」+「未解决项来源限制」把影响收敛，
  但**尚未做到完全可复现**，这是接入真实模型后的主要遗留风险。
- 多模态（商品图 / 患处照片核验）尚未接入，见下一阶段规划。

---

## 验证结果（真实运行，未修饰）

```
规则基线（SEMANTIC_MODE=rule_only）      53/53 通过
真实 LLM（qwen-plus, hybrid）            53/53 通过
```

覆盖 5 个赛题验收场景 + 状态回写闭环，共 53 项断言：

| 场景 | 断言数 | 内容 |
|---|---|---|
| Test1 补发承诺未兑现 | 12 | 未兑现判定 / 核验结论 / 根因 / 认知落差 / 必需动作 / 回复不引用历史对照单 |
| Test2 预计时效不是承诺 | 7 | 五分类边界 + 3 条回归样本（承诺动作+模糊词必须降级） |
| Test3 退款承诺未兑现 | 6 | 泛化验证：走 `check_refund`，自动给出 `request_refund`，零新增代码分支 |
| Test4 普通咨询不报警 | 7 | 风险 LOW / 无未解决项 / Case 保持 OPEN |
| Test5 敏感美妆事件 | 10 | 护栏 / 登记 / 升级 / 合规声明 / 不做医学判断 |
| Test6 状态回写闭环 | 11 | Tool 执行 → 业务状态变化 → 重算 → 5 态流转至 RESOLVED |

评估集（40 条标注样本）与三组对比见 `evaluation/REPORT.md`。
