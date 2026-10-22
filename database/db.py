"""SQLite database setup and schema for Brihaspati.

Two access layers are available:
    * :func:`get_connection` — raw sqlite3, used by the small
      settings/profile helpers below.
    * :func:`get_engine` / :func:`get_session` — SQLAlchemy ORM, used by
      the domain services (quiz, topics, roadmap, …).
"""

import logging
import os
import sqlite3
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, scoped_session

logger = logging.getLogger(__name__)


def get_db_path() -> str:
    """Return the SQLite database path, creating parent dirs."""
    db_path = os.getenv("DATABASE_PATH", "data/brihaspati.db")
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    return db_path


def get_connection() -> sqlite3.Connection:
    """Return a SQLite connection with foreign keys enabled."""
    conn = sqlite3.connect(get_db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def get_engine():
    """Return a SQLAlchemy engine pointing at the SQLite file."""
    return create_engine(
        f"sqlite:///{get_db_path()}",
        connect_args={"check_same_thread": False},
    )


def get_session(engine):
    """Return a scoped session bound to ``engine``."""
    session_factory = sessionmaker(bind=engine)
    return scoped_session(session_factory)


SCHEMA = """
CREATE TABLE IF NOT EXISTS student_profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL DEFAULT 'Student',
    college TEXT DEFAULT '',
    degree TEXT DEFAULT '',
    semester INTEGER DEFAULT 1,
    grading_system TEXT DEFAULT 'percentage',
    max_attendance_absence_pct REAL DEFAULT 25.0,
    study_hours_per_day REAL DEFAULT 4.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    current_streak INTEGER DEFAULT 0,
    last_studied_date TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT DEFAULT '',
    semester INTEGER DEFAULT 1,
    credits INTEGER DEFAULT 4,
    exam_date TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    file_type TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    text TEXT,
    page_count INTEGER DEFAULT 0,
    file_size INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS document_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL,
    title TEXT DEFAULT '',
    content TEXT,
    page INTEGER DEFAULT 0,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    source_document_id INTEGER,
    syllabus_weightage REAL DEFAULT 0,
    estimated_hours REAL DEFAULT 1.0,
    difficulty TEXT DEFAULT 'medium',
    prerequisite_topic_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
    FOREIGN KEY (source_document_id) REFERENCES documents(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS generated_materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER NOT NULL,
    material_type TEXT NOT NULL,
    topic_id INTEGER,
    title TEXT DEFAULT '',
    content TEXT,
    questions_json TEXT,
    source_document_ids TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quizzes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    topic_id INTEGER,
    total_marks INTEGER DEFAULT 10,
    negative_marking REAL DEFAULT 0,
    time_limit_minutes INTEGER DEFAULT 0,
    questions_json TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quiz_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    topic_id INTEGER,
    score REAL DEFAULT 0,
    max_score REAL DEFAULT 0,
    percentage REAL DEFAULT 0,
    answers_json TEXT,
    started_at TIMESTAMP,
    completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS marks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER NOT NULL,
    assessment_name TEXT NOT NULL,
    max_marks REAL NOT NULL,
    marks_obtained REAL NOT NULL,
    weightage REAL DEFAULT 100.0,
    assessment_type TEXT DEFAULT 'exam',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    attended INTEGER NOT NULL DEFAULT 1,
    note TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    task_type TEXT DEFAULT 'study',
    subject_id INTEGER,
    due_date TEXT,
    priority TEXT DEFAULT 'medium',
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS study_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER,
    topic_id INTEGER,
    planned_date TEXT,
    duration_minutes INTEGER DEFAULT 60,
    status TEXT DEFAULT 'planned',
    actual_duration_minutes INTEGER,
    notes TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    title TEXT NOT NULL,
    message TEXT DEFAULT '',
    remind_at TEXT NOT NULL,
    sent INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS video_recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER,
    topic_id INTEGER,
    title TEXT NOT NULL,
    channel TEXT DEFAULT '',
    url TEXT NOT NULL,
    duration TEXT DEFAULT '',
    reason TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE SET NULL
);
"""


def init_db() -> None:
    """Create all tables if they don't exist."""
    from database.models import Base  # noqa: PLC0415
    engine = get_engine()
    Base.metadata.create_all(bind=engine)
    logger.info("Database initialized at %s", get_db_path())


def get_setting(key: str, default: str = "") -> str:
    """Read a setting from the settings table."""
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT value FROM settings WHERE key = ?", (key,)
        ).fetchone()
        return row["value"] if row else default
    finally:
        conn.close()


def set_setting(key: str, value: str) -> None:
    """Write a setting to the settings table."""
    conn = get_connection()
    try:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        conn.commit()
    finally:
        conn.close()
