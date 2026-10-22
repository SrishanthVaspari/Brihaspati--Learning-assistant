import sys
sys.path.insert(0, ".")
from database.db import init_db, get_session, get_engine
from services.ai_service import AIService
from services.topic_ranker import TopicRanker
from services.roadmap_service import RoadmapService
from database.models import Subject
from datetime import date, timedelta

init_db()
engine = get_engine()
session = get_session(engine)
ai_service = AIService()
ranker = TopicRanker(ai_service, session)
roadmap_service = RoadmapService(ai_service, session, ranker)

subjects = session.query(Subject).all()
if not subjects:
    print("No subjects")
else:
    subject = subjects[0]
    print(f"Subject: {subject.id} {subject.name}, exam_date={subject.exam_date}")
    topics = ranker.rank_topics(subject.id)
    print(f"Ranked topics: {len(topics)}")
    for t in topics:
        print(f"  {t['name']} - {t['estimated_hours']} hrs, priority {t['priority_score']}")

    exam = date.today() + timedelta(days=30)
    result = roadmap_service.generate_roadmap(subject.id, exam, 3.0)
    print(f"Generated: id={result['id']}, days={len(result['days'])}")
    for d in result['days']:
        print(f"  {d['date']}: {d['tasks']}")
session.close()
