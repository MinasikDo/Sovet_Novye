import base64, hashlib, io, secrets, uuid
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import (FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect,
                     Query, UploadFile, File as FastFile, Form)
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session as DBSession
import qrcode

from models import (Base, Member, AuthSession, Meeting, Attendance, Question,
                    Choice, Vote, Request, Veto, DisplayToken, StoredFile,
                    Board, BoardColumn, Card, WorkingGroup, WorkingGroupMember,
                    AuditLog)
from voting import VoteTally, evaluate, quorum_threshold
from protocol import render_protocol

engine = create_engine("sqlite:///council.db", connect_args={"check_same_thread": False})
Base.metadata.create_all(engine)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
UPLOAD_DIR = Path("uploads"); UPLOAD_DIR.mkdir(exist_ok=True)

def get_db():
    db = SessionLocal()
    try: yield db
    finally: db.close()

def hash_password(pwd: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    h = hashlib.pbkdf2_hmac("sha256", pwd.encode(), salt, 100_000)
    return salt.hex() + "$" + h.hex()

def verify_password(pwd: str, stored: str) -> bool:
    salt_hex, h_hex = stored.split("$")
    h = hashlib.pbkdf2_hmac("sha256", pwd.encode(), bytes.fromhex(salt_hex), 100_000)
    return h.hex() == h_hex

def new_token() -> str: return secrets.token_urlsafe(32)

def audit(db, action, meeting_id=None, actor_id=None, **payload):
    db.add(AuditLog(meeting_id=meeting_id, actor_id=actor_id, action=action, payload=payload))

bearer = HTTPBearer(auto_error=False)

def current_member(cred: HTTPAuthorizationCredentials | None = Depends(bearer), db: DBSession = Depends(get_db)) -> Member:
    if not cred: raise HTTPException(401, "Не передан токен авторизации")
    s = db.query(AuthSession).filter_by(token=cred.credentials).first()
    if not s: raise HTTPException(401, "Неверный токен")
    m = db.query(Member).get(s.member_id)
    if not m or not m.is_active: raise HTTPException(401, "Пользователь неактивен")
    return m

def require_role(role: str):
    def checker(m: Member = Depends(current_member)) -> Member:
        if role not in (m.roles or []): raise HTTPException(403, f"Требуется роль: {role}")
        return m
    return checker

# --- Schemas ---
class LoginIn(BaseModel): name: str; password: str
class AttendanceIn(BaseModel): member_id: int; status: str; role: str = "member"; is_valid_excuse: bool = False; excuse_reason: str | None = None
class QuestionIn(BaseModel): title: str; text: str = ""; kind: str = "decision"; vote_type: str = "open"; majority_type: str = "simple"; choices: list[str] = []
class VoteIn(BaseModel): value: str | None = None; choice_id: int | None = None
class RequestIn(BaseModel): type: str; question_id: int | None = None; text: str | None = None
class HandleIn(BaseModel): action: str
class VetoIn(BaseModel): reason: str
class ActivateDisplayIn(BaseModel): t: str
class CardIn(BaseModel): column_id: int; board_id: int; title: str; description: str = ""; assignee_id: int | None = None; linked_question_id: int | None = None
class MoveIn(BaseModel): column_id: int; board_id: int; order_num: int = 0

# --- WebSocket Hub ---
class Hub:
    def __init__(self): self.map: dict[int, list[WebSocket]] = {}
    async def join(self, mid: int, ws: WebSocket):
        await ws.accept(); self.map.setdefault(mid, []).append(ws)
    def leave(self, mid: int, ws: WebSocket):
        if ws in self.map.get(mid, []): self.map[mid].remove(ws)
    async def broadcast(self, mid: int, payload: dict):
        for ws in list(self.map.get(mid, [])):
            try: await ws.send_json(payload)
            except Exception: self.leave(mid, ws)
    async def broadcast_all(self, payload: dict):
        for mid in list(self.map): await self.broadcast(mid, payload)
hub = Hub()

# --- State Builder ---
def _meeting_attendance(db, mid):
    return {r.member_id: r for r in db.query(Attendance).filter_by(meeting_id=mid).all()}

def compute_results(db, q: Question, att_map, total_members: int) -> dict:
    votes = db.query(Vote).filter_by(question_id=q.id, round=q.round).all()
    tally = VoteTally(
        for_=sum(1 for v in votes if v.value == "for"),
        against=sum(1 for v in votes if v.value == "against"),
        abstain=sum(1 for v in votes if v.value == "abstain"),
    )
    present = sum(1 for a in att_map.values() if a.status == "present" and a.role == "member")

    choices_counts = None
    if q.majority_type == "plurality":
        chs = db.query(Choice).filter_by(question_id=q.id).order_by(Choice.order_num).all()
        choices_counts = [sum(1 for v in votes if v.choice_id == c.id) for c in chs]

    verdict = evaluate(tally, present, total_members, q.majority_type, choices_counts)

    veto = db.query(Veto).filter_by(question_id=q.id).first()
    effective = verdict.passed
    if veto and not veto.overridden_at: effective = False

    choices_out = None
    if q.majority_type == "plurality":
        chs = db.query(Choice).filter_by(question_id=q.id).order_by(Choice.order_num).all()
        choices_out = [{"id": c.id, "text": c.text, "votes": sum(1 for v in votes if v.choice_id == c.id)} for c in chs]

    return {
        "for": tally.for_, "against": tally.against, "abstain": tally.abstain,
        "voters": tally.voters, "present": present,
        "has_quorum": present >= quorum_threshold(total_members),
        "passed": effective, "reason": verdict.reason, "needed": verdict.needed,
        "choices": choices_out,
        "veto": ({"reason": veto.reason, "chairman_id": veto.chairman_id, "created_at": veto.created_at.isoformat(), "overridden_at": veto.overridden_at.isoformat() if veto.overridden_at else None} if veto else None),
    }

def build_state(db, mid: int) -> dict:
    meeting = db.query(Meeting).get(mid)
    if not meeting: raise HTTPException(404, "Заседание не найдено")

    members = db.query(Member).filter_by(is_active=True).all()
    att_map = _meeting_attendance(db, mid)
    attendance = {m.id: (att_map[m.id].status if m.id in att_map else "absent") for m in members}
    present = sum(1 for mid_, s in attendance.items() if s == "present" and (mid_ not in att_map or att_map[mid_].role == "member"))
    needed = quorum_threshold(len(members))

    questions = db.query(Question).filter_by(meeting_id=mid).order_by(Question.order_num).all()
    current = next((q for q in questions if q.id == meeting.current_question_id), None)

    current_data = None
    if current:
        res = compute_results(db, current, att_map, len(members))
        current_data = {
            "id": current.id, "title": current.title, "text": current.text,
            "kind": current.kind, "status": current.status,
            "vote_type": current.vote_type, "majority_type": current.majority_type,
            "round": current.round, "results": res,
            "remote_deadline": current.remote_deadline.timestamp() if current.remote_deadline else None,
        }

    requests = db.query(Request).filter_by(meeting_id=mid).order_by(Request.created_at).all()
    req_data = [{
        "id": r.id, "member_id": r.member_id,
        "member_name": db.query(Member).get(r.member_id).name if r.member_id else "—",
        "type": r.type, "status": r.status, "question_id": r.question_id,
        "text": r.text, "created_at": r.created_at.isoformat(),
    } for r in requests]

    return {
        "meeting": {"id": meeting.id, "title": meeting.title, "status": meeting.status, "meeting_type": meeting.meeting_type, "format": meeting.format, "current_question_id": meeting.current_question_id},
        "attendance": attendance,
        "attendance_detail": {m.id: {"status": att_map[m.id].status if m.id in att_map else "absent", "role": att_map[m.id].role if m.id in att_map else "member", "is_valid_excuse": att_map[m.id].is_valid_excuse if m.id in att_map else False} for m in members},
        "members": [{"id": m.id, "name": m.name, "roles": m.roles} for m in members],
        "quorum": {"present": present, "needed": needed, "has_quorum": present >= needed, "total": len(members)},
        "questions": [{"id": q.id, "order_num": q.order_num, "title": q.title, "status": q.status, "kind": q.kind, "vote_type": q.vote_type, "majority_type": q.majority_type, "round": q.round} for q in questions],
        "current_question": current_data,
        "requests": req_data,
    }

async def push_state(db: DBSession, mid: int):
    await hub.broadcast(mid, {"type": "state", "state": build_state(db, mid)})

# --- FastAPI App ---
app = FastAPI(title="Система Совета")
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/", response_class=HTMLResponse)
def root(): return FileResponse("static/app.html")

@app.get("/board", response_class=HTMLResponse)
def board_page(): return FileResponse("static/board.html")

@app.post("/api/auth/login")
def login(body: LoginIn, db: DBSession = Depends(get_db)):
    m = db.query(Member).filter_by(name=body.name).first()
    if not m or not verify_password(body.password, m.password_hash):
        raise HTTPException(401, "Неверное имя или пароль")
    tok = new_token()
    db.add(AuthSession(token=tok, member_id=m.id)); db.commit()
    return {"token": tok, "member": {"id": m.id, "name": m.name, "roles": m.roles}}

@app.get("/api/me")
def me(m: Member = Depends(current_member)): return {"id": m.id, "name": m.name, "roles": m.roles}

@app.get("/api/meetings")
def list_meetings(db: DBSession = Depends(get_db)):
    return [{"id": mt.id, "title": mt.title, "status": mt.status, "meeting_type": mt.meeting_type, "format": mt.format} for mt in db.query(Meeting).order_by(Meeting.id.desc()).all()]

@app.get("/api/meetings/{mid}/state")
def state(mid: int, _=Depends(current_member), db: DBSession = Depends(get_db)): return build_state(db, mid)

@app.post("/api/meetings/{mid}/attendance")
async def set_attendance(mid: int, body: AttendanceIn, m: Member = Depends(require_role("secretary")), db: DBSession = Depends(get_db)):
    if body.status not in ("absent", "present", "left"): raise HTTPException(400, "Неверный статус")
    mt = db.query(Meeting).get(mid)
    if not mt: raise HTTPException(404, "Заседание не найдено")

    a = db.query(Attendance).filter_by(meeting_id=mid, member_id=body.member_id).first()
    if not a:
        a = Attendance(meeting_id=mid, member_id=body.member_id); db.add(a)
    a.status, a.role, a.is_valid_excuse, a.excuse_reason = body.status, body.role, body.is_valid_excuse, body.excuse_reason
    if body.status == "present" and not a.arrival_time: a.arrival_time = datetime.utcnow()
    if body.status == "left": a.departure_time = datetime.utcnow()

    audit(db, "attendance_set", meeting_id=mid, actor_id=m.id, target=body.member_id, status=body.status)
    db.commit(); await push_state(db, mid); return {"ok": True}

@app.post("/api/meetings/{mid}/questions")
async def add_question(mid: int, body: QuestionIn, m: Member = Depends(require_role("secretary")), db: DBSession = Depends(get_db)):
    n = db.query(Question).filter_by(meeting_id=mid).count() + 1
    q = Question(meeting_id=mid, order_num=n, title=body.title, text=body.text, kind=body.kind, vote_type=body.vote_type, majority_type=body.majority_type)
    db.add(q); db.flush()
    for i, c in enumerate(body.choices): db.add(Choice(question_id=q.id, text=c, order_num=i))
    audit(db, "question_add", meeting_id=mid, actor_id=m.id, qid=q.id)
    db.commit(); await push_state(db, mid); return {"ok": True, "id": q.id}

@app.post("/api/questions/{qid}/open")
async def open_question(qid: int, m: Member = Depends(require_role("secretary")), db: DBSession = Depends(get_db)):
    q = db.query(Question).get(qid)
    if not q: raise HTTPException(404, "Вопрос не найден")
    mt = db.query(Meeting).get(q.meeting_id)
    st = build_state(db, q.meeting_id)
    if not st["quorum"]["has_quorum"]: raise HTTPException(400, "Нет кворума. Голосование заблокировано.")
    q.status = "opened"; q.opened_at = datetime.utcnow()
    # 10 секунд на голосование для всех
    q.remote_deadline = datetime.utcnow() + timedelta(seconds=10)
    mt.current_question_id = q.id
    audit(db, "question_open", meeting_id=mt.id, actor_id=m.id, qid=qid)
    db.commit(); await push_state(db, mt.id); return {"ok": True}

@app.post("/api/questions/{qid}/close")
async def close_question(qid: int, m: Member = Depends(require_role("secretary")), db: DBSession = Depends(get_db)):
    q = db.query(Question).get(qid)
    if not q: raise HTTPException(404)
    q.status = "closed"; q.closed_at = datetime.utcnow()
    mt = db.query(Meeting).get(q.meeting_id)
    res = compute_results(db, q, _meeting_attendance(db, q.meeting_id), db.query(Member).filter_by(is_active=True).count())
    
    made_runoff = False
    if q.kind == "election" and q.majority_type == "plurality" and res["reason"] == "Ничья — требуется 2-й тур" and q.round == 1:
        finalists_ids = [c["id"] for c in res["choices"] if c["votes"] == max(x["votes"] for x in res["choices"])]
        q2 = Question(meeting_id=q.meeting_id, order_num=q.order_num + 1000, title=f"{q.title} — 2-й тур", kind="election", majority_type="plurality", round=2, parent_question_id=q.id, status="opened", opened_at=datetime.utcnow(), remote_deadline=datetime.utcnow() + timedelta(seconds=10))
        db.add(q2); db.flush()
        for cid in finalists_ids:
            src = db.query(Choice).get(cid); db.add(Choice(question_id=q2.id, text=src.text, order_num=src.order_num))
        mt.current_question_id = q2.id; made_runoff = True

    if not made_runoff and mt.current_question_id == q.id: mt.current_question_id = None
    audit(db, "question_close", meeting_id=q.meeting_id, actor_id=m.id, qid=qid)
    db.commit(); await push_state(db, q.meeting_id); return {"ok": True, "runoff": made_runoff}

@app.post("/api/questions/{qid}/vote")
async def vote(qid: int, body: VoteIn, m: Member = Depends(current_member), db: DBSession = Depends(get_db)):
    if bool(body.value) == bool(body.choice_id): raise HTTPException(400, "Укажите либо значение, либо кандидата")
    q = db.query(Question).get(qid)
    if not q or q.status != "opened": raise HTTPException(400, "Голосование не открыто")
    
    att = db.query(Attendance).filter_by(meeting_id=q.meeting_id, member_id=m.id).first()
    if not att or att.status != "present" or att.role == "observer": raise HTTPException(403, "Вы не можете голосовать (нет статуса присутствия)")

    # ОБЩАЯ ПРОВЕРКА ТАЙМЕРА (10 СЕКУНД НА ВСЁ ГОЛОСОВАНИЕ)
    if q.remote_deadline and datetime.utcnow() > q.remote_deadline:
        raise HTTPException(403, "Время голосования (10 сек) истекло.")

    conflict = db.query(Request).filter_by(meeting_id=q.meeting_id, member_id=m.id, question_id=qid, type="conflict", status="granted").first()
    if conflict: raise HTTPException(403, "У вас конфликт интересов по этому вопросу")
    if db.query(Vote).filter_by(question_id=qid, member_id=m.id, round=q.round).first(): raise HTTPException(400, "Вы уже проголосовали")

    db.add(Vote(question_id=qid, member_id=m.id, value=body.value, choice_id=body.choice_id, round=q.round))
    db.commit(); await push_state(db, q.meeting_id); return {"ok": True}

@app.post("/api/questions/{qid}/veto")
async def impose_veto(qid: int, body: VetoIn, m: Member = Depends(require_role("chairman")), db: DBSession = Depends(get_db)):
    if not body.reason.strip(): raise HTTPException(400, "Требуется мотивировка вето")
    q = db.query(Question).get(qid)
    if not q or q.status != "closed": raise HTTPException(400, "Вето возможно только на закрытый вопрос")
    if db.query(Veto).filter_by(question_id=qid).first(): raise HTTPException(400, "Вето уже наложено")
    db.add(Veto(question_id=qid, chairman_id=m.id, reason=body.reason))
    audit(db, "veto", meeting_id=q.meeting_id, actor_id=m.id, qid=qid)
    db.commit(); await push_state(db, q.meeting_id); return {"ok": True}

@app.post("/api/meetings/{mid}/requests")
async def create_request(mid: int, body: RequestIn, m: Member = Depends(current_member), db: DBSession = Depends(get_db)):
    if body.type not in ("speak", "question", "dissent", "conflict"): raise HTTPException(400, "Неверный тип запроса")
    q = db.query(Question).get(body.question_id) if body.question_id else None
    if q and q.status == "opened" and body.type in ("speak", "question"): raise HTTPException(400, "Идёт голосование. Запрос отложен.")
    r = Request(meeting_id=mid, member_id=m.id, question_id=body.question_id, type=body.type, text=body.text)
    db.add(r); db.commit(); await push_state(db, mid); return {"ok": True, "id": r.id}

@app.post("/api/requests/{rid}/handle")
async def handle_request(rid: int, body: HandleIn, m: Member = Depends(current_member), db: DBSession = Depends(get_db)):
    if not ({"chairman", "secretary"} & set(m.roles or [])): raise HTTPException(403, "Требуется роль Председателя")
    if body.action not in ("granted", "rejected", "deferred", "done"): raise HTTPException(400, "Неверное действие")
    r = db.query(Request).get(rid)
    if not r: raise HTTPException(404)
    r.status, r.handled_by, r.handled_at = body.action, m.id, datetime.utcnow()
    # ИСПРАВЛЕНИЕ ОШИБКИ 500: передаем action под другим именем (act), чтобы не было конфликта
    audit(db, "request_handle", meeting_id=r.meeting_id, actor_id=m.id, rid=rid, act=body.action)
    db.commit(); await push_state(db, r.meeting_id); return {"ok": True}

@app.post("/api/meetings/{mid}/display-token")
def create_display_token(mid: int, m: Member = Depends(require_role("secretary")), db: DBSession = Depends(get_db)):
    mt = db.query(Meeting).get(mid)
    if not mt: raise HTTPException(404)
    tok = new_token(); db.add(DisplayToken(token=tok, meeting_id=mid, expires_at=datetime.utcnow() + timedelta(minutes=5), activated=False, active=True)); db.commit()
    url = f"/board?t={tok}"; img = qrcode.make(url); buf = io.BytesIO(); img.save(buf, format="PNG"); b64 = base64.b64encode(buf.getvalue()).decode()
    return {"token": tok, "url": url, "qr": f"data:image/png;base64,{b64}"}

@app.post("/api/display/activate")
def activate_display(body: ActivateDisplayIn, db: DBSession = Depends(get_db)):
    dt = db.query(DisplayToken).filter_by(token=body.t).first()
    if not dt or not dt.active or dt.expires_at < datetime.utcnow(): raise HTTPException(400, "Токен недействителен или истёк")
    if not dt.activated: dt.activated = True; dt.expires_at = datetime.utcnow() + timedelta(hours=12); db.commit()
    return {"display_token": dt.token, "meeting_id": dt.meeting_id}

@app.get("/api/display/{token}/state")
def display_state(token: str, db: DBSession = Depends(get_db)):
    dt = db.query(DisplayToken).filter_by(token=token).first()
    if not dt or not dt.active or dt.expires_at < datetime.utcnow(): raise HTTPException(403, "Токен табло недействителен")
    return build_state(db, dt.meeting_id)

@app.get("/api/meetings/{mid}/protocol", response_class=HTMLResponse)
def get_protocol(mid: int, m: Member = Depends(current_member), db: DBSession = Depends(get_db)):
    mt = db.query(Meeting).get(mid)
    if not mt: raise HTTPException(404)
    members = db.query(Member).filter_by(is_active=True).all()
    att_map = _meeting_attendance(db, mid)
    attendance = [{"name": mem.name, "status": att_map[mem.id].status if mem.id in att_map else "absent", "role": att_map[mem.id].role if mem.id in att_map else "member", "is_valid_excuse": att_map[mem.id].is_valid_excuse if mem.id in att_map else False, "excuse_reason": att_map[mem.id].excuse_reason if mem.id in att_map else None} for mem in members]
    questions = []
    for q in db.query(Question).filter_by(meeting_id=mid).order_by(Question.order_num):
        res = compute_results(db, q, att_map, len(members))
        roll = [{"name": db.query(Member).get(v.member_id).name, "value": v.value} for v in db.query(Vote).filter_by(question_id=q.id, round=q.round)] if q.vote_type == "roll_call" else []
        reqs = [{"member_name": db.query(Member).get(r.member_id).name, "type": r.type, "status": r.status, "text": r.text} for r in db.query(Request).filter_by(meeting_id=mid, question_id=q.id)]
        questions.append({"order_num": q.order_num, "title": q.title, "text": q.text, "status": q.status, "vote_type": q.vote_type, "results": res, "veto": res["veto"], "roll": roll, "requests": reqs})
    all_requests = [{"member_name": db.query(Member).get(r.member_id).name, "type": r.type, "text": r.text} for r in db.query(Request).filter_by(meeting_id=mid)]
    html = render_protocol(mt, attendance, len(members), questions, all_requests)
    return HTMLResponse(f"<html><head><meta charset='utf-8'><style>body{{font-family:serif;max-width:900px;margin:2em auto;padding:0 1em}}table{{border-collapse:collapse}}</style></head><body>{html}</body></html>")

@app.websocket("/ws/{mid}")
async def ws(websocket: WebSocket, mid: int, token: str = Query(...)):
    db = SessionLocal()
    try:
        ok = bool(db.query(AuthSession).filter_by(token=token).first()) or (dt := db.query(DisplayToken).filter_by(token=token).first()) and dt.active and dt.expires_at > datetime.utcnow()
        if not ok: await websocket.close(code=1008); return
        await hub.join(mid, websocket)
        try:
            await websocket.send_json({"type": "state", "state": build_state(db, mid)})
            while True: await websocket.receive_text()
        except WebSocketDisconnect: hub.leave(mid, websocket)
    finally: db.close()