/* 验证码发送。优先级：Resend HTTP API > SMTP > 打印日志（开发用）。
 * Resend 走 HTTPS，国内也能连通，送达率高，推荐用于欧美市场。
 * 手机短信通道以后接 Twilio 时在此扩展 sendSms。 */
import 'dotenv/config';

const MAIL_FROM = process.env.MAIL_FROM || 'Lucky Buy <onboarding@resend.dev>';
const SUBJECT = 'Lucky Buy Verification Code';
const buildText = (code) => `Your verification code is ${code}. It expires in 10 minutes.`;
const buildHtml = (code) => `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="color:#c0392b;margin:0 0 12px">Lucky Buy</h2>
  <p style="font-size:15px;color:#333">Your verification code is:</p>
  <p style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#c0392b;margin:16px 0">${code}</p>
  <p style="font-size:13px;color:#888">This code expires in 10 minutes. If you didn't request it, please ignore this email.</p>
</div>`;

/* ---- 通道 1：Resend HTTP API ---- */
async function sendViaResend(to, code) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null; // 未配置，交给下一通道
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [to],
      subject: SUBJECT,
      text: buildText(code),
      html: buildHtml(code),
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Resend ${resp.status}: ${data.message || JSON.stringify(data)}`);
  }
  return { delivered: true, id: data.id };
}

/* ---- 通道 2：SMTP（回退） ---- */
let transporter = null;
async function getTransporter() {
  if (transporter !== null) return transporter;
  if (!process.env.SMTP_HOST) { transporter = false; return false; }
  const nodemailer = await import('nodemailer').catch(() => null);
  if (!nodemailer) {
    console.warn('[mailer] 未安装 nodemailer，SMTP 通道不可用');
    transporter = false; return false;
  }
  transporter = nodemailer.default.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  return transporter;
}

async function sendViaSmtp(to, code) {
  const t = await getTransporter();
  if (!t) return null; // 未配置，交给下一通道
  await t.sendMail({
    from: MAIL_FROM,
    to,
    subject: SUBJECT,
    text: buildText(code),
    html: buildHtml(code),
  });
  return { delivered: true };
}

export async function sendCode(account, type, code) {
  if (type === 'email') {
    // 依次尝试 Resend → SMTP，任一成功即返回；失败则降级到日志
    for (const [name, fn] of [['Resend', sendViaResend], ['SMTP', sendViaSmtp]]) {
      try {
        const r = await fn(account, code);
        if (r) return r; // 该通道已配置且发送成功
      } catch (e) {
        console.warn(`[mailer] ${name} 发送失败：${e.message}`);
        // 继续尝试下一通道
      }
    }
  }
  // 所有真实通道都没配置或都失败：打印日志，方便开发自测
  console.log(`\n  [验证码] ${account} (${type}) => ${code}\n`);
  return { delivered: false };
}
