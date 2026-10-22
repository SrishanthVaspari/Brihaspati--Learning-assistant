import streamlit as st
import os
import pandas as pd
from database.db import get_session
from database.models import Marks, Subject
from services.document_processor import extract_text
from services.ai_service import call_ai
import json

st.set_page_config(page_title="Performance Analytics", layout="wide")

st.title("📈 Performance Analytics")

session = get_session(st.session_state.engine)

subjects = session.query(Subject).all()
if not subjects:
    st.info("No subjects found. Please add a subject first.")
    st.stop()
    
# Marksheet Upload
with st.expander("Upload Marksheet or Score Card", expanded=False):
    st.write("Upload a PDF/Image of your marksheet. AI will extract your scores.")
    uploaded_file = st.file_uploader("Upload Marksheet (PDF)")
    
    if uploaded_file:
        file_path = os.path.join("data/documents", uploaded_file.name)
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        with open(file_path, "wb") as f:
            f.write(uploaded_file.getbuffer())
        text, _ = extract_text(file_path)
        
        with st.spinner("Extracting marks via AI..."):
            prompt = (
                "Extract all academic subjects and marks from the following document. "
                "Return a JSON array of objects with keys: 'subject_name', 'assessment_name', "
                "'obtained_marks', 'max_marks'. Do not invent details.\n\n"
                f"Document text:\n{text[:15000]}"
            )
            response = call_ai(prompt)
            
            # Clean JSON
            response = response.strip()
            if response.startswith("```json"): response = response[7:]
            elif response.startswith("```"): response = response[3:]
            if response.endswith("```"): response = response[:-3]
            response = response.strip()
            
            try:
                import re
                match = re.search(r'\[\s*\{.*?\}\s*\]', response, re.DOTALL)
                if match: response = match.group(0)
                extracted_marks = json.loads(response)
                
                st.success("Extracted successfully!")
                
                # Assign to Subject
                for mark in extracted_marks:
                    matched_subject = next((s for s in subjects if s.name.lower() in mark.get('subject_name', '').lower()), subjects[0])
                    col1, col2, col3, col4 = st.columns(4)
                    
                    st.markdown(f"**Found**: {mark.get('subject_name')} | Score: {mark.get('obtained_marks')}/{mark.get('max_marks')}")
                    
                    if st.button(f"Save {mark.get('assessment_name', 'Score')}", key=f"save_{mark.get('subject_name')}_{mark.get('obtained_marks')}"):
                        new_mark = Marks(
                            subject_id=matched_subject.id,
                            assessment_name=mark.get("assessment_name", "Exam"),
                            assessment_type="marksheet",
                            obtained_marks=float(mark.get("obtained_marks", 0)),
                            max_marks=float(mark.get("max_marks", 100))
                        )
                        session.add(new_mark)
                        session.commit()
                        st.toast("Saved!")
                        
            except Exception as e:
                st.error("Could not parse AI response. Please enter manually below.")

st.divider()

# Interactive Entry & Chart
st.subheader("Academic Progress")
marks_data = session.query(Marks).all()

if marks_data:
    subject_map = {s.id: s.name for s in subjects}
    data = []
    for m in marks_data:
        data.append({
            "Subject": subject_map.get(m.subject_id, "Unknown"),
            "Assessment": m.assessment_name,
            "Score": m.obtained_marks,
            "Max": m.max_marks,
            "Percentage": (m.obtained_marks / m.max_marks * 100) if m.max_marks > 0 else 0
        })
        
    df = pd.DataFrame(data)
    st.dataframe(df, use_container_width=True)
    st.bar_chart(df, x="Subject", y="Percentage", color="Assessment")
else:
    st.info("No marks data saved yet.")
    
session.close()
