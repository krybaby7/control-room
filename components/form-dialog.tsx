'use client';

import { createContext, cloneElement, isValidElement, useContext, useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode, type ReactElement } from 'react';
import { AlertCircle, LoaderCircle, X } from 'lucide-react';
import { SessionExpiredContext } from './session-state';

export const EditorOpenerContext=createContext<HTMLElement|null|undefined>(undefined);

export const OriginalSaveContext=createContext<{check?:()=>Promise<string>}>({});

export function FormDialog({ title, subtitle, dirty, onClose, onSave, submitLabel = 'Save changes', children }: { title: string; subtitle?: string; dirty: boolean; onClose: () => void; onSave: () => Promise<void>; submitLabel?: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const expired = useContext(SessionExpiredContext);
  const sessionExpired = useRef(expired);
  useLayoutEffect(() => { sessionExpired.current = expired; }, [expired]);
  const requestedOpener=useContext(EditorOpenerContext);
  const opener = useRef<HTMLElement | null>(requestedOpener!==undefined?requestedOpener:typeof document === 'undefined' ? null : document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const originalSave=useContext(OriginalSaveContext);
  const [checking,setChecking]=useState(false);const [outcome,setOutcome]=useState('');
  const titleId = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const close = () => { if (!saving && (!dirty || window.confirm('Discard your unsaved changes?'))) onClose(); };
  useEffect(() => { const dialog = ref.current; if (!expired && dialog) { dialog.showModal(); dialog.querySelector<HTMLElement>('[data-editor-autofocus="true"]')?.focus(); } return () => { dialog?.close(); if (!sessionExpired.current && opener.current?.isConnected) opener.current.focus(); }; }, [expired]);
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  if (expired) return null;
  return <dialog ref={ref} className="editor-dialog" aria-labelledby={titleId} onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const dialog = ref.current; if (!dialog) return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex]')).filter(node => !node.matches(':disabled,[hidden],[tabindex="-1"]') && node.getClientRects().length > 0);
    const first = controls[0], last = controls.at(-1);
    if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (active === last || !dialog.contains(active))) { event.preventDefault(); first.focus(); }
  }} onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={async event => { event.preventDefault(); if (saving) return; setSaving(true); setError(''); try { await onSave(); onClose(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'We could not save this. Your draft is still here.'); } finally { setSaving(false); } }}>
      <header className="dialog-header"><div><p className="eyebrow">YOUR WORKSPACE</p><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button type="button" className="icon-button" aria-label="Close editor" onClick={close} disabled={saving}><X size={21} /></button></header>
      <div className="dialog-body"><fieldset className="dialog-fields" disabled={saving}>{children}</fieldset></div>
      <footer className="dialog-footer">{originalSave.check&&<button type="button" className="text-button" disabled={checking||saving} onClick={async()=>{setChecking(true);try{setOutcome(await originalSave.check!());}finally{setChecking(false);}}}>Check original save</button>}{outcome&&<p role="status">{outcome}</p>}{error && <p className="form-error" role="alert"><AlertCircle size={17} /><span>{error}</span></p>}<div className="dialog-actions"><button className="button secondary" type="button" onClick={close} disabled={saving}>Cancel</button><button className="button primary" type="submit" disabled={saving}>{saving && <LoaderCircle size={16} className="spinning" />}{saving ? 'Saving…' : submitLabel}</button></div></footer>
    </form>
  </dialog>;
}

export function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  const hintId=useId();
  const control=isValidElement(children)&&typeof children.type==='string'&&['input','select','textarea'].includes(children.type)?cloneElement(children as ReactElement<Record<string,unknown>>,{'aria-label':(children.props as Record<string,unknown>)['aria-label']??label,...((children.props as Record<string,unknown>).autoFocus===true?{'data-editor-autofocus':'true'}:{}),...(hint?{'aria-describedby':hintId}:{})}):children;
  return <label className={`field ${className}`}><span className="field-label">{label}</span>{control}{hint && <span id={hintId} className="field-hint">{hint}</span>}</label>;
}
