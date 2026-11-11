const amazonDomains=['com','co.uk','de','fr','it','es','ca','com.au','co.jp','in','com.mx','com.br','nl','se','pl','sg','ae','sa','com.tr'];
export function productUrl(value, expected) {
  let url;try{url=new URL(value)}catch{throw new Error('请输入完整HTTPS商品链接')}
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))throw new Error('商品链接仅支持HTTPS标准地址');
  const host=url.hostname.toLowerCase().replace(/^www\./,'');
  const provider=host==='doba.com'?'doba':host==='saleyee.com'?'saleyee':amazonDomains.some(t=>host==='amazon.'+t)?'amazon':null;
  if(!provider||(expected&&provider!==expected))throw new Error('商品链接域名不受支持');
  return {url:url.href,provider};
}
export async function fetchProduct(value,options={},expected) {
  let target=productUrl(value,expected);
  for(let i=0;i<4;i++){
    const response=await fetch(target.url,{...options,redirect:'manual',signal:options.signal||AbortSignal.timeout(15000)});
    if(![301,302,303,307,308].includes(response.status))return response;
    const location=response.headers.get('location');await response.body?.cancel();
    if(!location)throw new Error('商品跳转地址缺失');
    target=productUrl(new URL(location,target.url).href,target.provider);
  }
  throw new Error('商品跳转次数过多');
}
