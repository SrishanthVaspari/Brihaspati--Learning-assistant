"""SQLite database setup and schema for Brihaspati."""

import logging
import os
import sqlite3
from pathlib import Path
import sqlalchemy
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


def get_engine(db_path: str = None):
    """Return a SQLAlchemy engine."""
    path = db_path or get_db_path()
    return create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})


def get_session(engine):
    """Return a scoped session."""
    session_factory = sessionmaker(bind=engine)
    re