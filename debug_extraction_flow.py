import sys, json, sqlite3
sys.path.insert(0, ".")
from database.db import get_session, get_engine
from database.models import Document, DocumentSection
engine = get_engine()
session = get_session(engine)
sections = session.query(DocumentSection).all()
for s in sections[:5]:
    print(f"Section title: {s.title}, DocID: {s.document_id}")
session.close()
