/**
 * Mock 数据种子层
 * ------------------------------------------------------------------
 * 设计原则：
 * 1. 所有日期相对「服务器启动时刻」动态生成，保证「昨天 / 今天」的语义
 *    在任何人任何时候运行 Demo 时都成立。
 * 2. 数据分成四个源：消费者 / 订单 / 售后工单 / 会话（含推荐推送等系统事件）。
 *    这与需求里的「聊天 + 订单 + 工单」三类核心数据一一对应。
 * 3. 刻意制造「跨源冲突」：聊天里客服承诺了补发，订单库里却没有补发单。
 *    这个冲突就是整个产品要帮人工客服发现的东西。
 */

export const DEMO_NOW = new Date();

/** 相对天数生成 ISO 时间，例如 at(-1, '20:03') = 昨天 20:03 */
export function at(dayOffset, hhmm = '12:00') {
  const d = new Date(DEMO_NOW);
  d.setDate(d.getDate() + dayOffset);
  const [h, m] = String(hhmm).split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

export const CHANNELS = {
  app: 'APP 在线客服',
  wechat: '微信公众号',
  miniprogram: '小程序客服',
  hotline: '电话热线',
};

export function buildSeed() {
  const consumers = [
    {
      id: 'CUST_8821',
      name: '林小满',
      level: 'VIP2',
      phone: '138****8821',
      city: '杭州',
      registeredAt: at(-418, '10:00'),
      skinProfile: '干皮 / 暖调肤色',
      tags: ['美妆高频复购', '偏好暖调底妆'],
      note: '历史客诉记录 1 次，均为发错货，非恶意进线。',
    },
    {
      id: 'CUST_9077',
      name: '苏黎',
      level: 'VIP1',
      phone: '159****9077',
      city: '成都',
      registeredAt: at(-96, '15:20'),
      skinProfile: '自述敏感肌',
      tags: ['敏感肌关注', '曾发起产品不适售后'],
      note: '历史存在产品使用不适反馈记录。',
    },
    {
      id: 'CUST_9134',
      name: '陈亦然',
      level: '普通会员',
      phone: '186****9134',
      city: '广州',
      registeredAt: at(-58, '09:40'),
      skinProfile: '未知',
      tags: ['近 30 天多次退款'],
      note: '近 30 天 3 笔退款，需关注异常退款风险。',
    },
    {
      id: 'CUST_9002',
      name: '周晓',
      level: '普通会员',
      phone: '137****9002',
      city: '南京',
      registeredAt: at(-12, '11:05'),
      skinProfile: '干皮',
      tags: ['新客'],
      note: '无历史客诉，本次为常规售前咨询。',
    },
  ];

  const orders = [
    // ── 林小满 ────────────────────────────────────────────────
    {
      id: 'ORDER_1024',
      consumerId: 'CUST_8821',
      type: 'sales',
      items: [
        {
          product: '轻雾持妆粉底液',
          sku: 'FD-1024-02',
          shade: '暖调自然色 02',
          qty: 1,
          price: 219,
        },
      ],
      amount: 219,
      createdAt: at(-21, '21:10'),
      paidAt: at(-21, '21:11'),
      shippedAt: at(-20, '10:30'),
      deliveredAt: at(-17, '16:02'),
      payStatus: 'paid',
      shipStatus: 'delivered',
      logistics: {
        carrier: '顺丰速运',
        trackingNo: 'SF7788 2100 1024',
        status: 'delivered',
        lastUpdate: at(-17, '16:02'),
        lastNode: '已签收，签收人：本人',
      },
      refundStatus: 'none',
      reshipStatus: 'none',
      address: '浙江省杭州市西湖区文三路 · 林小满',
      // 关键事实：实收商品与下单 SKU 不一致（由工单记录确认）
      receivedSku: 'FD-1024-01',
      receivedShade: '冷调象牙白 01',
    },
    {
      id: 'ORDER_0998',
      consumerId: 'CUST_8821',
      type: 'reshipment',
      items: [
        { product: '赠品 · 粉底刷', sku: 'GIFT-BRUSH-01', shade: '-', qty: 1, price: 0 },
      ],
      amount: 0,
      createdAt: at(-47, '14:10'),
      paidAt: at(-47, '14:10'),
      shippedAt: at(-46, '09:20'),
      deliveredAt: at(-44, '15:00'),
      payStatus: 'paid',
      shipStatus: 'delivered',
      logistics: {
        carrier: '中通快递',
        trackingNo: 'ZT9900 1100 0998',
        status: 'delivered',
        lastUpdate: at(-44, '15:00'),
        lastNode: '已签收',
      },
      refundStatus: 'none',
      reshipStatus: 'shipped',
      address: '浙江省杭州市西湖区文三路 · 林小满',
      parentOrderId: 'ORDER_0961',
    },

    // ── 苏黎 ──────────────────────────────────────────────────
    {
      id: 'ORDER_1103',
      consumerId: 'CUST_9077',
      type: 'sales',
      items: [
        {
          product: '丝绒雾感粉底液',
          sku: 'FD-2201-03',
          shade: '自然色 03',
          qty: 1,
          price: 259,
        },
      ],
      amount: 259,
      createdAt: at(-24, '20:41'),
      paidAt: at(-24, '20:42'),
      shippedAt: at(-23, '11:00'),
      deliveredAt: at(-21, '18:30'),
      payStatus: 'paid',
      shipStatus: 'delivered',
      logistics: {
        carrier: '圆通速递',
        trackingNo: 'YT6622 3300 1103',
        status: 'delivered',
        lastUpdate: at(-21, '18:30'),
        lastNode: '已签收，代收点',
      },
      refundStatus: 'done',
      refundedAt: at(-18, '16:12'),
      reshipStatus: 'none',
      address: '四川省成都市武侯区天府大道 · 苏黎',
    },
    {
      id: 'ORDER_1150',
      consumerId: 'CUST_9077',
      type: 'sales',
      items: [
        { product: '柔光遮瑕膏', sku: 'CC-3310-02', shade: '自然色 02', qty: 1, price: 149 },
      ],
      amount: 149,
      createdAt: at(-10, '19:22'),
      paidAt: at(-10, '19:23'),
      shippedAt: at(-9, '10:15'),
      deliveredAt: at(-7, '14:40'),
      payStatus: 'paid',
      shipStatus: 'delivered',
      logistics: {
        carrier: '中通快递',
        trackingNo: 'ZT9911 2200 1150',
        status: 'delivered',
        lastUpdate: at(-7, '14:40'),
        lastNode: '已签收',
      },
      refundStatus: 'none',
      reshipStatus: 'none',
      address: '四川省成都市武侯区天府大道 · 苏黎',
    },

    // ── 陈亦然（异常退款） ────────────────────────────────────
    {
      id: 'ORDER_1201',
      consumerId: 'CUST_9134',
      type: 'sales',
      items: [{ product: '空气感散粉', sku: 'PW-4410-01', shade: '透明色', qty: 1, price: 129 }],
      amount: 129,
      createdAt: at(-27, '13:10'),
      paidAt: at(-27, '13:11'),
      shippedAt: at(-26, '09:00'),
      deliveredAt: at(-24, '17:20'),
      payStatus: 'paid',
      shipStatus: 'delivered',
      logistics: {
        carrier: '韵达快递',
        trackingNo: 'YD1122 4400 1201',
        status: 'delivered',
        lastUpdate: at(-24, '17:20'),
        lastNode: '已签收',
      },
      refundStatus: 'done',
      refundedAt: at(-22, '10:05'),
      reshipStatus: 'none',
      address: '广东省广州市天河区体育西路 · 陈亦然',
    },
    {
      id: 'ORDER_1245',
      consumerId: 'CUST_9134',
      type: 'sales',
      items: [{ product: '水润唇釉', sku: 'LP-5520-06', shade: '豆沙 06', qty: 2, price: 99 }],
      amount: 198,
      createdAt: at(-15, '21:33'),
      paidAt: at(-15, '21:34'),
      shippedAt: at(-14, '10:00'),
      deliveredAt: at(-12, '15:10'),
      payStatus: 'paid',
      shipStatus: 'delivered',
      logistics: {
        carrier: '韵达快递',
        trackingNo: 'YD1122 4400 1245',
        status: 'delivered',
        lastUpdate: at(-12, '15:10'),
        lastNode: '已签收',
      },
      refundStatus: 'done',
      refundedAt: at(-9, '11:40'),
      reshipStatus: 'none',
      address: '广东省广州市天河区体育西路 · 陈亦然',
    },
    {
      id: 'ORDER_1290',
      consumerId: 'CUST_9134',
      type: 'sales',
      items: [{ product: '控油妆前乳', sku: 'PP-6630-01', shade: '标准', qty: 1, price: 179 }],
      amount: 179,
      createdAt: at(-6, '12:02'),
      paidAt: at(-6, '12:03'),
      shippedAt: at(-5, '09:30'),
      deliveredAt: at(-3, '16:45'),
      payStatus: 'paid',
      shipStatus: 'delivered',
      logistics: {
        carrier: '韵达快递',
        trackingNo: 'YD1122 4400 1290',
        status: 'delivered',
        lastUpdate: at(-3, '16:45'),
        lastNode: '已签收',
      },
      refundStatus: 'processing',
      refundRequestedAt: at(-2, '20:15'),
      reshipStatus: 'none',
      address: '广东省广州市天河区体育西路 · 陈亦然',
    },

    // ── 周晓（正常新客） ──────────────────────────────────────
    {
      id: 'ORDER_1301',
      consumerId: 'CUST_9002',
      type: 'sales',
      items: [
        { product: '柔光遮瑕膏', sku: 'CC-3310-02', shade: '自然色 02', qty: 1, price: 149 },
      ],
      amount: 149,
      createdAt: at(-4, '10:20'),
      paidAt: at(-4, '10:21'),
      shippedAt: at(-3, '14:00'),
      deliveredAt: at(-1, '11:15'),
      payStatus: 'paid',
      shipStatus: 'delivered',
      logistics: {
        carrier: '顺丰速运',
        trackingNo: 'SF7788 2100 1301',
        status: 'delivered',
        lastUpdate: at(-1, '11:15'),
        lastNode: '已签收',
      },
      refundStatus: 'none',
      reshipStatus: 'none',
      address: '江苏省南京市鼓楼区中山北路 · 周晓',
    },
  ];

  const tickets = [
    // 林小满：发错货工单（未关闭）—— 关键未解决项
    {
      id: 'TK_1005_011',
      consumerId: 'CUST_8821',
      orderId: 'ORDER_1024',
      type: 'wrong_item',
      title: '收到商品色号与订单不一致',
      status: 'PROCESSING',
      priority: 'P1',
      owner: '客服-王敏',
      createdAt: at(-1, '20:06'),
      updatedAt: at(-1, '20:18'),
      result: null,
      records: [
        { at: at(-1, '20:06'), actor: '客服-王敏', note: '消费者反馈实收为 01 冷调象牙白，订单为 02 暖调自然色，已核实为仓库拣货错误。' },
        { at: at(-1, '20:12'), actor: '客服-王敏', note: '已向消费者承诺次日中午 12 点前完成补发。' },
        { at: at(-1, '20:18'), actor: '系统', note: '工单挂起，等待补发单创建。' },
      ],
    },
    // 林小满：历史赠品补发工单（已关闭，用于对照"已兑现承诺"）
    {
      id: 'TK_0820_004',
      consumerId: 'CUST_8821',
      orderId: 'ORDER_0998',
      type: 'reshipment',
      title: '赠品刷头缺失补发',
      status: 'RESOLVED',
      priority: 'P2',
      owner: '客服-李航',
      createdAt: at(-47, '14:02'),
      updatedAt: at(-46, '09:25'),
      result: '已补发，物流单号 ZT9900 1100 0998，消费者已签收。',
      records: [
        { at: at(-47, '14:02'), actor: '客服-李航', note: '消费者反馈赠品刷头缺失，承诺补发。' },
        { at: at(-47, '14:10'), actor: '客服-李航', note: '补发单 ORDER_0998 已创建。' },
        { at: at(-44, '15:10'), actor: '系统', note: '物流显示已签收，工单关闭。' },
      ],
    },
    // 苏黎：产品不适售后（已关闭，但未登记为不适事件）—— 关键盲区
    {
      id: 'TK_0918_007',
      consumerId: 'CUST_9077',
      orderId: 'ORDER_1103',
      type: 'sensitive_skin',
      title: '使用后皮肤泛红刺痛',
      status: 'RESOLVED',
      priority: 'P2',
      owner: '客服-赵晴',
      createdAt: at(-18, '15:40'),
      updatedAt: at(-18, '16:12'),
      result: '已按常规售后流程办理仅退款，未登记产品不适事件。',
      records: [
        { at: at(-18, '15:40'), actor: '客服-赵晴', note: '消费者反馈使用粉底液后脸部泛红、刺痛。' },
        { at: at(-18, '15:52'), actor: '客服-赵晴', note: '已为消费者提交仅退款申请。' },
        { at: at(-18, '16:12'), actor: '系统', note: '退款到账，工单关闭。' },
      ],
      incidentLogged: false,
    },
    // 陈亦然：三笔退款工单
    {
      id: 'TK_0925_021',
      consumerId: 'CUST_9134',
      orderId: 'ORDER_1201',
      type: 'refund',
      title: '申请退货退款',
      status: 'RESOLVED',
      priority: 'P2',
      owner: '客服-王敏',
      createdAt: at(-22, '09:50'),
      updatedAt: at(-22, '10:05'),
      result: '已退款 ¥129。',
      records: [{ at: at(-22, '10:05'), actor: '系统', note: '退款完成。' }],
    },
    {
      id: 'TK_1001_033',
      consumerId: 'CUST_9134',
      orderId: 'ORDER_1245',
      type: 'refund',
      title: '申请退货退款',
      status: 'RESOLVED',
      priority: 'P2',
      owner: '客服-王敏',
      createdAt: at(-9, '11:20'),
      updatedAt: at(-9, '11:40'),
      result: '已退款 ¥198。',
      records: [{ at: at(-9, '11:40'), actor: '系统', note: '退款完成。' }],
    },
    {
      id: 'TK_1004_041',
      consumerId: 'CUST_9134',
      orderId: 'ORDER_1290',
      type: 'refund',
      title: '申请退货退款（处理中）',
      status: 'PROCESSING',
      priority: 'P2',
      owner: '客服-王敏',
      createdAt: at(-2, '20:15'),
      updatedAt: at(-2, '20:20'),
      result: null,
      records: [
        { at: at(-2, '20:15'), actor: '客服-王敏', note: '消费者申请退款，已提交仓库验收。' },
        { at: at(-2, '20:20'), actor: '客服-王敏', note: '承诺 48 小时内完成退款。' },
      ],
    },
  ];

  const sessions = [
    // ── 林小满 · 历史：赠品补发（已兑现） ─────────────────────
    {
      id: 'S_0820_A',
      consumerId: 'CUST_8821',
      channel: 'app',
      agentName: '客服-李航',
      startedAt: at(-47, '13:58'),
      endedAt: at(-47, '14:14'),
      messages: [
        { id: 'm1', role: 'consumer', at: at(-47, '13:58'), text: '你好，我收到的套装里少了一个粉底刷。' },
        { id: 'm2', role: 'agent', at: at(-47, '14:02'), text: '非常抱歉给您带来困扰，我帮您核实一下。' },
        { id: 'm3', role: 'agent', at: at(-47, '14:05'), text: '确认是赠品漏发，我今天就给您安排补发一个粉底刷。' },
        { id: 'm4', role: 'consumer', at: at(-47, '14:07'), text: '好的，谢谢。' },
      ],
    },

    // ── 林小满 · 历史：售前色号咨询（已解决，纯 Explanation） ──
    {
      id: 'S_0918_B',
      consumerId: 'CUST_8821',
      channel: 'app',
      agentName: '客服-赵晴',
      startedAt: at(-18, '10:30'),
      endedAt: at(-18, '10:46'),
      messages: [
        { id: 'm1', role: 'consumer', at: at(-18, '10:30'), text: '我是干皮，想问下轻雾持妆粉底液适合我吗？' },
        { id: 'm2', role: 'agent', at: at(-18, '10:33'), text: '这款是干皮友好型，遮瑕力中等偏上，适合日常通勤。' },
        { id: 'm3', role: 'consumer', at: at(-18, '10:36'), text: '那大概多久能到？' },
        { id: 'm4', role: 'agent', at: at(-18, '10:38'), text: '物流正常的情况下需要 2-3 天送达，具体以快递实际派送为准。' },
      ],
    },

    // ── 林小满 · 昨天：发错色号，产生「明确承诺」 ─────────────
    {
      id: 'S_1005_C',
      consumerId: 'CUST_8821',
      channel: 'app',
      agentName: '客服-王敏',
      startedAt: at(-1, '20:00'),
      endedAt: at(-1, '20:20'),
      messages: [
        {
          id: 'm1',
          role: 'consumer',
          at: at(-1, '20:00'),
          text: '你好，我收到的粉底液色号不对，我买的是 02 暖调自然色，收到的却是 01 冷调象牙白。',
        },
        { id: 'm2', role: 'agent', at: at(-1, '20:04'), text: '非常抱歉，是我们的仓库拣货出现了失误。' },
        { id: 'm3', role: 'agent', at: at(-1, '20:05'), text: '我帮您提交补发申请。' },
        { id: 'm4', role: 'agent', at: at(-1, '20:12'), text: '明天中午 12 点前一定给您重新补发正确的颜色，并把物流单号发您。' },
        { id: 'm5', role: 'consumer', at: at(-1, '20:15'), text: '好的，那我等明天。' },
        { id: 'm6', role: 'agent', at: at(-1, '20:18'), text: '感谢您的理解，有任何问题随时联系我们。' },
      ],
    },

    // ── 林小满 · 今天：再次进线（当前会话） ───────────────────
    {
      id: 'S_1006_D',
      consumerId: 'CUST_8821',
      channel: 'app',
      agentName: '客服-（待接入）',
      startedAt: at(0, '14:13'),
      endedAt: null,
      isCurrent: true,
      messages: [
        {
          id: 'm1',
          role: 'consumer',
          at: at(0, '14:13'),
          text: '昨天不是说今天一定给我补发吗？怎么现在还没发？我明天生日，再收不到我就去小红书曝光你们了。',
        },
      ],
    },

    // ── 苏黎 · 历史：产品不适（走完退款，但未登记不适事件） ────
    {
      id: 'S_0918_E',
      consumerId: 'CUST_9077',
      channel: 'app',
      agentName: '客服-赵晴',
      startedAt: at(-18, '15:36'),
      endedAt: at(-18, '16:14'),
      messages: [
        { id: 'm1', role: 'consumer', at: at(-18, '15:36'), text: '我用了你们这个丝绒雾感粉底液，脸上又红又刺痛。' },
        { id: 'm2', role: 'agent', at: at(-18, '15:42'), text: '很抱歉给您带来不好的体验，我帮您提交退款申请。' },
        { id: 'm3', role: 'agent', at: at(-18, '15:45'), text: '预计 24 小时内处理完成。' },
        { id: 'm4', role: 'consumer', at: at(-18, '15:50'), text: '嗯，先退了吧。' },
        { id: 'm5', role: 'agent', at: at(-18, '16:12'), text: '已为您完成退款，到账时间以银行为准。' },
      ],
    },

    // ── 苏黎 · 今天：再次进线（当前会话） ─────────────────────
    {
      id: 'S_1006_F',
      consumerId: 'CUST_9077',
      channel: 'app',
      agentName: '客服-（待接入）',
      startedAt: at(0, '14:21'),
      endedAt: null,
      isCurrent: true,
      messages: [
        {
          id: 'm1',
          role: 'consumer',
          at: at(0, '14:21'),
          text: '上次买这个粉底用了之后脸很红，还很刺痛，你们现在又给我推荐这个？',
        },
      ],
    },

    // ── 陈亦然 · 历史多次进线 ────────────────────────────────
    {
      id: 'S_0925_G',
      consumerId: 'CUST_9134',
      channel: 'wechat',
      agentName: '客服-王敏',
      startedAt: at(-22, '09:44'),
      endedAt: at(-22, '10:08'),
      messages: [
        { id: 'm1', role: 'consumer', at: at(-22, '09:44'), text: '这个散粉我要退。' },
        { id: 'm2', role: 'agent', at: at(-22, '09:50'), text: '好的，我帮您提交退款申请。' },
      ],
    },
    {
      id: 'S_1001_H',
      consumerId: 'CUST_9134',
      channel: 'wechat',
      agentName: '客服-王敏',
      startedAt: at(-9, '11:16'),
      endedAt: at(-9, '11:45'),
      messages: [
        { id: 'm1', role: 'consumer', at: at(-9, '11:16'), text: '唇釉颜色和图片差太多，退款。' },
        { id: 'm2', role: 'agent', at: at(-9, '11:22'), text: '很抱歉，我帮您提交退款申请。' },
        { id: 'm3', role: 'agent', at: at(-9, '11:40'), text: '已为您完成退款。' },
      ],
    },
    {
      id: 'S_1004_I',
      consumerId: 'CUST_9134',
      channel: 'miniprogram',
      agentName: '客服-王敏',
      startedAt: at(-2, '20:10'),
      endedAt: at(-2, '20:25'),
      messages: [
        { id: 'm1', role: 'consumer', at: at(-2, '20:10'), text: '妆前乳不控油，我要退款。' },
        { id: 'm2', role: 'agent', at: at(-2, '20:14'), text: '好的，我帮您提交退款申请。' },
        { id: 'm3', role: 'agent', at: at(-2, '20:20'), text: '预计 48 小时内完成退款，请您耐心等待。' },
      ],
    },
    {
      id: 'S_1006_J',
      consumerId: 'CUST_9134',
      channel: 'miniprogram',
      agentName: '客服-（待接入）',
      startedAt: at(0, '13:55'),
      endedAt: null,
      isCurrent: true,
      messages: [
        {
          id: 'm1',
          role: 'consumer',
          at: at(0, '13:55'),
          text: '你们这个退款到底什么时候到账？都第二次问了，一直让我等。',
        },
      ],
    },

    // ── 周晓 · 常规咨询（对照组） ─────────────────────────────
    {
      id: 'S_1006_K',
      consumerId: 'CUST_9002',
      channel: 'app',
      agentName: '客服-（待接入）',
      startedAt: at(0, '13:40'),
      endedAt: null,
      isCurrent: true,
      messages: [
        {
          id: 'm1',
          role: 'consumer',
          at: at(0, '13:40'),
          text: '你好，我刚收到的柔光遮瑕膏，想问下干皮用之前需要先上妆前乳吗？',
        },
      ],
    },
  ];

  /**
   * 系统侧事件（非人工产生的动作）。
   * 苏黎这条推送是第二场景的关键：消费者是被「再次推荐同款产品」激怒的。
   */
  const systemEvents = [
    {
      id: 'SYS_1006_01',
      consumerId: 'CUST_9077',
      at: at(0, '13:48'),
      type: 'product_push',
      title: '智能推荐推送：丝绒雾感粉底液 升级版',
      detail: 'APP 首页个性化推荐位向她推送了「丝绒雾感粉底液 升级版」，基于其历史浏览与购买记录。',
      relatedOrder: 'ORDER_1103',
    },
    {
      id: 'SYS_1006_02',
      consumerId: 'CUST_8821',
      at: at(0, '12:30'),
      type: 'reship_check',
      title: '系统巡检：承诺时限已过，未发现补发订单',
      detail: '客服承诺的补发时限（今日 12:00）已到达，订单系统巡检仍未查询到该消费者名下的补发单。',
      relatedOrder: 'ORDER_1024',
    },
  ];

  return { consumers, orders, tickets, sessions, systemEvents };
}
