#!/usr/bin/env python3
"""Read-only public candidate inspector. Never executes or extracts artifact code.

Inputs are independent operator pins, not discovered acceptance claims. A successful
report establishes archive/source integrity only; no release, deployment, provider,
owner-device or compiler reproducibility acceptance is inferred.
"""
import gzip, hashlib, importlib.util, io, json, os, re, subprocess, sys, tarfile, tempfile, zipfile
from pathlib import Path
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError
from urllib.parse import urlparse

REPOSITORY='krybaby7/control-room'
API='https://api.github.com/repos/'+REPOSITORY
MIB=1024*1024
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('candidate_inspector',ROOT/'scripts/inspect-candidate-artifact.py')
inspector=importlib.util.module_from_spec(spec);spec.loader.exec_module(inspector)
check=inspector.require
sha=inspector.sha

class NoRedirect(HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl): return None

def json_value(raw): return inspector.decode(raw)
def object_keys(value,keys): check(type(value) is dict and set(value)==set(keys))
def artifact_pin(value):
 object_keys(value,['id','zipSha256','workflowHead'])
 check(type(value['id']) is int and value['id']>0 and re.fullmatch('[a-f0-9]{64}',value['zipSha256']) is not None and re.fullmatch('[a-f0-9]{40}',value['workflowHead']) is not None)
 return value

