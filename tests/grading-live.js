'use strict';

/**
 * Post-run grading check — NOT part of the unit suite (makes real API calls).
 *
 * Run: node tests/grading-live.js
 *
 * Case A: session executed as prescribed.
 * Case B: prescribed 3x15, ran 3x12 — the spec §4.2 case. Must read as a
 *         correct execution of the bail condition, NOT a failure.
 */

const fs=require('fs'),path=require('path');
const __DIR__ = __dirname;
for(const line of fs.readFileSync(path.join(__dirname,'..','.env.local'),'utf8').split('\n')){
  const m=line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');
}
const {_internals}=require(path.join(__dirname,'..','api','webhook.js'));
const {DEFAULT_BLOCK_STATE}=require(path.join(__dirname,'..','api','_coach-kb.js'));

const activity={type:'Run',name:'3x12min sub-T',start_date_local:'2026-08-04T06:00:00Z',
  distance:10*1609.34,moving_time:4200,elapsed_time:4260,average_speed:10*1609.34/4200,
  average_heartrate:142,max_heartrate:163,workout_type:3};
const laps=[
 {distance:2*1609.34,elapsed_time:1000,average_speed:2*1609.34/1000,average_heartrate:120,max_heartrate:130},
 {distance:1.85*1609.34,elapsed_time:720,average_speed:1.85*1609.34/720,average_heartrate:148,max_heartrate:154},
 {distance:0.2*1609.34,elapsed_time:120,average_speed:0.2*1609.34/120,average_heartrate:132,max_heartrate:140},
 {distance:1.86*1609.34,elapsed_time:720,average_speed:1.86*1609.34/720,average_heartrate:155,max_heartrate:160},
 {distance:0.2*1609.34,elapsed_time:120,average_speed:0.2*1609.34/120,average_heartrate:136,max_heartrate:142},
 {distance:1.84*1609.34,elapsed_time:720,average_speed:1.84*1609.34/720,average_heartrate:161,max_heartrate:166},
 {distance:1.5*1609.34,elapsed_time:800,average_speed:1.5*1609.34/800,average_heartrate:125,max_heartrate:132},
];
const sm={grayZone:{grayPct:31,easyPct:29,flagged:false,detail:'31% in the 136-152 band — expected for a quality session. Not a gray-zone error.'},
 absoluteBands:{pcts:{easy:29,gray:31,mp:4,subt:33,threshold:3,vo2:0}}};

(async()=>{
 const facts=_internals.buildGradingFacts(activity,laps,sm);
 const summary=_internals.buildActivitySummary(activity,laps);

 // Case A: session went to plan
 const t0=Date.now();
 const a=await _internals.generateAnalysis(summary,'',facts,
   {source:'planned key session',text:'Q2: 3x12min sub-T @ 6:28-6:40'},DEFAULT_BLOCK_STATE);
 console.log('── A: executed as prescribed ── '+(Date.now()-t0)+'ms\n'+a+'\n');

 // Case B: prescribed 3x15, he ran 3x12 because HR climbed → bail condition, NOT a failure
 const t1=Date.now();
 const b=await _internals.generateAnalysis(summary,'',facts,
   {source:'planned key session',text:'Q2: 3x15min sub-T. BAIL: if HR passes 165 on any rep, cut the session.'},DEFAULT_BLOCK_STATE);
 console.log('── B: cut short (3x15 prescribed, 3x12 run) ── '+(Date.now()-t1)+'ms\n'+b);
})();
