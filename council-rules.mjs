/** Устав Малого совета: чистые расчёты без изменения состояния. */
export const RULES = Object.freeze({
  composition: 16, quorum: 9, qualified: 11,
  attendance: 70, onsite: 50, voting: 75,
  remote_per_month: 1, resolution_attempts: 3,
  agenda_notice_hours: 24, coordinator_notice_hours: 24,
  meeting_interval_days: 14, response_days: 7,
  speech_seconds: {report: 600, coreport: 300, debate: 180},
  procedures: {
    decision: {label: 'Решение', article: '27', majority: 'simple'},
    resolution: {label: 'Резолюция', article: '28', majority: 'simple'},
    charter_amendment: {label: 'Изменение Устава', article: '39.2', majority: 'qualified'},
    chair_recall: {label: 'Отзыв Председателя', article: '11.3', majority: 'qualified'},
    reprimand: {label: 'Выговор решением Совета', article: '35.1', majority: 'qualified'},
    veto_override: {label: 'Преодоление вето', article: '29.1', majority: 'qualified'},
    chair_election: {label: 'Выборы Председателя', article: '11', majority: 'plurality'},
    secretary_election: {label: 'Выборы Секретаря', article: '13, 27', majority: 'simple'},
    agenda: {label: 'Повестка и дополнительные вопросы', article: '20', majority: 'simple'},
    agenda_amendment: {label: 'Поправка к повестке', article: '20.3', majority: 'simple'},
    single_reading: {label: 'Принятие в одном чтении', article: '25.2', majority: 'simple'},
    circumstances: {label: 'Существенное изменение обстоятельств', article: '28.3', majority: 'simple'},
    appeal: {label: 'Апелляция на выговор Председателя', article: '36.2', majority: 'simple'},
    break: {label: 'Перерыв заседания', article: '21, 27', majority: 'simple'},
    amendment: {label: 'Поправка к нормативному проекту', article: '25.3', majority: 'simple'},
    speech_rules: {label: 'Изменение регламента выступлений', article: '21.2', majority: 'simple'},
    group_create: {label: 'Создание внутреннего комитета', article: '14', majority: 'simple'},
    group_close: {label: 'Ликвидация внутреннего комитета', article: '14.6', majority: 'simple'},
    mandate_termination: {label: 'Прекращение мандата', article: '37', majority: 'simple'},
  },
});

