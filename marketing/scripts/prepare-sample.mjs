// Run only deliberately: freeze the producer's synthetic export without editing either agent.
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root = new URL('../', import.meta.url);
const source = new URL('../../audience-research/fixtures/exports/review-input.fixture.json', import.meta.url);
const raw = await readFile(source, 'utf8'), input = JSON.parse(raw);
if (input.research.mode !== 'fixture') throw new Error('Only synthetic fixtures may be copied into public assets.');
const [mic, color] = input.clips;
const passage = c => c.transcript.map(s => ({clipTranscriptSegmentId:s.id, quote:s.text, sourceStartMs:s.sourceStartMs, sourceEndMs:s.sourceEndMs}));
const report = {
  schemaVersion: 'audience-clips.v1', runId: input.research.runId, mode: 'fixture', status:'complete',
  matches: [
    {questionId:'q_1',clipId:mic.id,verdict:'partial',explanation:'The passage describes a dynamic microphone, distance and processing, but does not identify a microphone model.',commentEvidenceIds:['ev_1','ev_2','ev_3'],answerPassages:passage(mic),contextWarnings:[],limitations:['The exact microphone model is not named in the available passage.']},
    {questionId:'q_2',clipId:color.id,verdict:'partial',explanation:'The clip covers exposure, white balance, contrast and a creative LUT. It omits the source passage about keeping saturation natural.',commentEvidenceIds:['ev_4','ev_5','ev_6'],answerPassages:passage(color),contextWarnings:[{explanation:'The selected clip omits the saturation step from source segment seg_7.',sourceSegmentIds:['seg_7']}],limitations:['Two noncontiguous source ranges; source times are not clip playback times.']}
  ],
  recommendations:[{rank:1,clipId:mic.id,questionIds:['q_1'],reason:'A useful partial answer about the microphone setup; no model is specified.'},{rank:2,clipId:color.id,questionIds:['q_2'],reason:'A partial walkthrough of the color grade, with the missing saturation step disclosed.'}],
  unansweredQuestions:[{questionId:'q_3',status:'not_found_in_generated_clips',explanation:'The available source describes folders, but no generated clip contains that passage. Partial source coverage cannot establish absence from the entire video.'}],
  limitations:['HAND-AUTHORED SAMPLE JUDGMENT: storyboard for the marketing interaction; not a recorded agent review and not live OpusClip output.','Synthetic comments, transcript and clips from the existing editing-workflow fixture. No real creator is represented.','Source transcript coverage is partial/unknown; the complete video was not verified.','The Channel intro clip has no verified ranges or transcript and remains unverifiable.']
};
await writeFile(new URL('public/sample-input.json',root),JSON.stringify(input,null,2)+'\n');
await writeFile(new URL('public/sample-report.json',root),JSON.stringify(report,null,2)+'\n');
await writeFile(new URL('docs/sample-provenance.json',root),JSON.stringify({source:'audience-research/fixtures/exports/review-input.fixture.json',sha256:createHash('sha256').update(raw).digest('hex'),mode:'synthetic fixture',judgment:'hand-authored marketing storyboard, not agent output',capturedAt:new Date().toISOString()},null,2)+'\n');
