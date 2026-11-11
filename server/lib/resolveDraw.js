import pool from '../db.js';
import {getRound,computeWinner,roundTime} from './drand.js';
import {withTransaction} from './helpers.js';
export async function resolveDraw(productId) {
  const initial=(await pool.query('SELECT * FROM draws WHERE product_id=$1',[productId])).rows[0];
  if(!initial || initial.drawn_at || Date.now()<roundTime(initial.round))return initial||null;
  const beacon=await getRound(initial.round);
  if(!beacon)return initial;
  return withTransaction(async c=>{
    await c.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[productId]);
    const draw=(await c.query('SELECT * FROM draws WHERE product_id=$1 FOR UPDATE',[productId])).rows[0];
    if(!draw || draw.drawn_at || draw.round!==initial.round)return draw||null;
    const number=computeWinner(beacon.randomness,productId,draw.total_shares);
    const {rows}=await c.query('SELECT user_id,numbers,shares FROM orders WHERE product_id=$1',[productId]);
    const winners=rows.filter(o=>{try{return JSON.parse(o.numbers).includes(number)}catch{return false}});
    if(winners.length!==1 || rows.reduce((n,o)=>n+Number(o.shares),0)!==draw.total_shares)throw new Error('开奖订单不完整，已停止结算，需管理员核对');
    const result=await c.query(`UPDATE draws SET randomness=$1,signature=$2,win_number=$3,winner_user_id=$4,drawn_at=$5 WHERE product_id=$6 RETURNING *`,
      [beacon.randomness,beacon.signature,number,winners[0].user_id,Date.now(),productId]);
    await c.query("UPDATE products SET status='done' WHERE id=$1",[productId]);
    return result.rows[0];
  });
}
