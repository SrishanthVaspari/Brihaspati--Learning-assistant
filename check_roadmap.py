import sqlite3
import json
conn = sqlite3.connect("data/brihaspati.db")
cursor = conn.cursor()
cursor.execute("SELECT * FROM roadmaps")
rows = cursor.fetchall()
print(f"Roadmaps rows: {len(rows)}")
for row in rows:
    print(row)
conn.close()
