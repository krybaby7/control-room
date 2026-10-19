#!/usr/bin/env python3
"""Read-only, network-free candidate archive inspection. Never extracts to disk."""
import hashlib, io, json, re, sys, zipfile, zlib
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
def bounded_tar(raw,cap):
    require(type(raw) is bytes and type(cap) is int and 0<cap<=256*MIB)
    if raw[:2]!=b'\x1f\x8b': require(len(raw)<=cap);return raw
    decoder=zlib.decompressobj(31);chunks=[];size=0
    for offset in range(0,len(raw),65536):
        chunk=raw[offset:offset+65536]
        while chunk:
            value=decoder.decompress(chunk,cap-size+1);size+=len(value);require(size<=cap);chunks.append(value)
            chunk=decoder.unconsumed_tail
            require(not decoder.unused_data)
    require(decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail)
    return b''.join(chunks)
def entries(raw,cap,maxfiles=20000,git_comment=None,gnu_long=False):
    # Do not pass untrusted bytes to tarfile: it eagerly interprets PAX/GNU
    # extension sizes before member iteration. Entire decompression and each raw
    # 512-byte header are bounded before any metadata payload is considered.
    data=bounded_tar(raw,cap);require(len(data)%512==0)
    result={};seen=set();offset=0;count=0;comment=False;longname=None;ended=False
    def field(h,a,b):
        value=h[a:b];head,separator,tail=value.partition(b'\0');require(not separator or not tail.strip(b'\0'))
        return head.decode('utf-8')
    def octal(h,a,b):
        value=h[a:b].strip(b'\0 ');require(re.fullmatch(b'[0-7]+',value) is not None);return int(value,8)
    while offset<len(data):
        h=data[offset:offset+512];offset+=512
        if not any(h):
            require(longname is None and len(data)-offset>=512 and not any(data[offset:]));ended=True;break
        count+=1;require(count<=maxfiles*2+4)
        require(octal(h,148,156)==sum(h[:148])+8*32+sum(h[156:]))
        magic=h[257:263];require(magic in (b'ustar\0',b'ustar '))
        name=field(h,0,100);kind=h[156:157];size=octal(h,124,136)
        require(size<=64*MIB and offset+((size+511)//512)*512<=len(data))
        require(not field(h,157,257))
        prefix=field(h,345,500) if magic==b'ustar\0' else ''
        if prefix:name=prefix+'/'+name
        # Git archive's sole inert global comment is accepted only as exactly
        # 52 bytes bound to the independently selected source commit. No PAX
        # override, per-file extension, sparse map or GNU link extension enters.
        if kind==b'g':
            require(git_comment is not None and not comment and count==1 and name=='pax_global_header' and size==52 and longname is None)
            require(data[offset:offset+size]==('52 comment='+git_comment+'\n').encode('ascii'));comment=True
        elif kind==b'L':
            # Actual GNU build packaging needs two >100-byte generated paths.
            # Interpret only a bounded NUL-terminated next-file name, never a
            # general GNU/PAX metadata parser or any sparse/link semantics.
            require(gnu_long and longname is None and name=='././@LongLink' and 2<=size<=1025)
            payload=data[offset:offset+size];require(payload[-1:]==b'\0' and b'\0' not in payload[:-1]);longname=payload[:-1].decode('utf-8')
            safe(longname[2:] if longname.startswith('./') else longname)
        else:
            require(kind in (b'0',b'\0',b'5'))
            if longname is not None:
                require(kind in (b'0',b'\0') and not prefix and name.encode('utf-8')==longname.encode('utf-8')[:100]);name=longname;longname=None
            root_header=kind==b'5' and name in ('.','./')
            if name.startswith('./'):name=name[2:]
            if kind==b'5':
                require(size==0)
                if name.endswith('/'):name=name[:-1]
                if name in ('','.'):require(root_header);name='__archive_root__'
            else:require(len(result)<maxfiles)
            if name!='__archive_root__':name=safe(name)
            require(name not in seen);seen.add(name)
            if kind!=b'5':result[name]=data[offset:offset+size]
        end=offset+size;offset+=((size+511)//512)*512;require(not any(data[end:offset]))
    require(ended and longname is None);return result
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
    parts=p.split('/')
    framework=re.fullmatch(r'dist/server/_next/static/framework~index[A-Za-z0-9_~-]*\.js',p) is not None
    require(len(p)<=1024 and all(part and part not in ('.','..') and not part.endswith((' ','.')) and (re.fullmatch(r'[A-Za-z0-9_@+(), .-]+',part) is not None or framework and index==len(parts)-1) for index,part in enumerate(parts)))
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
        require(all(not x.is_dir() and not x.flag_bits&1 and x.file_size<=128*MIB and ((x.external_attr>>16)&0o170000) in (0,0o100000) for x in infos))
        require(sum(x.file_size for x in infos)<=200*MIB)
        data={x.filename:z.read(x) for x in infos}
    manifest=decode(data["manifest.json"])
    require(set(manifest)=={"format","version","sourceCommit","node","artifacts","files","limitations"} and manifest["format"]=="control-room-reviewable-candidate" and manifest["version"]==1 and manifest["sourceCommit"]==source)
    inner=inventory(manifest["artifacts"]); compare({sn:data[sn],bn:data[bn]},inner)
    require(len(data[sn])<=64*MIB)
    source_files=entries(data[sn],64*MIB,git_comment=source)
    require(all(p.startswith("source/") for p in source_files))
    build=entries(data[bn],256*MIB,gnu_long=True)
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
    allowed=re.compile(r"(?:package\.json|README\.md|config\.example\.json|src/[a-z0-9-]+\.mjs|windows/[a-z0-9-]+\.ps1|executor/[a-z0-9-]+\.mjs|executor/README\.md|executor/config\.example\.json|executor/launch-config\.example\.json|windows/owned-process/(?:Program\.cs|OwnedProcess\.csproj|README\.md))")
    required={"package.json","src/cli.mjs","src/credentials.mjs","src/transport.mjs","windows/protect-credential.ps1","windows/run-bridge.ps1","windows/install-task.ps1","windows/uninstall-task.ps1","config.example.json","executor/cli.mjs","executor/runtime.mjs","executor/journal.mjs","executor/config.example.json"}
    require(required<=set(bf))

    expected_bridge={
      "package.json","README.md","config.example.json",
      *("src/"+n+".mjs" for n in ["agent-lab-import","agent-lab","cli","config","credentials","execution-policy","outbox","pc-command-center","sites-access","site-identity","transport","windows-state"]),
      *("executor/"+n+".mjs" for n in ["artifact-upload","artifacts","claims","cli","codec","completion","connection","content-policy","executor","journal","launch-config","lease","operations","owned-process","recovery","runner","runtime-install","runtime","store","transport","wire","workspace"]),
      "executor/README.md","executor/config.example.json","executor/launch-config.example.json",
      *("windows/"+n+".ps1" for n in ["install-task","protect-credential","protect-owned-helper","protect-state","run-bridge","uninstall-task"]),
      "windows/owned-process/Program.cs","windows/owned-process/OwnedProcess.csproj","windows/owned-process/README.md"}
    require(len(expected_bridge)==49 and set(bf)==expected_bridge)
    package_manifest=decode(bf['package.json'])
    require(package_manifest.get('name')=='control-room-windows-bridge' and filename=='control-room-windows-bridge-'+package_manifest.get('version','')+'.tgz')

    for p,b in bf.items():
        require(allowed.fullmatch(p) is not None and source_files.get("source/bridge/"+p)==b)
    print(json.dumps({"status":"REVIEWABLE_CANDIDATE","sourceCommit":source,"outerZipSha256":outer,"innerArchives":[{"sha256":inner[n]["sha256"],"bytes":inner[n]["bytes"]} for n in (sn,bn)],"sourceFiles":len(source_files),"buildFiles":len(build),"bridgeFiles":len(bf),"bridgeSha256":sha(packed),"releaseAccepted":False,"deployed":False},separators=(",",":")))
if __name__=="__main__":
    try: main()
    except Exception:
        print('{"status":"INVALID_CANDIDATE"}')
        sys.exit(1)

