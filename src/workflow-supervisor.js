/* Deterministic Q17/Q18 supervised executor. Model calls and persistence are injected.
 * No network or time-triggered activity in this module. */
import {validateSavedWorkflowPlan,stageInput,shouldRunStage,stageInstruction} from './workflow-plan.js';
// Persist a run, rolling back a just-added step when the persist fails so the
// in-memory run still matches durable state. On failure the status is set to
// 'stopped' and a second persist is attempted; if that also fails the error
// propagates and durable state stays at the pre-step checkpoint, which is
// still resumable.
async function persistStep(run,persist,added){
 try{await persist(run);}
 catch(e){
  if(added)run.steps.pop();
  run.status='stopped';run.inFlightStage=null;
  try{await persist(run);}catch{}
  throw e;
 }
}
export async function executeSavedPlan(run,{callStage,persist,signal,onStage=()=>{}}){
 if(!run||!validateSavedWorkflowPlan(run.plan)||!Array.isArray(run.steps)||run.steps.length>run.plan.length)throw Error('Invalid saved workflow.');
 if(typeof callStage!=='function'||typeof persist!=='function')throw Error('Workflow requires an authorized call and persistent checkpoint callbacks.');
 if(signal?.aborted)throw Error('Workflow was already stopped.');
 // Retry-from-failed-stage: a failed run's last step is an outcome, not a
 // completed stage. Record it as an attempt, drop it, and re-run that stage
 // instead of skipping past it. Completed stages are never re-run.
 if(run.status==='failed'){
  const last=run.steps.at(-1);
  if(last?.status==='failed'){
   (run.attempts??=[]).push({stage:last.stage,provider:last.provider,content:last.content,status:'failed'});
   run.steps.pop();
  }
 }
 run.status='running';
 await persist(run);
 for(let i=run.steps.length;i<run.plan.length;i++){
  if(signal?.aborted)break;
  const stage=run.plan[i];
  let input;
  try{input=stageInput(stage,run.steps);}catch(error){
   run.status='failed';run.inFlightStage=null;
   run.steps.push({stage:stage.label,provider:stage.route,status:'failed',content:'Variable reference failed: '+error.message});
   try{await persistStep(run,persist,true);}catch{run.status='stopped';return run;}
   onStage(run,i,'failed');return run;
  }
  if(!shouldRunStage(stage,input)){
   run.steps.push({stage:stage.label,provider:stage.route,status:'skipped',content:'Skipped: condition '+stage.when+' did not match.'});
   await persistStep(run,persist,true);onStage(run,i,'skipped');continue;
  }
  run.inFlightStage=i;
  try{await persist(run);}catch(e){run.inFlightStage=null;throw e;} // Persist before any request; failed persistence means no new provider request.
  onStage(run,i,'running');
  let response;
  try{response=await callStage(stage,stageInstruction(stage,run.goal,input,i),signal);}
  catch(error){
   run.inFlightStage=null;
   if(signal?.aborted||error?.name==='AbortError'){run.status='stopped';await persist(run);onStage(run,i,'stopped');return run;}
   run.steps.push({stage:stage.label,provider:stage.route,status:'failed',content:String(error?.message||error).slice(0,2000)});
   run.status='failed';
   try{await persistStep(run,persist,true);}catch{run.status='stopped';return run;}
   onStage(run,i,'failed');return run;
  }
  if(!response||typeof response.text!=='string')throw Error('Provider response lacks text.');
  run.steps.push({stage:stage.label,provider:stage.route,status:'complete',content:response.text.slice(0,30000),model:String(response.model||'').slice(0,130),savedAs:stage.save});
  run.inFlightStage=null;
  await persistStep(run,persist,true);onStage(run,i,'done');
 }
 if(run.status==='running')run.status=signal?.aborted?'stopped':run.steps.length===run.plan.length?'complete':'stopped';
 run.inFlightStage=null;
 await persist(run);
 return run;
}
