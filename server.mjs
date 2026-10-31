import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES, quorum, tally, remoteEligibility, compliance, protocolHTML } from './council-rules.mjs';

const ROOT=dirname(fileURLToPath(import.meta.url));
const DATA=resolve(process.env.COUNCIL_DATA_DIR || join(ROOT,'data'));
mkdirSync(DATA,{recursive:true});
const db=new DatabaseSync(join(DATA,'council.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, member_id TEXT NOT NULL, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS materials (id TEXT PRIMARY KEY, content BLOB NOT NULL);');
const initial={version:1,members:[],meetings:[],groups:[],tasks:[],correspondence:[],initiatives:[],discipline:[],audit:[],displays:[],settings:{established_members:16,convocation:'Текущий созыв',timezone:'Europe/Moscow'}};
db.prepare('INSERT OR IGNORE INTO state(id,body) VALUES (1,?)').run(JSON.stringify(initial));
const load=()=>JSON.parse(db.prepare('SELECT body FROM state WHERE id=1').get().body);
const save=s=>db.prepare('UPDATE state SET body=? WHERE id=1').run(JSON.stringify(s));
// Change the registry terminology without rewriting adopted protocols or source documents.
{
  const s=load();
  if(!s.settings.committee_nomenclature){
    for(const g of s.groups){const renamed=g.name.replace(/^рабочая группа(?=\s|$)/iu,'Внутренний комитет');if(renamed!==g.name){(g.previous_names||=[]).push(g.name);g.name=renamed;}}
    s.settings.committee_nomenclature=true;save(s);
  }
}
const now=()=>new Date().toISOString();
const uid=()=>randomBytes(12).toString('hex');
const fail=(status,message)=>{const e=new Error(message);e.status=status;throw e;};
const ensure=(value,message,status=400)=>{if(!value)fail(status,message);};
const text=(value,label,max=10000)=>{ensure(typeof value==='string'&&value.trim().length>0,`Заполните поле «${label}»`);ensure(value.length<=max,`Поле «${label}» слишком длинное`);return value.trim();};
const optional=(value,max=10000)=>{if(value==null)return '';ensure(typeof value==='string'&&value.length<=max,'Неверный текст');return value.trim();};
const oneOf=(v,values,label)=>{ensure(values.includes(v),`Неверное значение: ${label}`);return v;};
const date=(v,label)=>{ensure(typeof v==='string'&&Number.isFinite(Date.parse(v)),`Укажите дату: ${label}`);return new Date(v).toISOString();};
const digest=v=>createHash('sha256').update(v).digest('hex');
function hash(password){ensure(typeof password==='string'&&password.length>=8&&password.length<=200,'Пароль должен содержать от 8 до 200 символов');const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(password,salt,64).toString('hex');}
function verify(password,stored){if(typeof password!=='string'||password.length>200)return false;const [salt,h]=stored.split(':');const value=scryptSync(password,salt,64);return timingSafeEqual(value,Buffer.from(h,'hex'));}
const member=(s,id)=>{const m=s.members.find(m=>m.id===id);ensure(m,'Участник не найден',404);return m;};
const office=me=>ensure(me.roles.some(r=>['chairman','secretary'].includes(r)),'Действие доступно председателю или секретарю',403);
const chairman=me=>ensure(me.roles.includes('chairman'),'Действие доступно председателю',403);
const activeMember=me=>ensure(me.active!==false&&me.roles.includes('member'),'Требуется действующий мандат члена совета',403);
const getMeeting=(s,id)=>{const m=s.meetings.find(m=>m.id===id);ensure(m,'Заседание не найдено',404);return m;};
const getQuestion=(s,id)=>{for(const meeting of s.meetings){const question=meeting.questions.find(q=>q.id===id);if(question)return {meeting,question};}fail(404,'Вопрос не найден');};
function writable(m){ensure(m.status!=='closed','Заседание закрыто; исторические данные сохранены');}
function attending(s,m,id){const a=m.attendance[id];const mem=member(s,id);return mem.active!==false&&mem.roles.includes('member')&&a?.role!=='observer'&&(a?.status==='present'||(a?.status==='remote'&&a.identified===true));}
function audit(s,me,action,body){const safe={...body};delete safe.password;delete safe.new_password;delete safe.current_password;delete safe.data;if(action==='vote.cast'){delete safe.value;delete safe.choice_id;}s.audit.push({id:uid(),at:now(),actor_id:me?.id,action,details:safe});}
function publicMember(m){const {password_hash,...rest}=m;return rest;}
function recipient(s,type='council',id=null){
  if(type==='council')return {type,id:null,label:'Малый совет'};
  if(type==='member'){const m=member(s,id);ensure(m.active!==false,'Выбранный член совета больше не принимает обращения');return {type,id:m.id,label:m.name};}
  if(type==='position'){ensure(['chairman','secretary'].includes(id),'Выберите должность');return {type,id,label:id==='chairman'?'Председатель совета':'Секретарь совета'};}
  if(type==='group'){const g=s.groups.find(g=>g.id===id&&g.status==='active');ensure(g,'Выбранный внутренний комитет больше не принимает обращения');return {type,id:g.id,label:g.name};}
  fail(400,'Выберите адресата');
}
function snapshot(s,me,extra={}){
  const out=structuredClone(s);delete out.displays;
  out.members=out.members.map(publicMember);
  const privileged=me&&me.roles.some(r=>['chairman','secretary'].includes(r));
  out.submissions=privileged?(out.submissions||[]).map(({tracking_hash,...entry})=>entry):[];
  if(!privileged)out.audit=[];
  for(const meeting of out.meetings){meeting.quorum=quorum(meeting.attendance,out.members);for(const q of meeting.questions){
    q.result=q.status==='closed'&&q.result?q.result:tally(q,meeting,out.members);
    q.my_vote=q.votes.find(v=>v.member_id===me?.id)||null;
    if(q.status==='opened'&&q.vote_type==='secret')q.result={voters:q.votes.length,for:0,against:0,abstain:0,choices:[],reason:'Итоги тайного голосования доступны после закрытия'};
    // Secret votes are never sent with identities, including to the officers.
    if(q.vote_type==='secret'||q.status==='opened')q.votes=[];
  }}
  out.stats=compliance(s.members,s.meetings,s.groups,s.initiatives);
  const alerts=[];
  for(const t of s.tasks)if(t.status!=='done'&&t.due_date&&Date.parse(t.due_date)<Date.now())alerts.push({type:'task',text:`Просрочено поручение: ${t.title}`,id:t.id});
  for(const c of s.correspondence)if(c.status!=='answered'&&Date.parse(c.due_date)<Date.now())alerts.push({type:'correspondence',text:`Истёк срок ответа: ${c.title}`,id:c.id});
  for(const g of s.groups)if(g.status==='active'&&Date.parse(g.report_due_at)<Date.now())alerts.push({type:'group',text:`Ожидается ежемесячный отчёт: ${g.name}`,id:g.id});
  for(const m of s.meetings)if(m.status==='closed'&&!m.coordinator_sent_at&&Date.parse(m.coordinator_due_at)<Date.now())alerts.push({type:'coordinator',text:`Передайте решения Координатору: ${m.title}`,id:m.id});
  const latest=s.meetings.filter(m=>m.meeting_type==='regular'&&m.started_at).sort((a,b)=>Date.parse(b.started_at)-Date.parse(a.started_at))[0];
  if(latest&&Date.now()-Date.parse(latest.started_at)>14*86400000)alerts.push({type:'meeting',text:'Прошло более двух недель с очередного заседания'});
  out.alerts=alerts;
  return {...out,setupRequired:s.members.length===0,me:me?publicMember(me):null,rules:RULES,...extra};
}
function session(req){const raw=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('council_session='))?.slice(16);if(!raw)return null;const row=db.prepare('SELECT * FROM sessions WHERE token=? AND expires>?').get(digest(raw),Date.now());if(!row)return null;return load().members.find(m=>m.id===row.member_id)||null;}
function issue(res,id){const raw=uid()+uid();db.prepare('INSERT INTO sessions(token,member_id,expires) VALUES (?,?,?)').run(digest(raw),id,Date.now()+12*3600000);res.setHeader('Set-Cookie',`council_session=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);}
function visibleDisplay(s,m){return {meeting:{id:m.id,title:m.title,status:m.status,format:m.format,scheduled_at:m.scheduled_at,quorum:quorum(m.attendance,s.members),questions:m.questions.map(q=>({id:q.id,title:q.title,order_num:q.order_num,status:q.status,procedure:q.procedure,result:q.status==='closed'?q.result:{voters:q.votes.length},veto:q.veto,announced_at:q.announced_at})),current_question_id:m.current_question_id,speaker:m.requests.find(r=>r.status==='granted')?{name:m.requests.find(r=>r.status==='granted').member_name,started_at:m.requests.find(r=>r.status==='granted').started_at,speech_seconds:m.requests.find(r=>r.status==='granted').speech_seconds}:null}};}
const procedures=['decision','resolution','charter_amendment','chair_recall','reprimand','veto_override','chair_election','secretary_election','agenda','group_create','group_close','mandate_termination','agenda_amendment','single_reading','circumstances','appeal','break','amendment','speech_rules'];
function apply(s,me,b){
  const action=text(b.action,'Действие',80);
  if(action==='mandate.appeal'){
    const {question:q}=getQuestion(s,b.question_id);ensure(q.procedure==='mandate_termination'&&q.candidate_id===me.id&&q.result?.passed&&q.announced_at,'Можно обжаловать решение о собственном мандате',403);ensure(!q.mandate_appeal,'Апелляция уже зарегистрирована');q.mandate_appeal={text:text(b.reason,'Апелляция'),at:now(),status:'pending',authority:'Компетентная вышестоящая инстанция Движения'};audit(s,me,action,b);return {};
  }
  if(action!=='password.change')activeMember(me);
  let extra={};
  if(action==='member.add'){
    office(me);ensure(s.members.filter(x=>x.active!==false).length<16,'Установленный состав — 16 членов; наблюдателей добавляйте отдельно');
    const name=text(b.name,'ФИО',200);ensure(!s.members.some(m=>m.name.toLocaleLowerCase()===name.toLocaleLowerCase()),'Участник с таким именем уже есть');
    s.members.push({id:uid(),name,telegram:optional(b.telegram,200),roles:['member'],active:true,adult:b.adult===true,password_hash:hash(b.password),created_at:now()});
  }else if(action==='password.change'){
    ensure(verify(b.current_password,me.password_hash),'Текущий пароль неверен',403);member(s,me.id).password_hash=hash(b.new_password);
  }else if(action==='meeting.create'){
    office(me);const type=oneOf(b.meeting_type||'regular',['regular','extraordinary','emergency'],'тип заседания');const reason=optional(b.reason);
    if(type==='emergency')text(reason,'Обоснование экстренности');
    if(type==='extraordinary'){ensure(b.initiator==='chairman'||b.initiator==='coordinator'||(Array.isArray(b.signatories)&&new Set(b.signatories).size>=6),'Внеочередное заседание: инициатор председатель/координатор или 6 членов');if(Array.isArray(b.signatories))b.signatories.forEach(id=>ensure(member(s,id).active!==false,'Недействующий подписант'));}
    s.meetings.push({id:uid(),title:text(b.title,'Название',300),meeting_type:type,format:oneOf(b.format||'mixed',['present','remote','mixed'],'формат'),scheduled_at:date(b.scheduled_at,'Начало'),location:optional(b.location,500),reason,status:'preparing',attendance:{},attendance_history:[],observers:[],questions:[],requests:[],notes:[],current_question_id:null,agenda_approved:false,protocol_num:s.meetings.length+1,created_at:now(),created_by:me.id,signatories:b.signatories||[],initiator:b.initiator||'chairman'});
  }else if(action.startsWith('meeting.')){
    office(me);const m=getMeeting(s,b.meeting_id);writable(m);
    if(action==='meeting.publish'){
      ensure(m.status==='preparing','Повестка уже в работе');ensure(m.questions.length,'Сначала добавьте вопросы в проект повестки');
      if(m.meeting_type==='regular')ensure(Date.parse(m.scheduled_at)-Date.now()>=24*3600000,'Повестка очередного заседания должна быть подготовлена за 24 часа до начала; перенесите время заседания');
      m.published_at=now();m.published_agenda=m.questions.map(q=>({id:q.id,title:q.title,text:q.text}));m.notification_status='prepared';
    }else if(action==='meeting.start'){
      ensure(m.status==='preparing','Заседание уже открыто');ensure(m.published_at,'Подготовьте повестку и отметьте её рассылку');ensure(m.agenda_sent_at,'Подтвердите фактическую рассылку повестки');
      if(m.meeting_type==='regular'){ensure(Date.parse(m.scheduled_at)-Date.parse(m.agenda_sent_at)>=24*3600000,'Рассылка выполнена менее чем за 24 часа; перенесите заседание');ensure(Date.now()-Date.parse(m.agenda_sent_at)>=24*3600000,'После фактической рассылки очередной повестки должно пройти не менее 24 часов');}
      m.status='active';m.started_at=now();m.opening_quorum=quorum(m.attendance,s.members);m.members_snapshot=s.members.map(publicMember);m.chairman_name=s.members.find(x=>x.roles.includes('chairman'))?.name||'';m.secretary_name=s.members.find(x=>x.roles.includes('secretary'))?.name||'';
    }else if(action==='meeting.sent'){
      ensure(m.published_at,'Сначала подготовьте повестку');m.agenda_sent_at=now();m.notification_status='sent';
    }else if(action==='meeting.focus'){
      if(b.question_id)ensure(m.questions.some(q=>q.id===b.question_id),'Вопрос не относится к заседанию');m.discussion_question_id=b.question_id||null;
    }else if(action==='meeting.reschedule'){
      ensure(m.status==='preparing','Перенос доступен до открытия');m.scheduled_at=date(b.scheduled_at,'Начало');m.agenda_sent_at=null;m.published_at=null;
    }else if(action==='meeting.pause'){
      ensure(m.status==='active','Заседание не идёт');ensure(!m.questions.some(q=>q.status==='opened'),'Сначала завершите голосование');m.status='paused';m.notes.push({id:uid(),text:'Объявлен перерыв',at:now(),speaker:me.name});
    }else if(action==='meeting.resume'){ensure(m.status==='paused','Перерыв не объявлен');m.status='active';
    }else if(action==='meeting.close'){
      ensure(['active','paused'].includes(m.status),'Заседание ещё не открыто');ensure(!m.questions.some(q=>q.status==='opened'),'Завершите открытое голосование');ensure(!m.questions.some(q=>q.status==='closed'&&q.result?.passed&&!q.announced_at&&!q.veto&&!q.runoff_question_id),'Объявите результаты принятых решений либо оформите вето');m.status='closed';m.closed_at=now();m.closing_quorum=quorum(m.attendance,s.members);m.coordinator_due_at=new Date(Date.now()+24*3600000).toISOString();
    }else fail(400,'Неизвестное действие заседания');
  }else if(action==='attendance.set'){
    office(me);const m=getMeeting(s,b.meeting_id);writable(m);const target=member(s,b.member_id);ensure(target.active!==false,'Мандат участника прекращён');const status=oneOf(b.status,['present','remote','absent','left'],'присутствие');
    if(status==='remote'){
      ensure(m.format!=='present'||m.meeting_type==='emergency','Для дистанционного участия измените формат заседания на смешанный');ensure(b.identified===true,'Подтвердите идентификацию дистанционного участника');const result=remoteEligibility(target.id,m,s.meetings);ensure(result.allowed,result.reason);
    }
    if(status==='present')ensure(m.format!=='remote'||m.meeting_type==='emergency','Заседание объявлено дистанционным');
    const previous=m.attendance[target.id]||{};const a={...previous,status,role:'member',identified:status==='present'||b.identified===true,excused:b.excused===true,excuse_reason:optional(b.excuse_reason,1000),updated_at:now()};
    if(a.excused)text(a.excuse_reason,'Уважительная причина');
    if(['present','remote'].includes(status)&&!['present','remote'].includes(previous.status))a.arrival_time=now();if(status==='left')a.departure_time=now();if(status==='present')a.was_present=true;if(status==='remote')a.was_remote=true;
    m.attendance[target.id]=a;m.attendance_history.push({member_id:target.id,name:target.name,...a,at:now()});
  }else if(action==='observer.add'){
    office(me);const m=getMeeting(s,b.meeting_id);writable(m);m.observers.push({id:uid(),name:text(b.name,'Имя наблюдателя',200),status:oneOf(b.status||'present',['present','remote'],'форма участия'),role:'observer',arrival_time:now(),coordinator:b.coordinator===true});
  }else if(action==='question.add'){
    const m=getMeeting(s,b.meeting_id);writable(m);ensure(m.status==='preparing'||['chairman','secretary'].some(r=>me.roles.includes(r)),'Во время заседания направьте предложение председателю');
    const procedure=oneOf(b.procedure||'decision',procedures,'процедура');
    const q={id:uid(),order_num:m.questions.length+1,title:text(b.title,'Вопрос',500),text:optional(b.text,30000),decision_text:optional(b.decision_text,30000)||b.title,procedure,vote_type:oneOf(b.vote_type||'open',['open','roll_call','secret'],'форма голосования'),status:'pending',votes:[],choices:[],subject:optional(b.subject,300),reading:Number(b.reading)||0,parent_id:b.parent_id||null,candidate_id:b.candidate_id||null,assignee_id:b.assignee_id||null,due_date:b.due_date?date(b.due_date,'Срок'):null,group_name:optional(b.group_name,300),created_by:me.id,created_at:now(),round:1};
    if(procedure==='chair_election'){
      ensure(q.vote_type==='open','Председатель избирается открытым голосованием');ensure(Array.isArray(b.choices)&&b.choices.length>=1,'Добавьте кандидатов');const unique=new Set();
      q.choices=b.choices.map(c=>{const id=typeof c==='object'?c.member_id:c;const mem=member(s,id);ensure(mem.active!==false&&mem.adult===true,'Кандидат в председатели должен быть совершеннолетним членом Совета');ensure(!unique.has(id),'Кандидат указан повторно');unique.add(id);return {id:uid(),text:mem.name,member_id:id};});
    }
    if(['secretary_election','chair_recall','mandate_termination','reprimand'].includes(procedure))ensure(q.candidate_id&&member(s,q.candidate_id).active!==false,'Выберите действующего члена Совета');
    if(q.assignee_id)member(s,q.assignee_id);
    if(procedure==='single_reading'){q.subject=text(b.subject,'Предмет проекта',300);ensure(b.no_objections===true,'Одно чтение допускается при готовом тексте и отсутствии возражений');q.no_objections=true;}
    if(procedure==='circumstances')q.subject=text(b.subject,'Предмет резолюции',300).toLocaleLowerCase('ru');
    if(procedure==='appeal'){q.discipline_id=text(b.discipline_id,'Обжалуемая мера',100);const d=s.discipline.find(x=>x.id===q.discipline_id);ensure(d&&d.issuer==='chairman'&&d.status==='appealed','Совет рассматривает апелляцию на выговор председателя');q.candidate_id=d.member_id;}
    if(procedure==='resolution'){
      q.subject=text(b.subject,'Постоянный предмет резолюции',300).toLocaleLowerCase('ru');
      const attempts=s.meetings.flatMap(x=>x.questions).filter(x=>x.procedure==='resolution'&&x.subject===q.subject).length;
      if(attempts>=3){const changed=b.circumstances_question_id&&getQuestion(s,b.circumstances_question_id).question;ensure(changed?.procedure==='circumstances'&&changed.subject===q.subject&&changed.result?.passed&&changed.announced_at,'По одному предмету допускаются 3 попытки; нужно решение о существенном изменении обстоятельств по этому предмету');ensure(s.meetings.flatMap(x=>x.questions).filter(x=>x.procedure==='resolution'&&x.subject===q.subject&&x.circumstances_question_id===changed.id).length<3,'Три попытки по новым обстоятельствам уже использованы');q.circumstances_question_id=b.circumstances_question_id;}
    }
    if(procedure==='group_close'){q.group_id=text(b.group_id,'Внутренний комитет',100);q.transfer_to=text(b.transfer_to,'Передача функций');ensure(s.groups.some(g=>g.id===q.group_id&&g.status==='active'),'Внутренний комитет не найден');if(!me.roles.includes('chairman')){ensure(Array.isArray(b.signatories)&&new Set(b.signatories).size>=6,'Ликвидацию инициирует председатель либо не менее 6 членов');b.signatories.forEach(id=>ensure(member(s,id).active!==false,'Подписант не является действующим членом Совета'));q.signatories=b.signatories;}}
    if(procedure==='group_create')q.group_name=text(b.group_name,'Название внутреннего комитета',300);
    if(procedure==='mandate_termination'){q.notice=text(b.notice,'Уведомление и предъявленные основания');q.explanation=text(b.explanation,'Предоставление слова / объяснения');}
    if(procedure==='chair_recall')ensure(member(s,q.candidate_id).roles.includes('chairman'),'Выбранный участник не является председателем');
    q.normative=b.normative===true||procedure==='charter_amendment';q.single_reading_id=b.single_reading_id||null;
    if(q.normative){q.subject=text(b.subject,'Единый предмет нормативного проекта',300);text(q.text,'Текст нормативного проекта');}
    q.public=b.public!==false;q.confidential=b.confidential===true;q.public_summary=optional(b.public_summary,10000);
    if(b.parent_id){const parent=getQuestion(s,b.parent_id);ensure(parent.meeting.id===m.id,'Связанный вопрос относится к другому заседанию');}
    if(b.curator_invited_at)q.curator_invited_at=date(b.curator_invited_at,'Приглашение куратора');q.curator_explanation=optional(b.curator_explanation);q.no_confidence=b.no_confidence===true;
    if(q.no_confidence)ensure(q.curator_invited_at&&q.curator_explanation,'До недоверия зафиксируйте приглашение куратора и результат предоставления объяснений');
    if(q.procedure==='charter_amendment')ensure([1,2].includes(q.reading),'Выберите первое или второе чтение');
    if(procedure==='charter_amendment')q.changed_articles=text(b.changed_articles,'Изменяемые статьи Устава',2000);
    if(procedure==='amendment'){const parent=getQuestion(s,q.parent_id).question;ensure(m.questions.includes(parent)&&parent.normative&&parent.status==='pending'&&parent.reading!==1,'Поправка вносится к ещё не проголосованному итоговому нормативному проекту этого заседания');q.amended_text=text(b.amended_text,'Предлагаемая редакция текста проекта',30000);}
    if(procedure==='speech_rules'){q.speech_limits={};for(const kind of ['report','coreport','debate']){const seconds=Number(b[kind+'_seconds']);ensure(Number.isInteger(seconds)&&seconds>=30&&seconds<=3600,'Регламент: целое число секунд от 30 до 3600');q.speech_limits[kind]=seconds;}}
    if(m.status!=='preparing'&&procedure!=='agenda_amendment'){
      const permission=b.agenda_amendment_id&&getQuestion(s,b.agenda_amendment_id).question;
      ensure(permission?.procedure==='agenda_amendment'&&m.questions.includes(permission)&&permission.result?.passed&&permission.announced_at,'Дополнительный вопрос требует принятой на этом заседании поправки к повестке');q.agenda_amendment_id=b.agenda_amendment_id;
    }
    m.questions.push(q);
    if(m.status==='preparing'&&m.published_at){m.published_at=null;m.agenda_sent_at=null;m.notification_status='changed';}
  }else if(action.startsWith('question.')){
    office(me);const {meeting:m,question:q}=getQuestion(s,b.question_id);writable(m);
    if(action==='question.open'){
      ensure(m.status==='active','Откройте заседание или завершите перерыв');ensure(q.status==='pending','Вопрос уже вынесен на голосование');ensure(!m.questions.some(x=>x.status==='opened'),'Одновременно проводится одно голосование');ensure(quorum(m.attendance,s.members).has_quorum,'Нет кворума: нужно 9 из 16');
      ensure(m.agenda_approved||q.procedure==='agenda','Сначала утвердите повестку');
      if(q.normative&&q.reading!==1){
        const first=m.questions.find(x=>x.procedure===q.procedure&&x.reading===1&&x.subject===q.subject&&x.result?.passed&&x.announced_at);
        const single=q.single_reading_id&&getQuestion(s,q.single_reading_id).question;
        ensure(first||(single?.procedure==='single_reading'&&m.questions.includes(single)&&single.subject===q.subject&&single.no_objections&&single.result?.passed&&single.announced_at),'Нормативный проект: сначала первое чтение или отдельное решение об одном чтении по этому проекту');
      }
      if(q.normative&&q.reading!==1)ensure(!m.questions.some(x=>x.procedure==='amendment'&&x.parent_id===q.id&&(x.status!=='closed'||x.result?.passed&&!x.announced_at)),'Сначала рассмотрите поправки и объявите принятые изменения текста');
      if(q.parent_id&&q.procedure!=='veto_override'){const parent=getQuestion(s,q.parent_id).question;if(parent.reading===2)ensure(parent.status==='pending','Поправки рассматриваются до итогового голосования');}
      if(q.procedure==='chair_election')ensure(q.choices.every(c=>{const target=member(s,c.member_id);return target.active!==false&&target.adult===true;}),'Кандидат выбыл из состава или совершеннолетие не подтверждено');
      if(['secretary_election','chair_recall','reprimand','mandate_termination'].includes(q.procedure))ensure(member(s,q.candidate_id).active!==false,'Затронутый участник выбыл из состава');
      q.status='opened';q.opened_at=now();q.opening_quorum=quorum(m.attendance,s.members);q.members_snapshot=s.members.map(publicMember);m.current_question_id=q.id;
      // No arbitrary time limit is imposed by the charter.
    }else if(action==='question.close'){
      ensure(q.status==='opened','Голосование не открыто');q.result=tally(q,m,s.members);q.closing_attendance=structuredClone(m.attendance);q.status='closed';q.closed_at=now();m.current_question_id=q.id;
    }else if(action==='question.announce'){
      ensure(q.status==='closed','Завершите голосование');ensure(!q.announced_at,'Результат уже объявлен');ensure(!q.veto||q.veto.overridden_at,'Решение приостановлено вето');ensure(!q.result?.tiedIds?.length,'При равенстве лидеров проведите повторный тур');
      q.announced_at=now();q.effective_at=q.result?.passed&&!(q.normative&&q.reading===1)?now():null;
      if(q.result?.passed&&!(q.normative&&q.reading===1)){
        if(q.procedure==='amendment'){const parent=getQuestion(s,q.parent_id).question;ensure(parent.status==='pending','Итоговый текст уже поставлен на голосование');(parent.amendments||=[]).push({question_id:q.id,previous_text:parent.text,new_text:q.amended_text,at:now()});parent.text=q.amended_text;}
        if(q.procedure==='speech_rules')m.speech_limits=q.speech_limits;
        if(q.procedure==='charter_amendment')(s.settings.charter_revisions||=[]).push({question_id:q.id,at:now(),changed_articles:q.changed_articles,text:q.text});
        if(q.procedure==='agenda')m.agenda_approved=true;
        if(q.procedure==='chair_election'){
          const elected=q.choices.find(c=>c.id===q.result.winnerId)||q.result.choices?.find(c=>c.votes===Math.max(...q.result.choices.map(x=>x.votes)));
          const target=elected&&member(s,elected.member_id||q.choices.find(c=>c.id===elected.id)?.member_id);ensure(target&&target.active!==false&&target.adult===true,'Избранный кандидат выбыл из состава или возраст не подтверждён');for(const mem of s.members)mem.roles=mem.roles.filter(r=>r!=='chairman');target.roles.push('chairman');target.temporary_office=false;
        }
        if(q.procedure==='secretary_election'){ensure(member(s,q.candidate_id).active!==false,'Избранный участник выбыл из состава');for(const mem of s.members)mem.roles=mem.roles.filter(r=>r!=='secretary');member(s,q.candidate_id).roles.push('secretary');}
        if(q.procedure==='chair_recall'){const target=member(s,q.candidate_id);target.roles=target.roles.filter(r=>r!=='chairman');}
        if(q.procedure==='mandate_termination'){
          ensure(q.notice&&q.explanation,'Перед прекращением мандата зафиксируйте извещение и предоставление слова');const target=member(s,q.candidate_id);q.previous_roles=[...target.roles];target.active=false;target.roles=[];
        }
        if(q.procedure==='group_create'){
          ensure(q.group_name,'Укажите название создаваемого внутреннего комитета');s.groups.push({id:uid(),name:q.group_name,description:q.text,members:[],head_id:null,created_at:now(),question_id:q.id,status:'active',report_due_at:new Date(Date.now()+30*86400000).toISOString()});
        }
        if(q.procedure==='group_close'){const g=s.groups.find(x=>x.id===q.group_id);ensure(g,'Внутренний комитет не найден');ensure(q.transfer_to,'Укажите, кому передаются функции внутреннего комитета');g.status='closed';g.closed_at=now();g.transfer_to=q.transfer_to;}
        if(q.procedure==='veto_override'){const original=getQuestion(s,q.parent_id).question;ensure(original.veto,'Исходное вето отсутствует');original.veto.overridden_at=now();apply(s,me,{action:'question.announce',question_id:original.id});}
        if(q.assignee_id)s.tasks.push({id:uid(),title:q.decision_text,question_id:q.id,meeting_id:m.id,assignee_id:q.assignee_id,due_date:q.due_date,status:'todo',created_at:now()});
      }
    }else if(action==='question.veto'){
      chairman(me);ensure(q.status==='closed'&&q.result?.passed&&!q.announced_at&&!q.veto,'Вето возможно после принятия и до объявления результата');ensure(q.procedure!=='veto_override','Преодолённое вето подлежит исполнению');q.veto={reason:text(b.reason,'Мотивировка вето'),at:now(),chairman_id:me.id};
    }else if(action==='question.override'){
      ensure(q.veto&&!q.veto.overridden_at,'Нет действующего вето');ensure(!m.questions.some(x=>x.parent_id===q.id&&x.procedure==='veto_override'&&x.status!=='closed'),'Повторное голосование уже подготовлено');m.questions.push({...q,id:uid(),order_num:m.questions.length+1,title:`Преодоление вето: ${q.title}`,procedure:'veto_override',parent_id:q.id,status:'pending',votes:[],choices:[],veto:null,result:null,announced_at:null,opened_at:null,closed_at:null,assignee_id:null});
    }else if(action==='question.runoff'){
      ensure(q.status==='closed'&&q.procedure==='chair_election'&&q.result?.tiedIds?.length>=2,'Повторный тур нужен при равенстве наибольшего числа голосов');ensure(!q.runoff_question_id,'Повторный тур уже создан');const id=uid();q.runoff_question_id=id;m.questions.push({...q,id,parent_id:q.id,order_num:m.questions.length+1,title:`Выборы председателя · тур ${(q.round||1)+1}`,round:(q.round||1)+1,choices:q.choices.filter(c=>q.result.tiedIds.includes(c.id)),votes:[],status:'pending',result:null,runoff_question_id:null,announced_at:null,opened_at:null,closed_at:null});
    }else if(action==='question.details'){
      ensure(q.status==='pending','Уточнения допустимы до голосования');if(b.notice)q.notice=text(b.notice,'Извещение');if(b.explanation)q.explanation=text(b.explanation,'Объяснения / предоставление слова');if(b.transfer_to)q.transfer_to=text(b.transfer_to,'Передача функций');
    }else fail(400,'Неизвестное действие вопроса');
  }else if(action==='vote.cast'){
    const {meeting:m,question:q}=getQuestion(s,b.question_id);ensure(m.status==='active'&&q.status==='opened','Голосование не открыто');ensure(attending(s,m,me.id),'Голосовать могут только участвующие члены Совета',403);ensure(quorum(m.attendance,s.members).has_quorum,'Кворум утрачен; голосование приостановлено');ensure(!q.votes.some(v=>v.member_id===me.id),'Ваш голос уже учтён',409);
    if(m.attendance[me.id].status==='remote'){const check=remoteEligibility(me.id,m,s.meetings);ensure(check.allowed,check.reason);}
    const vote={member_id:me.id,at:now(),participation:m.attendance[me.id].status};
    if(q.procedure==='chair_election'){if(b.value==='abstain'&&!b.choice_id)vote.value='abstain';else{ensure(!b.value&&q.choices.some(c=>c.id===b.choice_id),'Выберите одного кандидата или воздержитесь');vote.choice_id=b.choice_id;}}
    else{ensure(!b.choice_id,'Голосование проводится за решение');vote.value=oneOf(b.value,['for','against','abstain'],'голос');}
    if(q.members_snapshot&&!q.members_snapshot.some(x=>x.id===me.id))q.members_snapshot.push(publicMember(me));
    q.votes.push(vote);if(vote.participation==='remote')m.attendance[me.id].voted_remotely=true;
  }else if(action==='request.add'){
    const m=getMeeting(s,b.meeting_id);writable(m);ensure(attending(s,m,me.id),'Зарегистрируйте участие в заседании');const type=oneOf(b.type,['speak','question','dissent','conflict','roll_call'],'тип запроса');if(b.question_id)ensure(getQuestion(s,b.question_id).meeting.id===m.id,'Другой вопрос заседания');
    const limits=m.speech_limits||{report:600,coreport:300,debate:180};const speech=Number(b.speech_seconds)||limits.debate;ensure(Object.values(limits).includes(speech),'Выберите время, установленное регламентом этого заседания');
    const r={id:uid(),member_id:me.id,member_name:me.name,question_id:b.question_id||m.current_question_id,type,text:optional(b.text),created_at:now(),status:['dissent','conflict'].includes(type)?'done':'pending',speech_seconds:speech};
    if(['dissent','conflict'].includes(type))text(r.text,'Содержание заявления');
    if(type==='roll_call'){const q=getQuestion(s,r.question_id).question;ensure(q.status==='pending','Поименное голосование запрашивается до открытия');q.vote_type='roll_call';r.status='done';}
    m.requests.push(r);
  }else if(action==='request.handle'){
    office(me);const m=getMeeting(s,b.meeting_id);writable(m);const r=m.requests.find(x=>x.id===b.request_id);ensure(r,'Запрос не найден',404);r.status=oneOf(b.status,['granted','deferred','rejected','done'],'статус');if(r.status==='granted'){ensure(!m.requests.some(x=>x.id!==r.id&&x.status==='granted'),'Сначала завершите предыдущее выступление');r.started_at=now();}r.handled_at=now();
  }else if(action==='note.add'){
    office(me);const m=getMeeting(s,b.meeting_id);writable(m);if(b.client_note_id){const existing=m.notes.find(n=>n.client_note_id===b.client_note_id);if(existing){ensure(existing.text===b.text?.trim()&&existing.question_id===(b.question_id||null)&&existing.kind===(b.kind||'speech')&&existing.speaker===(optional(b.speaker,300)||me.name),'Запись с этим кодом уже сохранена с другим содержанием. Исправьте существующую запись',409);return {};}}
    let q=null;if(b.question_id){const found=getQuestion(s,b.question_id);ensure(found.meeting.id===m.id,'Другой вопрос');q=found.question;}
    const kind=oneOf(b.kind||'speech',['speech','proposal','decision','remark','break'],'тип записи');const content=text(b.text,'Содержание записи',30000);
    if(kind==='decision'){ensure(q&&q.status==='pending','Формулировку решения можно менять только до открытия голосования');q.decision_text=content;}
    m.notes.push({id:uid(),client_note_id:optional(b.client_note_id,100),question_id:q?.id||null,kind,text:content,speaker:optional(b.speaker,300)||me.name,at:now()});
  }else if(action==='note.update'||action==='note.remove'){
    office(me);const m=getMeeting(s,b.meeting_id);writable(m);const n=m.notes.find(n=>n.id===b.note_id&&!n.voided);ensure(n,'Запись не найдена',404);ensure(n.kind!=='decision','Формулировка решения сохранена в истории. Добавьте новую формулировку до голосования');
    (n.revisions||=[]).push({text:n.text,speaker:n.speaker,at:now(),actor_id:me.id});
    if(action==='note.remove'){n.voided=true;n.removal_reason=text(b.reason,'Причина удаления',1000);}else{n.text=text(b.text,'Содержание записи',30000);n.speaker=optional(b.speaker,300)||n.speaker;n.edited_at=now();}
  }else if(action==='submission.accept'||action==='submission.update'){
    office(me);const entry=(s.submissions||[]).find(x=>x.id===b.submission_id);ensure(entry,'Заявка не найдена',404);
    if(action==='submission.accept'){
      ensure(!entry.registry_id,'Заявка уже передана в реестр',409);const id=uid();entry.registry_id=id;entry.status='in_review';
      if(entry.type==='appeal'){const r=entry.recipient||{type:'council'};s.correspondence.push({id,title:entry.title,text:entry.text,author_name:entry.name,public_submission_id:entry.id,recipient_label:r.label||'Малый совет',position:r.type==='position'?r.id:null,group_id:r.type==='group'?r.id:null,member_id:r.type==='member'?r.id:r.type==='council'?me.id:null,created_by:me.id,created_at:entry.created_at,due_date:entry.due_date,status:'pending'});}
      else s.initiatives.push({id,title:entry.title,text:entry.text,author_name:entry.name,member_id:null,source:'public',formal:false,public_submission_id:entry.id,created_at:entry.created_at});
    }else{entry.status=oneOf(b.status,['received','in_review','answered','closed'],'статус заявки');if(b.reply!==undefined)entry.reply=text(b.reply,'Ответ заявителю',20000);if(entry.status==='answered')text(entry.reply,'Ответ заявителю');entry.updated_at=now();}
  }else if(action==='group.create'){
    fail(400,'Создание внутреннего комитета автоматизировано: примите и объявите решение с процедурой «Создание внутреннего комитета»');
  }else if(action.startsWith('group.')){
    const g=s.groups.find(g=>g.id===b.group_id);ensure(g&&g.status==='active','Действующий внутренний комитет не найден',404);
    if(action==='group.join'){const id=b.member_id||me.id;if(id!==me.id)office(me);member(s,id);if(!g.members.includes(id))g.members.push(id);}
    else if(action==='group.update'){chairman(me);const head=member(s,b.head_id);ensure(head.active!==false,'Руководитель должен быть членом Совета');g.head_id=head.id;if(!g.members.includes(head.id))g.members.push(head.id);}
    else if(action==='group.report'){ensure(g.head_id===me.id||me.roles.some(r=>['chairman','secretary'].includes(r)),'Отчёт сдаёт руководитель внутреннего комитета',403);(g.reports||=[]).push({text:text(b.text,'Отчёт'),at:now(),member_id:me.id});g.report_due_at=new Date(Date.now()+30*86400000).toISOString();}
    else if(action==='group.external'){office(me);(g.external_members||=[]).push({id:uid(),name:text(b.name,'Участник Движения',200)});}
    else fail(400,'Неизвестное действие внутреннего комитета');
  }else if(action==='material.add'){
    office(me);const m=getMeeting(s,b.meeting_id);writable(m);if(b.question_id)ensure(getQuestion(s,b.question_id).meeting.id===m.id,'Материал относится к другому вопросу');
    ensure(typeof b.data==='string'&&/^[A-Za-z0-9+/]*={0,2}$/.test(b.data),'Неверный формат файла');const content=Buffer.from(b.data,'base64');ensure(content.length>0&&content.length<=10*1024*1024,'Размер файла: от 1 байта до 10 МБ');const id=uid();
    db.prepare('INSERT INTO materials(id,content) VALUES (?,?)').run(id,content);(s.materials||=[]).push({id,meeting_id:m.id,question_id:b.question_id||null,filename:text(b.filename,'Имя файла',250).replace(/[\\/\r\n]/g,'_'),size:content.length,sha256:digest(content),created_at:now(),uploaded_by:me.id});
  }else if(action==='task.add'){
    office(me);if(b.assignee_id)member(s,b.assignee_id);if(b.question_id)getQuestion(s,b.question_id);s.tasks.push({id:uid(),title:text(b.title,'Поручение',1000),description:optional(b.text),assignee_id:b.assignee_id||me.id,due_date:b.due_date?date(b.due_date,'Срок'):null,question_id:b.question_id||null,status:'todo',created_at:now()});
  }else if(action==='task.update'){
    const task=s.tasks.find(t=>t.id===b.task_id);ensure(task,'Поручение не найдено',404);if(task.assignee_id!==me.id)office(me);task.status=oneOf(b.status,['todo','doing','done'],'статус поручения');task.updated_at=now();
  }else if(action==='correspondence.add'){
    if(b.member_id)member(s,b.member_id);if(b.group_id)ensure(s.groups.some(g=>g.id===b.group_id),'Внутренний комитет не найден');ensure(b.member_id||b.group_id,'Выберите адресата');s.correspondence.push({id:uid(),title:text(b.title,'Тема'),text:text(b.text,'Обращение'),member_id:b.member_id||null,group_id:b.group_id||null,created_by:me.id,created_at:now(),due_date:new Date(Date.now()+7*86400000).toISOString(),status:'pending'});
  }else if(action==='correspondence.reply'){
    const c=s.correspondence.find(x=>x.id===b.correspondence_id);ensure(c,'Обращение не найдено');const g=s.groups.find(g=>g.id===c.group_id);ensure(c.member_id===me.id||g?.head_id===me.id||c.position&&me.roles.includes(c.position)||me.roles.some(r=>['chairman','secretary'].includes(r)),'Ответ доступен адресату или делопроизводителю',403);c.reply=text(b.reply,'Ответ');c.replied_at=now();c.replied_by=me.id;c.status='answered';const entry=(s.submissions||[]).find(x=>x.id===c.public_submission_id);if(entry){entry.reply=c.reply;entry.status='answered';entry.updated_at=now();}
  }else if(action==='initiative.add'){
    const external=b.source==='movement';const route=b.route==='agenda'?'agenda':'project';const signatures=Array.isArray(b.signatures)?b.signatures.map(x=>text(x,'Подписант',200)):[];
    if(external){office(me);ensure(new Set(signatures.map(x=>x.toLocaleLowerCase())).size>=(route==='agenda'?10:5),route==='agenda'?'Для предложения в повестку нужно 10 подписей':'Для направления проекта председателю нужно 5 подписей');}
    s.initiatives.push({id:uid(),member_id:external?null:me.id,source:external?'movement':'member',route,signatures,title:text(b.title,'Инициатива',500),text:text(b.text,'Содержание'),created_at:now()});
  }else if(action==='discipline.add'){
    office(me);member(s,b.member_id);const issuer=oneOf(b.issuer,['chairman','council','curators','federal'],'инициатор');if(issuer==='chairman')chairman(me);const notice=text(b.notice,'Предъявленные претензии и уведомление');const explanation=text(b.explanation,'Объяснения / возможность представить их');
    if(issuer==='council'){const q=getQuestion(s,b.question_id).question;ensure(q.procedure==='reprimand'&&q.candidate_id===b.member_id&&q.result?.passed&&q.announced_at,'Требуется объявленное решение Совета: не менее 11 голосов');ensure(!s.discipline.some(d=>d.question_id===q.id),'Это решение уже зарегистрировано в реестре взысканий');}
    s.discipline.push({id:uid(),member_id:b.member_id,kind:oneOf(b.kind||'reprimand',['warning','reprimand'],'мера'),issuer,reason:text(b.reason,'Основание'),notice,explanation,status:'proposed',question_id:b.question_id||null,created_at:now(),created_by:me.id});
  }else if(action==='discipline.appeal'){
    const d=s.discipline.find(d=>d.id===b.discipline_id);ensure(d,'Мера не найдена');ensure(d.member_id===me.id,'Обжалование доступно затронутому участнику',403);ensure(['proposed','final'].includes(d.status),'Апелляция уже зарегистрирована');d.status='appealed';d.appeal=text(b.reason,'Апелляция');d.appeal_at=now();d.appeal_authority=d.issuer==='chairman'?'Совет':d.issuer==='council'?'Кураторский состав Движения в Москве':'Компетентная вышестоящая инстанция по правилам Движения';
  }else if(action==='discipline.resolve'){
    office(me);const d=s.discipline.find(d=>d.id===b.discipline_id);ensure(d,'Мера не найдена');ensure(d.status!=='cancelled','Мера отменена');const resolution=oneOf(b.resolution,['final','cancelled'],'итог');
    ensure(d.status!=='final','Мера уже окончательно оформлена');
    if(d.status==='appealed'&&d.issuer==='chairman'){const q=getQuestion(s,b.question_id).question;ensure(q.procedure==='appeal'&&q.discipline_id===d.id&&q.result?.passed&&q.announced_at,'Нужно решение Совета по этой апелляции');}
    d.resolution_note=text(b.reason,'Основание окончательного оформления / итог апелляции');d.status=resolution;d.resolved_at=now();
  }else if(action==='mandate.resolve'){
    office(me);const {question:q}=getQuestion(s,b.question_id);ensure(q.procedure==='mandate_termination'&&q.mandate_appeal,'Апелляция на прекращение мандата не найдена');const resolution=oneOf(b.resolution,['uphold','restore','suspend'],'решение компетентной инстанции');q.mandate_appeal.resolution=resolution;q.mandate_appeal.resolution_note=text(b.reason,'Решение компетентной вышестоящей инстанции');q.mandate_appeal.status=resolution==='suspend'?'suspended':'resolved';q.mandate_appeal.resolved_at=now();const target=member(s,q.candidate_id);if(resolution!=='uphold'){ensure(target.active!==false||s.members.filter(m=>m.active!==false).length<16,'Перед восстановлением урегулируйте замещение мандата: состав не может превышать 16');target.active=true;if(!target.roles.includes('member'))target.roles=['member'];}else{target.active=false;target.roles=[];}
  }else if(action==='display.create'){
    office(me);const m=getMeeting(s,b.meeting_id);const token=uid()+uid();s.displays.push({token:digest(token),meeting_id:m.id,expires:Date.now()+12*3600000});extra.display_url=`/board?t=${token}`;
  }else if(action==='coordinator.sent'){
    office(me);const m=getMeeting(s,b.meeting_id);ensure(m.status==='closed','Заседание ещё не закрыто');m.coordinator_sent_at=now();m.coordinator_delivery_note=text(b.text,'Подтверждение отправки');
  }else fail(400,'Неизвестное действие');
  audit(s,me,action,b);return extra;
}

function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function body(req,limit=15*1024*1024){let data='';let length=0;for await(const chunk of req){length+=chunk.length;ensure(length<=limit,'Запрос слишком большой',413);data+=chunk;}try{return JSON.parse(data||'{}');}catch{fail(400,'Неверный JSON');}}
const attempts=new Map();
const intakeAttempts=new Map();
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
  try{
    const url=new URL(req.url,'http://localhost');
    if(req.method==='POST'){
      ensure(!req.headers['sec-fetch-site']||req.headers['sec-fetch-site']!=='cross-site','Межсайтовый запрос запрещён',403);
      if(req.headers.origin)ensure(req.headers.origin===`http://${req.headers.host}`||req.headers.origin===`https://${req.headers.host}`,'Недопустимый источник запроса',403);
      ensure((req.headers['content-type']||'').startsWith('application/json'),'Ожидается JSON',415);
      const b=await body(req,url.pathname.startsWith('/api/public/')?65536:15*1024*1024);
      if(url.pathname==='/api/public/submit'){
        const s=load();ensure(s.members.length,'Приём заявок откроется после настройки совета',503);
        const key=req.socket.remoteAddress;for(const [ip,a] of intakeAttempts)if(Date.now()-a.since>3600000)intakeAttempts.delete(ip);
        const a=intakeAttempts.get(key)||{count:0,since:Date.now()};ensure(a.count<10,'Слишком много заявок. Попробуйте через час',429);a.count++;intakeAttempts.set(key,a);
        ensure(!b.website,'Не удалось принять заявку');ensure(b.consent===true,'Подтвердите использование данных для рассмотрения и ответа');
        const ticket=uid()+uid();const entry={id:uid(),tracking_hash:digest(ticket),type:oneOf(b.type,['appeal','initiative'],'вид заявки'),name:text(b.name,'Ваше имя',200),contact:text(b.contact,'Контакт для ответа',300),title:text(b.title,'Тема',300),text:text(b.text,'Содержание',20000),created_at:now(),due_date:new Date(Date.now()+7*86400000).toISOString(),status:'received',reply:''};
        entry.recipient=recipient(s,b.recipient_type||'council',b.recipient_id||null);
        (s.submissions||=[]).push(entry);save(s);return json(res,201,{ticket,number:entry.id.slice(0,8).toUpperCase(),status:entry.status});
      }
      if(url.pathname==='/api/public/status'){
        ensure(typeof b.ticket==='string'&&/^[a-f0-9]{48}$/.test(b.ticket),'Заявка не найдена',404);const entry=(load().submissions||[]).find(x=>x.tracking_hash===digest(b.ticket));ensure(entry,'Заявка не найдена',404);
        return json(res,200,{number:entry.id.slice(0,8).toUpperCase(),type:entry.type,title:entry.title,recipient:entry.recipient||{type:'council',label:'Малый совет'},status:entry.status,created_at:entry.created_at,reply:entry.reply||'',updated_at:entry.updated_at||null});
      }
      if(url.pathname==='/api/setup'){
        const s=load();ensure(s.members.length===0,'Начальная настройка уже выполнена',409);const m={id:uid(),name:text(b.name,'ФИО',200),roles:['member','chairman','secretary'],adult:true,active:true,temporary_office:true,password_hash:hash(b.password),created_at:now()};s.members.push(m);audit(s,m,'setup',{});save(s);issue(res,m.id);return json(res,200,snapshot(s,m));
      }
      if(url.pathname==='/api/login'){
        const key=req.socket.remoteAddress;const a=attempts.get(key)||{count:0,since:Date.now()};if(Date.now()-a.since>15*60000){a.count=0;a.since=Date.now();}ensure(a.count<30,'Слишком много попыток. Повторите через 15 минут',429);a.count++;attempts.set(key,a);const s=load();const m=s.members.find(m=>m.id===b.member_id||(!b.member_id&&m.name===b.name));ensure(m&&verify(b.password,m.password_hash),'Неверное имя или пароль',401);attempts.delete(key);issue(res,m.id);return json(res,200,snapshot(s,m));
      }
      const me=session(req);ensure(me,'Войдите в систему',401);
      if(url.pathname==='/api/logout'){const raw=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('council_session='))?.slice(16);if(raw)db.prepare('DELETE FROM sessions WHERE token=?').run(digest(raw));res.setHeader('Set-Cookie','council_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json(res,200,{ok:true});}
      if(url.pathname==='/api/action'){
        // All validation and state changes commit atomically. Failed procedures leave no partial records.
        db.exec('BEGIN IMMEDIATE');try{const s=load();const extra=apply(s,member(s,me.id),b);const result=snapshot(s,s.members.find(m=>m.id===me.id),extra);save(s);db.exec('COMMIT');return json(res,200,result);}catch(e){db.exec('ROLLBACK');throw e;}
      }
      fail(404,'Неизвестный маршрут');
    }
    ensure(req.method==='GET','Метод не поддерживается',405);
    if(url.pathname==='/api/health')return json(res,200,{ok:true,version:1});
    if(url.pathname==='/api/public/options'){const s=load();return json(res,200,{members:s.members.filter(m=>m.active!==false).map(m=>({id:m.id,name:m.name})),positions:[{id:'chairman',name:'Председатель совета'},{id:'secretary',name:'Секретарь совета'}],groups:s.groups.filter(g=>g.status==='active').map(g=>({id:g.id,name:g.name}))});}
    if(url.pathname==='/api/bootstrap'){
      const s=load();const me=session(req);if(me)return json(res,200,snapshot(s,me));
      return json(res,200,{setupRequired:s.members.length===0,me:null,members:s.members.map(m=>({id:m.id,name:m.name})),settings:s.settings});
    }
    if(url.pathname.startsWith('/api/display/')){
      const s=load();const d=s.displays.find(d=>d.token===digest(url.pathname.slice(13))&&d.expires>Date.now());ensure(d,'Ссылка табло недействительна или истекла',403);return json(res,200,visibleDisplay(s,getMeeting(s,d.meeting_id)));
    }
    if(url.pathname.startsWith('/api/')){
      const me=session(req);ensure(me,'Войдите в систему',401);const s=load();
      if(url.pathname==='/api/state')return json(res,200,snapshot(s,me));
      if(url.pathname.startsWith('/api/material/')){const id=url.pathname.slice(14);const f=(s.materials||=[]).find(x=>x.id===id);ensure(f,'Файл не найден',404);const row=db.prepare('SELECT content FROM materials WHERE id=?').get(id);ensure(row,'Файл не найден',404);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`});return res.end(row.content);}
      if(url.pathname==='/api/reference'){const type=oneOf(url.searchParams.get('type'),['charter','protocol'],'источник');res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});return res.end(readFileSync(join(ROOT,'requirements',type==='charter'?'charter.txt':'protocol-example.txt')));}
      if(url.pathname==='/api/export'){
        office(me);const out=structuredClone(s);out.members=out.members.map(publicMember);delete out.displays;for(const m of out.meetings)for(const q of m.questions)if(q.vote_type==='secret')q.votes=[];res.setHeader('Content-Disposition','attachment; filename="council-backup.json"');return json(res,200,out);
      }
      if(url.pathname.startsWith('/api/protocol/')){
        const m=getMeeting(s,url.pathname.slice(14));const html=protocolHTML(m,s.members,url.searchParams.get('public')==='1');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(html);
      }
      if(url.pathname.startsWith('/api/agenda/')){
        const m=getMeeting(s,url.pathname.slice(12));const content=`${m.title}\n${new Date(m.scheduled_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} · ${m.location}\n\n${m.questions.map(q=>`${q.order_num}. ${q.title}\n${q.text}`).join('\n\n')}\n\nПроект повестки. Подготовлен: ${m.published_at||now()}`;res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':'attachment; filename="agenda.txt"'});return res.end(content);
      }
      fail(404,'Неизвестный маршрут');
    }
    const files={'/':'index.html','/public':'public.html','/public/':'public.html','/board':'display.html','/static/public.mjs':'public.mjs','/static/app.mjs':'app.mjs','/static/app.css':'app.css','/static/council.css':'council.css'};
    const name=files[url.pathname];ensure(name,'Страница не найдена',404);const content=readFileSync(join(ROOT,'static',name));const mime=name.endsWith('.mjs')?'text/javascript':name.endsWith('.css')?'text/css':'text/html';res.writeHead(200,{'Content-Type':mime+'; charset=utf-8','Cache-Control':'no-cache'});res.end(content);
  }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'Ошибка сервера. Данные не изменены.'});else res.end();if(!e.status)console.error(e);}
});
const host=process.env.HOST||'127.0.0.1';const port=Number(process.env.PORT||8765);
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`Порт ${port} занят. Закройте предыдущий экземпляр или задайте PORT.`:e);process.exitCode=1;db.close();});
server.listen(port,host,()=>console.log(`Малый совет: http://${host==='0.0.0.0'?'localhost':host}:${port}\nДанные: ${DATA}`));
function stop(){server.close(()=>{db.close();process.exit(0);});server.closeIdleConnections();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
