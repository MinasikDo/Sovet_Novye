from datetime import datetime
from models import Base, Member, Meeting, Attendance, Question, Choice, Vote
from main import engine, SessionLocal, hash_password

# Создаем таблицы, если их нет
Base.metadata.create_all(engine)
db = SessionLocal()

# Проверка, чтобы не перезаписать базу
if db.query(Member).count() > 0:
    print("База уже засеяна. Удалите council.db для пересоздания.")
    raise SystemExit(0)

# Список из 16 человек (0-й — председатель, 5-й — секретарь)
NAMES = [
    ("Чувилев Матфей", "Matfey_88"),             # 0  Председатель
    ("Гайворонский Николай", "cactus_boris"),    # 1
    ("Ермаков Влад", "WhatIsLove5273"),          # 2
    ("Кокорев Андрей", "azzillukki"),            # 3
    ("Арутюнян Самвел", "samvelochka"),          # 4
    ("Чернышов Артём", "catmenmilota"),          # 5  Секретарь
    ("Асалханов Александр", "AlexandrAsalkhanov"),# 6
    ("Спирина Анастасия", "gxxmili"),            # 7
    ("Дугин Антон", "iamiat"),                   # 8
    ("Дзукаева Адриана", "i_Audrey_7"),          # 9
    ("Котлярова Татьяна", "bitterrsaltsugg"),    # 10
    ("Кадин Давид", "zhan_klod_van_dan"),        # 11
    ("Халиков Данила", "gdfg1221"),              # 12 (опоздал)
    ("Резерв 14", None),                         # 13 (отсутствует)
    ("Резерв 15", None),                         # 14 (отсутствует)
    ("Резерв 16", None)                          # 15 (отсутствует)
]

members = []
for i, (name, tg) in enumerate(NAMES):
    roles = ["member"]
    if i == 0: roles.append("chairman")
    if i == 5: roles.append("secretary")
    # Пароль для всех: pass
    members.append(Member(name=name, telegram=tg, roles=roles, password_hash=hash_password("pass")))

db.add_all(members)
db.flush() # Получаем ID созданных пользователей

# Создаем заседание
mt = Meeting(
    title="Заседание Малого Совета от 24.10.2026", 
    meeting_type="regular", 
    format="present", # Формат: очный
    status="active", 
    started_at=datetime(2026, 10, 24, 15, 0), 
    protocol_num=1
)
db.add(mt)
db.flush()

# Отмечаем присутствие (ВСЕ ТОЛЬКО ОЧНО)
# 0-7 пришли вовремя
for i in range(8): 
    db.add(Attendance(meeting_id=mt.id, member_id=members[i].id, status="present", role="member", arrival_time=datetime(2026, 10, 24, 15, 0)))
# 8-11 тоже очно (дистанционных больше нет)
for i in range(8, 12): 
    db.add(Attendance(meeting_id=mt.id, member_id=members[i].id, status="present", role="member", arrival_time=datetime(2026, 10, 24, 15, 0)))
# 12-й опоздал
db.add(Attendance(meeting_id=mt.id, member_id=members[12].id, status="present", role="member", arrival_time=datetime(2026, 10, 24, 15, 3)))
# 13, 14, 15 отсутствуют (записи не создаем, по умолчанию absent)

# 1. Исторический вопрос (уже закрыт и принят)
q1 = Question(
    meeting_id=mt.id, 
    order_num=1, 
    title="Назначить секретарём собрания Чернышова Артёма", 
    kind="decision", 
    status="closed", 
    vote_type="open", 
    majority_type="simple", 
    opened_at=datetime(2026, 10, 24, 15, 5), 
    closed_at=datetime(2026, 10, 24, 15, 6)
)
db.add(q1)
db.flush()

# Все 13 присутствующих проголосовали "За"
for i in range(13): 
    db.add(Vote(question_id=q1.id, member_id=members[i].id, value="for"))

# 2. Демо-вопрос (ожидает открытия, чтобы вы могли протестировать таймер)
q_demo = Question(
    meeting_id=mt.id, 
    order_num=18, 
    title="Создать рабочую группу по цифровизации", 
    text="В помощь методотделу: сайты, боты, IT-инициативы.", 
    kind="decision", 
    status="pending", 
    vote_type="open", 
    majority_type="simple"
)
db.add(q_demo)

db.commit()
print("✅ База данных успешно создана.")
print("Пароль для всех: 'pass'")
print("Секретарь: Чернышов Артём")
print("Председатель: Чувилев Матфей")