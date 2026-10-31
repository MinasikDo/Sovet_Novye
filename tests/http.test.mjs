import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';

const project = resolve(import.meta.dirname, '..');
const password = 'Council-test-2026!';
const delay = ms => new Promise(r => setTimeout(r, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('HTTP: полный цикл заседания, права доступа, неизменяемость результата и сохранение', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'council-http-'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let processHandle;
  let output = '';
  async function start() {
    output = '';
    processHandle = spawn(process.execPath, ['server.mjs'], {
      cwd: project,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), COUNCIL_DATA_DIR: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    processHandle.stdout.on('data', b => { output += b; });
    processHandle.stderr.on('data', b => { output += b; });
    for (let n = 0; n < 100; n++) {
      if (processHandle.exitCode !== null) throw new Error(`Server exited: ${output}`);
      try { const response = await fetch(origin + '/api/bootstrap'); if (response.ok) return; } catch {}
      await delay(50);
    }
    throw new Error(`Server unavailable: ${output}`);
  }
  async function stop() {
    if (!processHandle || processHandle.exitCode !== null) return;
    const exited = new Promise(resolve => processHandle.once('exit', resolve));
    processHandle.kill();
    await exited;
  }
  async function request(path, body, cookie) {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('json') ? await response.json() : await response.text();
    return { response, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  let officeCookie, officeId, meetingId, agendaId, secretId, electionId, groupId, firstReadingId, finalReadingId;
  let people = [];
  const act = async (action, fields = {}, cookie = officeCookie) => request('/api/action', { action, meeting_id: meetingId, ...fields }, cookie);
  async function okay(result) { assert.equal(result.response.status, 200, JSON.stringify(result.data)); return result.data; }
  try {
    await start();
    await t.test('первый запуск, вход и отсутствие анонимного доступа', async () => {
      assert.equal((await request('/api/bootstrap')).data.setupRequired, true);
      assert.equal((await request('/api/state')).response.status, 401);
      const setup = await request('/api/setup', { name: 'Тестовый секретарь', password });
      const state = await okay(setup); officeCookie = setup.cookie; officeId = state.me.id;
      assert.ok(officeCookie); assert.ok(state.me.roles.includes('secretary'));
      assert.ok([400, 403, 409].includes((await request('/api/setup', { name: 'Повтор', password })).response.status));
      for (let n = 0; n < 10; n++) {
        const state = await okay(await act('member.add', { name: `Участник ${n + 1}`, password, adult: true, roles: ['member'] }));
        const member = state.members.find(m => m.name === `Участник ${n + 1}`);
        const login = await request('/api/login', { member_id: member.id, password });
        await okay(login); people.push({ id: member.id, cookie: login.cookie });
      }
      people.unshift({ id: officeId, cookie: officeCookie });
      assert.equal((await request('/api/login', { member_id: officeId, password: 'wrong-password' })).response.status, 401);
      assert.equal((await act('meeting.create', { title: 'Нет прав', meeting_type: 'emergency', reason: 'Тест', scheduled_at: new Date().toISOString(), format: 'mixed' }, people[1].cookie)).response.status, 403);
    });
    await t.test('создание заседания, наблюдатель и блокировка голосований без кворума', async () => {
      const state = await okay(await act('meeting.create', { title: 'Интеграционное заседание', meeting_type: 'emergency', reason: 'Проверка срочного проведения', scheduled_at: new Date().toISOString(), format: 'mixed', location: 'Тестовый зал' }));
      meetingId = state.meetings.at(-1).id;
      const qs = await okay(await act('question.add', { title: 'Утвердить повестку', text: 'Утвердить повестку заседания', procedure: 'agenda', vote_type: 'open' }));
      agendaId = qs.meetings.find(m => m.id === meetingId).questions.at(-1).id;
      const secret = await okay(await act('question.add', { title: 'Тайное решение', text: 'Текст тайного решения', procedure: 'decision', vote_type: 'secret' }));
      secretId = secret.meetings.find(m => m.id === meetingId).questions.at(-1).id;
      const election = await okay(await act('question.add', { title: 'Выборы председателя', procedure: 'chair_election', choices: [people[0].id, people[1].id], vote_type: 'open' }));
      electionId = election.meetings.find(m => m.id === meetingId).questions.at(-1).id;
      const group = await okay(await act('question.add', { title: 'Создать рабочую группу', text: 'Цифровые проекты', procedure: 'group_create', group_name: 'Цифровизация', assignee_id: officeId, vote_type: 'open' }));
      groupId = group.meetings.find(m => m.id === meetingId).questions.at(-1).id;
      const firstReading = await okay(await act('question.add', { title:'Положение — первое чтение', text:'Содержательный текст положения', procedure:'decision', normative:true, subject:'Единое положение', reading:1, vote_type:'open' }));
      firstReadingId = firstReading.meetings.find(m=>m.id===meetingId).questions.at(-1).id;
      const finalReading = await okay(await act('question.add', { title:'Положение — окончательный текст', text:'Окончательный текст положения', procedure:'decision', normative:true, subject:'Единое положение', reading:2, vote_type:'open' }));
      finalReadingId = finalReading.meetings.find(m=>m.id===meetingId).questions.at(-1).id;
      await okay(await act('meeting.publish'));
      assert.ok((await act('meeting.start')).response.status >= 400, 'нельзя открыть заседание до подтверждения рассылки');
      await okay(await act('meeting.sent'));
      await okay(await act('meeting.start'));
      assert.ok((await act('question.open', { question_id: agendaId })).response.status >= 400);
      await okay(await act('observer.add', { name: 'Наблюдатель без голоса', status: 'present' }));
      for (const member of people) await okay(await act('attendance.set', { member_id: member.id, status: 'present', identified: true }));
      await okay(await act('question.open', { question_id: agendaId }));
    });
    await t.test('один голос на человека, большинство от голосовавших и фиксация результата', async () => {
      for (let n = 0; n < 9; n++) await okay(await act('vote.cast', { question_id: agendaId, value: n < 5 ? 'for' : n < 8 ? 'against' : 'abstain' }, people[n].cookie));
      assert.ok((await act('vote.cast', { question_id: agendaId, value: 'against' })).response.status >= 400);
      const state = await okay(await act('question.close', { question_id: agendaId }));
      const result = state.meetings.find(m => m.id === meetingId).questions.find(q => q.id === agendaId).result;
      assert.equal(result.for, 5); assert.equal(result.against, 3); assert.equal(result.abstain, 1); assert.equal(result.needed, 5); assert.equal(result.passed, true);
      await okay(await act('attendance.set', { member_id: people[8].id, status: 'left' }));
      const announced = await okay(await act('question.announce', { question_id: agendaId }));
      const meeting = announced.meetings.find(m => m.id === meetingId);
      assert.equal(meeting.agenda_approved, true);
      assert.deepEqual(meeting.questions.find(q => q.id === agendaId).result, result);
      assert.ok((await act('vote.cast', { question_id: agendaId, value: 'for' }, people[8].cookie)).response.status >= 400);
    });
    await t.test('ложные бюллетени и кандидаты отклоняются без изменения голосов', async () => {
      await okay(await act('attendance.set', { member_id: people[8].id, status: 'present' }));
      const opened = await okay(await act('question.open', { question_id: electionId }));
      assert.equal((await act('question.close', { question_id: electionId }, people[1].cookie)).response.status, 403);
      assert.ok((await act('vote.cast', { question_id: electionId, choice_id: 'foreign-candidate' })).response.status >= 400);
      assert.ok((await act('vote.cast', { question_id: electionId, value: 'for' })).response.status >= 400);
      const question = opened.meetings.find(m => m.id === meetingId).questions.find(q => q.id === electionId);
      for (let n=0;n<10;n++) await okay(await act('vote.cast', { question_id: electionId, choice_id: question.choices[n<5?0:1].id }, people[n].cookie));
      const closed = await okay(await act('question.close', { question_id: electionId }));
      assert.equal(closed.meetings.find(m => m.id === meetingId).questions.find(q => q.id === electionId).result.tiedIds.length, 2);
      assert.ok((await act('question.announce', {question_id:electionId})).response.status>=400);
      const runoffState=await okay(await act('question.runoff',{question_id:electionId}));
      const runoff=runoffState.meetings.find(m=>m.id===meetingId).questions.at(-1);
      assert.equal(runoff.choices.length,2);
      await okay(await act('question.open',{question_id:runoff.id}));
      for(let n=0;n<people.length;n++) await okay(await act('vote.cast',{question_id:runoff.id,choice_id:runoff.choices[n<6?0:1].id},people[n].cookie));
      await okay(await act('question.close',{question_id:runoff.id}));
      await okay(await act('question.announce',{question_id:runoff.id}));
    });
    await t.test('тайные голоса не раскрывают личности в API, экспорте и журнале', async () => {
      await okay(await act('question.open', { question_id: secretId }));
      assert.ok((await act('vote.cast', { question_id: secretId, value: 'invalid-ballot' })).response.status >= 400);
      for (const p of people) await okay(await act('vote.cast', { question_id: secretId, value: 'for' }, p.cookie));
      await okay(await act('question.close', { question_id: secretId }));
      const state = await okay(await act('question.announce', { question_id: secretId }));
      const q = state.meetings.find(m => m.id === meetingId).questions.find(q => q.id === secretId);
      assert.deepEqual(q.votes, []);
      const exported = await okay(await request('/api/export', undefined, officeCookie));
      assert.ok(exported.meetings.find(m => m.id === meetingId).questions.find(q => q.id === secretId).votes.every(v => !('member_id' in v)));
      assert.ok(exported.members.every(m => !('password_hash' in m)));
      for (const entry of exported.audit || []) {
        if (entry.action === 'vote.cast' && entry.details?.question_id === secretId) {
          assert.ok(!entry.details.value && !entry.details.choice_id, 'журнал раскрывает тайный выбор и его автора');
        }
      }
    });
    await t.test('валидация кадрового вопроса атомарна; вето преодолевается 11 голосами и исполняет исходное решение', async () => {
      const before=await okay(await request('/api/state',undefined,officeCookie));
      const invalid=await act('question.add',{title:'Неполная кадровая процедура',procedure:'mandate_termination',candidate_id:people[8].id});
      assert.ok(invalid.response.status>=400);
      const after=await okay(await request('/api/state',undefined,officeCookie));
      assert.deepEqual(after.meetings,before.meetings);
      assert.deepEqual(after.audit,before.audit);
      await okay(await act('question.open',{question_id:groupId}));
      for(const p of people) await okay(await act('vote.cast',{question_id:groupId,value:'for'},p.cookie));
      await okay(await act('question.close',{question_id:groupId}));
      const vetoed=await okay(await act('question.veto',{question_id:groupId,reason:'Требуется повторное обсуждение'}));
      assert.equal(vetoed.groups.length,0);
      assert.ok((await act('question.announce',{question_id:groupId})).response.status>=400);
      const overrideState=await okay(await act('question.override',{question_id:groupId}));
      const override=overrideState.meetings.find(m=>m.id===meetingId).questions.at(-1);
      await okay(await act('question.open',{question_id:override.id}));
      for(const p of people) await okay(await act('vote.cast',{question_id:override.id,value:'for'},p.cookie));
      const closed=await okay(await act('question.close',{question_id:override.id}));
      assert.equal(closed.meetings.find(m=>m.id===meetingId).questions.at(-1).result.needed,11);
      const announced=await okay(await act('question.announce',{question_id:override.id}));
      assert.equal(announced.groups.filter(g=>g.question_id===groupId).length,1);
      assert.equal(announced.tasks.filter(task=>task.question_id===groupId).length,1);
      assert.ok(announced.meetings.find(m=>m.id===meetingId).questions.find(q=>q.id===groupId).veto.overridden_at);
      assert.ok((await act('question.announce',{question_id:override.id})).response.status>=400);
    });
    await t.test('нормативный проект вступает в силу после окончательного чтения', async () => {
      const premature=await act('question.open',{question_id:finalReadingId});
      assert.ok(premature.response.status>=400);
      for (const id of [firstReadingId,finalReadingId]) {
        await okay(await act('question.open',{question_id:id}));
        for(const p of people) await okay(await act('vote.cast',{question_id:id,value:'for'},p.cookie));
        await okay(await act('question.close',{question_id:id}));
        const announced=await okay(await act('question.announce',{question_id:id}));
        const question=announced.meetings.find(m=>m.id===meetingId).questions.find(q=>q.id===id);
        assert.equal(Boolean(question.effective_at),id===finalReadingId);
        assert.ok(question.announced_at);
      }
    });
    await t.test('материал скачивается как вложение с безопасным именем, исходные байты сохраняются', async () => {
      const content='<script>alert("material")</script>\nТочный текст материала';
      const data=Buffer.from(content).toString('base64');
      const added=await okay(await act('material.add',{filename:'../Пример\r\nX-Injected: yes.html',data,question_id:agendaId}));
      const material=added.materials.at(-1);
      assert.ok(!/[\\/\r\n]/.test(material.filename));
      const downloaded=await request(`/api/material/${material.id}`,undefined,officeCookie);
      assert.equal(downloaded.response.status,200);
      assert.equal(downloaded.data,content);
      assert.match(downloaded.response.headers.get('content-type'),/^application\/octet-stream/);
      assert.match(downloaded.response.headers.get('content-disposition'),/^attachment;/);
      assert.equal(downloaded.response.headers.get('x-injected'),null);
      assert.equal((await request(`/api/material/${material.id}`)).response.status,401);
    });
    await t.test('публичная приёмная: без входа, личный код, приватность, реестр и ответ', async () => {
      assert.equal((await request('/public')).response.status,200);
      const payload={type:'appeal',name:'Заявитель',contact:'private@example.test',title:'Вопрос <script>',text:'Описание проблемы',consent:true};
      assert.equal((await request('/api/public/submit',{...payload,consent:false})).response.status,400);
      const submitted=await request('/api/public/submit',payload);
      assert.equal(submitted.response.status,201);assert.equal(submitted.data.ticket.length,48);
      const status=await request('/api/public/status',{ticket:submitted.data.ticket});
      assert.equal(status.data.status,'received');assert.equal(status.data.contact,undefined);assert.equal(status.data.tracking_hash,undefined);
      assert.equal((await request('/api/public/status',{ticket:'a'.repeat(48)})).response.status,404);
      let state=await okay(await request('/api/state',undefined,officeCookie));
      const entry=state.submissions.at(-1);assert.equal(entry.tracking_hash,undefined);assert.equal(entry.contact,payload.contact);
      const ordinary=await okay(await request('/api/state',undefined,people[1].cookie));assert.deepEqual(ordinary.submissions,[]);
      assert.equal((await act('submission.accept',{submission_id:entry.id},people[1].cookie)).response.status,403);
      state=await okay(await act('submission.accept',{submission_id:entry.id}));
      const letter=state.correspondence.find(c=>c.public_submission_id===entry.id);assert.ok(letter);
      assert.equal((await act('submission.accept',{submission_id:entry.id})).response.status,409);
      await okay(await act('correspondence.reply',{correspondence_id:letter.id,reply:'Ответ <b>заявителю</b>'}));
      const answered=await request('/api/public/status',{ticket:submitted.data.ticket});assert.equal(answered.data.status,'answered');assert.equal(answered.data.reply,'Ответ <b>заявителю</b>');
      const idea=await request('/api/public/submit',{...payload,type:'initiative',title:'Новая идея'});assert.equal(idea.response.status,201);
      state=await okay(await request('/api/state',undefined,officeCookie));const ideaEntry=state.submissions.at(-1);
      state=await okay(await act('submission.accept',{submission_id:ideaEntry.id}));assert.equal(state.initiatives.find(i=>i.public_submission_id===ideaEntry.id).formal,false);
      const directory=await request('/api/public/options');assert.equal(directory.response.status,200);assert.ok(directory.data.members.length);assert.equal(directory.data.members[0].password_hash,undefined);assert.equal(directory.data.members[0].telegram,undefined);
      const committee=state.groups.find(g=>g.status==='active');assert.ok(committee);
      for(const target of [{type:'member',id:people[2].id},{type:'position',id:'secretary'},{type:'group',id:committee.id}]){
        const result=await request('/api/public/submit',{...payload,recipient_type:target.type,recipient_id:target.id});assert.equal(result.response.status,201);
        state=await okay(await request('/api/state',undefined,officeCookie));const item=state.submissions.at(-1);assert.equal(item.recipient.id,target.id);
        const checked=await request('/api/public/status',{ticket:result.data.ticket});assert.equal(checked.data.recipient.type,target.type);
        state=await okay(await act('submission.accept',{submission_id:item.id}));const routed=state.correspondence.find(c=>c.public_submission_id===item.id);
        assert.equal(routed[target.type==='member'?'member_id':target.type==='position'?'position':'group_id'],target.id);
        if(target.type==='member'){assert.equal((await act('correspondence.reply',{correspondence_id:routed.id,reply:'Не мой адресат'},people[3].cookie)).response.status,403);await okay(await act('correspondence.reply',{correspondence_id:routed.id,reply:'Ответ выбранного участника'},people[2].cookie));}
      }
      assert.equal((await request('/api/public/submit',{...payload,recipient_type:'member',recipient_id:'unknown'})).response.status,404);
      assert.equal((await request('/api/public/submit',{...payload,recipient_type:'position',recipient_id:'admin'})).response.status,400);

    });
    await t.test('быстрый протокол: выбранный вопрос, формулировка, повтор запроса и история исправлений', async () => {
      let state=await okay(await act('meeting.create',{title:'Быстрые записи',meeting_type:'emergency',reason:'Тест',format:'mixed',scheduled_at:new Date().toISOString()}));
      const mid=state.meetings.at(-1).id;
      state=await okay(await act('question.add',{meeting_id:mid,title:'Вопрос для записи',procedure:'decision'}));const qid=state.meetings.at(-1).questions[0].id;
      await okay(await act('meeting.focus',{meeting_id:mid,question_id:qid}));
      const note={meeting_id:mid,question_id:qid,text:'Первое выступление',speaker:'Докладчик',kind:'speech',client_note_id:'retry-token'};
      state=await okay(await act('note.add',note));const id=state.meetings.at(-1).notes[0].id;
      state=await okay(await act('note.add',note));assert.equal(state.meetings.at(-1).notes.length,1);
      assert.equal((await act('note.add',{...note,text:'Другой текст с тем же кодом'})).response.status,409);
      state=await okay(await act('note.update',{meeting_id:mid,note_id:id,text:'Исправленное выступление',speaker:'Докладчик'}));assert.equal(state.meetings.at(-1).notes[0].revisions[0].text,note.text);
      assert.equal((await act('note.update',{meeting_id:mid,note_id:id,text:'Подмена'},people[1].cookie)).response.status,403);
      state=await okay(await act('note.add',{meeting_id:mid,question_id:qid,text:'Точная формулировка решения',kind:'decision'}));assert.equal(state.meetings.at(-1).questions[0].decision_text,'Точная формулировка решения');
      await okay(await act('note.remove',{meeting_id:mid,note_id:id,reason:'Дублирующее выступление'}));
      const report=await request('/api/protocol/'+mid,undefined,officeCookie);assert.ok(!report.data.includes('Исправленное выступление'));assert.ok(report.data.includes('Точная формулировка решения'));
      assert.equal((await act('note.add',{question_id:agendaId,text:'Нельзя изменить решение',kind:'decision'})).response.status,400);
    });
    await t.test('протокол экранирует введённый текст и закрытие сохраняется после перезапуска', async () => {
      await okay(await act('note.add', { question_id: agendaId, speaker: 'Секретарь', text: '<script>alert("x")</script>' }));
      const report = await request(`/api/protocol/${meetingId}`, undefined, officeCookie);
      assert.equal(report.response.status, 200);
      assert.ok(report.data.includes('&lt;script&gt;'));
      assert.ok(!report.data.includes('<script>alert("x")</script>'));
      await okay(await act('meeting.close'));
      const exported = await request('/api/export', undefined, officeCookie);
      assert.equal(exported.response.status, 200); assert.ok(exported.data);
      await stop(); await start();
      const login = await request('/api/login', { member_id: officeId, password }); await okay(login);
      const persisted = await okay(await request('/api/state', undefined, login.cookie));
      assert.equal(persisted.meetings.find(m => m.id === meetingId).status, 'closed');
      assert.equal(persisted.meetings.find(m => m.id === meetingId).questions.find(q => q.id === agendaId).result.for, 5);
    });
    await t.test('очередное заседание: срок 24 часа, перенос и изменённая повестка требуют новой рассылки', async () => {
      let state=await okay(await act('meeting.create',{title:'Очередное заседание',meeting_type:'regular',format:'mixed',scheduled_at:new Date(Date.now()+3600000).toISOString()}));
      const id=state.meetings.at(-1).id;
      await okay(await act('question.add',{meeting_id:id,title:'Утверждение повестки',procedure:'agenda'}));
      assert.ok((await act('meeting.publish',{meeting_id:id})).response.status>=400);
      await okay(await act('meeting.reschedule',{meeting_id:id,scheduled_at:new Date(Date.now()+48*3600000).toISOString()}));
      await okay(await act('meeting.publish',{meeting_id:id}));
      await okay(await act('meeting.sent',{meeting_id:id}));
      state=await okay(await act('question.add',{meeting_id:id,title:'Дополнительный пункт до открытия',procedure:'decision'}));
      const changed=state.meetings.find(m=>m.id===id);
      assert.equal(changed.published_at,null);assert.equal(changed.agenda_sent_at,null);
      assert.ok((await act('meeting.start',{meeting_id:id})).response.status>=400);
      const group=state.groups.find(g=>g.question_id===groupId);
      const closure={meeting_id:id,title:'Ликвидация группы',procedure:'group_close',group_id:group.id,transfer_to:'Председателю'};
      assert.ok((await act('question.add',{...closure,signatories:people.slice(0,5).map(p=>p.id)},people[1].cookie)).response.status>=400);
      assert.ok((await act('question.add',{...closure,signatories:Array(6).fill(people[1].id)},people[1].cookie)).response.status>=400);
      await okay(await act('question.add',{...closure,signatories:people.slice(0,6).map(p=>p.id)},people[1].cookie));
      await okay(await act('meeting.publish',{meeting_id:id}));
      await okay(await act('meeting.sent',{meeting_id:id}));
      assert.ok((await act('meeting.start',{meeting_id:id})).response.status>=400,'после фактической рассылки должно пройти 24 часа, будущая дата заседания не обходит срок');
      assert.ok((await act('attendance.set',{meeting_id:id,member_id:people[1].id,status:'remote',identified:false})).response.status>=400);
      await okay(await act('attendance.set',{meeting_id:id,member_id:people[1].id,status:'remote',identified:true}));
    });
    await t.test('инициативы участников Движения: 5 подписей для проекта и 10 для повестки', async () => {
      const signatures=Array.from({length:10},(_,i)=>`Подписант ${i+1}`);
      const initiative={source:'movement',title:'Предложение участников',text:'Содержательная инициатива'};
      assert.ok((await act('initiative.add',{...initiative,route:'project',signatures:signatures.slice(0,4)})).response.status>=400);
      const project=await okay(await act('initiative.add',{...initiative,route:'project',signatures:signatures.slice(0,5)}));
      assert.equal(project.initiatives.at(-1).signatures.length,5);
      assert.ok((await act('initiative.add',{...initiative,route:'agenda',signatures:signatures.slice(0,9)})).response.status>=400);
      assert.ok((await act('initiative.add',{...initiative,route:'agenda',signatures:[...signatures.slice(0,9),signatures[0].toLocaleUpperCase()]})).response.status>=400);
      const agenda=await okay(await act('initiative.add',{...initiative,route:'agenda',signatures}));
      assert.equal(agenda.initiatives.at(-1).signatures.length,10);
      assert.equal(agenda.initiatives.at(-1).member_id,null);
    });
    await t.test('связанные чтения, поправки, регламент выступлений, взыскание и апелляция после прекращения мандата', async () => {
      const created=await okay(await act('meeting.create',{title:'Связанные процедуры',meeting_type:'emergency',reason:'Проверка процедур',scheduled_at:new Date().toISOString(),format:'mixed'}));
      const id=created.meetings.at(-1).id;
      const action=(name,fields={},cookie=officeCookie)=>act(name,{meeting_id:id,...fields},cookie);
      async function add(fields){const s=await okay(await action('question.add',fields));return s.meetings.find(m=>m.id===id).questions.at(-1);}
      const agenda=await add({title:'Повестка',procedure:'agenda'});
      assert.ok((await action('question.add',{title:'Одно чтение без согласия',procedure:'single_reading',subject:'Проект А'})).response.status>=400);
      const single=await add({title:'Одно чтение проекта А',procedure:'single_reading',subject:'Проект А',no_objections:true});
      const cross=await add({title:'Другой проект Б',text:'Проект Б',procedure:'decision',normative:true,subject:'Проект Б',single_reading_id:single.id});
      const final=await add({title:'Проект А',text:'Исходный текст',procedure:'decision',normative:true,subject:'Проект А',single_reading_id:single.id});
      const amendment=await add({title:'Изменение текста А',procedure:'amendment',parent_id:final.id,amended_text:'Принятая новая редакция'});
      const speech=await add({title:'Регламент выступлений',procedure:'speech_rules',report_seconds:480,coreport_seconds:240,debate_seconds:120});
      const reprimand=await add({title:'Выговор',procedure:'reprimand',candidate_id:people[9].id});
      const mandate=await add({title:'Рассмотрение мандата',procedure:'mandate_termination',candidate_id:people[10].id,notice:'Претензии вручены заранее',explanation:'Слово предоставлено, позиция изложена'});
      const charter1=await add({title:'Поправка Устава — первое чтение',text:'Концепция изменения статьи 21',procedure:'charter_amendment',reading:1,subject:'Поправка статьи 21',changed_articles:'Статья 21'});
      const charter2=await add({title:'Поправка Устава — второе чтение',text:'Окончательная редакция статьи 21',procedure:'charter_amendment',reading:2,subject:'Поправка статьи 21',changed_articles:'Статья 21'});
      await okay(await action('meeting.publish'));await okay(await action('meeting.sent'));
      for(const p of people)await okay(await action('attendance.set',{member_id:p.id,status:'present'}));
      await okay(await action('meeting.start'));
      async function adopt(q){await okay(await action('question.open',{question_id:q.id}));for(const p of people)await okay(await action('vote.cast',{question_id:q.id,value:'for'},p.cookie));await okay(await action('question.close',{question_id:q.id}));return okay(await action('question.announce',{question_id:q.id}));}
      await adopt(agenda);await adopt(single);
      assert.ok((await action('question.open',{question_id:cross.id})).response.status>=400,'разрешение одного чтения нельзя переносить на другой проект');
      assert.ok((await action('question.open',{question_id:final.id})).response.status>=400,'поправка должна предшествовать голосованию в целом');
      let state=await adopt(amendment);
      assert.equal(state.meetings.find(m=>m.id===id).questions.find(q=>q.id===final.id).text,'Принятая новая редакция');
      await adopt(final);state=await adopt(speech);
      assert.deepEqual(state.meetings.find(m=>m.id===id).speech_limits,{report:480,coreport:240,debate:120});
      await adopt(reprimand);
      const sanction={member_id:people[9].id,kind:'reprimand',issuer:'council',question_id:reprimand.id,reason:'Основание решения',notice:'Претензии вручены',explanation:'Объяснения выслушаны'};
      state=await okay(await action('discipline.add',sanction));
      const count=state.discipline.length;
      assert.ok((await action('discipline.add',sanction)).response.status>=400);
      state=await okay(await request('/api/state',undefined,officeCookie));assert.equal(state.discipline.length,count);
      state=await adopt(charter1);assert.equal((state.settings.charter_revisions||[]).length,0);
      state=await adopt(charter2);assert.equal(state.settings.charter_revisions.length,1);assert.equal(state.settings.charter_revisions[0].changed_articles,'Статья 21');
      state=await adopt(mandate);assert.equal(state.members.find(m=>m.id===people[10].id).active,false);
      const inactiveLogin=await request('/api/login',{member_id:people[10].id,password});
      await okay(inactiveLogin);assert.equal(inactiveLogin.data.me.active,false);
      assert.equal((await action('vote.cast',{question_id:cross.id,value:'for'},inactiveLogin.cookie)).response.status,403);
      assert.equal((await action('mandate.appeal',{question_id:mandate.id,reason:'Чужая жалоба'},people[9].cookie)).response.status,403);
      state=await okay(await action('mandate.appeal',{question_id:mandate.id,reason:'Прошу пересмотреть решение'},inactiveLogin.cookie));
      assert.equal(state.meetings.find(m=>m.id===id).questions.find(q=>q.id===mandate.id).mandate_appeal.status,'pending');
      state=await okay(await action('mandate.resolve',{question_id:mandate.id,resolution:'restore',reason:'Получено решение компетентной вышестоящей инстанции о восстановлении'}));
      const restored=state.members.find(m=>m.id===people[10].id);assert.equal(restored.active,true);assert.deepEqual(restored.roles,['member']);
    });
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
