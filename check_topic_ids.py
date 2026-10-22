import sys, json, sqlite3
sys.path.insert(0, ".")
from database.db import get_session, get_engine
from database.models import Topic
engine = get_engine()
session = get_session(engine)
sub = session.query(Topic).all()
for t in sub:
    ids = t.source_document_ids
    print(f"Topic: {t.name}, DocIDs: '{ids}'")
session.close()
