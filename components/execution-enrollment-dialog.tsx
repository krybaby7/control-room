'use client';
import {useContext,useEffect,useLayoutEffect,useRef} from 'react';
import {ExecutionEnrollment,type ExecutionEnrollmentProps} from './execution-enrollment';
import {EditorOpenerContext} from './form-dialog';
import {SessionExpiredContext} from './session-state';
export function ExecutionEnrollmentDialog(props:ExecutionEnrollmentProps&{onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null);
 const expired=useContext(SessionExpiredContext),sessionExpired=useRef(expired);
 useLayoutEffect(()=>{sessionExpired.current=expired;},[expired]);
 const requestedOpener=useContext(EditorOpenerContext);
 const opener=useRef<HTMLElement|null>(requestedOpener!==undefined?requestedOpener:typeof document==='undefined'?null:document.activeElement instanceof HTMLElement?document.activeElement:null);
 useEffect(()=>{const node=dialog.current;node?.showModal();return()=>{node?.close();if(!sessionExpired.current&&opener.current?.isConnected)opener.current.focus();};},[]);
 return <dialog ref={dialog} className="editor-dialog" aria-labelledby="execution-enrollment-title" onKeyDown={event=>{
 if(event.key!=='Tab')return;const node=dialog.current;if(!node)return;
 const controls=Array.from(node.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex]')).filter(control=>!control.matches(':disabled,[hidden],[tabindex="-1"]')&&control.getClientRects().length>0),first=controls[0],last=controls.at(-1);
 if(!first||!last){event.preventDefault();node.focus();return;}
 if(event.shiftKey&&(document.activeElement===first||!node.contains(document.activeElement))){event.preventDefault();last.focus();}
 else if(!event.shiftKey&&(document.activeElement===last||!node.contains(document.activeElement))){event.preventDefault();first.focus();}
 }} onCancel={event=>{event.preventDefault();if(!props.disabled)props.onClose();}}><div><header className="dialog-header"><div><p className="eyebrow">PRIVATE DEVICE ACCESS</p><h2 id="execution-enrollment-title">Enroll an executor or evaluation reader</h2></div><button type="button" className="icon-button" aria-label="Close editor" disabled={props.disabled} onClick={props.onClose}>×</button></header><div className="dialog-fields"><ExecutionEnrollment {...props}/></div></div></dialog>;
}
