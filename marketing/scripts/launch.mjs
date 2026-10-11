// Starts the existing integration launcher plus the isolated marketing server.
// Does not implement a new coordinator, load credentials, or change agent cwd.
import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));const cwd=fileURLToPath(new URL('../',import.meta.url));
const children=[spawn('npm',['start','--',...process.argv.slice(2)],{cwd:root,stdio:'inherit'}),spawn(process.execPath,['server.mjs'],{cwd,stdio:'inherit',env:process.env})];
let stopping=false;
function stop(code){if(stopping)return;stopping=true;for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');Promise.all(children.map(c=>c.exitCode!==null?Promise.resolve():new Promise(r=>c.once('exit',r)))).then(()=>process.exit(code));}
for(const child of children)child.on('exit',code=>{if(!stopping)stop(code || 0);});
process.on('SIGINT',()=>stop(0));process.on('SIGTERM',()=>stop(0));
console.log('Marketing homepage: http://127.0.0.1:'+ (process.env.MARKETING_PORT || 3103)+'. Coordinator routes are proxied same-origin; Generate stays explicit.');
