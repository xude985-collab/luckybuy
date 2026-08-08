/*
 * Doba.com 商品页解析。
 *
 * Doba 是 Next.js 应用，产品页需要登录查看。
 * 服务器 IP 被 WAF 拦截，通过 Jina Reader 代理绕过。
 * 如果产品需要登录（大部分情况），前端会 fallback 到让管理员粘贴页面源码。
 */

function stripTags(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseDobaUrl(url) {
  const m = url.match(/doba\.com\/product\/([^/]+)\/([^/.]+)/i);
  if (!m) return null;
  return { skuId: m[1], slug: m[2] };
}

export async function fetchDoba(url) {
  const parsed = parseDobaUrl(url);
  if (!parsed) throw new Error('无效的 Doba 商品链接');

  // 通过 Jina Reader 获取页面 HTML（绕过 WAF）
  const jinaUrl = 'https://r.jina.ai/' + url;
  const resp = await fetch(jinaUrl, {
    headers: { 'X-Respond-With': 'html' },
    signal: AbortSignal.timeout(20000),
  });

  if (!resp.ok) throw new Error(`Doba 页面获取失败 (${resp.status})`);

  const html = await resp.text();
  const m = html.match(/__NEXT_DATA__[^>]*>([\s\S]*?)<\/script/);
  if (!m) throw new Error('Doba 页面解析失败');

  const data = JSON.parse(m[1]);
  const pp = data.props?.pageProps;
  if (!pp) throw new Error('Doba 数据结构异常');

  if (pp.abnormalType === 'UN_LOGIN' || (pp.productDetail && pp.productDetail.errorPage)) {
    throw new Error('Doba 需要登录，请在弹窗中粘贴页面源码');
  }

  const pd = pp.productDetail;
  if (!pd) throw new Error('商品不存在或已下架');

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
  const profitDiff = parseFloat(pd.maxPriceProfitDiff) || 0;
  const profitRate = parseFloat(pd.maxPriceProfitDiffRate) || 0;
  if (profitDiff > 0 && profitRate > 0) {
    refPrice = Math.round((profitDiff / (profitRate / 100)) * 100) / 100;
  } else if (pd.price) {
    refPrice = parseFloat(pd.price);
  } else if (pd.retailPrice) {
    refPrice = parseFloat(pd.retailPrice);
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
      ? `参考价 $${refPrice}（根据利润率估算，请核实实际价格）`
      : '价格需登录 Doba 查看，请手动填写',
  };
}
