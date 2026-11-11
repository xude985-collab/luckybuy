import pool from '../db.js';
import {resolveDraw} from './resolveDraw.js';
import { getRound, computeWinner, roundTime } from './drand.js';
import { withTransaction } from './helpers.js';
import logger from './logger.js';

const POLL_MS = 15_000;
let isPolling = false; // 轮询锁，防止重叠执行

async function resolvePendingDraws() {
  if (isPolling) {
    logger.debug('上次轮询尚未完成，跳过本次');
    return;
  }

  isPolling = true;
  try {
    const { rows: pending } = await pool.query(
      `SELECT d.product_id, d.round, d.total_shares
       FROM draws d
       WHERE d.drawn_at IS NULL`
    );
    if (!pending.length) return;

    for (const d of pending) {
      if (Date.now() < roundTime(d.round)) continue;

      try {
        await resolveDraw(d.product_id);
      } catch (e) {
        logger.error({ err: e, productId: d.product_id }, '商品揭晓异常');
      }
    }
  } finally {
    isPolling = false;
  }
}

export function startDrawWorker() {
  logger.info({ pollInterval: POLL_MS }, '揭晓 worker 已启动');
  resolvePendingDraws().catch(e => logger.error({ err: e }, '初始轮询失败'));
  setInterval(
    () => resolvePendingDraws().catch(e => logger.error({ err: e }, '轮询失败')),
    POLL_MS
  );
}
