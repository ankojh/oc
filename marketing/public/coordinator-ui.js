import {CoordinatorProvider} from './coordinator-adapter.js';
import {safeMediaUrl,timecode,isYouTubeUrl} from './adapter.js';
const $=id=>document.getElementById(id),provider=new CoordinatorProvider();
const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const action=(text,fn)=>{const b=node('button',text,'button');b.type='button';b.addEventListener('click',fn);return b;};
const fixtureUrl='https://www.youtube.com/watch?v=FXdemo00001',fixtureGoal='Turn recurring viewer questions into Shorts';
let hooks,view=null,pollTimer=null,locked=false,observing=false,lastStatus=null;
export let connection={coordinator:false,services:false,liveResearchAvailable:false};
export function configureCoordinator(callbacks){hooks=callbacks;}
export function selectedMode(){return document.querySelector('input[name=provider]:checked')?.value || 'sample';}
export function setMode(mode){const radio=document.querySelector(`input[name=provider][value=${mode}]`);if(radio && !radio.disabled)radio.checked=true;modeHelp();}
function modeHelp(){
  const mode=selectedMode();$('research-button').textContent=mode==='sample'?'Research sample questions →':mode==='fixture'?'Research integrated fixture →':'Research audience questions →';
  $('workbench-mode-help').textContent=mode==='live'?'Research retrieves real audience comments. It does not generate clips. Generate is a separate credit-acknowledged action. Provider access is not pre-verified.':mode==='fixture'?'Runs the two real services on their shared synthetic fixture. Uses FXdemo00001 and the fixture goal, not comments from your entered URL. No credits are spent.':'Loads the offline storyboard, not comments from your URL. Judgment is hand-authored, not an agent review. No credits are spent.';
  if(mode==='sample')stopObservation();
}
export async function probeConnection(){
  try{connection=await provider.connection();}catch{connection={coordinator:false,services:false,liveResearchAvailable:false};}
  const fixture=$('fixture-mode-label'),live=$('live-mode-label');
  const fixtureRadio=fixture.querySelector('input'),liveRadio=live.querySelector('input');
  fixtureRadio.disabled=!connection.services;liveRadio.disabled=!connection.liveResearchAvailable;
  fixture.classList.toggle('unavailable-mode',fixtureRadio.disabled);live.classList.toggle('unavailable-mode',liveRadio.disabled);
  fixture.lastChild.textContent=connection.services?' Integrated fixture':' Integrated fixture — unavailable';
  live.lastChild.textContent=connection.liveResearchAvailable?' Live research':' Live — unavailable';
  document.querySelectorAll('input[name=provider]').forEach(r=>r.addEventListener('change',modeHelp));modeHelp();
  return connection;
}
function saveId(){try{sessionStorage.setItem('opusclip-coordinator-id',view.integrationId);}catch{}history.replaceState({},'',`/workbench?mode=${view.mode}&id=${encodeURIComponent(view.integrationId)}`);}
export function stopObservation(){clearTimeout(pollTimer);pollTimer=null;}
function schedule(){stopObservation();if(view && ['researching','generating','reviewing'].includes(view.status) && $('workbench').open)pollTimer=setTimeout(()=>void observe(view.integrationId),1200);}
function update(v){view=v;saveId();render();if(lastStatus!==v.status){hooks.announce(v.statusText);lastStatus=v.status;}schedule();}
export async function resumeCoordinator(id){if(!/^[A-Za-z0-9_-]+$/.test(id))return;await observe(id);}
async function observe(id){
  if(locked || observing)return;stopObservation();observing=true;
  try{const v=await provider.observe(id);if(!locked && (!view || v.updatedAt!==view.updatedAt))update(v);else schedule();}
  catch(err){stopObservation();$('workbench-results').replaceChildren(node('p',err.message,'notice'),action('Resume observation',()=>observe(id)));hooks.announce('Observation paused. Your saved run is not restarted.');}
  finally{observing=false;}
}
export async function startCoordinator(mode,url,goal){
  if(locked)return;if(!isYouTubeUrl(url)){hooks.announce('Enter a valid public YouTube video URL.');return;}
  if(!connection.services || (mode==='live' && !connection.liveResearchAvailable)){hooks.announce('This provider is unavailable. Explicitly choose the offline sample instead.');return;}
  locked=true;stopObservation();$('research-button').disabled=true;hooks.setProgress('researching');hooks.announce(mode==='fixture'?'Starting research on the shared synthetic fixture…':'Researching real audience questions…');
  $('workbench-results').replaceChildren();
  try{update(await provider.research(mode,mode==='fixture'?fixtureUrl:url,mode==='fixture'?fixtureGoal:goal));}
  catch(err){$('workbench-results').replaceChildren(node('p',err.message,'notice'));hooks.announce('Research could not start. No generation was submitted.');}
  finally{locked=false;$('research-button').disabled=false;schedule();}
}
async function act(fn){if(locked)return;locked=true;stopObservation();document.querySelectorAll('#workbench-results button').forEach(b=>b.disabled=true);
  try{update(await fn());}catch(err){hooks.announce(err.message);render();}finally{locked=false;schedule();}}
