import test from 'node:test';
import assert from 'node:assert/strict';
import {quorum,tally,remoteEligibility,compliance,protocolHTML} from '../council-rules.mjs';

const members=Array.from({length:16},(_,i)=>({id:i+1,name:`Член ${i+1}`,roles:['member'],is_active:true}));
const attendance=(n=16)=>Object.fromEntries(members.slice(0,n).map(m=>[m.id,{status:'present',role:'member'}]));
const votes=(f,a=0,b=0)=>[...Array(f).fill('for'),...Array(a).fill('against'),...Array(b).fill('abstain')].map((value,i)=>({member_id:i+1,value}));
const meeting={id:1,status:'active',started_at:'2026-10-31T15:00:00+03:00',attendance:attendance(),questions:[]};

test('quorum remains 9 of 16 with vacancies and excludes observers and unidentified remote',()=>{
  const a=attendance(8);a[9]={status:'remote',identified:false};a[10]={status:'present',role:'observer'};a[99]={status:'present'};
  assert.deepEqual(quorum(a,members),{present:8,total:16,needed:9,has_quorum:false});
  a[9].identified=true;assert.equal(quorum(a,members).has_quorum,true);
  assert.equal(quorum(attendance(8),members.slice(0,8)).needed,9);
});
test('simple majority includes abstentions; 7 of 14 fails, 8 passes',()=>{
  const r=tally({procedure:'decision',votes:votes(7,1,6)},meeting,members);assert.equal(r.needed,8);assert.equal(r.passed,false);
  assert.equal(tally({procedure:'decision',votes:votes(8,0,6)},meeting,members).passed,true);
});
test('procedural decisions use ordinary simple majority',()=>{
  for(const procedure of ['agenda_amendment','single_reading','circumstances','appeal','break','amendment','speech_rules']){
    assert.equal(tally({procedure,votes:votes(5,3,1)},meeting,members).passed,true);
    assert.equal(tally({procedure,votes:votes(4,4)},meeting,members).passed,false);
  }
});
test('all special decisions require 11 regardless of turnout',()=>{
  for(const procedure of ['charter_amendment','chair_recall','reprimand','veto_override']){
    assert.equal(tally({procedure,votes:votes(10)},meeting,members).passed,false);
    assert.equal(tally({procedure,votes:votes(11)},meeting,members).passed,true);
    assert.equal(tally({procedure,votes:votes(11)},meeting,members).needed,11);
  }
});
test('no votes or no quorum cannot pass; duplicate, invalid, observer ballots ignored',()=>{
  assert.equal(tally({votes:[]},meeting,members).passed,false);
  assert.equal(tally({votes:votes(8)}, {...meeting,attendance:attendance(8)},members).passed,false);
  const r=tally({votes:[...votes(8),{member_id:1,value:'against'},{member_id:99,value:'for'},{member_id:9,value:'anything'},{member_id:10,value:'for',choice_id:'x'}]},meeting,members);
  assert.equal(r.voters,8);assert.equal(r.for,8);
});
test('chair election uses plurality, ties only among top candidates',()=>{
  const choices=[{id:'a',text:'A'},{id:'b',text:'B'},{id:'c',text:'C'}];
  const ballots=[...Array(8).fill('a'),...Array(6).fill('b')].map((choice_id,i)=>({member_id:i+1,choice_id}));
  const r=tally({procedure:'chair_election',choices,votes:ballots},meeting,members);assert.equal(r.passed,true);assert.equal(r.winnerId,'a');
  ballots[7].choice_id='c';ballots.push({member_id:15,choice_id:'b'});
  const tie=tally({procedure:'chair_election',choices,votes:ballots},meeting,members);assert.equal(tie.passed,false);assert.deepEqual(tie.tiedIds,['a','b']);
});
test('closed result is immutable snapshot after attendance changes',()=>{
  const result=tally({votes:votes(10,2)},meeting,members);const q={status:'closed',result,votes:[]};
  const r=tally(q,{...meeting,attendance:{}},members);assert.equal(r.passed,true);r.for=0;assert.equal(q.result.for,10);
});
test('valid cast membership is frozen but closing quorum uses current members',()=>{
  const current=structuredClone(members);current[0].is_active=false;current[0].roles=[];
  const q={procedure:'decision',members_snapshot:structuredClone(members),votes:votes(9)};
  const result=tally(q,meeting,current);assert.equal(result.voters,9);assert.equal(result.for,9);assert.equal(result.quorum.present,15);assert.equal(result.passed,true);
  const lostQuorum=tally(q,{...meeting,attendance:attendance(9)},current);assert.equal(lostQuorum.for,9);assert.equal(lostQuorum.quorum.present,8);assert.equal(lostQuorum.passed,false);
});
test('remote participation monthly quota and consecutive ordinary meetings, emergency exemption',()=>{
  const before={...meeting,id:2,status:'closed',started_at:'2026-10-10T12:00:00Z',attendance:{1:{status:'remote',identified:true}},questions:[{votes:[{member_id:1,value:'for',mode:'remote'}]}]};
  const middle={...meeting,id:3,status:'closed',started_at:'2026-10-20T12:00:00Z',attendance:{1:{status:'present'}}};
  assert.equal(remoteEligibility(1,meeting,[before]).allowed,false);
  assert.match(remoteEligibility(1,meeting,[before,middle]).reason,/месяце/);
  assert.equal(remoteEligibility(1,{...meeting,meeting_type:'emergency'},[before]).allowed,true);
  const november={...meeting,id:4,started_at:'2026-11-02T12:00:00Z'};
  assert.equal(remoteEligibility(1,november,[before,middle]).allowed,true);
  assert.equal(remoteEligibility(1,november,[before]).allowed,false);
});
test('Moscow calendar month, emergency history does not consume quota',()=>{
  const m={...meeting,id:5,started_at:'2026-11-01T00:15:00+03:00'};
  const previous={...meeting,id:4,status:'closed',started_at:'2026-10-31T22:00:00Z',attendance:{1:{status:'remote',identified:true}},questions:[{votes:[{member_id:1,value:'for'}]}]};
  const middle={...meeting,id:6,status:'closed',started_at:'2026-10-31T22:30:00Z',attendance:{1:{status:'present'}}};
  // Both prior records actually occur after the target and must not affect eligibility.
  assert.equal(remoteEligibility(1,m,[previous,middle]).allowed,true);
  assert.equal(remoteEligibility(1,meeting,[{...previous,started_at:'2026-10-10T12:00:00Z',meeting_type:'emergency'}]).allowed,true);
});
test('remote history survives departure or a switch to onsite; server participation field is used',()=>{
  const previous={...meeting,id:2,status:'closed',started_at:'2026-10-10T12:00:00Z',attendance:{1:{status:'left',was_remote:true,voted_remotely:true}},questions:[{votes:[{member_id:1,value:'for',participation:'remote'}]}]};
  assert.equal(remoteEligibility(1,meeting,[previous]).allowed,false);
  const next={...meeting,id:3,status:'closed',started_at:'2026-10-20T12:00:00Z',attendance:{1:{status:'present'}}};
  assert.match(remoteEligibility(1,meeting,[previous,next]).reason,/месяце/);
  const historyOnly={...previous,attendance:{1:{status:'present'}},attendance_history:[{member_id:1,status:'remote'}],questions:[]};
  assert.equal(remoteEligibility(1,meeting,[historyOnly]).allowed,false);
  const votesOnly={...previous,attendance:{1:{status:'left'}},questions:[{votes:[{member_id:1,value:'for',participation:'remote'}]}]};
  assert.match(remoteEligibility(1,meeting,[votesOnly,next]).reason,/месяце/);
});
test('compliance excludes excused absence and does not invent 100% with empty denominator',()=>{
  const meetings=[{...meeting,status:'closed',questions:[{status:'closed',result:{},votes:[{member_id:1,value:'for'}]}]}, {...meeting,id:2,status:'closed',attendance:{1:{status:'absent',excused:true}}}];
  const [r]=compliance([members[0]],meetings,[{name:'IT',members:[1]}],[{author_id:1,status:'submitted'}]);
  assert.equal(r.meetings_total,1);assert.equal(r.attendance_percent,100);assert.equal(r.voting_percent,100);assert.deepEqual(r.warnings,[]);
  assert.equal(compliance([members[0]],[])[0].attendance_percent,null);
});
test('compliance thresholds use exact ratios rather than display rounding',()=>{
  const meetings=Array.from({length:3000},(_,i)=>({...meeting,id:i,status:'closed',attendance:i<2099?{1:{status:'present'}}:{},questions:[]}));
  const [r]=compliance([members[0]],meetings);assert.equal(r.attendance_percent,70);assert.equal(r.checks.attendance,false);
});
test('new mandate does not inherit meetings before membership snapshot',()=>{
  const older={...meeting,status:'closed',members_snapshot:[members[1]],attendance:{2:{status:'present'}},questions:[]};
  const newer={...meeting,id:2,status:'closed',members_snapshot:[members[0],members[1]],attendance:{1:{status:'present'}},questions:[]};
  const [r]=compliance([members[0]],[older,newer]);assert.equal(r.meetings_total,1);assert.equal(r.attendance_percent,100);
});
test('protocol escapes user content, uses snapshots and hides private attendance in public copy',()=>{
  const m={...meeting,title:'<script>alert(1)</script>',questions:[{id:1,title:'<img src=x onerror=bad>',status:'closed',decision_text:'Решение',result:{passed:true,for:8,against:0,abstain:0,voters:8,needed:5,reason:'Снимок'}}],requests:[{type:'dissent',member_id:1,text:'<b>Особое</b>'}],observers:[{name:'Гость',role:'observer'}]};
  const html=protocolHTML(m,members);assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('Снимок'));assert.ok(html.includes('Гость'));assert.ok(html.includes('&lt;b&gt;Особое&lt;/b&gt;'));
  const pub=protocolHTML(m,members,true);assert.ok(!pub.includes('Гость'));assert.ok(!pub.includes('Особое'));
});
test('protocol preserves historical membership names, absent members and coordinator arrival',()=>{
  const m={...meeting,meeting_type:'emergency',reason:'Срочная причина',attendance:{1:{status:'present'}},members_snapshot:[{id:1,name:'Историческое имя',roles:['member']},{id:2,name:'Отсутствовавший',roles:['member']}],observers:[{name:'Координатор Тест',coordinator:true,arrival_time:'2026-10-31T14:00:00Z'}]};
  const html=protocolHTML(m,[{id:1,name:'Новое имя',roles:['member']}]);
  assert.ok(html.includes('Историческое имя'));assert.ok(!html.includes('Новое имя'));assert.ok(html.includes('Отсутствовавший'));assert.ok(html.includes('отсутствует'));assert.ok(html.includes('Срочная причина'));assert.ok(html.includes('Координатор, без права голоса; прибыл:'));
});
test('protocol records changed articles, amendment versions and speech rules',()=>{
  const html=protocolHTML({...meeting,questions:[{id:1,title:'Проект',changed_articles:'Статьи 6 и 7',amended_text:'Предложение <новое>',amendments:[{question_id:'amendment-1',previous_text:'Старая редакция',new_text:'Новая редакция',at:'2026-10-31T12:00:00Z'}],speech_limits:{report:600,coreport:300,debate:240}}]},members);
  assert.ok(html.includes('Статьи 6 и 7'));assert.ok(html.includes('Предложение &lt;новое&gt;'));assert.ok(html.includes('Старая редакция'));assert.ok(html.includes('Новая редакция'));assert.ok(html.includes('прения — 240 сек.'));
});
test('public protocol includes only announced effective adopted decisions without unresolved veto',()=>{
  const effective={status:'closed',result:{passed:true,for:9,voters:9},announced_at:'2026-10-01T00:00:00Z',effective_at:'2026-10-01T00:00:00Z'};
  const m={...meeting,questions:[
    {...effective,id:1,title:'Действует'},
    {...effective,id:2,title:'Не объявлено',announced_at:null},
    {...effective,id:3,title:'Будущий акт',effective_at:'2099-01-01T00:00:00Z'},
    {...effective,id:4,title:'Вето действует',veto:{reason:'Возражение'}},
    {...effective,id:5,title:'Вето преодолено',veto:{reason:'Возражение',overridden_at:'2026-10-02T00:00:00Z'}},
    {...effective,id:6,title:'Не вступил',effective_at:null},
    {...effective,id:7,title:'Конфиденциальный',confidential:true},
  ]};
  const html=protocolHTML(m,members,true);assert.ok(html.includes('Действует'));assert.ok(html.includes('Вето преодолено'));
  for(const text of ['Не объявлено','Будущий акт','Вето действует','Не вступил','Конфиденциальный'])assert.ok(!html.includes(text),text);
});
