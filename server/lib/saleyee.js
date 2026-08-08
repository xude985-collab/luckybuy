/*
 * 赛盈分销平台商品页抓取 + 解析。
 *
 * 赛盈商品页需要登录Cookie才能访问。
 * URL格式: https://www.saleyee.com/item/{SKU}.html?warehouseId={wid}
 *
 * 与 amazon.js 一样返回 draft 对象供管理员确认后入库。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export function extractSku(url) {
  const m = url.match(/\/item\/(\d+)\.html/i);
  return m ? m[1] : null;
}

function decodeEntities(s = '') {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .trim();
}

function stripTags(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseHtml(html, url, sku) {
  // 标题：取第一个 h1 或 h2（赛盈商品页中文标题）
  let title = '';
  const titleMatch = html.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i);
  if (titleMatch) {
    title = stripTags(titleMatch[1]);
  }
  // 去掉【同款编码：XXXX】前缀
  title = title.replace(/【同款编码[：:][^】]*】\s*/g, '').trim();
  // 如果没拿到标题，fallback用 og:title 或 title 标签
  if (!title) {
    const ogMatch = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    if (ogMatch) title = decodeEntities(ogMatch[1]);
  }
  if (!title) {
    const tMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (tMatch) title = decodeEntities(tMatch[1]).replace(/\s*[-–|].*$/, '');
  }

  // 图片：匹配赛盈CDN图片URL
  const gallery = new Set();
  const imgPatterns = [
    /img-accelerate\.saleyee\.cn\/upload\/product\/[^"'\s)]+/g,
    /resource\.saleyee\.com\/UploadFiles\/[^"'\s)]+/g,
    /img\.saleyee\.cn\/[^"'\s)]+/g,
  ];
  for (const pat of imgPatterns) {
    for (const m of html.matchAll(pat)) {
      let imgUrl = m[0];
      if (!imgUrl.startsWith('http')) imgUrl = 'https://' + imgUrl;
      // 跳过缩略图（thumb/small）
      if (/thumb|_s\.|_small/i.test(imgUrl)) continue;
      gallery.add(imgUrl);
      if (gallery.size >= 10) break;
    }
    if (gallery.size >= 10) break;
  }

  // SKU / SPU
  const skuMatch = html.match(/SKU[：:]\s*(\d+)/i);
  const spuMatch = html.match(/SPU[：:]\s*([A-Z0-9]+)/i);

  // 规格参数
  const specs = [];
  // 长宽高重量
  const dimPatterns = [
    [/长[（(]CM[)）][：:]\s*([\d.]+)/i, '长(cm)'],
    [/宽[（(]CM[)）][：:]\s*([\d.]+)/i, '宽(cm)'],
    [/高[（(]CM[)）][：:]\s*([\d.]+)/i, '高(cm)'],
    [/重量[（(]G[)）][：:]\s*([\d.]+)/i, '重量(g)'],
  ];
  for (const [re, label] of dimPatterns) {
    const dm = html.match(re);
    if (dm) specs.push({ k: label, v: dm[1] });
  }
  if (spuMatch) specs.push({ k: 'SPU', v: spuMatch[1] });
  if (skuMatch || sku) specs.push({ k: 'SKU', v: (skuMatch && skuMatch[1]) || sku });

  // 价格：尝试多种匹配（赛盈价格可能在data属性或JS变量里）
  let price = 0;
  const pricePatterns = [
    /代发价[^<]*?[¥$￥]\s*([\d,]+\.?\d*)/i,
    /"price"\s*[：:]\s*"?([\d.]+)/i,
    /data-price="([\d.]+)"/i,
    /salePrice[：="]\s*([\d.]+)/i,
  ];
  for (const re of pricePatterns) {
    const pm = html.match(re);
    if (pm) { price = parseFloat(pm[1].replace(/,/g, '')); break; }
  }

  // 描述：取英文标题作为补充描述
  let desc = '';
  const h3Match = html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
  if (h3Match) {
    const enTitle = stripTags(h3Match[1]).replace(/【[^】]*】\s*/g, '');
    if (enTitle && enTitle !== title) desc = enTitle;
  }

  return {
    name: title || `赛盈商品 ${sku || ''}`.trim(),
    emoji: '📦',
    sourceUrl: url,
    sku: sku || (skuMatch && skuMatch[1]) || '',
    refPrice: price,
    gallery: [...gallery].map(u => ({ type: 'image', url: u })),
    specs,
    desc,
    bullets: desc ? [desc] : [],
  };
}

export async function fetchSaleyee(url, cookie) {
  if (!cookie) throw new Error('未配置赛盈Cookie，请在系统设置中粘贴登录Cookie');

  const sku = extractSku(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Cookie': cookie,
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();

    // 检测是否被重定向到登录页
    if (/login|登录|sign.?in/i.test(html) && !/item|商品|product/i.test(html.slice(0, 2000)))
      throw new Error('赛盈登录已过期，请更新Cookie');

    const draft = parseHtml(html, url, sku);
    if (!draft.name || (draft.gallery.length === 0 && !draft.refPrice))
      throw new Error('页面解析失败，可能Cookie已过期或页面结构变更');
    return draft;
  } finally {
    clearTimeout(timer);
  }
}
