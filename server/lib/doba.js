/*
 * Doba.com 商品页解析。
 *
 * Doba 是 Next.js 应用，商品页数据在 __NEXT_DATA__ script 标签内。
 * 先直接请求，如果被 WAF 拦截则通过 Jina Reader 代理获取。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function stripTags(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseDobaUrl(url) {
  const m = url.match(/doba\.com\/product\/([^/]+)\/([^/.]+)/i);
  if (!m) return null;
  return { skuId: m[1], slug: m[2] };
}

async function fetchHtml(url, cookie) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (cookie) headers['Cookie'] = cookie;
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

async function fetchViaJina(url) {
  const resp = await fetch(`https://r.jina.ai/${url}`, {
    headers: {
      'Accept': 'text/html',
      'X-Return-Format': 'html',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`Jina HTTP ${resp.status}`);
  return resp.text();
}

function parseNextData(html) {
  const m = html.match(/__NEXT_DATA__[^>]*>([\s\S]*?)<\/script/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export async function fetchDoba(url) {
  const parsed = parseDobaUrl(url);
  if (!parsed) throw new Error('无效的 Doba 商品链接');

  // 从数据库读取 Doba Cookie
  const { default: pool } = await import('../db.js');
  const { rows } = await pool.query(`SELECT v FROM config WHERE k='doba_cookie'`);
  const cookie = rows[0]?.v || '';

  let html;
  let data;

  try {
    html = await fetchHtml(url, cookie);
    data = parseNextData(html);
  } catch { /* 直接请求失败，尝试 Jina */ }

  if (!data) {
    try {
      html = await fetchViaJina(url);
      data = parseNextData(html);
    } catch { /* Jina 也失败 */ }
  }

  if (!data) throw new Error('Doba 页面获取失败，请稍后重试');

  const pp = data.props?.pageProps;
  if (!pp) throw new Error('Doba 数据结构异常');

  const pd = pp.productDetail;
  if (!pd || pd.errorPage) throw new Error('Doba Cookie 未设置或已过期，请在后台系统设置中更新 Doba Cookie');

  return buildDraft(pd, url);
}

function buildDraft(pd, url) {
  const name = pd.goodsName || pd.title || pd.name || '';

  const gallery = (pd.goodsImg || pd.imgList || pd.images || [])
    .map(img => {
      const u = typeof img === 'string' ? img : (img.imgBigUrl || img.imgUrl || img.url || '');
      return u ? { type: 'image', url: u.startsWith('//') ? 'https:' + u : u } : null;
    })
    .filter(Boolean)
    .slice(0, 15);

  const specs = [];
  const size = pd.goodsSize || {};
  if (size.length) specs.push({ k: `长(${size.dimUnit || 'in.'})`, v: size.length });
  if (size.width) specs.push({ k: `宽(${size.dimUnit || 'in.'})`, v: size.width });
  if (size.height) specs.push({ k: `高(${size.dimUnit || 'in.'})`, v: size.height });
  if (size.weight) specs.push({ k: `重量(${size.weightUnit || 'lbs'})`, v: size.weight });
  if (pd.categoryName) specs.push({ k: '分类', v: pd.categoryName });
  if (pd.deliveryTime) specs.push({ k: '发货时间(天)', v: pd.deliveryTime });
  if (pd.selectedSku?.itemNo) specs.push({ k: 'ItemNo', v: pd.selectedSku.itemNo });
  if (pd.selectedSku?.selfPickUpLocation) specs.push({ k: '发货地', v: pd.selectedSku.selfPickUpLocation });

  const bullets = [];
  if (Array.isArray(pd.highlights)) bullets.push(...pd.highlights.filter(Boolean));
  const detailText = stripTags(pd.productDetail || '').slice(0, 1500);
  if (detailText) bullets.push(detailText);

  let refPrice = 0;
  if (pd.salePrice) {
    refPrice = parseFloat(pd.salePrice);
  } else if (pd.promotionPrice) {
    refPrice = parseFloat(pd.promotionPrice);
  } else if (pd.selectedSku?.salePrice) {
    refPrice = parseFloat(pd.selectedSku.salePrice);
  } else if (pd.selectedSku?.price) {
    refPrice = parseFloat(pd.selectedSku.price);
  }
  if (!refPrice) {
    const profitDiff = parseFloat(pd.maxPriceProfitDiff) || 0;
    const profitRate = parseFloat(pd.maxPriceProfitDiffRate) || 0;
    if (profitDiff > 0 && profitRate > 0) {
      refPrice = Math.round((profitDiff / (profitRate / 100)) * 100) / 100;
    }
  }
  if (!refPrice && pd.price) {
    refPrice = parseFloat(pd.price);
  }

  return {
    name,
    emoji: '📦',
    sourceUrl: url,
    sku: pd.selectedSku?.itemNo || '',
    refPrice,
    gallery,
    specs,
    desc: bullets.join('\n\n'),
    bullets,
    priceNote: refPrice > 0
      ? `参考价 $${refPrice}`
      : '价格需登录 Doba 查看，请手动填写',
  };
}
