/*
 * 服务端可审计开奖随机源：drand 公共随机信标（League of Entropy, quicknet 链）。
 *
 * 为什么可信：每个轮次(round)的 randomness 带 BLS 签名，由分布式网络产生，
 * 任何人事后都能用链公钥独立验证；我们“卖满即锁定一个尚未产生的未来轮次”，
 * 那一刻连平台自己都无法预知结果 → 不可操纵。
 *
 * 开奖公式（与前端 js/rng.js 完全一致，任何人可复算）：
 *   winNumber = ( int(HMAC-SHA256(key=randomness, msg=period)) mod totalShares ) + 1
 */
import crypto from 'crypto';

const GATEWAYS = [
  'https://api.drand.sh',
  'https://drand.cloudflare.com',
  'https://api2.drand.sh',
];
const CHAIN_HASH = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
const GENESIS = 1692803367; // quicknet 创世（秒）
const PERIOD = 3;           // 出块间隔（秒）

async function fetchJSON(path) {
  let lastErr;
  for (const g of GATEWAYS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(`${g}/${CHAIN_HASH}/public/${path}`, {
        cache: 'no-store', signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (r.ok) return await r.json();
      lastErr = new Error('HTTP ' + r.status);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all drand gateways failed');
}

export function currentRound(nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  return Math.max(1, Math.floor((now - GENESIS) / PERIOD) + 1);
}

// 锁定一个未来轮次：leadSeconds 后那轮当前尚未产生 → 结果不可预测
export function futureRound(nowMs = Date.now(), leadSeconds = 30) {
  return currentRound(nowMs) + Math.ceil(leadSeconds / PERIOD);
}

// 该轮预计产生的时间（毫秒）
export function roundTime(round) {
  return (GENESIS + (round - 1) * PERIOD) * 1000;
}

// 取指定轮次；未产生返回 null（HTTP 404）
export async function getRound(round) {
  try {
    const d = await fetchJSON(String(round));
    return { round: d.round, randomness: d.randomness, signature: d.signature };
  } catch (e) {
    if (/HTTP 404/.test(e.message)) return null;
    throw e;
  }
}

// 由 randomness 计算中奖号（period 用 productId 绑定，防同轮多商品同号）
export function computeWinner(randomnessHex, period, totalShares) {
  const key = Buffer.from(randomnessHex, 'hex');
  const mac = crypto.createHmac('sha256', key).update(String(period)).digest();
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(mac[i]);
  return Number(n % BigInt(totalShares)) + 1;
}
