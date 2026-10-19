import os, sys, io, json, zipfile, hashlib, math
from urllib.request import Request, build_opener, HTTPRedirectHandler, urlopen
from urllib.error import HTTPError
from urllib.parse import urlparse
class NoRedirect(HTTPRedirectHandler):
 def redirect_request(self, req, fp, code, msg, headers, newurl): return None
def main():
 token=os.environ.get('GH_TOKEN')
 if not token: raise ValueError()
 req=Request('https://api.github.com/repos/krybaby7/control-room/actions/artifacts/12161927116/zip',headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json'})
 try:
  response=build_opener(NoRedirect()).open(req,timeout=20)
 except HTTPError as error:
  if error.code not in (301,302,303,307,308): raise ValueError()
  location=error.headers.get('Location',''); target=urlparse(location)
  if target.scheme!='https' or target.username or target.password: raise ValueError()
  response=urlopen(Request(location),timeout=30)
 with response: data=response.read(8*1024*1024+1)
 if len(data)>8*1024*1024 or hashlib.sha256(data).hexdigest()!='34814a0c847b0876b44565b85571128ddb8c1b62f8437d51b7922d92c525c8e1': raise ValueError()
 outer=zipfile.ZipFile(io.BytesIO(data)); traces=[]
 for item in outer.infolist():
  if item.filename.endswith('/trace.zip') and 'agents-finite-execution-bu-' in item.filename:
   if item.file_size>16*1024*1024: raise ValueError()
   traces.append(outer.read(item))
 if len(traces)!=1: raise ValueError()
 inner=zipfile.ZipFile(io.BytesIO(traces[0])); entries=inner.infolist()
 if len(entries)>2000 or sum(x.file_size for x in entries)>64*1024*1024: raise ValueError()
 known={'Sign in again.':'sign-in-required','Agent storage is unavailable.':'binding-unavailable','Invalid owner page.':'invalid-page','Agent records are unavailable. Refresh again.':'agent-read-unavailable'}
 result=[]; calls={}; action_results=[]; scanned=0
 for entry in entries:
  if not entry.filename.endswith(('.network','.trace')): continue
  if entry.file_size>16*1024*1024: raise ValueError()
  for line in inner.read(entry).splitlines():
   if len(line)>2*1024*1024: raise ValueError()
   event=json.loads(line); scanned+=1
   snap=event.get('snapshot',{})
   request=snap.get('request',{})
   if request.get('method')=='GET' and urlparse(request.get('url','')).path=='/api/jobs':
    response=snap.get('response',{}); status=response.get('status'); row={'status':status}
    duration=snap.get('time')
    if isinstance(duration,(int,float)) and math.isfinite(duration): row['durationMs']=round(duration,3)
    content=response.get('content',{}); sha=content.get('_sha1')
    if isinstance(status,int) and status>=400 and isinstance(sha,str):
     key='resources/'+sha
     if key in inner.namelist() and inner.getinfo(key).file_size<=65536:
      try: row['errorClass']=known.get(json.loads(inner.read(key)).get('error'),'other-response')
      except (ValueError,AttributeError): row['errorClass']='non-json-response'
    result.append(row)
   params=event.get('params',{})
   if event.get('type')=='before' and str(params.get('method','GET')).upper()=='GET' and urlparse(str(params.get('url',''))).path=='/api/jobs':
    calls[event.get('callId')]=event.get('startTime')
   if event.get('type')=='after' and event.get('callId') in calls:
    row={'failed':bool(event.get('error'))}; start=calls[event.get('callId')]; end=event.get('endTime')
    if isinstance(start,(int,float)) and isinstance(end,(int,float)): row['durationMs']=round(end-start,3)
    response=event.get('result',{}).get('response',{})
    if isinstance(response,dict) and isinstance(response.get('status'),int): row['status']=response['status']
    action_results.append(row)
 print(json.dumps({'sourceCommit':'e4af1fc5ae344a029f9677576963700c92aaefee','artifactId':12161927116,'outerDigestVerified':True,'traceCount':len(traces),'eventsScanned':scanned,'jobsResponses':result[:32],'jobsActions':action_results[:32],'productRerun':False},separators=(',',':')))
try: main()
except Exception:
 print('TRACE_INSPECTION_FAILED',file=sys.stderr);sys.exit(1)
