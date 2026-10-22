import sqlite3
import os
from pathlib import Path

db_path = os.getenv("DATABASE_PATH", "data/brihaspati.db")
if not os.path.exists(db_path):
    print(f"Database not found at {db_path}")
    exit(1)

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

def column_exists(table, column):
    cursor.execute(f"PRAGMA table_info({table})")
    columns = [info[1] for info in cursor.fetchall()]
    return column in columns

try:
    if not column_exists("student_profile", "current_streak"):
        print("Adding column current_streak...")
        cursor.execute("ALTER TABLE student_profile ADD COLUMN current_streak INTEGER DEFAULT 0")

    if not column_exists("student_profile", "last_studied_date"):
        print("Adding column last_studied_date...")
        cursor.execute("ALTER TABLE student_profile ADD COLUMN last_studied_date TIMESTAMP")

    conn.commit()
    print("Migration successful.")
except Exception as e:
    print(f"Migration failed: {e}")
finally:
    conn.close()
