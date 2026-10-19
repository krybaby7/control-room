#!/usr/bin/env python3
"""Read-only, network-free candidate archive inspection. Never extracts to disk."""
import hashlib, io, json, re, sys, tarfile, zipfile
MIB=1024*1024
def require(ok):
    if not ok: raise ValueError("invalid_candidate")
def sha(b): return hashlib.sha256(b).hexdigest()
def obj(pairs):
    d={}
    for k,v in pairs:
        require(k not in d); d[k]=v
    return d
def decode(b,cap=8*MIB):
    require(len(b)<=cap)
    return json.loads(b.decode("utf-8"),object_pairs_hook=obj)
def safe(p):
    require(isinstance(p,str) and 0<len(p)<=1024 and "\\" not in p and not p.startswith("/") and not re.search(r"[\x00-\x1f\x7f]",p))
    parts=p.split("/")
    require(all(x not in ("","..",".") for x in parts))
    return p
def entries(raw,cap,maxfiles=20000):
    result={}; total=0; count=0
    with tarfile.open(fileobj=io.BytesIO(raw),mode="r|*") as tf:
        for m in tf:
            count+=1; require(count<=maxfiles*2)
            p=m.name
            if p in (".","./") and m.isdir(): continue
            if p.startswith("./"): p=p[2:]
            p=safe(p.rstrip("/") if m.isdir() else p)
            require(not m.issym() and not m.islnk() and not m.isdev() and not m.isfifo())
            if m.isdir(): continue
            require(m.isfile() and p not in result and 0<=m.size<=64*MIB)
            total+=m.size; require(total<=cap and len(result)<maxfiles)
            f=tf.extractfile(m); require(f is not None)
            b=f.read(m.size+1); require(len(b)==m.size)
            result[p]=b
    return result
def inventory(rows):
    require(isinstance(rows,list) and len(rows)<=20000)
    d={}
    for r in rows:
        require(isinstance(r,dict) and set(r)=={"path","bytes","sha256"})
        p=safe(r["path"]); require(p not in d and type(r["bytes"]) is int and 0<=r["bytes"]<=128*MIB and re.fullmatch("[a-f0-9]{64}",r["sha256"]) is not None)
        d[p]=r
    return d
def compare(files,rows):
    require(set(files)==set(rows))
    for p,b in files.items(): require(len(b)==rows[p]["bytes"] and sha(b)==rows[p]["sha256"])
def build_path(p):
    if p.startswith("bridge/"): return
    require(p.startswith(("dist/client/","dist/server/")))
    known={"dist/client/.assetsignore","dist/client/.vite/manifest.json","dist/server/.vite/manifest.json","dist/server/BUILD_ID"}
    if p in known: return
    for part in p.split("/")[2:]:
        require(not part.startswith(".") and not re.search(r"^(?:node_modules|credentials?|secrets?|tokens?|passwords?|private[-_]?keys?|owner[-_]?data|runtime[-_]?state|outbox|journal)(?:\.|$)",part,re.I))
        require(not re.search(r"\.(?:sqlite3?|db|pem|key|p12|pfx|log|ndjson|tgz|tar|gz|zip)$",part,re.I))
    require(re.search(r"\.(?:m?js|cjs|css|map|json|html|txt|xml|webmanifest|wasm|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico)$",p,re.I) is not None or p.rsplit("/",1)[-1] in ("_headers","_redirects"))
def main():
    require(len(sys.argv)==4)
    path,source,outer=sys.argv[1:]
    require(re.fullmatch("[a-f0-9]{40}",source) is not None and re.fullmatch("[a-f0-9]{64}",outer) is not None)
    with open(path,"rb") as f: raw=f.read(256*MIB+1)
    require(len(raw)<=256*MIB and sha(raw)==outer)
    sn="control-room-source-"+source+".tar"; bn="control-room-build-"+source+".tar.gz"
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        infos=z.infolist(); require(len(infos)==3 and {x.filename for x in infos}=={"manifest.json",sn,bn})
        require(all(not x.is_dir() and not x.flag_bits&1 and x.file_size<=128*MIB and ((x.external_attr>>16)&0o170000) not in (0o120000,0o060000,0o020000) for x in infos))
        require(sum(x.file_size for x in infos)<=200*MIB)
        data={x.filename:z.read(x) for x in infos}
    manifest=decode(data["manifest.json"])
    require(set(manifest)=={"format","version","sourceCommit","node","artifacts","files","limitations"} and manifest["format"]=="control-room-reviewable-candidate" and manifest["version"]==1 and manifest["sourceCommit"]==source)
    inner=inventory(manifest["artifacts"]); compare({sn:data[sn],bn:data[bn]},inner)
    require(len(data[sn])<=64*MIB)
    source_files=entries(data[sn],64*MIB)
    require(all(p.startswith("source/") for p in source_files))
    build=entries(data[bn],256*MIB)
    compare(build,inventory(manifest["files"]))
    for p in build: build_path(p)
    bridge=decode(build["bridge/manifest.json"])
    require(set(bridge)=={"format","version","sourceCommit","filename","bytes","sha256","files","acceptance"} and bridge["format"]=="control-room-bridge-package" and bridge["version"]==1 and bridge["sourceCommit"]==source)
    require(bridge["acceptance"]=={"automated":"See source-specific CI checks.","windows":"not-run","privateIngress":"unavailable","execution":"disabled"})
    filename=bridge["filename"]; require(re.fullmatch(r"control-room-windows-bridge-[0-9]+\.[0-9]+\.[0-9]+\.tgz",filename) is not None)
    require({p for p in build if p.startswith("bridge/")}=={"bridge/manifest.json","bridge/"+filename})
    packed=build["bridge/"+filename]; require(len(packed)==bridge["bytes"] and sha(packed)==bridge["sha256"])
    bf=entries(packed,128*MIB,100)
    require(all(p.startswith("package/") for p in bf))
    bf={p[len("package/"):]:b for p,b in bf.items()}; bi=inventory(bridge["files"]); require(10<=len(bi)<=100); compare(bf,bi)
    allowed=re.compile(r"(?:package\.json|README\.md|config\.example\.json|src/[a-z0-9-]+\.mjs|windows/[a-z0-9-]+\.ps1|executor/[a-z0-9-]+\.mjs|executor/README\.md|executor/config\.example\.json)")
    required={"package.json","src/cli.mjs","src/credentials.mjs","src/transport.mjs","windows/protect-credential.ps1","windows/run-bridge.ps1","windows/install-task.ps1","windows/uninstall-task.ps1","config.example.json","executor/cli.mjs","executor/runtime.mjs","executor/journal.mjs","executor/config.example.json"}
    require(required<=set(bf))
    for p,b in bf.items():
        require(allowed.fullmatch(p) is not None and source_files.get("source/bridge/"+p)==b)
    print(json.dumps({"status":"REVIEWABLE_CANDIDATE","sourceCommit":source,"outerZipSha256":outer,"innerArchives":[{"sha256":inner[n]["sha256"],"bytes":inner[n]["bytes"]} for n in (sn,bn)],"sourceFiles":len(source_files),"buildFiles":len(build),"bridgeFiles":len(bf),"bridgeSha256":sha(packed),"releaseAccepted":False,"deployed":False},separators=(",",":")))
if __name__=="__main__":
    try: main()
    except Exception:
        print('{"status":"INVALID_CANDIDATE"}')
        sys.exit(1)
