/*
 * Doba.com 商品页解析。
 *
 * Doba 是 Next.js 应用，产品页被 Tencent Cloud EdgeOne WAF 拦截，
 * 但 _next/data API 可正常访问并返回完整 JSON 数据。
 *
 * 价格数据需要登录（skuPriceDetail 为空），其余信息公开可获取。
 * buildId 通过请求一个错误 buildId 的 404 页面来动态获取。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function stripTags(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchBuildId() {
  // 请求一个不存在的 _buildManifest 会返回包含正确 buildId 的 404 页面
  const resp = await fetch(
    'https://www.doba.com/_next/static/PROBE/_buildManifest.js',
    { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }
  );
  const html = await resp.text();
  const m = html.match(/"buildId":"([^"]+)"/);
  if (!m) throw new Error('无法获取 Doba buildId');
  return m[1];
}

export function parseDobaUrl(url) {
  // https://www.doba.com/product/{skuId}/{slug}.html
  const m = url.match(/doba\.com\/product\/([^/]+)\/([^/.]+)/i);
  if (!m) return null;
  return { skuId: m[1], slug: m[2] };
}

export async function fetchDoba(url) {
  const parsed = parseDobaUrl(url);
  if (!parsed) throw new Error('无效的 Doba 商品链接');

  const buildId = await fetchBuildId();
  const dataUrl = `https://www.doba.com/_next/data/${buildId}/product/${parsed.skuId}/${parsed.slug}.html.json`;

  const resp = await fetch(dataUrl, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`Doba API 返回 ${resp.status}`);

  const json = await resp.json();
  const pd = json?.pageProps?.productDetail;
  if (!pd || pd.invalidPage) throw new Error('商品不存在或已下架');

  return buildDraft(pd, url);
}

function buildDraft(pd, url) {
  const name = pd.goodsName || '';

  // 图片
  const gallery = (pd.goodsImg || [])
    .map(img => {
      const u = img.imgBigUrl || img.imgUrl || '';
      return u ? { type: 'image', url: u.startsWith('//') ? 'https:' + u : u } : null;
    })
    .filter(Boolean)
    .slice(0, 15);

  // 规格尺寸
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

  // 描述：highlights + productDetail 文本
  const bullets = [];
  if (Array.isArray(pd.highlights)) {
    bullets.push(...pd.highlights.filter(Boolean));
  }
  const detailText = stripTags(pd.productDetail || '').slice(0, 1500);
  if (detailText) bullets.push(detailText);

  // 价格：公开API无法拿到，用 maxPriceProfitDiff 估算参考价
  let refPrice = 0;
  const profitDiff = parseFloat(pd.maxPriceProfitDiff) || 0;
  const profitRate = parseFloat(pd.maxPriceProfitDiffRate) || 0;
  if (profitDiff > 0 && profitRate > 0) {
    refPrice = Math.round((profitDiff / (profitRate / 100)) * 100) / 100;
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
