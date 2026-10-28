'use client';
import {useEffect} from 'react';
import type {Workspace} from '@/lib/types';
import {useFeedModel} from './briefing-feed';
import {needsYouTotal} from './needs-you-view';

/** Reports how many things wait on the owner, for the count beside Needs you in the menu. It reads
 * the shared live feed (no extra polling) and renders nothing itself; `null` means not known yet. */
export default function NeedsCount({workspace,revision,onCount}:{workspace:Workspace;revision:number;onCount:(count:number|null)=>void}){
 const {expired,model,snapshot}=useFeedModel({workspace,revision,reports:false});
 const count=expired||snapshot.feeds.briefings.status==='loading'?null:needsYouTotal(model,workspace);
 useEffect(()=>{onCount(count);},[count,onCount]);
 useEffect(()=>()=>onCount(null),[onCount]);
 return null;
}
