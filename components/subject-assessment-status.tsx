'use client';
import {useContext,useEffect,useRef,useState} from 'react';
import {boundedRequest} from '@/lib/save-controller';
import {SessionExpiredError} from '@/lib/workspace-client';
import {readSubjectAssessmentStatus,subjectAssessmentPresentation,type SubjectAssessmentStatus} from '@/lib/subject-assessment-status';
import {SessionExpiredContext} from './session-state';
export function SubjectAssessmentStatus({subject,planningStatus,revision}:{subject:{type:'task'|'milestone';id:string};planningStatus:string;revision?:number}){
 const contextExpired=useContext(SessionExpiredContext),[expired,setExpired]=useState(false),[refresh,setRefresh]=useState(0),[loaded,setLoaded]=useState<{key:string;value:SubjectAssessmentStatus|null;error:string}|null>(null),generation=useRef(0),active=useRef<AbortController|null>(null);
 const subjectType=subject.type,subjectId=subject.id;
 const key=JSON.stringify([subjectType,subjectId,planningStatus,revision,refresh]);
 useEffect(()=>{const clear=()=>{generation.current++;active.current?.abort();setLoaded(null);setExpired(true);};window.addEventListener('control-room-session-expired',clear);return()=>window.removeEventListener('control-room-session-expired',clear);},[]);
 useEffect(()=>{if(contextExpired||expired)return;const focus=()=>setRefresh(value=>value+1);window.addEventListener('focus',focus);return()=>window.removeEventListener('focus',focus);},[contextExpired,expired]);
 useEffect(()=>{
  if(contextExpired||expired)return;const currentGeneration=generation,epoch=++currentGeneration.current,controller=new AbortController();active.current=controller;let remove=()=>{};
  void boundedRequest(`/api/evidence/subject-status?type=${subjectType}&id=${encodeURIComponent(subjectId)}`,{credentials:'same-origin',cache:'no-store'},response=>readSubjectAssessmentStatus(response,{subject:{type:subjectType,id:subjectId},planningStatus,revision}),{deadlineMs:15000,fetch:(input,init)=>{const signal=init?.signal,abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});remove=()=>signal?.removeEventListener('abort',abort);return fetch(input,{...init,signal:controller.signal});}}).then(value=>{if(epoch===generation.current&&!controller.signal.aborted)setLoaded({key,value,error:''});}).catch(error=>{if(epoch!==generation.current||controller.signal.aborted)return;if(error instanceof SessionExpiredError){window.dispatchEvent(new Event('control-room-session-expired'));return;}setLoaded({key,value:null,error:'Assessment status could not be loaded safely. Refresh before reviewing acceptance.'});}).finally(()=>remove());
  return()=>{currentGeneration.current++;controller.abort();remove();};
 },[key,subjectType,subjectId,planningStatus,revision,contextExpired,expired]);
 if(contextExpired||expired)return null;
 const current=loaded?.key===key?loaded:null,presentation=current?.value?subjectAssessmentPresentation(current.value):null;
 return <section className="capture-preview" aria-label="Structured assessment status"><p role="status"><strong>{presentation?.label??(current?.error?'Assessment status unavailable':'Loading assessment status…')}</strong></p>{presentation&&<><p className="field-hint">{presentation.detail}</p>{presentation.reasons.length>0&&<ul>{presentation.reasons.map((reason,index)=><li key={`${index}:${reason}`}>{reason}</li>)}</ul>}</>}{current?.error&&<p className="field-hint">{current.error}</p>}<button type="button" className="text-button" onClick={()=>setRefresh(value=>value+1)}>Refresh assessment status</button></section>;
}
