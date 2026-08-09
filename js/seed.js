/* 种子商品数据（演示用，货币单位：美元 $）。接后端后可删除。 */
window.SEED_PRODUCTS = [
  {
    id: 'p1', sku: '3C-00001', category: 'digital', name: 'iPhone 16 Pro 256G', period: '第 001 期',
    price: 1, totalShares: 999, soldShares: 620, freeQuota: 20,
    img: '📱', status: 'ongoing',
    desc: '全新国行，暗紫色，256G 存储。幸运中选后填写地址包邮到家。',
  },
  {
    id: 'p2', sku: 'AP-00001', category: 'appliance', name: '戴森吹风机 HD15', period: '第 001 期',
    price: 1, totalShares: 299, soldShares: 287, freeQuota: 15,
    img: '💨', status: 'ongoing',
    desc: '新一代智能温控，负离子护发。$1 一份。',
  },
  {
    id: 'p3', sku: '3C-00002', category: 'digital', name: 'Switch OLED 白色', period: '第 001 期',
    price: 5, totalShares: 229, soldShares: 90, freeQuota: 10,
    img: '🎮', status: 'ongoing',
    desc: '任天堂 Switch OLED 主机，附赠健身环。$5 一份。',
  },
  {
    id: 'p4', sku: '3C-00003', category: 'digital', name: '大疆 Osmo Pocket 3', period: '第 001 期',
    price: 2, totalShares: 199, soldShares: 199, freeQuota: 10,
    img: '🎥', status: 'revealed', winNumber: 128,
    winnerName: '幸运用户 J***n', winnerUserId: 'u_demo', winnerOrderId: null,
    revealTime: '2026-07-20T10:30:00.000Z',
    showcase: { type: 'emoji', media: '📸🎥', caption: 'J***n 用 $2 夺得 Osmo Pocket 3，已收货！' },
    desc: '一英寸口袋云台相机，套装版。$2 一份。',
  },
  {
    id: 'p5', sku: 'FD-00001', category: 'food', name: '星巴克 $100 电子券', period: '第 002 期',
    price: 1, totalShares: 99, soldShares: 30, freeQuota: 20,
    img: '☕', status: 'ongoing',
    desc: '小额尝鲜款，快速揭晓，人人有机会。',
  },
  {
    id: 'p6', sku: '3C-00004', category: 'digital', name: 'AirPods Pro 2', period: '第 001 期',
    price: 10, totalShares: 39, soldShares: 25, freeQuota: 5,
    img: '🎧', status: 'ongoing',
    desc: '主动降噪，USB-C 充电盒。$10 一份，份数少更快揭晓。',
  },
];
