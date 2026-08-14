import pool from '../db.js';
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
        const rd = await getRound(d.round);
        if (!rd) continue;

        const winNumber = computeWinner(rd.randomness, d.product_id, d.total_shares);

        const { rows: orders } = await pool.query(
          `SELECT user_id, numbers FROM orders WHERE product_id=$1`, [d.product_id]
        );
        const winner = orders.find(o => {
          try { return JSON.parse(o.numbers).includes(winNumber); } catch { return false; }
        });

        await withTransaction(async (client) => {
          const { rows: updated } = await client.query(
            `UPDATE draws SET randomness=$1,signature=$2,win_number=$3,winner_user_id=$4,drawn_at=$5
             WHERE product_id=$6 AND drawn_at IS NULL RETURNING product_id`,
            [rd.randomness, rd.signature, winNumber, winner?.user_id || null, Date.now(), d.product_id]
          );
          if (updated.length) {
            await client.query(`UPDATE products SET status='done' WHERE id=$1`, [d.product_id]);
            logger.info({
              productId: d.product_id,
              winNumber,
              winnerId: winner?.user_id || null,
            }, '商品揭晓完成');
          }
        });
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
