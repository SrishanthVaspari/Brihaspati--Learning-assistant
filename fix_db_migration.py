import sqlite3
import os
db_path = os.getenv("DATABASE_PATH", "data/brihaspati.db")
conn = sqlite3.connect(db_path)
cursor = conn.cursor()
cursor.execute("ALTER TABLE topics ADD COLUMN source_document_ids TEXT")
conn.commit()
conn.close()
