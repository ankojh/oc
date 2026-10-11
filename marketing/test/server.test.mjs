import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';import {startServer} from '../server.mjs';
test('local static server serves homepage and sample, but exposes no secrets or paid POST',async()=>{
  const s=startServer(0);await once(s,'listening');const base=`http://127.0.0.1:${s.address().port}`;
  try{
    for(const path of ['/','/workbench','/sample-input.json','/adapter.js'])assert.equal((await fetch(base+path)).status,200,path);
    for(const path of ['/.env','/server.mjs','/%2e%2e/package.json','/assets/../../.env'])assert.equal((await fetch(base+path)).status,404,path);
    const r=await fetch(base+'/research',{method:'POST'});assert.equal(r.status,405);assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  }finally{s.closeAllConnections();await new Promise(r=>s.close(r));}
});
