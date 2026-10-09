"""Data access helpers — one function per table."""

import json
import sqlite3
from datetime import datetime
from typing import Any

from database.db import get_connection


def _rows_to_dicts(rows: list[sqlite3.Row]) -> list[dict]:
    return [dict(r) for r in rows]


# ── Student profile ────────────────────────────────────

def get_profile() -> dict:
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM student_profile WHERE id = 1").fetchone()
        if row:
            return dict(row)
        conn.execute(
            "INSERT INTO student_profile (id, name) VALUES (1, 'Student')"
        )
        conn.commit()
        return dict(conn.execute(
            "SELECT * FROM student_profile WHERE id = 1"
        ).fetchone())
    finally:
        conn.close()


def update_profile(data: dict) -> None:
    conn = get_connection()
    try:
        keys = [k for k in data if k in {
            "name", "college", "degree", "semester",
            "grading_system", "max_attendance_absence_pct", "study_hours_per_day",
        }]
        if not keys:
            return
        set_clause = ", ".join(f"{k} = ?" for k in keys)
        values = [data[k] for k in keys]
        conn.execute(
            f"UPDATE student_profile SET {set_clause}, "
            "updated_at = CURRENT_TIMESTAMP WHERE id = 1",
            values,
        )
        conn.commit()
    finally:
        conn.close()


# ── Subjects ───────────────────────────────────────────

def list_subjects() -> list[dict]:
    conn = get_connection()
    try:
        return _rows_to_dicts(conn.execute(
            "SELECT * FROM subjects ORDER BY semester, name"
        ).fetchall())
    finally:
        conn.close()


def get_subject(subject_id: int) -> dict | None:
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM subjects WHERE id = ?", (subject_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def create_subject(name: str, code: str = "", semester: int = 1,
                   credits: int = 4, exam_date: str = None) -> int:
    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO subjects (name, code, semester, credits, exam_date) "
            "VALUES (?, ?, ?, ?, ?)",
            (name, code, semester, credits, exam_date),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def update_subject(subject_id: int, data: dict) -> None:
    conn = get_connection()
    try:
        keys = [k for k in data if k in {"name", "code", "semester", "credits", "exam_date"}]
        if not keys:
            return
        set_clause = ", ".join(f"{k} = ?" for k in keys)
        conn.execute(
            f"UPDATE subjects SET {set_clause} WHERE id = ?",
            [data[k] for k in keys] + [subject_id],
        )
        conn.commit()
    finally:
        conn.close()


def delete_subject(subject_id: int) -> None:
    conn = get_connection()
    try:
        conn.execute("DELETE FROM subjects WHERE id = ?", (subject_id,))
        conn.commit()
    finally:
        conn.close()


# ── Documents ──────────────────────────────────────────

def list_documents(subject_id: int = None) -> list[dict]:
    conn = get_connection()
    try:
        if subject_id:
            rows = conn.execute(
                "SELECT * FROM documents WHERE subject_id = ? "
                "ORDER BY created_at DESC", (subject_id,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM documents ORDER BY created_at DESC"
            ).fetchall()
        return _rows_to_dicts(rows)
    finally:
        conn.close()


def get_document(document_id: int) -> dict | None:
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM documents WHERE id = ?", (document_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def create_document(subject_id: int, filename: str, file_type: str,
                    original_filename: str, text: str, page_count: int,
                    file_size: int = 0) -> int:
    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO documents (subject_id, filename, file_type, "
            "original_filename, text, page_count, file_size) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (subject_id, filename, file_type, original_filename,
             text, page_count, file_size),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def delete_document(document_id: int) -> None:
    conn = get_connection()
    try:
        conn.execute("DELETE FROM documents WHERE id = ?", (document_id,))
        conn.commit()
    finally:
        conn.close()


def list_document_sections(document_id: int) -> list[dict]:
    conn = get_connection()
    try:
        return _rows_to_dicts(conn.execute(
            "SELECT * FROM document_sections WHERE document_id = ? "
            "ORDER BY page", (document_id,)
        ).fetchall())
    finally:
        conn.close()


