from datetime import datetime
from sqlalchemy import (Column, Integer, String, DateTime, ForeignKey,
                        Boolean, JSON, UniqueConstraint, Text)
from sqlalchemy.orm import declarative_base

Base = declarative_base()

class Member(Base):
    __tablename__ = "members"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False, unique=True)
    telegram = Column(String, nullable=True)
    password_hash = Column(String, nullable=False)
    roles = Column(JSON, default=list)          # ["member","chairman","secretary"]
    is_active = Column(Boolean, default=True)

class AuthSession(Base):
    __tablename__ = "auth_sessions"
    token = Column(String, primary_key=True)
    member_id = Column(Integer, ForeignKey("members.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

class Meeting(Base):
    __tablename__ = "meetings"
    id = Column(Integer, primary_key=True)
    title = Column(String, nullable=False)
    meeting_type = Column(String, default="regular")   # regular | emergency | extraordinary
    format = Column(String, default="mixed")           # present | remote | mixed
    status = Column(String, default="preparing")       # preparing | active | closed
    started_at = Column(DateTime, nullable=True)
    closed_at = Column(DateTime, nullable=True)
    current_question_id = Column(Integer, nullable=True)
    protocol_num = Column(Integer, nullable=True)
    published_at = Column(DateTime, nullable=True)

class Attendance(Base):
    __tablename__ = "attendance"
    id = Column(Integer, primary_key=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=False)
    member_id = Column(Integer, ForeignKey("members.id"), nullable=False)
    status = Column(String, default="absent")          # absent | present | remote | left
    role = Column(String, default="member")            # member | observer
    is_valid_excuse = Column(Boolean, default=False)
    excuse_reason = Column(String, nullable=True)
    arrival_time = Column(DateTime, nullable=True)
    departure_time = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    __table_args__ = (UniqueConstraint("meeting_id", "member_id"),)

class Question(Base):
    __tablename__ = "questions"
    id = Column(Integer, primary_key=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=False)
    order_num = Column(Integer, nullable=False)
    title = Column(String, nullable=False)
    text = Column(Text, default="")
    kind = Column(String, default="decision")          # decision | resolution | election | amendment
    status = Column(String, default="pending")         # pending | opened | closed
    vote_type = Column(String, default="open")         # open | secret | roll_call
    majority_type = Column(String, default="simple")   # simple | qualified_11 | two_thirds | plurality
    round = Column(Integer, default=1)
    parent_question_id = Column(Integer, nullable=True)
    opened_at = Column(DateTime, nullable=True)
    remote_deadline = Column(DateTime, nullable=True)  # Дедлайн для дистанционных
    closed_at = Column(DateTime, nullable=True)

class Choice(Base):
    __tablename__ = "choices"
    id = Column(Integer, primary_key=True)
    question_id = Column(Integer, ForeignKey("questions.id"), nullable=False)
    text = Column(String, nullable=False)
    order_num = Column(Integer, default=0)

class Vote(Base):
    __tablename__ = "votes"
    id = Column(Integer, primary_key=True)
    question_id = Column(Integer, ForeignKey("questions.id"), nullable=False)
    member_id = Column(Integer, ForeignKey("members.id"), nullable=False)
    value = Column(String, nullable=True)              # for | against | abstain
    choice_id = Column(Integer, ForeignKey("choices.id"), nullable=True)
    round = Column(Integer, default=1)
    created_at = Column(DateTime, default=datetime.utcnow)
    __table_args__ = (UniqueConstraint("question_id", "member_id", "round"),)

class Request(Base):
    __tablename__ = "requests"
    id = Column(Integer, primary_key=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=False)
    member_id = Column(Integer, ForeignKey("members.id"), nullable=False)
    question_id = Column(Integer, ForeignKey("questions.id"), nullable=True)
    type = Column(String, nullable=False)              # speak | question | dissent | conflict
    status = Column(String, default="pending")         # pending | granted | rejected | deferred | done
    text = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    handled_by = Column(Integer, ForeignKey("members.id"), nullable=True)
    handled_at = Column(DateTime, nullable=True)

class Veto(Base):
    __tablename__ = "vetoes"
    id = Column(Integer, primary_key=True)
    question_id = Column(Integer, ForeignKey("questions.id"), nullable=False, unique=True)
    chairman_id = Column(Integer, ForeignKey("members.id"), nullable=False)
    reason = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    overridden_at = Column(DateTime, nullable=True)

class DisplayToken(Base):
    __tablename__ = "display_tokens"
    token = Column(String, primary_key=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=False)
    expires_at = Column(DateTime, nullable=False)
    activated = Column(Boolean, default=False)
    active = Column(Boolean, default=True)

class StoredFile(Base):
    __tablename__ = "files"
    id = Column(Integer, primary_key=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=True)
    question_id = Column(Integer, ForeignKey("questions.id"), nullable=True)
    uploaded_by = Column(Integer, ForeignKey("members.id"), nullable=False)
    original_name = Column(String, nullable=False)
    stored_path = Column(String, nullable=False)
    mime = Column(String, default="application/octet-stream")
    size = Column(Integer, default=0)
    sha256 = Column(String, nullable=False)
    is_public = Column(Boolean, default=False)
    public_token = Column(String, nullable=True, unique=True)
    created_at = Column(DateTime, default=datetime.utcnow)

class WorkingGroup(Base):
    __tablename__ = "working_groups"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    description = Column(String, default="")
    head_id = Column(Integer, ForeignKey("members.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    closed_at = Column(DateTime, nullable=True)

class WorkingGroupMember(Base):
    __tablename__ = "wg_members"
    group_id = Column(Integer, ForeignKey("working_groups.id"), primary_key=True)
    member_id = Column(Integer, ForeignKey("members.id"), primary_key=True)

class Board(Base):
    __tablename__ = "boards"
    id = Column(Integer, primary_key=True)
    title = Column(String, nullable=False)
    group_id = Column(Integer, ForeignKey("working_groups.id"), nullable=True)
    created_by = Column(Integer, ForeignKey("members.id"))
    created_at = Column(DateTime, default=datetime.utcnow)

class BoardColumn(Base):
    __tablename__ = "board_columns"
    id = Column(Integer, primary_key=True)
    board_id = Column(Integer, ForeignKey("boards.id"), nullable=False)
    title = Column(String, nullable=False)
    order_num = Column(Integer, default=0)
    is_done_column = Column(Boolean, default=False)

class Card(Base):
    __tablename__ = "cards"
    id = Column(Integer, primary_key=True)
    column_id = Column(Integer, ForeignKey("board_columns.id"), nullable=False)
    title = Column(String, nullable=False)
    description = Column(Text, default="")
    assignee_id = Column(Integer, ForeignKey("members.id"), nullable=True)
    due_date = Column(DateTime, nullable=True)
    order_num = Column(Integer, default=0)
    linked_question_id = Column(Integer, ForeignKey("questions.id"), nullable=True)
    created_by = Column(Integer, ForeignKey("members.id"))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class AuditLog(Base):
    __tablename__ = "audit_log"
    id = Column(Integer, primary_key=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=True)
    actor_id = Column(Integer, ForeignKey("members.id"), nullable=True)
    action = Column(String, nullable=False)
    payload = Column(JSON, default=dict)
    created_at = Column(DateTime, default=datetime.utcnow)