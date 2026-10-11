import {SampleProvider, isYouTubeUrl, safeMediaUrl, timecode, validateSample} from './adapter.js';
import {configureCoordinator,connection,probeConnection,selectedMode,setMode,startCoordinator,resumeCoordinator,stopObservation} from './coordinator-ui.js';
const $ = id => document.getElementById(id);
const provider = new SampleProvider();
let sampleInput, sampleReport, selection = 0, animations = [], record = null, busy = false, opener = null;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const storageKey = 'opusclip-marketing-sample-v1';
function el(tag, text, className) {const n=document.createElement(tag); if(text!==undefined)n.textContent=text; if(className)n.className=className; return n;}
function button(text, action, className='button') {const n=el('button',text,className);n.type='button';n.addEventListener('click',action);return n;}
function stopMedia() {document.querySelectorAll('dialog video').forEach(v=>v.pause());}
function persist() {try {if(record)sessionStorage.setItem(storageKey,JSON.stringify(record));}catch { /* Storage is optional; never restart jobs to compensate. */ }}
function announce(text) {if($('workbench-announcement').textContent!==text)$('workbench-announcement').textContent=text;}
function cancelAnimations() {animations.forEach(a=>a.cancel());animations=[];}
function selectQuestion(index, animate = true) {
  if(!sampleInput)return;
  selection=index;cancelAnimations();
  const question=sampleInput.research.questions[index];
  document.querySelectorAll('.question-button').forEach((b,i)=>b.setAttribute('aria-pressed',String(i===index)));
  const evidence=sampleInput.research.evidence.find(e=>e.id===question.evidenceIds[0]);
  const match=sampleReport.matches.find(m=>m.questionId===question.id);
  const clip=match && sampleInput.clips.find(c=>c.id===match.clipId);
  const passage=match?.answerPassages[0];
  const source=passage ? {text:passage.quote,startMs:passage.sourceStartMs,endMs:passage.sourceEndMs} : sampleInput.sourceTranscript.segments.find(s=>s.id==='seg_1');
  $('comment-quote').textContent=evidence?.quote || 'No supporting comment available.';
  $('comment-meta').textContent=`${question.observedCommentCount} supporting synthetic comments · ${question.kind === 'inferred' ? 'inferred request' : 'explicit question'}`;
  $('passage-time').textContent=source ? `${timecode(source.startMs)}–${timecode(source.endMs)}`:'Unavailable';
  $('passage-quote').textContent=source?.text || 'No transcript passage available.';
  $('poster-quote').textContent=index===0?'I record voiceover on a dynamic microphone about four inches away.':index===1?'fix exposure and white balance first, then contrast.':'No matching clip found.';
  document.querySelector('.poster-mark').textContent=clip?'“':'↳';
  $('poster-time').textContent=clip?`SOURCE ${clip.sourceRanges.map(r=>`${timecode(r.startMs)}–${timecode(r.endMs)}`).join(' + ')}`:'NO GENERATED MATCH';
  $('clip-title').textContent=clip?.title || 'A question for your next recording';
  $('clip-explanation').textContent=match?.explanation || sampleReport.unansweredQuestions.find(q=>q.questionId===question.id)?.explanation || 'Cannot assess with the available evidence.';
  $('relationship').textContent=match?`Partial answer · ${question.observedCommentCount} synthetic comments connect to the cited source passage and clip. Hand-authored sample judgment, not an agent review.`:'No generated match · the folder passage exists in the available source, but no sample clip contains it. This does not prove absence from the whole video.';
  const marker=$('selection-marker'), from=getComputedStyle(marker).left;
  const target=`${Math.min(95,(source?.startMs || 0)/1075000*100)}%`;
  marker.style.left=target;
  if(animate && !reduced.matches){
    animations.push($('passage-quote').animate([{backgroundColor:'#51436d'},{backgroundColor:'#2d2a39'}],{duration:180,easing:'ease-out'}));
    animations.push(marker.animate([{left:from},{left:target}],{duration:280,delay:180,fill:'backwards',easing:'cubic-bezier(.2,.7,.2,1)'}));
    animations.push($('clip-poster').animate([{opacity:.25},{opacity:1}],{duration:180,delay:420,fill:'backwards',easing:'ease-out'}));
  }
}
async function loadHomepageSample(){
  try {
    [sampleInput,sampleReport]=await Promise.all([fetch('/sample-input.json').then(r=>{if(!r.ok)throw Error();return r.json();}),fetch('/sample-report.json').then(r=>{if(!r.ok)throw Error();return r.json();})]);
    validateSample(sampleInput,sampleReport);
    $('question-list').replaceChildren(...sampleInput.research.questions.map((q,i)=>{
      const b=el('button',undefined,'question-button'); b.type='button'; b.setAttribute('aria-pressed',String(i===0));
      b.append(el('span',String(i+1).padStart(2,'0'),'mono'));
      const text=el('span',q.question,'question-text');text.append(el('span',`${q.observedCommentCount} supporting comments${q.kind==='inferred'?' · inferred request':''}`,'count'));
      b.append(text,el('span','↗'));b.addEventListener('click',()=>selectQuestion(i));return b;
    }));
    selectQuestion(0,false);
  }catch { $('question-list').replaceChildren(el('p','Sample evidence could not load. Refresh after restarting the local server.'));$('relationship').textContent='Sample unavailable. No live request was made.'; }
}
// Disclosure navigation: ordinary links, Escape, focus return, no inaccessible custom tabs.
const menu=$('menu-toggle');
function closeMenu(){ $('mobile-menu').hidden=true;menu.setAttribute('aria-expanded','false');menu.setAttribute('aria-label','Open navigation');}
menu.addEventListener('click',()=>{const open=menu.getAttribute('aria-expanded')!=='true';$('mobile-menu').hidden=!open;menu.setAttribute('aria-expanded',String(open));menu.setAttribute('aria-label',open?'Close navigation':'Open navigation');});
$('mobile-menu').addEventListener('click',e=>{if(e.target.closest('a'))closeMenu();});
document.addEventListener('keydown',e=>{if(e.key==='Escape' && menu.getAttribute('aria-expanded')==='true'){closeMenu();menu.focus();}});
matchMedia('(min-width: 821px)').addEventListener('change',e=>{if(e.matches)closeMenu();});
document.querySelectorAll('[data-focus-entry]').forEach(a=>a.addEventListener('click',()=>{closeMenu();requestAnimationFrame(()=>$('video-url').focus({preventScroll:true}));}));
function setProgress(status){
  const step=['idle','researching'].includes(status)?0:status==='research_ready'||status==='generating'?1:2;
  [...$('progress-steps').children].forEach((n,i)=>{n.classList.toggle('current',i===step);n.classList.toggle('done',i<step);n.removeAttribute('aria-current');if(i===step)n.setAttribute('aria-current','step');});
}
function openWorkbench(explore=false, route=true){
  opener=document.activeElement;
  closeMenu();
  $('workbench-url').value=$('video-url').value || record?.videoUrl || 'https://www.youtube.com/watch?v=FXdemo00001';
  if(route)setMode(explore && connection.services?'fixture':!explore && connection.liveResearchAvailable?'live':'sample');
  $('provider-notice').textContent=selectedMode()==='fixture'?'Integrated synthetic fixture · runs the two services, with a bound hand-authored fixture judgment. No credits or live media.':selectedMode()==='live'?'Live research connected · your video link will start audience research. Clip generation remains a separate credit-acknowledged action.':explore?'Offline sample · synthetic comments and clips. No paid generation, no live audience retrieval. Judgments are hand-authored for this storyboard.':'Live research is not connected or configured yet. Your video link is preserved. Explicitly explore the offline sample below; it will not research your video or spend credits.';
  if(!$('workbench').open)$('workbench').showModal();
  if(route)history.pushState({},'', `/workbench?mode=${selectedMode()}`);
  if(record && selectedMode()==='sample')renderRecord();
  else if(route)$('workbench-results').replaceChildren();
  if(route && selectedMode()!=='sample')void researchSample();
  else if(explore && !record && !busy)void researchSample();
}
function closeWorkbench(route=true){stopMedia();stopObservation();$('workbench').close();if(route)history.replaceState({},'','/#video-entry');opener?.focus?.();}
$('close-workbench').addEventListener('click',()=>closeWorkbench());
$('workbench').addEventListener('cancel',()=>{stopMedia();stopObservation();history.replaceState({},'','/#video-entry');});
$('workbench').addEventListener('close',()=>{stopMedia();stopObservation();});
window.addEventListener('popstate',()=>{if(location.pathname==='/workbench')openWorkbench(false,false);else if($('workbench').open)closeWorkbench(false);});
document.querySelectorAll('[data-explore]').forEach(b=>b.addEventListener('click',()=>openWorkbench(true)));
$('video-url').addEventListener('input',()=>{$('entry-error').hidden=true;$('video-url').removeAttribute('aria-invalid');});
$('video-entry').addEventListener('submit',e=>{
  e.preventDefault();const value=$('video-url').value.trim();
  if(!isYouTubeUrl(value)){$('entry-error').textContent='Enter a public YouTube watch, Shorts, live or youtu.be link with a valid video ID.';$('entry-error').hidden=false;$('video-url').setAttribute('aria-invalid','true');return;}
  openWorkbench(false);
});
$('workbench-form').addEventListener('submit',e=>{e.preventDefault();void researchSample();});
async function researchSample(){
  if(busy)return;
  const url=$('workbench-url').value.trim();
  if(selectedMode()!=='sample'){return startCoordinator(selectedMode(),url,$('creator-goal').value.trim());}
  if(!isYouTubeUrl(url)){announce('Enter a valid YouTube video link. The sample will use its own fixture, not this URL.');$('workbench-url').focus();return;}
  busy=true;$('research-button').disabled=true;setProgress('researching');announce('Loading the existing sample audience research…');
  $('workbench-results').replaceChildren();
  try {record=await provider.research(url,$('creator-goal').value.trim());persist();renderRecord();announce('Sample questions loaded. Review the comments before choosing Generate.');}
  catch(err){record={id:crypto.randomUUID(),mode:'sample',videoUrl:url,goal:$('creator-goal').value,status:'failed',failedStage:'research',error:err.message};persist();renderRecord();announce('Sample research could not load. No live request was made.');}
  finally{busy=false;$('research-button').disabled=false;}
}
async function generate(){
  if(busy || !record || record.status!=='research_ready')return;
  if(!$('credit-ack')?.checked)return;
  busy=true;record={...record,status:'generating'};persist();renderRecord();announce('Loading existing synthetic clips. No OpusClip project is being submitted.');
  try{
    record=await provider.generate(record,true);persist();renderRecord();announce('Loading hand-authored sample answer judgments…');
    try{record=await provider.review(record);persist();renderRecord();announce('Sample review loaded. Two partial answers and one unanswered question.');}
    catch(err){record={...record,status:'failed',failedStage:'review',error:err.message};persist();renderRecord();announce('Sample review could not load. Retry uses the same snapshot, without regeneration.');}
  }catch(err){record={...record,status:'failed',failedStage:'generation',error:err.message};persist();renderRecord();announce('Sample clips could not load. No paid generation was attempted.');}
  finally{busy=false;}
}
async function retryReview(){
  if(busy || !record)return;
  busy=true;announce('Reloading judgments against the same saved sample snapshot…');
  try{record=await provider.retryReview(record);persist();renderRecord();announce('Sample review loaded; no clips were regenerated.');}
  catch(err){record={...record,status:'failed',failedStage:'review',error:err.message};persist();renderRecord();announce('Sample review still unavailable. The saved evidence is retained.');}
  finally{busy=false;}
}
function comments(question,input,parent){
  for(const id of question.evidenceIds){const evidence=input.research.evidence.find(e=>e.id===id);if(evidence){parent.append(el('blockquote',evidence.quote));parent.append(el('p',`Synthetic comment ${evidence.commentId} · ${evidence.publishedAt.slice(0,10)}`,'helper'));}}
}
function renderResearch(input,root){
  root.append(el('h3','Questions found in the sample','wb-title'),el('p',`${input.research.video.title} · ${input.research.coverage.commentCount} retrieved synthetic comments. Top-level comments only; not the full audience.`, 'helper'));
  input.research.questions.forEach(q=>{const section=el('section',undefined,'wb-question');section.append(el('h3',q.question),el('p',`${q.observedCommentCount} supporting comments · ${q.kind} · ${q.rationale}`,'helper'));comments(q,input,section);root.append(section);});
}
function addLimitations(input,report,root){
  const panel=el('section',undefined,'wb-limitations');panel.append(el('h3','What was—and wasn’t—checked'));
  const list=el('ul');const items=[...input.research.coverage.limitations,...input.sourceTranscript.limitations,...input.limitations,...(report?.limitations || [])];
  [...new Set(items)].forEach(t=>list.append(el('li',t)));panel.append(list);root.append(panel);
}
function addMedia(clip,parent){
  const preview=safeMediaUrl(clip.previewUrl),exportUrl=safeMediaUrl(clip.exportUrl);
  if(preview){const v=el('video',undefined,'workbench-media');v.controls=true;v.preload='none';v.playsInline=true;const play=button('Load clip preview',()=>{v.src=preview;v.load();play.remove();v.focus();});v.addEventListener('error',()=>{parent.append(el('p','This preview could not load. The transcript evidence remains available.','helper'));});parent.append(play,v);}
  else parent.append(el('p','Video preview unavailable in this synthetic fixture. No generated media is represented.','helper'));
  if(exportUrl){const a=el('a','Download available export','text-link');a.href=exportUrl;a.rel='noopener';a.target='_blank';parent.append(a);}else parent.append(el('p','HD video export unavailable. Fixture URLs are not download links.','helper'));
}
function renderReport(input,report,root){
  root.append(el('h3','Reviewing the answers','wb-title'),el('p','Hand-authored sample judgments, not the independent reviewer’s output. Source times below are not clip playback times.','helper'));
  for(const q of input.research.questions){
    const section=el('section',undefined,'wb-question');
    const match=report.matches.find(m=>m.questionId===q.id);const clip=input.clips.find(c=>c.id===match?.clipId);
    const header=el('div',undefined,'result-header');header.append(el('h3',q.question),el('span',match?.verdict.toUpperCase() || 'NO MATCH','verdict'));section.append(header);comments(q,input,section);
    if(match && clip){section.append(el('h3',clip.title),el('p',match.explanation));match.answerPassages.forEach(p=>{section.append(el('p',`SOURCE ${timecode(p.sourceStartMs)}–${timecode(p.sourceEndMs)}`,'helper'),el('blockquote',p.quote));});
      const caveats=el('ul');[...match.limitations,...match.contextWarnings.map(w=>w.explanation)].forEach(t=>caveats.append(el('li',t)));section.append(caveats);addMedia(clip,section);
    }else{const unanswered=report.unansweredQuestions.find(u=>u.questionId===q.id);section.append(el('p',unanswered?.explanation || 'This question cannot be assessed with the available evidence.'));const source=input.sourceTranscript.segments.find(s=>s.id==='seg_1');if(source){section.append(el('p',`Available source passage · ${timecode(source.startMs)}–${timecode(source.endMs)} · not in a generated clip`,'helper'),el('blockquote',source.text));}}
    root.append(section);
  }
  const matched=new Set(report.matches.map(m=>m.clipId));
  for(const clip of input.clips.filter(c=>!matched.has(c.id))){root.append(el('div',`${clip.title} — ${clip.transcriptStatus==='unavailable'?'Unverifiable: source ranges and transcript are unavailable.':'No recommended question match in the sample judgment.'}`,'unverifiable-row'));}
  const actions=el('div',undefined,'wb-actions');actions.append(button('Export sample evidence (.json)',()=>{
    const blob=new Blob([JSON.stringify({label:'Synthetic fixture + hand-authored sample judgment. Not live output.',input,report},null,2)],{type:'application/json'});const a=el('a');a.href=URL.createObjectURL(blob);a.download='opusclip-sample-evidence.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }));root.append(actions);
}
function renderRecord(){
  if(!record)return;setProgress(record.status);const root=$('workbench-results');root.replaceChildren();
  const input=record.input;
  if(record.status==='failed'){
    if(input && record.failedStage==='review')renderResearch(input,root);
    const panel=el('section',undefined,'wb-error');panel.append(el('h3',`Could not load sample ${record.failedStage || 'data'}`),el('p',record.error || 'The saved sample is unavailable.'),button(record.failedStage==='review'?'Retry review from saved evidence':'Retry sample research',record.failedStage==='review'?retryReview:researchSample));root.append(panel);return;
  }
  if(['insufficient_evidence','unavailable_transcript','unverifiable','no_match','needs_reconciliation'].includes(record.status)){
    const messages={insufficient_evidence:'Not enough supporting audience comments. No questions or clips will be invented.',unavailable_transcript:'Transcript unavailable. The clips cannot be verified against the source.',unverifiable:'The available evidence is insufficient to verify these clips.',no_match:'No generated clip answers the supported questions. This is not a claim about the entire video.',needs_reconciliation:'Generation ownership is uncertain. Reconcile the existing project in the integration before proceeding. No new project will be submitted.'};root.append(el('p',messages[record.status],'notice'));
    if(input)addLimitations(input,record.report,root);return;
  }
  if(!input)return;
  if(record.status==='complete' && record.report){renderReport(input,record.report,root);addLimitations(input,record.report,root);}
  else{
    renderResearch(input,root);
    if(record.status==='research_ready'){
      const label=el('label',undefined,'credit-confirm'),check=el('input');check.type='checkbox';check.id='credit-ack';
      label.append(check,el('span','I understand that live Generate submits an OpusClip project and consumes the connected account’s credits. This offline sample only loads existing synthetic clips and spends no credits.'));root.append(label);
      const generateButton=button('Generate sample clips →',generate);generateButton.disabled=true;check.addEventListener('change',()=>generateButton.disabled=!check.checked);root.append(generateButton);
    }else root.append(el('p',record.status==='generating'?'Loading existing sample clips…':'Loading sample judgments…','notice'));
    addLimitations(input,null,root);
  }
  if(record.status==='complete')root.append(button('Clear sample and start again',()=>{record=null;try{sessionStorage.removeItem(storageKey);}catch{}root.replaceChildren();setProgress('idle');announce('Sample cleared. Your video URL remains in the entry form.');},'text-button'));
}
try{
  const saved=sessionStorage.getItem(storageKey);if(saved){record=JSON.parse(saved);if(record.mode!=='sample')throw Error('Not sample');if(record.input)validateSample(record.input,record.report);
    if(['generating','reviewing','researching'].includes(record.status)){record={...record,status:'failed',failedStage:record.status==='reviewing'?'review':'research',error:'The sample was interrupted. Resume by reloading its saved evidence; no paid job exists.'};persist();}
  }
}catch{record=null;try{sessionStorage.removeItem(storageKey);}catch{}}
void loadHomepageSample();
configureCoordinator({announce,setProgress});
void probeConnection().then(()=>{
  if(location.pathname==='/workbench'){
    const params=new URLSearchParams(location.search),mode=params.get('mode');
    if(mode==='fixture' || mode==='live')setMode(mode);
    openWorkbench(false,false);
    if(params.get('id'))void resumeCoordinator(params.get('id'));
  }
});
window.addEventListener('pagehide',()=>{stopMedia();stopObservation();cancelAnimations();});
reduced.addEventListener('change',()=>{cancelAnimations();if(sampleInput)selectQuestion(selection,false);});
