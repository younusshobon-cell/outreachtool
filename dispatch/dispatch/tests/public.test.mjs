import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile} from 'node:fs/promises';
test('public homepage and cacheable assets bypass credentials; private routes require login',async()=>{
 const files={};for(const f of ['home.html','home.css','home.js','brand.svg','auth.html'])files['/'+f]=await readFile('public/'+f,'utf8');
 const contents=`import app from './src/index.js';const files=${JSON.stringify(files)};export default{fetch(req,env,ctx){return app.fetch(req,{...env,DB:{prepare(){throw Error('Public request touched DB')}},ASSETS:{fetch:r=>new Response(files[new URL(r.url).pathname]||'missing')}},ctx)}};`;
 const bundle=await build({stdin:{contents,resolveDir:process.cwd()},bundle:true,format:'esm',platform:'browser',write:false,external:['cloudflare:sockets']});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-17',compatibilityFlags:['nodejs_compat']}));
 try{
 const r=await mf.dispatchFetch('https://app.test/');assert.equal(r.status,200);assert.match(await r.text(),/Better outreach/);assert.match(r.headers.get('cache-control'),/public/);
 const asset=await mf.dispatchFetch('https://app.test/home.css?v=ol3');assert.equal(asset.status,200);assert.match(asset.headers.get('cache-control'),/immutable/);
 const app=await mf.dispatchFetch('https://app.test/app',{redirect:'manual'});assert.equal(app.status,302);assert.equal(app.headers.get('location'),'https://app.test/login');assert.match(app.headers.get('cache-control'),/private, no-store/);
 const api=await mf.dispatchFetch('https://app.test/api/state');assert.equal(api.status,401);assert.match(api.headers.get('cache-control'),/no-store/);
 const head=await mf.dispatchFetch('https://app.test/',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
 }finally{await mf.dispose();}
});
