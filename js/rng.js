/* 可审计开奖随机源：drand 公共随机信标（League of Entropy）
 *
 * 为什么用 drand：
 *   - 无需注册 / 无 API key，全网公开
 *   - 每个轮次(round)输出带 BLS 签名，任何人可用公钥验证
 *   - 锁定“未来轮次”做种子 → 开奖前谁都无法预知结果，开奖后人人可复现
 *
 * 生产环境：本文件逻辑应整体放到服务端，前端只展示凭据(round/randomness/signature)。
 * 演示环境：前端直接调用 drand 公共 HTTP 端点。
 */
(function (global) {
  'use strict';

  // drand 默认链（quicknet，3 秒一轮）。多网关容灾。
  const GATEWAYS = [
    'https://api.drand.sh',
    'https://drand.cloudflare.com',
    'https://api2.drand.sh',
  ];
  const CHAIN_HASH = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
  const GENESIS = 1692803367; // quicknet 创世时间(秒)
  const PERIOD = 3;           // 出块间隔(秒)

  async function fetchJSON(path) {
    let lastErr;
    for (const g of GATEWAYS) {
      try {
        const r = await fetch(`${g}/${CHAIN_HASH}/public/${path}`, { cache: 'no-store' });
        if (r.ok) return await r.json();
        lastErr = new Error('HTTP ' + r.status);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('all drand gateways failed');
  }

  // 当前最新轮次号（估算：无需请求，用创世时间推算，避免多一次往返）
  function currentRound(nowMs) {
    const now = Math.floor(nowMs / 1000);
    return Math.max(1, Math.floor((now - GENESIS) / PERIOD) + 1);
  }

  // 锁定一个“未来轮次”作为开奖种子。leadSeconds 后那一轮尚未产生 → 不可预测。
  function futureRound(nowMs, leadSeconds) {
    return currentRound(nowMs) + Math.ceil((leadSeconds || 30) / PERIOD);
  }

  // 取指定轮次的随机数（未产生则 404，调用方需轮询等待）
  async function getRound(round) {
    const d = await fetchJSON(String(round));
    // d = { round, randomness(hex), signature(hex), previous_signature? }
    return d;
  }

  async function getLatest() { return fetchJSON('latest'); }

  /* 开奖公式（可复现）：
   *   winNumber = ( int(HMAC-SHA256(key=randomness, msg=period)) mod totalShares ) + 1
   * 任何人拿到 randomness + period + totalShares 即可重算，结果唯一确定。
   */
  function hexToBytes(hex) {
    const a = new Uint8Array(hex.length / 2);
    for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
    return a;
  }

  async function computeWinner(randomnessHex, period, totalShares) {
    const key = await crypto.subtle.importKey(
      'raw', hexToBytes(randomnessHex),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(period)));
    const bytes = new Uint8Array(mac);
    // 取前 8 字节转 BigInt，避免 Number 精度问题
    let n = 0n;
    for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(bytes[i]);
    return Number(n % BigInt(totalShares)) + 1;
  }

  global.RNG = {
    currentRound, futureRound, getRound, getLatest, computeWinner,
    CHAIN_HASH, GENESIS, PERIOD,
  };
})(window);

