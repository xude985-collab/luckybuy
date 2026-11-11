import pool from '../db.js';
import {settleRecharge} from './recharges.js';
import {getOrder,captureOrder} from './paypal.js';
import logger from './logger.js';
export async function reconcilePayment(rc) {
  if(!rc || rc.status!=='pending' || !rc.stripe_session)return false;
  if(rc.method==='paypal'){
    let order=await getOrder(rc.stripe_session);
    if(order?.status==='APPROVED')order=await captureOrder(rc.stripe_session);
    const units=order?.purchase_units||[],captures=units.flatMap(u=>u.payments?.captures||[]);
    if(order?.status!=='COMPLETED')return false;
    if(order.id!==rc.stripe_session || units.length!==1 || units[0].reference_id!==rc.id || captures.length!==1 || captures[0].status!=='COMPLETED' || captures[0].amount?.currency_code!=='USD' || Number(captures[0].amount.value)!==Number(rc.amount))throw new Error('PayPal payment verification failed');
  } else if(rc.method==='stripe'){
    if(!process.env.STRIPE_SECRET_KEY)return false;
    const response=await fetch('https://api.stripe.com/v1/checkout/sessions/'+encodeURIComponent(rc.stripe_session),{headers:{Authorization:`Bearer ${process.env.STRIPE_SECRET_KEY}`},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('Stripe status lookup failed');
    const session=await response.json();
    if(session.payment_status!=='paid')return false;
    if(session.id!==rc.stripe_session || session.metadata?.rechargeId!==rc.id || session.metadata?.userId!==rc.user_id || session.currency!=='usd' || session.amount_total!==Number(rc.amount)*100)throw new Error('Stripe payment verification failed');
  } else return false;
  return settleRecharge(rc.id,rc.method,rc.stripe_session);
}
export function startPaymentWorker(){
 let running=false;
 async function tick(){if(running)return;running=true;try{
   const {rows}=await pool.query("SELECT * FROM recharges WHERE status='pending' AND stripe_session IS NOT NULL AND created_at>$1 ORDER BY COALESCE(last_checked_at,0),created_at LIMIT 20",[Date.now()-30*86400000]);
   for(const rc of rows){try{await pool.query('UPDATE recharges SET last_checked_at=$1 WHERE id=$2',[Date.now(),rc.id]);await reconcilePayment(rc)}catch(e){logger.warn({rechargeId:rc.id,error:e.message},'支付对账待重试')}}
 }catch(e){logger.error({err:e},'支付对账失败')}finally{running=false}}
 const timer=setInterval(tick,60000);timer.unref();
}
