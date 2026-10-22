import streamlit as st
from database.db import get_engine, get_session
from database.models import Subject

st.set_page_config(page_title="Subjects", layout="wide")

st.title("🎓 Subjects")

session = get_session(st.session_state.engine)

# Add subject form
with st.form("add_subject"):
    name = st.text_input("Subject Name")
    code = st.text_input("Subject Code")
    credits = st.number_input("Credits", min_value=0.0, max_value=10.0, value=3.0)
    semester = st.number_input("Semester", min_value=1, max_value=10, value=1)
    exam_date = st.date_input("Exam Date")
    submitted = st.form_submit_button("Add Subject")

    if submitted and name:
        subject = Subject(name=name, code=code, credits=credits, semester=semester, exam_date=exam_date)
        session.add(subject)
        session.commit()
        st.success(f"Added {name}")

st.subheader("Current Subjects")
subjects = session.query(Subject).all()
if subjects:
    for s in subjects:
        col1, col2 = st.columns([3, 1])
        with col1:
            st.write(f"**{s.name}** ({s.code}) - Semester {s.semester} - {s.credits} credits")
        with col2:
            if st.button(f"Delete {s.name}", key=f"del_{s.id}"):
                session.delete(s)
                session.commit()
                st.rerun()
else:
    st.info("No subjects added yet. Add one above.")

session.close()
