"""Brihaspati — Your Personal AI Academic Companion."""
import os
import sys
from pathlib import Path
from dotenv import load_dotenv
import streamlit as st

# Setup paths and env
PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))
load_dotenv(PROJECT_ROOT / ".env")

# Ensure data dir exists
Path(PROJECT_ROOT / "data").mkdir(exist_ok=True)

# Database
from database.db import init_db, get_engine, get_session
init_db()  # SCHEMA created

# Session state
if "engine" not in st.session_state:
    st.session_state.engine = get_engine()

# Pages config
st.set_page_config(page_title="Brihaspati", layout="wide", page_icon="🎓")

st.sidebar.title("🎓 Brihaspati")

# Simple Navigation
pg = st.navigation([
    st.Page("pages/dashboard.py", title="Dashboard", icon="📊"),
    st.Page("pages/subjects.py", title="Subjects", icon="📚"),
    st.Page("pages/study_workspace.py", title="Workspace", icon="📖"),
])
pg.run()
