import streamlit as st
import os
from database.db import get_engine, get_session
from database.models import Subject, Document
from services.document_processor import extract_text

st.set_page_config(page_title="Study Workspace", layout="wide")

st.title("📚 Study Workspace")

# Initialize session
engine = get_engine("data/brihaspati.db")
session = get_session(engine)

# Subject selection
subjects = session.query(Subject).all()
subject_names = {s.name: s.id for s in subjects}
selected_subject_name = st.selectbox("Select Subject", list(subject_names.keys()))

if selected_subject_name:
    subject_id = subject_names[selected_subject_name]

    st.subheader(f"Sources for {selected_subject_name}")

    # Upload
    uploaded_file = st.file_uploader("Upload PPT, PDF, DOCX")
    if uploaded_file:
        file_path = os.path.join("data/documents", uploaded_file.name)
        with open(file_path, "wb") as f:
            f.write(uploaded_file.getbuffer())

        # Process
        text, meta = extract_text(file_path)

        # Save to DB
        doc = Document(
            subject_id=subject_id,
            filename=uploaded_file.name,
            original_name=uploaded_file.name,
            file_type=os.path.splitext(uploaded_file.name)[1].lower()[1:],
            file_path=file_path,
            text_content=text,
            processed=True
        )
        session.add(doc)
        session.commit()
        st.success(f"File {uploaded_file.name} saved and processed.")

    # List sources
    docs = session.query(Document).filter(Document.subject_id == subject_id).all()
    for d in docs:
        if st.expander(f"{d.original_name} (Uploaded: {d.uploaded_at.date()})"):
            st.write(d.text_content[:500] + "...")
            st.code(d.file_path)

session.close()
