import os, sys, io, json, hashlib, zipfile, subprocess, tempfile
from pathlib import Path
from urllib.request import Request, build_opener, HTTPRedirectHandler, urlopen
from urllib.error import HTTPError
from urllib.parse import urlparse
SOURCE='e4af1fc5ae344a029f9677576963700c92aaefee'
DIGEST='3fd91ac8e6756bc20cc8b0caadebfbac7ca6e227dbd6b8241f6851e83d2e632f'
class NoRedirect(HTTPRedirectHandler):
 def redirect_request(self, req, fp, code, msg, headers, newurl): return None
def check(condition):
 if not condition: raise ValueError()
def main():
 req=Request('https://api.github.com/repos/krybaby7/control-room/actions/artifacts/12161504710/zip',headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json'})
 try: response=build_opener(NoRedirect()).open(req,timeout=20)
 except HTTPError as error:
  check(error.code in (301,302,303,307,308)); location=error.headers.get('Location',''); target=urlparse(location)
  check(target.scheme=='https' and not target.username and not target.password)
  response=urlopen(Request(location),timeout=30)
 with response: data=response.read(8*1024*1024+1)
 check(len(data)<=8*1024*1024 and hashlib.sha256(data).hexdigest()==DIGEST)
 inspector=str(Path('scripts/inspect-candidate-artifact.py').resolve())
 compile(Path(inspector).read_text(),'<review-artifact-inspector>','exec')
 with tempfile.TemporaryDirectory(prefix='control-room-review-',dir=os.environ['RUNNER_TEMP']) as folder:
  path=Path(folder)/'candidate.zip';path.write_bytes(data)
  def inspect(candidate,digest):
   return subprocess.run([sys.executable,inspector,str(candidate),SOURCE,digest],capture_output=True,text=True,timeout=60)
  good=inspect(path,DIGEST); check(good.returncode==0); result=json.loads(good.stdout)
  check(result.get('status')=='REVIEWABLE_CANDIDATE' and result.get('sourceCommit')==SOURCE and result.get('releaseAccepted') is False and result.get('deployed') is False)
  wrong=inspect(path,'0'*64);check(wrong.returncode!=0 and json.loads(wrong.stdout).get('status')=='INVALID_CANDIDATE')
  archive=zipfile.ZipFile(io.BytesIO(data)); changed=io.BytesIO()
  with zipfile.ZipFile(changed,'w',compression=zipfile.ZIP_DEFLATED) as output:
   for entry in archive.infolist():
    payload=archive.read(entry)
    if entry.filename=='control-room-source-'+SOURCE+'.tar':
     check(len(payload)>0);payload=bytes([payload[0]^1])+payload[1:]
    output.writestr(entry.filename,payload)
  badbytes=changed.getvalue();bad=Path(folder)/'tampered-inner.zip';bad.write_bytes(badbytes)
  corrupted=inspect(bad,hashlib.sha256(badbytes).hexdigest());check(corrupted.returncode!=0 and json.loads(corrupted.stdout).get('status')=='INVALID_CANDIDATE')
  result.update({'candidateArtifactId':12161504710,'packagingRunId':39196349095,'packagingWorkflowHead':'50c17a8c5239ea05cd71f847b2afd8ac9e2190f9','negativeControls':{'wrongOuterDigest':'rejected','changedInnerArchiveWithRecomputedOuterDigest':'rejected'},'releaseGateNote':'UNVALIDATED review package; main browser and D1 latency gates failed.'})
  Path('artifact-verification.json').write_text(json.dumps(result,indent=2)+'\n')
  print(json.dumps(result,separators=(',',':')))
try: main()
except Exception:
 print('REVIEW_ARTIFACT_VERIFICATION_FAILED',file=sys.stderr);sys.exit(1)
