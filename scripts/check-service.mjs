// Read-only service diagnosis; no account credentials or transaction writes.
const samples = Math.min(10, Math.max(1, Number(process.argv[2]) || 3));
const paths = ['/api/health','/api/shop/catalog?page=1&limit=1','/api/shop/categories'];
let failed = false;
for (let sample=1; sample<=samples; sample++) {
  for (const path of paths) {
    const started=Date.now();
    try {
      const response=await fetch('https://luckybuy.vip'+path,{
        signal:AbortSignal.timeout(30000), headers:{Accept:'application/json','Cache-Control':'no-cache'}
      });
      let data=null;
      let parseError=null;
      if(response.headers.get('content-type')?.includes('application/json')) {
        try { data=await response.json(); } catch { parseError='invalid_json'; }
      } else {
        parseError='non_json';
        await response.body?.cancel();
      }
      const challenge=response.headers.get('cf-mitigated')==='challenge';
      const ok=response.ok&&data?.ok===true&&!challenge;
      if(!ok)failed=true;
      console.log(JSON.stringify({time:new Date().toISOString(),sample,path:path.split('?')[0],status:response.status,ok,challenge,parseError,ms:Date.now()-started,requestId:response.headers.get('X-Request-ID'),ray:response.headers.get('CF-Ray')}));
    } catch(error) { failed=true;console.log(JSON.stringify({time:new Date().toISOString(),sample,path:path.split('?')[0],status:0,ok:false,error:error.name==='TimeoutError'?'timeout':'connection_failed',ms:Date.now()-started})); }
  }
}
process.exitCode=failed?1:0;
