import streamlit as st
from database.db import get_engine, get_session
from sqlalchemy import func
from database.models import Subject, Task, Document

st.set_page_config(page_title="Dashboard", layout="wide")

st.title("📊 Dashboard")

# Initialize session
engine = get_engine("data/brihaspati.db")
session = get_session(engine)

# Metrics
col1, col2, col3 = st.columns(3)
with col1:
    subject_count = session.query(func.count(Subject.id)).scalar()
    st.metric("Total Subjects", subject_count)
with col2:
    task_count = session.query(func.count(Task.id)).filter(Task.is_completed == False).scalar()
    st.metric("Pending Tasks", task_count)
with col3:
    doc_count = session.query(func.count(Document.id)).scalar()
    st.metric("Uploaded Docs", doc_count)

st.subheader("Upcoming Tasks")
pending_tasks = session.query(Task).filter(Task.is_completed == False).order_by(Task.due_date).limit(5).all()
if pending_tasks:
    for t in pending_tasks:
        st.write(f"- **{t.title}** (Due: {t.due_date} | Priority: {t.priority})")
else:
    st.info("No pending tasks.")

session.close()
