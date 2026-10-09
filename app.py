import streamlit as st
import os
from dotenv import load_dotenv

# Load env variables early
load_dotenv()

st.set_page_config(page_title="Brihaspati", layout="wide", page_icon="🎓")

st.title("🎓 Brihaspati — Your Personal AI Academic Companion")
st.sidebar.success("Select a functionality from above.")

# Placeholder for dashboard
st.subheader("Dashboard Overview")
st.info("Brihaspati is setting up your workspace...")

# Basic check
if not os.path.exists("data/brihaspati.db"):
    st.error("Database not initialized. Please run the setup script.")
else:
    st.success("App ready! (Database connected)")

# Navigation (will use pages/ folder)
st.sidebar.markdown("---")
st.sidebar.write("### Quick Actions")
if st.sidebar.button("Upload Academic Material"):
    st.switch_page("pages/study_workspace.py")
