const omission='[… omitted …]';
function shorten(text,limit){
  if(text.length<=limit)return text;
  if(limit<omission.length+2)return '';
  const available=limit-omission.length,head=Math.ceil(available/2);
  return text.slice(0,head)+omission+text.slice(-(available-head));
}
function concise(text){
  if(text.length>800||/```|~~~/.test(text))return false;
  // Formatting is only a template heuristic; it makes no authorship claim.
  const lines=text.split('\n'),structured=lines.filter(line=>/^\s*(?:#{1,6}\s|[-*]\s|\d+[.)]\s|[{}[\]]\s*$)/.test(line)).length;
  return !(text.length>240&&structured>=6);
}
function needsContext(text){
  const normalized=text.toLowerCase().replace(/[.,!?،؛؟]/g,' ').replace(/\s+/g,' ').trim();
  if(/^(?:yes|yeah|yep|ok|okay|sure|no|that|this|continue|proceed|go ahead|do it|نعم|أيوه|ايوه|تمام|ماشي|كمل|تابع|موافق|لا)$/.test(normalized))return true;
  // Match complete dependent constructions, not standalone requests sharing a prefix.
  if(/^(?:(?:yes|yeah|yep|ok|okay|sure|no) )?(?:please )?(?:(?:i )?(?:do|use|choose|select|prefer) )?(?:option ?(?:one|two|three|\d+)|that|this|it|continue|proceed|go ahead|do it)$/.test(normalized))return true;
  return /^(?:نعم|أيوه|ايوه|تمام|ماشي|موافق) (?:كمل|تابع|استمر)$/.test(normalized);
}
/** Select only already sanitized candidates from the collector's bounded window. */
export function selectChatMessages(safe){
  const selected=new Map();let remaining=2000;
  for(let i=safe.length-1;i>=0;i--){
    const row=safe[i];
    if(row.role==='user'&&concise(row.text)&&row.text.length<=remaining){selected.set(i,row);remaining-=row.text.length;}
  }
  if(!selected.size){
    const index=safe.findLastIndex(row=>row.role==='user');
    if(index>=0)selected.set(index,{role:'user',text:shorten(safe[index].text,1000)});
  }else{
    let assistantRemaining=600;
    for(const [index,row] of [...selected.entries()].sort((a,b)=>b[0]-a[0])){
      if(!needsContext(row.text))continue;
      const preceding=index-1;
      if(preceding<0||safe[preceding].role!=='assistant'||safe[preceding].position!==row.position-1||selected.has(preceding))continue;
      const text=shorten(safe[preceding].text,Math.min(remaining,assistantRemaining));
      if(!text)continue;
      selected.set(preceding,{role:'assistant',text});remaining-=text.length;assistantRemaining-=text.length;
    }
  }
  const messages=[...selected.entries()].sort((a,b)=>a[0]-b[0]).map(([,row])=>({role:row.role,text:row.text}));
  return {messages,truncated:selected.size!==safe.length||[...selected].some(([index,row])=>row.text!==safe[index].text)};
}
