/*
 * 亚马逊商品页抓取 + 解析（自建，无第三方 API）。
 *
 * 现实提醒：亚马逊有强反爬（风控/验证码/封 IP），此为“尽力而为”解析器：
 *   - 成功：返回标题/主图/图集/价格/要点，管理员在后台确认后再入库；
 *   - 失败：抛错，前端提示手动录入。
 * 若将来要稳定量产，换成 Rainforest/Canopy 这类付费 API，只需替换本文件的 fetchAmazon。
 */

const UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// 从 URL 提取 ASIN（/dp/ASIN 或 /gp/product/ASIN）
export function extractAsin(url) {
  const m = url.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i)
    || url.match(/[?&]asin=([A-Z0-9]{10})/i);
  return m ? m[1].toUpperCase() : null;
}

function decodeEntities(s = '') {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .trim();
}

function pick(re, html) { const m = html.match(re); return m ? decodeEntities(m[1]) : ''; }

function parseHtml(html, url, asin) {
  // 标题：优先 productTitle，其次 og:title
  const title =
    pick(/<span[^>]*id="productTitle"[^>]*>([\s\S]*?)<\/span>/i, html) ||
    pick(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i, html) ||
    pick(/<title>([^<]+)<\/title>/i, html).replace(/\s*:\s*Amazon.*$/i, '');

  // 主图：og:image 或 landingImage 的 data-old-hires / src
  const mainImg =
    pick(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i, html) ||
    pick(/id="landingImage"[^>]*data-old-hires="([^"]+)"/i, html) ||
    pick(/id="landingImage"[^>]*src="([^"]+)"/i, html);

  // 图集：hiRes / large 图 URL（去重）
  const gallery = new Set();
  if (mainImg) gallery.add(mainImg);
  for (const m of html.matchAll(/"(?:hiRes|large)":"(https:[^"]+?\.jpg)"/g)) {
    gallery.add(m[1].replace(/\\u002F/g, '/'));
    if (gallery.size >= 8) break;
  }

  // 价格：多种位置兜底
  const priceStr =
    pick(/<span[^>]*class="a-offscreen"[^>]*>\s*\$?([\d,]+\.?\d*)/i, html) ||
    pick(/"price"\s*:\s*"?\$?([\d,]+\.?\d*)/i, html) ||
    pick(/id="priceblock_ourprice"[^>]*>\s*\$?([\d,]+\.?\d*)/i, html);
  const price = priceStr ? parseFloat(priceStr.replace(/,/g, '')) : 0;

  // 要点（feature bullets）→ 规格/描述
  const bullets = [];
  const flSection = html.match(/id="feature-bullets"[\s\S]*?<\/ul>/i);
  if (flSection) {
    for (const m of flSection[0].matchAll(/<span[^>]*class="a-list-item"[^>]*>([\s\S]*?)<\/span>/gi)) {
      const t = decodeEntities(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
      if (t && t.length > 2) bullets.push(t);
    }
  }

  // 清理品牌名:去掉 "Amazon Basics"/"AmazonBasics" 前缀
  let cleanName = title || `Amazon 商品 ${asin || ''}`.trim();
  cleanName = cleanName.replace(/^Amazon\s*Basics?\s*/i, '').trim();

  return {
    name: cleanName,
    emoji: '📦',
    sourceUrl: url,
    asin,
    refPrice: price,                       // 参考价（美元），管理员据此定份数
    gallery: [...gallery].map(u => ({ type: 'image', url: u })),
    specs: [],
    desc: bullets.join('\n'),
    bullets,
  };
}

export async function fetchAmazon(url) {
  const asin = extractAsin(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html',
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();
    // 命中验证码/机器人墙
    if (/api-services-support@amazon|Enter the characters you see below|To discuss automated access/i.test(html))
      throw new Error('被亚马逊反爬拦截（验证码墙）');
    const draft = parseHtml(html, url, asin);
    if (!draft.name || draft.gallery.length === 0)
      throw new Error('页面结构未识别，可能被拦截');
    return draft;
  } finally {
    clearTimeout(timer);
  }
}
