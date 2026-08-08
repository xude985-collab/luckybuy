/*
 * 赛盈分销平台商品页解析。
 *
 * 赛盈商品页静态HTML中包含完整JSON数据（hideDefaultSkuData），
 * 描述通过公开API /Product/GetProductDescription?pid={id} 获取。
 * 两者均不需要登录，可以直接服务端抓取，和亚马逊一样只需粘贴链接。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export function extractSku(url) {
  const m = url.match(/\/item\/(\d+)\.html/i);
  return m ? m[1] : null;
}

function stripTags(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function fetchSaleyee(url) {
  const sku = extractSku(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();

    // 从 hideDefaultSkuData 提取结构化 JSON
    const jsonMatch = html.match(/class="hideDefaultSkuData"[^>]*>([\s\S]*?)<\/div>/i);
    if (!jsonMatch) throw new Error('页面结构异常，未找到商品数据');

    const decoded = jsonMatch[1]
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
    const data = JSON.parse(decoded);

    // 获取商品描述（公开API，不需要登录）
    let description = '';
    if (data.Id) {
      try {
        const descResp = await fetch(
          `https://www.saleyee.com/Product/GetProductDescription?pid=${data.Id}`,
          { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) }
        );
        if (descResp.ok) {
          const descHtml = await descResp.text();
          description = stripTags(descHtml).slice(0, 2000);
        }
      } catch (e) { /* 描述获取失败不影响整体 */ }
    }

    return buildDraft(data, url, sku, description);
  } finally {
    clearTimeout(timer);
  }
}

function buildDraft(data, url, sku, description) {
  // 标题
  let name = data.ProductName || '';
  name = name.replace(/【同款编码[：:][^】]*】\s*/g, '').trim();
  const nameEn = (data.ProductNameUS || '').replace(/【[^】]*】\s*/g, '').trim();

  // 价格：从物流产品列表中取
  let price = 0;
  let originalPrice = 0;
  const regions = data.ProductDetailRegionLogisticsProductList || [];
  for (const region of regions) {
    const logistics = region.ProductDetailLogisticsProductList || [];
    for (const lp of logistics) {
      if (lp.DiscountPrice_d && lp.DiscountPrice_d > 0) {
        price = lp.DiscountPrice_d;
        originalPrice = lp.Price_d || 0;
        break;
      }
      if (lp.Price_d && lp.Price_d > 0 && !price) {
        price = lp.Price_d;
      }
    }
    if (price) break;
  }
  // fallback: 如果没折扣价，用原价
  if (!price && originalPrice) price = originalPrice;

  // 图片：从 PictureModels 取原始大图
  const gallery = (data.PictureModels || [])
    .map(p => p.OriginalImageUrl || p.FullSizeImageUrl || p.ImageUrl)
    .filter(Boolean)
    .slice(0, 15)
    .map(u => ({ type: 'image', url: u }));

  // 规格
  const specs = [];
  const spec = data.Spec || {};
  if (spec.SpecLength) specs.push({ k: '长(cm)', v: String(spec.SpecLength) });
  if (spec.SpecWidth) specs.push({ k: '宽(cm)', v: String(spec.SpecWidth) });
  if (spec.SpecHeight) specs.push({ k: '高(cm)', v: String(spec.SpecHeight) });
  if (spec.SpecWeight) specs.push({ k: '重量(g)', v: String(spec.SpecWeight) });
  if (data.SPU) specs.push({ k: 'SPU', v: data.SPU });
  specs.push({ k: 'SKU', v: data.Sku || sku || '' });

  // 库存
  const stockQty = regions.reduce((sum, r) => sum + (r.StockQty || 0), 0);
  if (stockQty) specs.push({ k: '库存', v: String(stockQty) });

  // 描述：合并英文名 + 详情
  const bullets = [];
  if (nameEn) bullets.push(nameEn);
  if (description) bullets.push(description);

  return {
    name: name || `赛盈商品 ${sku || ''}`.trim(),
    emoji: '📦',
    sourceUrl: url,
    sku: data.Sku || sku || '',
    refPrice: price,
    originalPrice,
    gallery,
    specs,
    desc: bullets.join('\n\n'),
    bullets,
  };
}
