import streamlit as st
from database.db import get_engine, get_session
from sqlalchemy import func
from database.models import Subject, Task, Document, PreparationTracker, TrackerTask
from services.notification_service import NotificationService
from services.streak_service import get_study_streak
from datetime import datetime, date

st.set_page_config(page_title="Dashboard", layout="wide")

st.title("📊 Academic Dashboard")

# Initialize session
session = get_session(st.session_state.engine)
notifier = NotificationService()

# --- Metrics Section ---
st.subheader("💡 Quick View")
col1, col2, col3, col4 = st.columns(4)
with col1:
    subject_count = session.query(func.count(Subject.id)).scalar()
    st.metric("Subjects", subject_count)
with col2:
    # Calculate pending tasks using date comparison (assuming string format YYYY-MM-DD)
    today = date.today().isoformat()
    task_count = session.query(func.count(Task.id)).filter(Task.is_completed == False).scalar()
    st.metric("Tasks (Pending)", task_count)
with col3:
    doc_count = session.query(func.count(Document.id)).scalar()
    st.metric("Documents", doc_count)
with col4:
    # Dummy streak metric
    streak = get_study_streak(session)
    st.metric("Study Streak", f"🔥 {streak} days")

st.divider()

# --- Preparation Trackers ---
st.subheader("🎯 Preparation Trackers")
trackers = session.query(PreparationTracker).all()
if trackers:
    for t in trackers:
        tasks = session.query(TrackerTask).filter(TrackerTask.tracker_id == t.id).all()
        completed = sum(1 for task in tasks if task.is_completed)
        progress = completed / len(tasks) if tasks else 0
        st.write(f"**{t.name}**: {t.goal} | Progress: {int(progress*100)}%")
        st.progress(progress)
else:
    st.info("No trackers created. You can create custom trackers to monitor your progress.")

# Simple Deadline Summary (replacing full calendar for now)
st.divider()
st.subheader("🗓️ Calendar & Deadlines")
pending_tasks = session.query(Task).filter(Task.is_completed == False).order_by(Task.due_date).all()
if pending_tasks:
    # Group by date
    from collections import defaultdict
    deadlines = defaultdict(list)
    for t in pending_tasks:
        if t.due_date:
            deadlines[t.due_date].append(t)

    for date_str, tasks in sorted(deadlines.items()):
        st.markdown(f"**{date_str}**")
        for t in tasks:
            st.write(f" - {t.title} ({t.priority})")
else:
    st.info("No deadlines upcoming.")

session.close()
