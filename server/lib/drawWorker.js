import pool from '../db.js';
import { getRound, computeWinner, roundTime } from './drand.js';
import { withTransaction } from './helpers.js';

const POLL_MS = 15_000;
let isPolling = false; // 轮询锁，防止重叠执行

async function resolvePendingDraws() {
  if (isPolling) {
    console.log('[draw] 上次轮询尚未完成，跳过本次');
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
            console.log(`[draw] ${d.product_id} 揭晓完成 → 幸运号 ${winNumber}，得主 ${winner?.user_id || '无'}`);
          }
        });
      } catch (e) {
        console.error(`[draw] ${d.product_id} 揭晓异常:`, e.message);
      }
    }
  } finally {
    isPolling = false;
  }
}

export function startDrawWorker() {
  console.log('[draw] 揭晓 worker 已启动（每 15 秒轮询）');
  resolvePendingDraws().catch(e => console.error('[draw] 初始轮询失败:', e.message));
  setInterval(
    () => resolvePendingDraws().catch(e => console.error('[draw] 轮询失败:', e.message)),
    POLL_MS
  );
}
