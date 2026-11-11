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
import {fetchBeacon} from 'drand-client';

const GATEWAYS = [
  'https://api.drand.sh',
  'https://drand.cloudflare.com',
  'https://api2.drand.sh',
];
export const CHAIN_HASH = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
const GENESIS = 1692803367; // quicknet 创世（秒）
const PERIOD = 3;           // 出块间隔（秒）

export const CHAIN_INFO = {
 hash:CHAIN_HASH, public_key:'83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
 period:PERIOD,genesis_time:GENESIS,schemeID:'bls-unchained-g1-rfc9380'
};
export async function verifyBeaconData(data,round){
 if(!Number.isSafeInteger(round)||round<1)throw new Error('无效随机轮次');
 return fetchBeacon({options:{disableBeaconVerification:false},chain:()=>({info:async()=>CHAIN_INFO}),get:async()=>data},round);
}
async function fetchJSON(round) {
 let lastErr;
 for(const gateway of GATEWAYS){
  try {
   const r=await fetch(`${gateway}/${CHAIN_HASH}/public/${round}`,{cache:'no-store',signal:AbortSignal.timeout(8000)});
   if(!r.ok)throw new Error('HTTP '+r.status);
   return await verifyBeaconData(await r.json(),round);
  }catch(e){lastErr=e}
 }
 throw lastErr||new Error('随机源暂不可用');
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
    const d = await fetchJSON(Number(round));
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
