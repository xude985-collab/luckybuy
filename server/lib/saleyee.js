/*
 * 赛盈分销平台商品页解析。
 *
 * 赛盈需要登录，无法直接服务端抓取。
 * 改为：用户在浏览器Console中复制页面HTML，粘贴到后台解析。
 * URL格式: https://www.saleyee.com/item/{SKU}.html?warehouseId={wid}
 */

export function extractSku(url) {
  const m = url.match(/\/item\/(\d+)\.html/i);
  return m ? m[1] : null;
}

function stripTags(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s = '') {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .trim();
}

export function parseSaleyeeHtml(html, url) {
  const sku = extractSku(url || '') || '';

  // 标题：h1 或 h2
  let title = '';
  const titleMatch = html.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i);
  if (titleMatch) title = stripTags(titleMatch[1]);
  title = title.replace(/【同款编码[：:][^】]*】\s*/g, '').trim();
  if (!title) {
    const ogMatch = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    if (ogMatch) title = decodeEntities(ogMatch[1]);
  }
  if (!title) {
    const tMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (tMatch) title = decodeEntities(tMatch[1]).replace(/\s*[-–|].*$/, '');
  }

  // 图片
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

  // 价格（DOM渲染后的内容可能包含价格）
  let price = 0;
  const pricePatterns = [
    /USD\s*([\d,]+\.?\d*)/i,
    /代发价[^<]*?[¥$￥]\s*([\d,]+\.?\d*)/i,
    /"price"\s*[：:]\s*"?([\d.]+)/i,
    /data-price="([\d.]+)"/i,
    /salePrice[：="]\s*([\d.]+)/i,
    /class="[^"]*price[^"]*"[^>]*>\s*\$?\s*([\d,.]+)/i,
  ];
  for (const re of pricePatterns) {
    const pm = html.match(re);
    if (pm) { price = parseFloat(pm[1].replace(/,/g, '')); break; }
  }

  // 描述
  let desc = '';
  const h3Match = html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
  if (h3Match) {
    const enTitle = stripTags(h3Match[1]).replace(/【[^】]*】\s*/g, '');
    if (enTitle && enTitle !== title) desc = enTitle;
  }

  return {
    name: title || `赛盈商品 ${sku}`.trim(),
    emoji: '📦',
    sourceUrl: url || '',
    sku: sku || (skuMatch && skuMatch[1]) || '',
    refPrice: price,
    gallery: [...gallery].map(u => ({ type: 'image', url: u })),
    specs,
    desc,
    bullets: desc ? [desc] : [],
  };
}