const idOf = value => String(value);
const memberList = members => Array.isArray(members) ? members : Object.values(members || {});
const councilMember = member => !!member && member.is_active !== false && member.active !== false && !['observer','coordinator','guest'].includes(member.role) && (!Array.isArray(member.roles) || member.roles.includes('member'));
const attendanceOf = meeting => meeting?.attendance || {};
const attended = a => !!a && a.role !== 'observer' && (a.status === 'present' || a.status === 'remote' && a.identified === true);
const isEmergency = m => (m.meeting_type || m.type) === 'emergency';
const meetingDate = m => m.started_at || m.scheduled_at || m.date || m.created_at;
const monthOf = date => {
  const d = new Date(date);
  if (!Number.isFinite(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Moscow',year:'numeric',month:'2-digit'}).format(d);
};

/** Fixed statutory denominator is not reduced by vacancies or observers. */
export function quorum(attendance = {}, members = []) {
  const known = new Set(memberList(members).filter(councilMember).map(m => idOf(m.id)));
  const present = Object.entries(attendance).filter(([id,a]) => known.has(idOf(id)) && attended(a)).length;
  return {present, total: RULES.composition, needed: RULES.quorum, has_quorum: present >= RULES.quorum};
}

/** Vote validity at cast time is enforced by the server, not recomputed from later departures. */
export function tally(question, meeting, members = []) {
  if (question.status === 'closed' && question.result) return structuredClone(question.result);
  const procedure = question.procedure || (question.kind === 'resolution' ? 'resolution' : 'decision');
  const rule = RULES.procedures[procedure];
  if (!rule) throw new Error(`Неизвестная процедура: ${procedure}`);
  const known = new Set(memberList(question.members_snapshot || members).filter(councilMember).map(m => idOf(m.id)));
  const seen = new Set();
  const choices = (question.choices || []).map(c => ({id:c.id, text:c.text || c.name || '', member_id:c.member_id, votes:0}));
  const result = {for:0,against:0,abstain:0,voters:0,needed:null,passed:false,reason:'',choices,tiedIds:[],winnerId:null};
  for (const vote of question.votes || []) {
    const key = idOf(vote.member_id);
    if (!known.has(key) || seen.has(key)) continue;
    if (rule.majority === 'plurality') {
      const choice = choices.find(c => idOf(c.id) === idOf(vote.choice_id));
      if (choice && !vote.value) choice.votes++;
      else if (vote.value === 'abstain' && vote.choice_id == null) result.abstain++;
      else continue;
    } else {
      if (!['for','against','abstain'].includes(vote.value) || vote.choice_id != null) continue;
      result[vote.value]++;
    }
    seen.add(key);
    result.voters++;
  }
  const q = quorum(attendanceOf(meeting), members);
  result.quorum = q;
  if (rule.majority === 'plurality') {
    const top = Math.max(0, ...choices.map(c=>c.votes));
    result.tiedIds = top ? choices.filter(c=>c.votes===top).map(c=>c.id) : [];
    result.needed = top || 1;
    if (!q.has_quorum) result.reason = 'Нет кворума — решение не принято';
    else if (!top) result.reason = 'Голоса за кандидатов не поданы';
    else if (result.tiedIds.length > 1) result.reason = 'Равенство голосов — повторное голосование между лидерами';
    else {
      result.passed = true;
      result.winnerId = result.tiedIds[0];
      result.tiedIds = [];
      result.reason = 'Наибольшее число голосов при наличии кворума (ст. 11)';
    }
  } else {
    result.needed = rule.majority === 'qualified' ? RULES.qualified : Math.floor(result.voters/2)+1;
    result.passed = q.has_quorum && result.voters > 0 && result.for >= result.needed;
    result.reason = !q.has_quorum ? 'Нет кворума — решение не принято'
      : !result.voters ? 'Голоса не поданы'
      : rule.majority === 'qualified' ? `Не менее 11 голосов «за» (ст. ${rule.article})`
      : 'Больше половины участвующих в голосовании, включая воздержавшихся (ст. 27)';
  }
  return result;
}

/** Emergency meetings neither consume the monthly quota nor break normal-meeting sequence. */
export function remoteEligibility(memberId, meeting, meetings = []) {
  if (isEmergency(meeting)) return {allowed:true,reason:'Экстренное заседание: ограничения ст. 7.2 не применяются'};
  const target = new Date(meetingDate(meeting)).getTime();
  if (!Number.isFinite(target)) return {allowed:false,reason:'Укажите дату заседания для проверки дистанционного участия'};
  const prior = meetings.filter(m => idOf(m.id)!==idOf(meeting.id) && !isEmergency(m) && ['active','closed','paused'].includes(m.status) && new Date(meetingDate(m)).getTime() < target)
    .sort((a,b)=>new Date(meetingDate(b))-new Date(meetingDate(a)));
  const a = m => attendanceOf(m)[memberId] || {};
  const remoteInvolvement = m => a(m).status === 'remote' || a(m).was_remote === true || a(m).mode === 'remote' || a(m).voted_remotely === true || (m.attendance_history || []).some(h=>idOf(h.member_id)===idOf(memberId) && (h.status==='remote' || h.mode==='remote' || h.was_remote===true)) || (m.questions || []).some(q=>(q.votes || []).some(v=>idOf(v.member_id)===idOf(memberId) && [v.participation,v.mode,v.attendance_status].includes('remote')));
  if (prior[0] && remoteInvolvement(prior[0])) return {allowed:false,reason:'Нельзя участвовать дистанционно в двух обычных заседаниях подряд (ст. 7.2)'};
  const remoteVote = m => a(m).voted_remotely === true || (m.questions || []).some(q => (q.votes || []).some(v => idOf(v.member_id)===idOf(memberId) && (v.participation === 'remote' || v.attendance_status === 'remote' || v.mode === 'remote' || (!v.participation && !v.attendance_status && !v.mode && remoteInvolvement(m)))));
  if (prior.some(m => monthOf(meetingDate(m)) === monthOf(meetingDate(meeting)) && remoteVote(m))) return {allowed:false,reason:'Дистанционное голосование уже использовано в этом месяце (ст. 7.2, 7.5)'};
  return {allowed:true,reason:'Дистанционное участие допустимо при подтверждении личности'};
}

const percent = (n,d) => d ? Math.round(n/d*1000)/10 : null;
export function compliance(members, meetings = [], groups = [], initiatives = []) {
  const completed = meetings.filter(m=>m.status==='closed');
  return memberList(members).filter(councilMember).map(member => {
    let meetings_total=0,attendedCount=0,onsite=0,votes_total=0,voted=0;
    for (const meeting of completed) {
      // A replacement member must not inherit absences from before obtaining a mandate.
      // An explicit attendance entry can record a member admitted after opening.
      if (meeting.members_snapshot && !memberList(meeting.members_snapshot).some(m=>idOf(m.id)===idOf(member.id) && councilMember(m)) && !Object.hasOwn(attendanceOf(meeting),member.id)) continue;
      const a=attendanceOf(meeting)[member.id] || {};
      const participated=attended(a) || a.participated === true || !!a.arrival_time || !!a.arrived_at;
      if (!participated && (a.excused || a.is_valid_excuse)) continue;
      meetings_total++;
      if(participated) attendedCount++;
      if(a.status==='present' || a.was_present === true || a.mode === 'present') onsite++;
      for(const q of meeting.questions || []) {
        if(q.status!=='closed' || !(q.opened_at || q.result || (q.votes || []).length)) continue;
        votes_total++;
        if((q.votes || []).some(v=>idOf(v.member_id)===idOf(member.id))) voted++;
      }
    }
    const memberships=groups.filter(g=>!g.closed_at && g.status!=='closed' && (g.members || g.member_ids || []).some(m=>idOf(typeof m==='object'?m.member_id ?? m.id:m)===idOf(member.id)));
    const initiative_count=initiatives.filter(i=>idOf(i.author_id ?? i.member_id ?? i.created_by)===idOf(member.id) && i.status!=='draft').length;
    const attendance_percent=percent(attendedCount,meetings_total),onsite_percent=percent(onsite,meetings_total),voting_percent=percent(voted,votes_total);
    // Display rounding must never turn a value below a statutory threshold into compliance.
    const checks={attendance:meetings_total?attendedCount*100>=meetings_total*70:null,onsite:meetings_total?onsite*100>=meetings_total*50:null,voting:votes_total?voted*100>=votes_total*75:null,group:memberships.length>=1,initiative:initiative_count>=1};
    const labels={attendance:'Участие менее 70%',onsite:'Очное участие менее 50%',voting:'Участие в голосованиях менее 75%',group:'Нет участия в внутреннему комитету',initiative:'Нет зарегистрированной инициативы'};
    return {member_id:member.id,name:member.name,meetings_total,attended:attendedCount,onsite,votes_total,voted,attendance_percent,onsite_percent,voting_percent,groups:memberships.map(g=>g.name),initiative_count,checks,warnings:Object.entries(checks).filter(([,v])=>v===false).map(([k])=>labels[k])};
  });
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = value => {const d=new Date(value);return value && Number.isFinite(d.getTime()) ? d.toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}) : '—'};
const status = {present:'очно',remote:'дистанционно',absent:'отсутствует',left:'покинул заседание'};
const reqtype={speak:'Выступление',question:'Вопрос',dissent:'Особое мнение',conflict:'Конфликт интересов'};
export function protocolHTML(meeting, members, publicVersion=false) {
  const historicalMembers=meeting.members_snapshot || members;
  const list=memberList(historicalMembers),names=new Map(list.map(m=>[idOf(m.id),m.name]));
  const name=id=>names.get(idOf(id)) || 'Участник';
  const out=[];
  out.push(`<h1>${publicVersion?'Публичное сообщение о заседании':'ПРОТОКОЛ СОБРАНИЯ МАЛОГО СОВЕТА ДВИЖЕНИЯ «НОВЫЕ» В МОСКВЕ'}</h1><p>№ ${esc(meeting.protocol_num || meeting.number || meeting.id)} от ${esc(date(meetingDate(meeting)))}</p><h2>${esc(meeting.title)}</h2>`);
  out.push(`<p>Форма: ${esc(({present:'очная',remote:'дистанционная',mixed:'смешанная'})[meeting.format] || meeting.format)}. Вид: ${esc(({regular:'очередное',extraordinary:'внеочередное',emergency:'экстренное'})[meeting.meeting_type || meeting.type] || 'очередное')}.</p>`);
  if(isEmergency(meeting) && (meeting.emergency_reason || meeting.reason)) out.push(`<p><b>Обоснование экстренности:</b> ${esc(meeting.emergency_reason || meeting.reason)}</p>`);
  const q=meeting.quorum_snapshot || meeting.opening_quorum || quorum(attendanceOf(meeting),historicalMembers);
  out.push(`<p><b>Кворум${meeting.quorum_snapshot || meeting.opening_quorum?' при открытии':''}:</b> ${q.present} из 16; необходимо 9. ${q.has_quorum?'Набран.':'Не набран. Принятие решений не допускается.'}</p>`);
  if(!publicVersion){
    out.push('<h2>Состав участников</h2><table><thead><tr><th>Участник</th><th>Форма участия</th><th>Примечание</th></tr></thead><tbody>');
    const allAttendance={...Object.fromEntries(list.filter(councilMember).map(m=>[m.id,{status:'absent'}])),...attendanceOf(meeting)};
    for(const [id,a] of Object.entries(allAttendance))out.push(`<tr><td>${esc(a.name || name(id))}</td><td>${esc(status[a.status] || a.status)}</td><td>${esc([a.role==='observer'?'Наблюдатель, без права голоса':'',a.role==='coordinator'?'Координатор, без права голоса':'',a.identified===true && a.status==='remote'?'Личность подтверждена':'',(a.excused || a.is_valid_excuse)?`Уважительная причина: ${a.excuse_reason || a.reason || 'подтверждена'}`:'',a.arrival_time || a.arrived_at?`Прибыл: ${date(a.arrival_time || a.arrived_at)}`:'',a.departure_time || a.left_at?`Выбыл: ${date(a.departure_time || a.left_at)}`:''].filter(Boolean).join('; '))}</td></tr>`);
    for(const a of meeting.observers || [])out.push(`<tr><td>${esc(a.name)}</td><td>${esc(status[a.status] || a.status || 'очно')}</td><td>${a.role==='coordinator' || a.coordinator===true?'Координатор':'Наблюдатель'}, без права голоса${a.arrived_at || a.arrival_time?'; прибыл: '+esc(date(a.arrived_at || a.arrival_time)):''}</td></tr>`);
    out.push('</tbody></table>');
    if((meeting.attendance_history || []).length)out.push('<h3>Изменения присутствия</h3><ul>'+meeting.attendance_history.map(a=>`<li>${esc(date(a.at || a.created_at))}: ${esc(a.name || name(a.member_id))} — ${esc(status[a.status] || a.status)}${a.reason?' · '+esc(a.reason):''}</li>`).join('')+'</ul>');
    out.push('<h2>Повестка</h2><ol>'+(meeting.questions || []).map(q=>`<li>${esc(q.title)}</li>`).join('')+'</ol>');
  }
  out.push('<h2>Рассмотренные вопросы и решения</h2>');
  for(const question of meeting.questions || []){
    if(publicVersion && (!question.result?.passed || !question.announced_at || !question.effective_at || !Number.isFinite(new Date(question.effective_at).getTime()) || new Date(question.effective_at).getTime()>Date.now() || (question.veto && !question.veto.overridden_at && !question.veto.overridden) || question.public === false || question.confidential === true))continue;
    out.push(`<h3>${esc(question.order_num || '')}. ${esc(question.title)}</h3><p>${esc(publicVersion ? question.public_summary || question.decision_text || question.text : question.text)}</p>`);
    if(question.decision_text && !publicVersion)out.push(`<p><b>Формулировка решения:</b> ${esc(question.decision_text)}</p>`);
    if(question.changed_articles)out.push(`<p><b>Изменяемые статьи Устава:</b> ${esc(question.changed_articles)}</p>`);
    if(question.amended_text)out.push(`<p><b>Предлагаемая редакция проекта по поправке:</b> ${esc(question.amended_text)}</p>`);
    if(question.speech_limits)out.push(`<p><b>Регламент выступлений:</b> основной доклад — ${esc(question.speech_limits.report)} сек.; содоклад — ${esc(question.speech_limits.coreport)} сек.; прения — ${esc(question.speech_limits.debate)} сек.</p>`);
    if(!publicVersion){
      for(const version of question.amendments || [])out.push(`<p><b>Принятая поправка (${esc(date(version.at))}), вопрос ${esc(version.question_id)}:</b></p><p>Предыдущая редакция: ${esc(version.previous_text)}</p><p>Новая редакция: ${esc(version.new_text)}</p>`);
      if(question.reading)out.push(`<p>Чтение: ${esc(question.reading)}. ${question.single_reading_reason?'Основание одного чтения: '+esc(question.single_reading_reason):''}</p>`);
      for(const note of [...(question.notes || []),...(meeting.notes || []).filter(n=>!n.voided && idOf(n.question_id)===idOf(question.id))])out.push(`<p><b>${esc(note.speaker || note.member_name || name(note.member_id))}:</b> ${esc(typeof note==='string'?note:note.text)}</p>`);
      for(const request of (meeting.requests || []).filter(r=>idOf(r.question_id)===idOf(question.id)))out.push(`<p><b>${esc(reqtype[request.type] || request.type)} — ${esc(request.member_name || name(request.member_id))}:</b> ${esc(request.text || '')}</p>`);
    }
    const r=question.result || (question.status==='closed'?tally(question,meeting,historicalMembers):null);
    if(r){
      out.push(`<p><b>Голосование:</b> за — ${r.for || 0}, против — ${r.against || 0}, воздержались — ${r.abstain || 0}; участвовало — ${r.voters || 0}. ${r.needed!=null?'Требовалось: '+esc(r.needed)+'.':''}</p>`);
      if(r.choices?.length)out.push('<ul>'+r.choices.map(c=>`<li>${esc(c.text)} — ${c.votes}</li>`).join('')+'</ul>');
      out.push(`<p><b>${r.passed?'РЕШЕНИЕ ПРИНЯТО':'РЕШЕНИЕ НЕ ПРИНЯТО'}</b>. ${esc(r.reason)}</p>`);
      if(r.quorum)out.push(`<p>Кворум при подведении итогов: ${r.quorum.present} из 16.</p>`);
      if(!publicVersion && question.vote_type==='roll_call')out.push('<h4>Поименное голосование</h4><ul>'+(question.votes || []).map(v=>`<li>${esc(name(v.member_id))}: ${esc(({for:'за',against:'против',abstain:'воздержался'})[v.value] || question.choices?.find(c=>idOf(c.id)===idOf(v.choice_id))?.text || '—')}</li>`).join('')+'</ul>');
    }else out.push('<p>Голосование не завершено / вопрос не ставился на голосование.</p>');
    if(question.veto)out.push(`<p><b>Вето Председателя:</b> ${esc(question.veto.reason)}. ${question.veto.overridden_at || question.veto.overridden?'Преодолено.':'Не преодолено; решение не вступило в силу.'}</p>`);
    if(question.announced_at)out.push(`<p>Результат объявлен: ${esc(date(question.announced_at))}. ${question.effective_at?'Вступление в силу: '+esc(date(question.effective_at)):''}</p>`);
  }
  if(!publicVersion){
    const general=(meeting.requests || []).filter(r=>!r.question_id && ['dissent','conflict'].includes(r.type));
    for(const r of general)out.push(`<p><b>${esc(reqtype[r.type])} — ${esc(r.member_name || name(r.member_id))}:</b> ${esc(r.text)}</p>`);
    for(const n of (meeting.notes || []).filter(n=>!n.voided && !n.question_id))out.push(`<p>${esc(typeof n==='string'?n:n.text)}</p>`);
    out.push(`<p>Открытие: ${esc(date(meeting.started_at))}. Закрытие: ${esc(date(meeting.closed_at))}.</p><p class="signatures">Председатель __________________ / ${esc(meeting.chairman_name || '')}<br>Секретарь __________________ / ${esc(meeting.secretary_name || '')}</p>`);
  }else out.push('<p>Проект публичного сообщения. Перед размещением Секретарь проверяет отсутствие персональных и конфиденциальных сведений (ст. 8).</p>');
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Протокол Малого совета</title><style>body{font:14px/1.65 Arial,sans-serif;max-width:900px;padding:35px;margin:auto;color:#111}h1{font-size:22px}h2{font-size:19px}h3{font-size:16px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:9px;text-align:left;vertical-align:top}p{white-space:pre-wrap}.signatures{margin-top:50px;line-height:3}@media print{body{padding:0}h2,h3{break-after:avoid}tr{break-inside:avoid}}</style></head><body>'+out.join('\n')+'</body></html>';
}
