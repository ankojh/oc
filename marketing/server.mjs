import {createServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, extname, sep} from 'node:path';
const root = resolve(fileURLToPath(new URL('./public/', import.meta.url)));
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.ttf':'font/ttf','.txt':'text/plain; charset=utf-8','.mp4':'video/mp4'};
export function startServer(port = Number(process.env.MARKETING_PORT || 3103), coordinatorOrigin = process.env.COORDINATOR_ORIGIN || 'http://127.0.0.1:3100') {
  const target = new URL(coordinatorOrigin);
  if (target.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(target.hostname) || target.username || target.password || target.pathname !== '/') throw new Error('COORDINATOR_ORIGIN must be a loopback HTTP origin.');
  const server = createServer(async (req,res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; media-src 'self' https:; frame-ancestors 'none'; form-action 'self'; base-uri 'self'");
    const host = req.headers.host || '';
    const json = (status,body) => {res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return json(403,{error:{message:'Only loopback hosts are accepted.'}});
    if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${host}`) return json(403,{error:{message:'Cross-origin actions are refused.'}});
    const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if(path === '/api/connection' && req.method === 'GET') {
      try {
        const health=await fetch(new URL('/health',target),{signal:AbortSignal.timeout(2000)});if(!health.ok)throw new Error();
        const r=await fetch(new URL('/api/services',target),{signal:AbortSignal.timeout(4000)});const services=await r.json();
        return json(200,{coordinator:true,services:!!(services.research?.ok && services.review?.ok),liveResearchAvailable:!!(services.research?.ok && services.review?.ok && services.research?.live?.youtubeApiKey),message:'Coordinator connected. Provider entitlement is checked at Generate; live generation is not pre-verified.'});
      }catch{return json(200,{coordinator:false,services:false,liveResearchAvailable:false,message:'Integration coordinator is unavailable. The offline sample remains usable.'});}
    }
    const permittedGet = /^\/api\/integrations(?:\/[A-Za-z0-9_-]+)?$/;
    const permittedPost = /^\/api\/integrations(?:\/[A-Za-z0-9_-]+\/(?:generate|retry-review|retry-handoff|resume-polling|reconcile|adopt-project))?$/;
    if ((req.method === 'GET' && permittedGet.test(path)) || (req.method === 'POST' && permittedPost.test(path))) {
      try {
        let size=0, chunks=[];
        for await(const chunk of req){size+=chunk.length;if(size>65536)return json(413,{error:{message:'Request too large.'}});chunks.push(chunk);}
        // The target is fixed loopback; credentials and arbitrary routes are never forwarded.
        const upstream=await fetch(new URL(path,target),{method:req.method,headers:req.method==='POST'?{'content-type':'application/json'}:{},body:req.method==='POST'?Buffer.concat(chunks):undefined,signal:AbortSignal.timeout(30000)});
        const data=await upstream.text();res.writeHead(upstream.status,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(data);
      }catch{return json(502,{error:{message:'The coordinator is unreachable. Observe or retry your saved run; do not regenerate clips.'}});}
    }
    if (!['GET','HEAD'].includes(req.method || '')) {res.writeHead(405);res.end('Only documented coordinator actions are supported.');return;}
    try {
      const decodedPath = decodeURIComponent(path);
      const file = resolve(root, '.'+(decodedPath === '/' || decodedPath === '/workbench' ? '/index.html' : decodedPath));
      if (!file.startsWith(root+sep) || !mime[extname(file)] || extname(file) === '.d.ts') {res.writeHead(404);res.end('Not found');return;}
      const info = await stat(file); if(!info.isFile()) throw new Error('Not file');
      const data = await readFile(file);
      res.writeHead(200,{'Content-Type':mime[extname(file)],'Cache-Control':path.startsWith('/assets/')?'public, max-age=86400':'no-store'});
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {res.writeHead(404);res.end('Not found');}
  });
  server.listen(port,'127.0.0.1',()=>console.log(`OpusClip redesign: http://127.0.0.1:${server.address().port} (offline sample; live unavailable)`));
  return server;
}
if(process.argv[1] === fileURLToPath(import.meta.url)) startServer();
