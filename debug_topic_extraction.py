import sys, json, sqlite3
sys.path.insert(0, ".")
from database.db import get_session, get_engine
from services.topic_ranker import TopicRanker
from database.models import Topic
engine = get_engine()
session = get_session(engine)
# List topics for first subject
sub = session.query(Topic).all()
print(f"Total topics in DB: {len(sub)}")
for t in sub:
    print(f"Topic: {t.name}, SubjectID: {t.subject_id}, DocIDs: {t.source_document_ids}")
session.close()
