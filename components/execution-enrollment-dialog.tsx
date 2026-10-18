'use client';
import {useEffect,useRef} from 'react';
import {ExecutionEnrollment,type ExecutionEnrollmentProps} from './execution-enrollment';
export function ExecutionEnrollmentDialog(props:ExecutionEnrollmentProps&{onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const node=dialog.current;node?.showModal();return()=>node?.close();},[]);
 return <dialog ref={dialog} className="editor-dialog" aria-labelledby="execution-enrollment-title" onCancel={event=>{event.preventDefault();if(!props.disabled)props.onClose();}}><div><header className="dialog-header"><div><p className="eyebrow">PRIVATE DEVICE ACCESS</p><h2 id="execution-enrollment-title">Enroll an executor or evaluation reader</h2></div><button type="button" className="icon-button" aria-label="Close editor" disabled={props.disabled} onClick={props.onClose}>×</button></header><div className="dialog-fields"><ExecutionEnrollment {...props}/></div></div></dialog>;
}
