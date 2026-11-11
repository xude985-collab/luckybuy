import {genId, withTransaction, walletTx} from './helpers.js';
export const bad = (message, status=400) => Object.assign(new Error(message), {status});
export function integer(value, name, min=0, max=2147483647) {
  if (typeof value === 'boolean' || value === null || value === '' || !Number.isSafeInteger(Number(value)) || Number(value)<min || Number(value)>max) throw bad(`${name}必须为${min}~${max}的整数`);
  return Number(value);
}
export async function audit(client, actor, action, target, detail) {
  await client.query('INSERT INTO admin_audit (id,actor_id,action,target_id,detail,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [genId('a_'),actor,action,target,JSON.stringify(detail),Date.now()]);
}
// Reset only unfulfilled rounds; keep the complete old rows in the audit record and record refunds.
export async function resetSales(actor, productId, confirmation, reason) {
  if(confirmation!=='RESET' || typeof reason!=='string' || reason.trim().length<3) throw bad('请输入RESET并填写至少3字的重置原因');
  return withTransaction(async client=>{
    const {rows:products}=await client.query(`SELECT * FROM products ${productId?'WHERE id=$1':''} ORDER BY id FOR UPDATE`,productId?[productId]:[]);
    if(productId&&!products.length) throw bad('商品不存在',404);
    const ids=products.map(p=>p.id);
    const {rows:draws}=await client.query('SELECT * FROM draws WHERE product_id=ANY($1) FOR UPDATE',[ids]);
    if(draws.some(d=>d.drawn_at)) throw bad('已开奖商品不能重置，请保留中奖和履约记录');
    const {rows:orders}=await client.query('SELECT * FROM orders WHERE product_id=ANY($1) ORDER BY user_id,id',[ids]);
    const userIds=[...new Set(orders.map(o=>o.user_id))].sort();
    const {rows:users}=await client.query('SELECT id FROM users WHERE id=ANY($1) ORDER BY id FOR UPDATE',[userIds]);
    if(users.length!==userIds.length) throw bad('订单关联用户缺失，需先核对历史数据');
    await audit(client,actor,'reset-sales',productId||'*',{reason,products,draws,orders});
    for(const o of orders){
      if(Number(o.free_coins)>0)await walletTx(o.user_id,'grant',Number(o.free_coins),`重置退款 免费金币 订单:${o.id}`,client);
      if(Number(o.paid_coins)>0)await walletTx(o.user_id,'refund',Number(o.paid_coins),`重置退款 订单:${o.id}`,client);
    }
    await client.query("UPDATE purchase_receipts SET response=response || '{\"cancelled\":true}'::jsonb WHERE product_id=ANY($1)",[ids]);
    await client.query('DELETE FROM orders WHERE product_id=ANY($1)',[ids]);
    await client.query('DELETE FROM draws WHERE product_id=ANY($1)',[ids]);
    await client.query("UPDATE products SET free_used=0,status='active' WHERE id=ANY($1)",[ids]);
    return orders.length;
  });
}