def create_document_sections(document_id: int, sections: list[dict]) -> None:
    conn = get_connection()
    try:
        conn.executemany(
            "INSERT INTO document_sections (document_id, title, content, page) "
            "VALUES (?, ?, ?, ?)",
            [(document_id, s["title"], s["content"], s.get("page", 0))
             for s in sections],
        )
        conn.commit()
    finally:
        conn.close()


# ── Topics ─────────────────────────────────────────────

def list_topics(subject_id: int = None) -> list[dict]:
    conn = get_connection()
    try:
        if subject_id:
            rows = conn.execute(
                "SELECT * FROM topics WHERE subject_id = ? ORDER BY name",
                (subject_id,),
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM topics ORDER BY name").fetchall()
        return _rows_to_dicts(rows)
    finally:
        conn.close()


def get_topic(topic_id: int) -> dict | None:
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM topics WHERE id = ?", (topic_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def create_topic(subject_id: int, name: str, **kwargs) -> int:
    conn = get_connection()
    try:
        allowed = {
            "source_document_id", "syllabus_weightage", "estimated_hours",
            "difficulty", "prerequisite_topic_id",
        }
        cols = ["subject_id", "name"]
        vals = [subject_id, name]
        for k, v in kwargs.items():
            if k in allowed and v is not None:
                cols.append(k)
                vals.append(v)
        placeholders = ", ".join("?" * len(cols))
        cur = conn.execute(
            f"INSERT INTO topics ({', '.join(cols)}) VALUES ({placeholders})",
            vals,
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def update_topic(topic_id: int, data: dict) -> None:
    conn = get_connection()
    try:
        allowed = {"name", "syllabus_weightage", "estimated_hours",
                   "difficulty", "prerequisite_topic_id"}
        keys = [k for k in data if k in allowed]
        if not keys:
            return
        set_clause = ", ".join(f"{k} = ?" for k in keys)
        conn.execute(
            f"UPDATE topics SET {set_clause} WHERE id = ?",
            [data[k] for k in keys] + [topic_id],
        )
        conn.commit()
    finally:
        conn.close()


def delete_topic(topic_id: int) -> None:
    conn = get_connection()
    try:
        conn.execute("DELETE FROM topics WHERE id = ?", (topic_id,))
        conn.commit()
    finally:
        conn.close()


# ── Generated materials ────────────────────────────────

def list_materials(subject_id: int = None,
                   material_type: str = None) -> list[dict]:
    conn = get_connection()
    try:
        query = "SELECT * FROM generated_materials"
        clauses, params = [], []
        if subject_id:
            clauses.append("subject_id = ?")
            params.append(subject_id)
        if material_type:
            clauses.append("material_type = ?")
            params.append(material_type)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY created_at DESC"
        return _rows_to_dicts(conn.execute(query, params).fetchall())
    finally:
        conn.close()


def get_material(material_id: int) -> dict | None:
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM generated_materials WHERE id = ?", (material_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def create_material(subject_id: int, material_type: str, title: str,
                    content: str = None, questions_json: str = None,
                    topic_id: int = None,
                    source_document_ids: list[int] = None) -> int:
    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO generated_materials (subject_id, material_type, "
            "topic_id, title, content, questions_json, source_document_ids) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (subject_id, material_type, topic_id, title, content,
             questions_json,
             json.dumps(source_document_ids) if source_document_ids else None),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def delete_material(material_id: int) -> None:
    conn = get_connection()
    try:
        conn.execute(
            "DELETE FROM generated_materials WHERE id = ?", (material_id,)
        )
        conn.commit()
    finally:
        conn.close()


# ── Quizzes ────────────────────────────────────────────

def list_quizzes(subject_id: int = None) -> list[dict]:
    conn = get_connection()
    try:
        if subject_id:
            rows = conn.execute(
                "SELECT * FROM quizzes WHERE subject_id = ? "
                "ORDER BY created_at DESC", (subject_id,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM quizzes ORDER BY created_at DESC"
            ).fetchall()
        return _rows_to_dicts(rows)
    finally:
        conn.close()


def get_quiz(quiz_id: int) -> dict | None:
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM quizzes WHERE id = ?", (quiz_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def create_quiz(subject_id: int, title: str, questions_json: str,
                topic_id: int = None, total_marks: int = 10,
                negative_marking: float = 0, time_limit_minutes: int = 0) -> int:
    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO quizzes (subject_id, title, topic_id, total_marks, "
            "negative_marking, time_limit_minutes, questions_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (subject_id, title, topic_id, total_marks, negative_marking,
             time_limit_minutes, questions_json),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def list_quiz_attempts(quiz_id: int = None, subject_id: int = None,
                       limit: int = 50) -> list[dict]:
    conn = get_connection()
    try:
        query = "SELECT * FROM quiz_attempts"
        clauses, params = [], []
        if quiz_id:
            clauses.append("quiz_id = ?")
            params.append(quiz_id)
        if subject_id:
            clauses.append("subject_id = ?")
            params.append(subject_id)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY completed_at DESC LIMIT ?"
        params.append(limit)
        return _rows_to_dicts(conn.execute(query, params).fetchall())
    finally:
        conn.close()


def create_quiz_attempt(quiz_id: int, subject_id: int, score: float,
                        max_score: float, percentage: float,
                        answers_json: str = None, topic_id: int = None) -> int:
    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO quiz_attempts (quiz_id, subject_id, topic_id, score, "
            "max_score, percentage, answers_json, started_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (quiz_id, subject_id, topic_id, score, max_score, percentage,
             answers_json, datetime.now().isoformat()),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


# ── Marks ──────────────────────────────────────────────

def list_marks(subject_id: int = None) -> list[dict]:
    conn = get_connection()
    try:
        if subject_id:
            rows = conn.execute(
                "SELECT * FROM marks WHERE subject_id = ? ORDER BY id",
                (subject_id,),
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM marks ORDER BY id").fetchall()
        return _rows_to_dicts(rows)
    finally:
        conn.close()


def create_mark(subject_id: int, assessment_name: str, max_marks: float,
                marks_obtained: float, weightage: float = 100.0,
                assessment_type: str = "exam") -> int:
    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO marks (subject_id, assessment_name, max_marks, "
            "marks_obtained, weightage, assessment_type) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (subject_id, assessment_name, max_marks, marks_obtained,
             weightage, assessment_type),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def delete_mark(mark_id: int) -> None:
    conn = get_connection()
    try:
        conn.execute("DELETE FROM marks WHERE id = ?", (mark_id,))
        conn.commit()
    finally:
        conn.close()


# ── Attendance ─────────────────────────────────────────

def list_attendance(subject_id: int = None) -> list[dict]:
    conn = get_connection()
    try:
        if subject_id:
            rows = conn.execute(
                "SELECT * FROM attendance WHERE subject_id = ? ORDER BY date",
                (subject_id,),
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM attendance ORDER BY date").fetchall()
        return _rows_to_dicts(rows)
    finally:
        conn.close()


def create_attendance(subject_id: int, date: str, attended: bool,
                      note: str = "") -> int:
    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO attendance (subject_id, date, attended, note) "
            "VALUES (?, ?, ?, ?)",
            (subject_id, date, 1 if attended else 0, note),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def delete_attendance(attendance_id: int) -> None:
    conn = get_connection()
    try:
        conn.execute("DELETE FROM attendance WHERE id = ?", (attendance_id,))
        conn.commit()
    finally:
        conn.close()


# ── Tasks ──────────────────────────────────────────────

def list_tasks(status: str = None, subject_id: int = None) -> list[dict]:
    conn = get_connection()
    try:
        query = "SELECT * FROM tasks"
        clauses, params = [], []
        if status:
            clauses.append("status = ?")
            params.append(status)
        if subject_id:
            clauses.append("subject_id = ?")
            params.append(subject_id)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY due_date IS NULL, due_date, id"
        return _rows_to_dicts(conn.execute(query, params).fetchall())
    finally:
        conn.close()


def get_task(task_id: int) -> dict | None:
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM tasks WHERE id = ?",
                           (task_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def create_task(title: str, task_type: str = "study", description: str = "",
                subject_id: int = None, due_date: str = None,
                priority: str = "medium") -> int:
    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO tasks (title, description, task_type, subject_id, "
            "due_date, priority) VALUES (?, ?, ?, ?, ?, ?)",
            (title, description, task_type, subject_id, due_date, priority),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def update_task(task_id: int, data: dict) -> None:
    conn = get_connection()
    try:
        allowed = {"title", "description", "task_type", "subject_id",
                   "due_date", "priority", "status"}
        keys = [k for k in data if k in allowed]
        if not keys:
            return
        set_clause = ", ".join(f"{k} = ?" for k in keys)
        conn.execute(
            f"UPDATE tasks SET {set_clause} WHERE id = ?",
            [data[k] for k in keys] + [task_id],
        )
        conn.commit()
    finally:
        conn.close()


def delete_task(task_id: int) -> None:
    conn = get_connection()
    try:
        conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        conn.commit()
    finally:
        conn.close()


# ── Study sessions ─────────────────────────────────────

def list_study_sessions(status: str = None,
                        planned_date: str = None) -> list[dict]:
    conn = get_connection()
    try:
        query = "SELECT * FROM study_sessions"
        clauses, params = [], []
        if status:
            clauses.append("status = ?")
            params.append(status)
        if planned_date:
            clauses.append("planned_date = ?")
            params.append(planned_date)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY planned_date, id"
        return _rows_to_dicts(conn.execute(query, params).fetchall())
    finally:
        conn.close()


def create_study_session(subject_id: int = None, topic_id: int = None,
                         planned_date: str = None,
                         duration_minutes: int = 60) -> int:
    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO study_sessions (subject_id, topic_id, planned_date, "
            "duration_minutes) VALUES (?, ?, ?, ?)",
            (subject_id, topic_id, planned_date, duration_minutes),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def update_study_session(session_id: int, data: dict) -> None:
    conn = get_connection()
    try:
        allowed = {"status", "actual_duration_minutes", "notes"}
        keys = [k for k in data if k in allowed]
        if not keys:
            return
        set_clause = ", ".join(f"{k} = ?" for k in keys)
        conn.execute(
            f"UPDATE study_sessions SET {set_clause} WHERE id = ?",
            [data[k] for k in keys] + [session_id],
        )
        conn.commit()
    finally:
        conn.close()


# ── Reminders ──────────────────────────────────────────

def list_reminders(sent: bool = None) -> list[dict]:
    conn = get_connection()
    try:
        if sent is None:
            rows = conn.execute(
                "SELECT * FROM reminders ORDER BY remind_at"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM reminders WHERE sent = ? ORDER BY remind_at",
                (1 if sent else 0,),
            ).fetchall()
        return _rows_to_dicts(rows)
    finally:
        conn.close()


def create_reminder(title: str, message: str, remind_at: str,
                    task_id: int = None) -> int:
    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO reminders (task_id, title, message, remind_at) "
            "VALUES (?, ?, ?, ?)",
            (task_id, title, message, remind_at),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def mark_reminder_sent(reminder_id: int) -> None:
    conn = get_connection()
    try:
        conn.execute(
            "UPDATE reminders SET sent = 1 WHERE id = ?", (reminder_id,)
        )
        conn.commit()
    finally:
        conn.close()


# ── Video recommendations ──────────────────────────────

def list_video_recommendations(subject_id: int = None,
                               status: str = None) -> list[dict]:
    conn = get_connection()
    try:
        query = "SELECT * FROM video_recommendations"
        clauses, params = [], []
        if subject_id:
            clauses.append("subject_id = ?")
            params.append(subject_id)
        if status:
            clauses.append("status = ?")
            params.append(status)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY created_at DESC"
        return _rows_to_dicts(conn.execute(query, params).fetchall())
    finally:
        conn.close()


def create_video_recommendation(subject_id: int, topic_id: int, title: str,
                                url: str, channel: str = "",
                                duration: str = "", reason: str = "") -> int:
    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO video_recommendations (subject_id, topic_id, title, "
            "channel, url, duration, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (subject_id, topic_id, title, channel, url, duration, reason),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def update_video_recommendation(video_id: int, status: str) -> None:
    conn = get_connection()
    try:
        conn.execute(
            "UPDATE video_recommendations SET status = ? WHERE id = ?",
            (status, video_id),
        )
        conn.commit()
    finally:
        conn.close()
