import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {samplePcCommandCenter,sanitizePcCommandCenter} from '../src/pc-command-center.mjs';
const now='2026-10-18T12:00:00Z';
const health=()=>({app:'pc-command-center',ready:true,worker_alive:true,collector_state:'running',last_sample_at:now,sample_age_seconds:1,hostname:'private-host',token:'secret'});
const summary=()=>({schema_version:1,timestamp:now,cpu:{percent:12.5},memory:{percent:32},gpus:[{id:'gpu-0',utilization_percent:99},{id:'gpu-1',utilization_percent:6,memory_used_bytes:2,memory_total_bytes:17,temperature_c:42}],disk_io:{read_bytes_per_sec:1000,write_bytes_per_sec:2000},network:{sent_bytes_per_sec:1000,received_bytes_per_sec:3000},prompt:'private prompt',path:'C:/private'});
test('sanitizer uses only explicitly selected GPU and strips private fields',()=>{
 const result=sanitizePcCommandCenter(health(),summary(),{instanceId:'pc',selectedGpuId:'gpu-1'});
 assert.equal(result.metrics.gpuUtilizationPercent,6);assert.equal(result.state,'ready');assert.ok(!JSON.stringify(result).includes('private'));assert.ok(!JSON.stringify(result).includes('secret'));
 assert.equal(sanitizePcCommandCenter(health(),summary(),{instanceId:'pc'}).metrics.gpuUtilizationPercent,null);
 assert.equal(sanitizePcCommandCenter(health(),summary(),{instanceId:'pc',selectedGpuId:'missing'}).diagnostic,'source_invalid');
 const changed=summary();changed.cpu.percent=-1;changed.memory.percent=101;changed.gpus[1].memory_used_bytes=20;
 const sanitized=sanitizePcCommandCenter(health(),changed,{instanceId:'pc',selectedGpuId:'gpu-1'});assert.equal(sanitized.metrics.cpuPercent,null);assert.equal(sanitized.metrics.memoryPercent,null);assert.equal(sanitized.metrics.gpuMemoryUsedBytes,null);
 const clock=health();clock.last_sample_at='2026-10-18T11:59:59Z';assert.equal(sanitizePcCommandCenter(clock,summary(),{instanceId:'pc'}).reportedAgeSeconds,null);
});
test('fixed numeric loopback reader GETs health and summary only; rejects redirects, oversized, invalid and hanging bodies',async()=>{
 let mode='valid';const requests=[];const sockets=new Set();
 const server=http.createServer((request,response)=>{
  requests.push([request.method,request.url]);response.setHeader('Content-Type','application/json');
  if(mode==='redirect'){response.writeHead(302,{Location:'http://127.0.0.1:47632/private'});response.end();return;}
  if(mode==='oversized'){response.writeHead(200,{'Content-Length':'262145'});response.end();return;}
  if(mode==='invalid'){response.end(Buffer.from([0xff]));return;}
  if(mode==='hang'){response.writeHead(200);response.write('{');return;}
  response.end(JSON.stringify(request.url==='/api/health'?health():summary()));
 });server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 // EADDRINUSE is a test failure: never connect to an unknown local service.
 server.listen(47631,'127.0.0.1');await once(server,'listening');
 const previous=process.env.HTTP_PROXY;process.env.HTTP_PROXY='http://127.0.0.1:1';
 try{
  const good=await samplePcCommandCenter({instanceId:'pc',selectedGpuId:'gpu-1',now:()=>now});assert.equal(good.state,'ready');assert.deepEqual(requests.sort(),[['GET','/api/health'],['GET','/api/summary']]);
  for(mode of ['redirect','oversized','invalid']){const result=await samplePcCommandCenter({instanceId:'pc',now:()=>now});assert.equal(result.state,'unavailable');assert.equal(result.diagnostic,'source_invalid');}
  mode='hang';const started=Date.now();const result=await samplePcCommandCenter({instanceId:'pc',now:()=>now});assert.equal(result.diagnostic,'source_unreachable');assert.ok(Date.now()-started<4000);
  assert.ok(requests.every(([method,path])=>method==='GET'&&['/api/health','/api/summary'].includes(path)));
 }finally{if(previous===undefined)delete process.env.HTTP_PROXY;else process.env.HTTP_PROXY=previous;for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
});
