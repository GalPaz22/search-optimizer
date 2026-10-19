import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {dashboardChatEngine,studioConfig,runStudioTurn} from '../src/agent/studio-client.js';
test('customer chat defaults to Studio and never silently falls back when Studio is unconfigured',()=>{
 assert.equal(dashboardChatEngine({}),'studio');assert.throws(()=>dashboardChatEngine({DASHBOARD_CHAT_ENGINE:'typo'}));
 assert.throws(()=>studioConfig({NODE_ENV:'production'}));
 assert.throws(()=>studioConfig({NODE_ENV:'production',STUDIO_SERVICE_URL:'http://127.0.0.1:4320',STUDIO_CUSTOMER_API_TOKEN:'test'}));
 assert.equal(studioConfig({NODE_ENV:'production',STUDIO_SERVICE_URL:'https://studio.example.com',STUDIO_CUSTOMER_API_TOKEN:'test'}).origin,'https://studio.example.com');
});
test('Studio streaming handles chunk boundaries and rejects incomplete turns',async()=>{
 const oldUrl=process.env.STUDIO_SERVICE_URL,oldToken=process.env.STUDIO_CUSTOMER_API_TOKEN;let incomplete=false;
 const server=http.createServer((req,res)=>{assert.equal(req.url,'/api/customer-chat/turn');assert.equal(req.headers['x-studio-customer-token'],'test-only-token');res.writeHead(200,{'content-type':'application/x-ndjson'});res.write('{"type":"tool","name":"overview","id":"a"}\n');if(!incomplete){const line=JSON.stringify({type:'done',engine:'tenant-studio',summary:'שלום',actions:[],draft:null,usage:[],modelCalls:1});res.write(line.slice(0,21));res.write(line.slice(21));}res.end();});
 server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));process.env.STUDIO_SERVICE_URL=`http://127.0.0.1:${(server.address() as any).port}`;process.env.STUDIO_CUSTOMER_API_TOKEN='test-only-token';
 try{const events:any[]=[];const result=await runStudioTurn({apiKey:'own-store'},new AbortController().signal,async e=>{events.push(e);});assert.equal(result.summary,'שלום');assert.equal(events[0].name,'overview');incomplete=true;await assert.rejects(()=>runStudioTurn({},new AbortController().signal,async()=>{}),/תשובה מלאה/);}
 finally{await new Promise<void>(r=>server.close(()=>r()));if(oldUrl===undefined)delete process.env.STUDIO_SERVICE_URL;else process.env.STUDIO_SERVICE_URL=oldUrl;if(oldToken===undefined)delete process.env.STUDIO_CUSTOMER_API_TOKEN;else process.env.STUDIO_CUSTOMER_API_TOKEN=oldToken;}
});