def api(path,cap=2*MIB):
 request=Request(API+path,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
 with build_opener(NoRedirect()).open(request,timeout=30) as response:
  data=response.read(cap+1)
 check(len(data)<=cap);return json_value(data)

def download(pin,cap):
 meta=api('/actions/artifacts/'+str(pin['id']))
 check(meta.get('id')==pin['id'] and meta.get('expired') is False and meta.get('digest')=='sha256:'+pin['zipSha256'])
 workflow=meta.get('workflow_run',{});check(workflow.get('head_sha')==pin['workflowHead'] and type(workflow.get('id')) is int)
 run=api('/actions/runs/'+str(workflow['id']))
 check(run.get('head_sha')==pin['workflowHead'] and run.get('repository',{}).get('full_name')==REPOSITORY)
 # CI status is recorded separately. This inspector does not turn a failed gate
 # into acceptance merely because it produced a review artifact.
 request=Request(API+'/actions/artifacts/'+str(pin['id'])+'/zip',headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json'})
 try: response=build_opener(NoRedirect()).open(request,timeout=30)
 except HTTPError as error:
  check(error.code in (301,302,303,307,308));location=error.headers.get('Location','');target=urlparse(location)
  check(target.scheme=='https' and not target.username and not target.password and target.hostname and target.hostname.endswith(('.blob.core.windows.net','.githubusercontent.com')))
  # The GitHub bearer is intentionally never forwarded to signed blob URLs.
  response=build_opener(NoRedirect()).open(Request(location),timeout=30)
 with response: data=response.read(cap+1)
 check(len(data)<=cap and sha(data)==pin['zipSha256'])
 return data,{'id':pin['id'],'zipSha256':pin['zipSha256'],'workflowHead':pin['workflowHead'],'runId':workflow['id'],'runConclusion':run.get('conclusion'),'workflowPath':run.get('path')}

def zip_members(raw,maximum=200*MIB):
 with zipfile.ZipFile(io.BytesIO(raw)) as z:
  infos=z.infolist();check(1<=len(infos)<=4 and len({x.filename for x in infos})==len(infos))
  check(sum(x.file_size for x in infos)<=maximum)
  for x in infos:
   inspector.safe(x.filename);check(not x.is_dir() and not x.flag_bits&1 and 0<=x.file_size<=128*MIB and ((x.external_attr>>16)&0o170000) in (0,0o100000))
  return {x.filename:z.read(x) for x in infos}

def git_tree(commit):
 # Public Git only; no token is placed in argv, files or output.
 resolved=subprocess.run(['git','rev-parse','--verify',commit+'^{commit}'],cwd=ROOT,capture_output=True,timeout=15)
 if resolved.returncode:
  subprocess.run(['git','fetch','--no-tags','https://github.com/'+REPOSITORY+'.git',commit],cwd=ROOT,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=90)
 resolved=subprocess.run(['git','rev-parse','--verify',commit+'^{commit}'],cwd=ROOT,capture_output=True,check=True,timeout=15)
 check(resolved.stdout.decode().strip()==commit)
 tree=subprocess.run(['git','ls-tree','-rzl','--full-tree',commit],cwd=ROOT,capture_output=True,check=True,timeout=30).stdout
 entries=[];total=0
 for entry in tree.split(b'\0'):
  if not entry:continue
  header,path=entry.split(b'\t',1);mode,kind,oid,size=header.split();check(mode in (b'100644',b'100755') and kind==b'blob')
  name=inspector.safe(path.decode('utf-8'));size=int(size);check(0<=size<=64*MIB);total+=size;entries.append((name,oid,size))
 check(0<len(entries)<=20000 and total<=64*MIB)
 values=subprocess.run(['git','cat-file','--batch'],cwd=ROOT,input=b''.join(oid+b'\n' for _,oid,_ in entries),capture_output=True,check=True,timeout=60).stdout
 check(len(values)<=total+len(entries)*128);position=0;result={}
 for name,oid,size in entries:
  end=values.index(b'\n',position);check(values[position:end].split()==[oid,b'blob',str(size).encode()]);position=end+1
  data=values[position:position+size];position+=size;check(values[position:position+1]==b'\n');position+=1
  check(len(data)==size and 'source/'+name not in result);result['source/'+name]=data
 check(position==len(values));return result

def run_inspector(raw,commit):
 with tempfile.TemporaryDirectory(prefix='review-integrity-',dir=os.environ.get('RUNNER_TEMP')) as temporary:
  path=Path(temporary)/'candidate.zip';path.write_bytes(raw)
  result=subprocess.run([sys.executable,str(ROOT/'scripts/inspect-candidate-artifact.py'),str(path),commit,sha(raw)],capture_output=True,timeout=90)
  return result.returncode,json_value(result.stdout)

def candidate(raw,commit):
 code,report=run_inspector(raw,commit);check(code==0 and report['status']=='REVIEWABLE_CANDIDATE')
 members=zip_members(raw);source='control-room-source-'+commit+'.tar';build='control-room-build-'+commit+'.tar.gz'
 verify_source(members[source],git_tree(commit),commit)
 files=inspector.entries(members[build],256*MIB,gnu_long=True)
 return report,members,files

def helper(raw,commit):
 members=zip_members(raw,33*MIB);check(set(members)=={'OwnedProcess.exe','manifest.json'})
 manifest=json.loads(members['manifest.json'].decode('utf-8-sig'),object_pairs_hook=inspector.obj)
 object_keys(manifest,['sourceCommit','sha256','runtimeRequirement','ownerDeviceAcceptance','providerExecution'])
 check(manifest['sourceCommit']==commit and manifest['sha256']==sha(members['OwnedProcess.exe']) and manifest['runtimeRequirement']=='.NET 8' and manifest['ownerDeviceAcceptance'] is False and manifest['providerExecution'] is False)
 check(0<len(members['OwnedProcess.exe'])<=32*MIB and members['OwnedProcess.exe'][:2]==b'MZ')
 return {'sourceCommit':commit,'sha256':manifest['sha256'],'bytes':len(members['OwnedProcess.exe']),'runtimeRequirement':'.NET 8','ownerDeviceAcceptance':False,'providerExecution':False}

def mutate_zip(raw,name,offset=0):
 members=zip_members(raw);check(name in members and len(members[name])>offset);value=members[name];members[name]=value[:offset]+bytes([value[offset]^1])+value[offset+1:];out=io.BytesIO()
 with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
  for path,value in members.items():z.writestr(path,value)
 return out.getvalue()

def repack(members):
 out=io.BytesIO()
 with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
  for path,value in members.items():z.writestr(path,value)
 return out.getvalue()

def verify_source(source_bytes,expected,commit):
 actual=inspector.entries(source_bytes,64*MIB,git_comment=commit)
 check(set(actual)==set(expected) and all(actual[path]==expected[path] for path in expected))

def parser_negative_controls():
 def header(name,kind,size):
  h=bytearray(512);h[:len(name)]=name;h[100:108]=b'0000644\0';h[108:116]=h[116:124]=b'0000000\0';h[124:136]=('%011o\0'%size).encode();h[136:148]=b'00000000000\0';h[148:156]=b'        ';h[156:157]=kind;h[257:265]=b'ustar\x0000';h[148:156]=('%06o\0 '%sum(h)).encode();return bytes(h)
 def refused(raw,cap):
  try:inspector.entries(raw,cap)
  except Exception:return
  check(False)
 # Extension bytes are included in the decompression cap, before header parsing.
 payload=b'x'*(1024*1024);pax=header(b'PaxHeader',b'x',len(payload))+payload+b'\0'*1024
 refused(gzip.compress(pax),1);refused(pax,2*MIB)
 refused(header(b'source/',b'5',0)*2+b'\0'*1024,MIB)
 refused(header(b'/',b'5',0)+b'\0'*1024,MIB)
 return {'tarMetadataDecompressionBound':'rejected','unsupportedPaxExtension':'rejected','duplicateDirectoryPath':'rejected','absoluteDirectoryPath':'rejected'}

def main():
 check(len(sys.argv)==2 and os.environ.get('GITHUB_REPOSITORY',REPOSITORY)==REPOSITORY)
 config=json_value(Path(sys.argv[1]).read_bytes());object_keys(config,['candidateCommit','candidateArtifact','helperArtifact','bridgeArtifact'])
 commit=config['candidateCommit'];check(type(commit) is str and re.fullmatch('[a-f0-9]{40}',commit) is not None and commit!='0'*40)
 candidate_pin=artifact_pin(config['candidateArtifact']);helper_pin=artifact_pin(config['helperArtifact'])
 # The helper is separately built/tested from this exact public candidate head.
 check(helper_pin['workflowHead']==commit)
 raw,source_evidence=download(candidate_pin,256*MIB);report,members,build=candidate(raw,commit)
 native,native_evidence=download(helper_pin,34*MIB);native_report=helper(native,commit)
 bridge_evidence=None
 if config['bridgeArtifact'] is not None:
  bridge_raw,bridge_evidence=download(artifact_pin(config['bridgeArtifact']),129*MIB);bridge=zip_members(bridge_raw,129*MIB)
  expected={path[len('bridge/'):]:value for path,value in build.items() if path.startswith('bridge/')};check(bridge==expected)
 # Wrong outer digest: separately call the same parser with a wrong expectation.
 with tempfile.TemporaryDirectory(prefix='review-negative-',dir=os.environ.get('RUNNER_TEMP')) as temporary:
  path=Path(temporary)/'candidate.zip';path.write_bytes(raw)
  wrong=subprocess.run([sys.executable,str(ROOT/'scripts/inspect-candidate-artifact.py'),str(path),commit,'0'*64],capture_output=True,timeout=90)
  check(wrong.returncode!=0 and json_value(wrong.stdout).get('status')=='INVALID_CANDIDATE')
 tampered=mutate_zip(raw,'control-room-source-'+commit+'.tar');code,negative=run_inspector(tampered,commit);check(code!=0 and negative.get('status')=='INVALID_CANDIDATE')
 check(len(zip_members(native)['OwnedProcess.exe'])>64)
 helper_changed=mutate_zip(native,'OwnedProcess.exe',64)
 check(zip_members(helper_changed)['OwnedProcess.exe'][:2]==b'MZ')
 try:helper(helper_changed,commit)
 except Exception:pass
 else:check(False)
 # The whole-source comparison independently rejects even self-consistent
 # manifest/archive substitutions; it does not trust embedded source identity.
 changed=dict(members);source='control-room-source-'+commit+'.tar';source_files=inspector.entries(changed[source],64*MIB,git_comment=commit);first=next(p for p in source_files if not p.startswith('source/bridge/'));source_files[first]=source_files[first]+b'\n'
 forged=io.BytesIO()
 with tarfile.open(fileobj=forged,mode='w') as tar:
  for name,value in source_files.items():
   info=tarfile.TarInfo(name);info.size=len(value);info.mode=0o644;tar.addfile(info,io.BytesIO(value))
 changed[source]=forged.getvalue();manifest=json_value(changed['manifest.json'])
 for item in manifest['artifacts']:
  if item['path']==source:item.update(bytes=len(changed[source]),sha256=sha(changed[source]))
 changed['manifest.json']=json.dumps(manifest).encode();forged_zip=repack(changed)
 code,_=run_inspector(forged_zip,commit);check(code==0)
 try:verify_source(changed[source],git_tree(commit),commit)
 except Exception:pass
 else:check(False)
 report.update({'status':'INTEGRITY_VERIFIED_REVIEW_ONLY','sourceGitTreeExactBytes':True,'candidateArtifact':source_evidence,'bridgeArtifact':bridge_evidence,'helperArtifact':native_evidence,'helper':native_report,'negativeControls':{'wrongOuterDigest':'rejected','changedInnerArchiveWithRecomputedOuterDigest':'rejected','changedWholeSourceAgainstGitTree':'rejected','changedHelperInteriorPreservingMZWithRecomputedOuterDigest':'rejected',**parser_negative_controls()},'releaseAccepted':False,'deployed':False,'providerExecution':False,'ownerDeviceAcceptance':False,'limitations':['Integrity does not establish reproducible build output or pass failed application gates.','Helper source binding is exact manifest plus public workflow-head provenance; compiler reproducibility is not asserted.','No artifact code was executed and no private runtime artifact was consumed.']})
 Path('artifact-verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,separators=(',',':')))

if __name__=='__main__':
 try:main()
 except Exception:
  print('PUBLIC_REVIEW_INTEGRITY_VERIFICATION_FAILED',file=sys.stderr);sys.exit(1)
