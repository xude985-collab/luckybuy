import { withTransaction, walletTx } from './helpers.js';

// 条件更新领取处理权；重复/并发回调只允许一次余额入账。
export async function settleRecharge(id, method, sessionId) {
  return withTransaction(async client => {
    const { rows } = await client.query(
      `UPDATE recharges SET status='paid',paid_at=$1
       WHERE id=$2 AND method=$3 AND stripe_session=$4 AND status='pending' RETURNING *`,
      [Date.now(), id, method, sessionId]);
    const rc = rows[0];
    if (!rc) return false;
    await walletTx(rc.user_id, 'recharge', Number(rc.amount), `${method} 充值 $${rc.amount}`, client);
    if (Number(rc.bonus) > 0) await walletTx(rc.user_id, 'grant', Number(rc.bonus), '充值赠送', client);
    return true;
  });
}
