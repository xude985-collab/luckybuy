// Read-only service diagnosis; no account credentials or transaction writes.
const samples = Math.min(10, Math.max(1, Number(process.argv[2]) || 3));
const paths = ['/api/health','/api/shop/catalog?page=1&limit=1','/api/shop/categories'];
let failed = false;
for (let sample=1; sample<=samples; sample++) {
  for (const path of paths) {
    const started=Date.now();
    try {
      const response=await fetch('https://luckybuy.vip'+path,{signal:AbortSignal.timeout(30000)});
      const data=await response.json();
      const ok=response.ok&&data.ok===true;
      if(!ok)failed=true;
      console.log(JSON.stringify({time:new Date().toISOString(),sample,path:path.split('?')[0],status:response.status,ok,ms:Date.now()-started,requestId:response.headers.get('X-Request-ID')}));
    } catch { failed=true;console.log(JSON.stringify({sample,path:path.split('?')[0],ok:false,ms:Date.now()-started})); }
  }
}
process.exitCode=failed?1:0;
