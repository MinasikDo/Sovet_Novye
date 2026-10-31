"""Генератор протокола (с русской локализацией)."""

STATUS_RU = {"present": "очно", "remote": "дистанционно",
             "left": "покинул заседание", "absent": "отсутствует"}
VOTE_RU = {"for": "за", "against": "против", "abstain": "воздержался"}
FORMAT_RU = {"present": "очная", "remote": "дистанционная", "mixed": "смешанная"}
TYPE_RU = {"regular": "очередное", "extraordinary": "внеочередное", "emergency": "экстренное"}
REQ_RU = {"speak": "выступление", "question": "вопрос", "dissent": "особое мнение", "conflict": "конфликт интересов"}

def render_protocol(meeting, attendance, total_members, questions, requests):
    present = sum(1 for a in attendance if a["status"] in ("present", "remote") and a["role"] == "member")
    lines = []
    date = meeting.started_at.strftime("%d.%m.%Y") if meeting.started_at else "—"
    
    lines.append(f"<h1>ПРОТОКОЛ ЗАСЕДАНИЯ СОВЕТА №{meeting.protocol_num or meeting.id} от {date}</h1>")
    lines.append(f"<p><b>Заседание:</b> {meeting.title}<br><b>Форма:</b> {FORMAT_RU.get(meeting.format, '—')}, <b>тип:</b> {TYPE_RU.get(meeting.meeting_type, '—')}</p>")

    lines.append("<h2>Присутствовали</h2><table border='1' cellpadding='4'><tr><th>#</th><th>ФИО</th><th>Форма участия</th><th>Прим.</th></tr>")
    for i, a in enumerate(attendance, 1):
        note = "наблюдатель, без права голоса" if a["role"] == "observer" else ""
        if a["is_valid_excuse"]:
            note = (note + "; " if note else "") + f"уваж. причина: {a['excuse_reason'] or '—'}"
        lines.append(f"<tr><td>{i}</td><td>{a['name']}</td><td>{STATUS_RU.get(a['status'], a['status'])}</td><td>{note}</td></tr>")
    lines.append("</table>")
    lines.append(f"<p><b>Кворум:</b> {present} из {total_members} — {'набран' if present >= total_members // 2 + 1 else 'НЕ НАБРАН'}</p>")

    lines.append("<h2>Повестка</h2><ol>")
    for q in questions:
        lines.append(f"<li>{q['title']}</li>")
    lines.append("</ol>")

    lines.append("<h2>Рассмотрение вопросов</h2>")
    for q in questions:
        lines.append(f"<h3>Вопрос {q['order_num']}. {q['title']}</h3>")
        if q["text"]: lines.append(f"<p>{q['text']}</p>")

        if q["requests"]:
            lines.append("<p><b>Выступления и запросы:</b></p><ul>")
            for r in q["requests"]:
                extra = f" — «{r['text']}»" if r.get("text") else ""
                lines.append(f"<li>{r['member_name']} — {REQ_RU.get(r['type'], r['type'])} ({r['status']}){extra}</li>")
            lines.append("</ul>")

        if q["status"] == "closed":
            r = q["results"]
            lines.append(f"<p><b>Голосование:</b> за — {r['for']}, против — {r['against']}, воздержались — {r['abstain']} (участвовало {r['voters']}).</p>")
            if r.get("choices"):
                lines.append("<p><b>Распределение голосов по кандидатам:</b></p><ul>")
                for c in r["choices"]: lines.append(f"<li>{c['text']} — {c['votes']}</li>")
                lines.append("</ul>")
            verdict = "РЕШЕНИЕ ПРИНЯТО" if r["passed"] else "РЕШЕНИЕ НЕ ПРИНЯТО"
            lines.append(f"<p><b>{verdict}</b> {r['reason']} {' (требовалось: ' + str(r['needed']) + ')' if r.get('needed') else ''}.</p>")

            if q.get("veto"):
                v = q["veto"]
                status = "преодолено" if v["overridden_at"] else "не преодолено"
                lines.append(f"<p style='color:#b00'><b>ВЕТО Председателя</b> ({status}): {v['reason']}</p>")

            if q["vote_type"] == "roll_call" and q.get("roll"):
                lines.append("<p><b>Поименное голосование:</b></p><table border='1' cellpadding='4'><tr><th>ФИО</th><th>Голос</th></tr>")
                for v in q["roll"]: lines.append(f"<tr><td>{v['name']}</td><td>{VOTE_RU.get(v['value'], v['value'] or '—')}</td></tr>")
                lines.append("</table>")
        else:
            lines.append(f"<p><i>Вопрос не был вынесен на голосование.</i></p>")

    dissent = [r for r in requests if r["type"] == "dissent" and r.get("text")]
    if dissent:
        lines.append("<h2>Особые мнения</h2><ul>")
        for r in dissent: lines.append(f"<li><b>{r['member_name']}:</b> «{r['text']}»</li>")
        lines.append("</ul>")

    lines.append("<p style='margin-top:40px'>Председатель ____________ / Секретарь ____________</p>")
    return "\n".join(lines)