function link(parent,url,text){const safe=safeMediaUrl(url);if(safe){const a=node('a',text,'text-link');a.href=safe;a.target='_blank';a.rel='noopener noreferrer';parent.append(a);}}
function media(clip,parent){
  if(view.mode==='fixture'){parent.append(node('p','Synthetic fixture: no media file exists. Preview and HD export are unavailable.','helper'));return;}
  const url=safeMediaUrl(clip.previewUrl);
  if(url){const v=node('video',undefined,'workbench-media');v.controls=true;v.playsInline=true;v.preload='none';const b=action('Load video preview',()=>{v.src=url;v.load();b.remove();});parent.append(b,v);v.addEventListener('error',()=>parent.append(node('p','Preview unavailable. The evidence below remains available.','helper')));}
  else parent.append(node('p','No video preview available.','helper'));
  const exportUrl=safeMediaUrl(clip.exportUrl);if(exportUrl)link(parent,exportUrl,'Download available HD export ↗');else parent.append(node('p','HD export unavailable. Preview URLs are not HD exports.','helper'));
}
function render(){
  if(!view)return;const root=$('workbench-results');root.replaceChildren();hooks.setProgress(view.status);
  $('provider-notice').textContent=view.mode==='fixture'?view.modeLabel:'Live audience research · Generate uses OpusClip credits only after explicit acknowledgment. Provider access and model availability are not guaranteed.';
  root.append(node('h3',view.statusText,'wb-title'));
  if(view.input.videoUrl!==$('workbench-url').value)root.append(node('p',`Active synthetic fixture: ${view.input.videoUrl}. Your entered URL above is preserved and has not been researched.`,'helper'));
  if(view.error){const box=node('section',undefined,'wb-error');box.append(node('h3',`${view.failedStage || 'Run'} could not finish`),node('p',view.error.message));if(view.error.action)box.append(node('p',view.error.action));root.append(box);}
  if(view.status==='insufficient_evidence')root.append(node('p','Not enough supported audience questions. No clip generation was submitted and no answers will be invented.','notice'));
  if(view.status==='unverifiable')root.append(node('p','The clips could not be verified against the available evidence. This is not a successful answer review.','notice'));
  if(['researching','generating','reviewing'].includes(view.status)){
    const progress=view.status==='researching'?view.research.progress.map(p=>p.message):view.status==='generating'?view.generation.events.map(p=>p.message):view.review.progress.map(p=>p.step);
    const list=node('ul',undefined,'progress-list');progress.slice(-4).forEach(t=>list.append(node('li',t)));root.append(list);
  }
  const coverage=view.research.coverage;
  if(coverage)root.append(node('p',`${view.research.video?.title || 'Video'} · ${coverage.commentCount} comments sampled from ${coverage.videoIds.length} videos. ${view.mode==='fixture'?'Synthetic comments.':''}`,'helper'));
  for(const q of view.questions){
    const section=node('section',undefined,'wb-question');section.append(node('h3',q.question),node('p',`${q.observedCommentCount} supporting comments · ${q.kind} · ${q.rationale}`,'helper'));
    for(const e of q.evidence){section.append(node('blockquote',e.quote));if(view.mode==='live')link(section,e.url,'View original comment ↗');else section.append(node('p',`Synthetic comment ${e.commentId}`,'helper'));}
    for(const r of q.recommendations){
      section.append(node('h3',`${r.rank.toString().padStart(2,'0')} / ${r.clip?.title || 'Clip unavailable'}`),node('p',r.reason));
      if(r.match){section.append(node('span',r.match.verdict.replaceAll('_',' ').toUpperCase(),'verdict'),node('p',r.match.explanation));
        for(const p of r.match.answerPassages){section.append(node('p',`SOURCE ${timecode(p.sourceStartMs)}–${timecode(p.sourceEndMs)}`,'helper'),node('blockquote',p.quote));if(view.mode==='live')link(section,p.sourceLink,'Watch the original source passage ↗');}
        for(const w of r.match.contextWarnings){section.append(node('p',`Missing context: ${w.explanation}`));for(const s of w.sourceSegments){if(s.text)section.append(node('blockquote',s.text));}}
        const list=node('ul');r.match.limitations.forEach(t=>list.append(node('li',t)));section.append(list);
      }
      if(r.clip)media(r.clip,section);
    }
    if(q.unanswered)section.append(node('p',`No recommended clip: ${q.unanswered.explanation}`));
    if(view.report && !q.recommendations.length && !q.unanswered)section.append(node('p','No clip is recommended for this question with the available evidence.'));
    if(view.report){const checked=node('ul');q.checked.forEach(m=>checked.append(node('li',`${m.clipTitle}: ${m.verdict.replaceAll('_',' ')} — ${m.explanation}`)));section.append(checked);}
    root.append(section);
  }
  if(view.actions.generate){
    const label=node('label',undefined,'credit-confirm'),check=node('input');check.type='checkbox';check.id='coordinator-credit-ack';
    label.append(check,node('span',view.mode==='live'?'I understand that Generate submits one OpusClip project and consumes the connected account’s credits.':'I understand that live Generate consumes OpusClip credits. This integrated fixture uses synthetic clips and spends no credits.'));root.append(label);
    const b=action(view.mode==='fixture'?'Generate fixture clips →':'Generate clips →',()=>{if(check.checked)void act(()=>provider.generate(view.integrationId,true));});b.disabled=true;check.addEventListener('change',()=>b.disabled=!check.checked);root.append(b);
    if(view.generation.creditNotice)root.append(node('p',view.generation.creditNotice,'helper'));
  }
  const recovery=node('div',undefined,'wb-actions');
  if(view.actions.retryReview)recovery.append(action('Retry review — keep existing clips',()=>act(()=>provider.retryReview(view.integrationId))));
  if(view.actions.retryHandoff)recovery.append(action('Retry handoff — keep existing project',()=>act(()=>provider.retryHandoff(view.integrationId))));
  if(view.actions.resumePolling)recovery.append(action('Resume existing clip processing',()=>act(()=>provider.resumePolling(view.integrationId))));
  if(view.actions.reconcile){root.append(node('p','Submission outcome is uncertain. Check for the existing project before any further generation. This interface never forces a new paid project.','notice'));recovery.append(action('Check for existing project',()=>act(()=>provider.reconcile(view.integrationId))));
    for(const candidate of view.generation.reconciliation?.candidates || [])recovery.append(action(`Use existing project: ${candidate.title || candidate.projectId}`,()=>act(()=>provider.adopt(view.integrationId,candidate.projectId))));
  }
  root.append(recovery);
  if(view.clips.length){root.append(node('h3',`All generated clips / ${view.clips.length}`,'wb-title'));for(const c of view.clips)root.append(node('div',`${c.title} — ${c.verifiable?`source ${c.sourceRanges.map(r=>`${timecode(r.startMs)}–${timecode(r.endMs)}`).join(' + ')}`:'Unverifiable: source ranges or transcript unavailable.'}`,'unverifiable-row'));}
  const limits=[...(coverage?.limitations || []),...view.handoff.limitations,...(view.handoff.sourceTranscript?.limitations || []),...(view.report?.limitations || [])];
  if(limits.length){const panel=node('section',undefined,'wb-limitations');panel.append(node('h3','What was—and wasn’t—checked'));if(coverage)panel.append(node('p',coverage.samplingMethod));if(view.handoff.sourceTranscript)panel.append(node('p',`Source coverage: ${view.handoff.sourceTranscript.coverage}. ${view.handoff.sourceTranscript.segmentCount} available segments.`));const list=node('ul');[...new Set(limits)].forEach(t=>list.append(node('li',t)));panel.append(list);root.append(panel);}
  if(view.report){root.append(action('Export reviewed evidence (.json)',()=>{const blob=new Blob([JSON.stringify({label:view.modeLabel,view},null,2)],{type:'application/json'});const a=node('a');a.href=URL.createObjectURL(blob);a.download='opusclip-reviewed-evidence.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}));}
}
