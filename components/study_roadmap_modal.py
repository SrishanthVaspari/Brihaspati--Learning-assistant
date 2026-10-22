"""Study Roadmap modal component for the Study Workspace.

Opens as a large, responsive Streamlit dialog containing:
  - Setup state: document selection + daily-hours slider
  - Generation state: honest staged progress
  - Timeline state: animated vertical study timeline with per-session completion
"""

from __future__ import annotations

import json
import logging
from datetime import date

import streamlit as st

from database.db import get_session
from database.models import Document, Roadmap, StudySession, Subject
from services.ai_service import AIService
from services.roadmap_service import RoadmapService
from services.topic_ranker import TopicRanker

logger = logging.getLogger(__name__)

# ── CSS design tokens ─────────────────────────────────────────────

CSS = r"""
<style>
.sm-card { border:1px solid rgba(110,118,129,0.25); border-radius:10px;
           padding:14px 16px; margin:10px 0;
           box-shadow:0 1px 3px rgba(0,0,0,0.06);
           transition:transform 0.15s ease,box-shadow 0.15s ease; }
.sm-card:hover { transform:translateY(-1px); box-shadow:0 4px 12px rgba(0,0,0,0.08); }
.sm-day-label { display:inline-flex; align-items:center; gap:8px; font-size:0.95rem;
                font-weight:600; color:inherit; margin-bottom:6px; width:100%; }
.sm-dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
.sm-dot.done { background:linear-gradient(135deg,#10b981,#059669); }
.sm-dot.current { background:linear-gradient(135deg,#3b82f6,#2563eb); }
.sm-dot.upcoming { background:#6b7280; }
.sm-task { display:flex; align-items:flex-start; gap:10px; padding:8px 0;
           border-bottom:1px dashed rgba(110,118,129,0.25); }
.sm-task:last-child { border-bottom:none; }
.sm-task-title { font-weight:600; color:inherit; flex:1; font-size:0.92rem; }
.sm-task-meta { font-size:0.78rem; opacity:0.75; white-space:nowrap; }
.sm-badge { display:inline-block; padding:1.5px 7px; border-radius:999px;
            font-size:0.72rem; font-weight:600; text-transform:uppercase; }
.sm-badge.study { background:rgba(59,130,246,0.14); color:#2563eb; }
.sm-badge.read { background:rgba(34,197,94,0.14); color:#16a34a; }
.sm-badge.lecture { background:rgba(99,102,241,0.14); color:#6366f1; }
.sm-badge.practice { background:rgba(245,158,11,0.14); color:#d97706; }
.sm-badge.revision { background:rgba(245,158,11,0.14); color:#d97706; }
.sm-badge.self-assessment { background:rgba(168,85,247,0.14); color:#9333ea; }
.sm-progress-track { height:8px; background:rgba(110,118,129,0.2);
                     border-radius:999px; overflow:hidden; margin-top:8px; }
.sm-progress-fill { height:100%; background:linear-gradient(90deg,#2563eb,#10b981);
                    border-radius:999px; transition:width 0.4s ease; }
@media (prefers-reduced-motion: reduce) {
    .sm-card, .sm-progress-fill { transition:none; }
}
</style>
"""


def _inject_css():
    st.markdown(CSS, unsafe_allow_html=True)


# ── Entry point ──────────────────────────────────────────────────

def open_study_roadmap(engine, subject_id: int, doc_id: int | None = None,
                       default_hours: float = 3.0):
    """Render the Study Roadmap modal content.

    Manages three states through ``st.session_state``:
      - **setup**: document picker + hours slider + Generate button
      - **generating**: progress indicator + AI call
      - **timeline**: the animated study plan with Mark-done buttons
    """
    _inject_css()

    state = st.session_state
    state.setdefault("rr_mode", "setup")
    state.setdefault("rr_doc_id", doc_id)
    state.setdefault("rr_hours", default_hours)
    state.setdefault("rr_roadmap_id", None)

    if state.rr_mode == "setup":
        _render_setup(engine, subject_id, doc_id, state)
    elif state.rr_mode == "generating":
        _render_generating(engine, subject_id, state)
    elif state.rr_mode == "timeline":
        _render_timeline(engine, state.rr_roadmap_id)


# ── Setup view ───────────────────────────────────────────────────

def _render_setup(engine, subject_id, doc_id, state):
    st.subheader("Turn a document into an intelligent study timeline")
    st.caption("Choose the document you want to study and set your daily availability. "
               "The AI will build a complete, personalized plan.")

    db = get_session(engine)
    try:
        docs = db.query(Document).filter(
            Document.subject_id == subject_id).order_by(Document.created_at).all()
    finally:
        db.close()

    if not docs:
        st.info("Upload a document first in the Workspace Sources panel.")
        return

    doc_options = {d.original_filename: d.id for d in docs}
    default_idx = 0
    if doc_id:
        names = list(doc_options.keys())
        for i, name in enumerate(names):
            if doc_options[name] == doc_id:
                default_idx = i
                break

    selected_name = st.selectbox("Select study document",
                                 list(doc_options.keys()),
                                 index=default_idx,
                                 key="rr_doc_sel")
    state.rr_doc_id = doc_options[selected_name]

    hours = st.slider("How many hours per day can you study?",
                      min_value=1.0, max_value=15.0,
                      value=float(state.rr_hours),
                      step=0.5, key="rr_hours_slider")
    state.rr_hours = hours

    c1, c2 = st.columns([3, 1])
    with c1:
        st.markdown("**{:.1f} hours/day** — the plan adapts automatically.".format(hours))
    with c2:
        st.metric("Daily capacity", "{:.1f}h".format(hours))

    if st.button("Generate My Study Roadmap",
                 use_container_width=True, key="rr_generate",
                 type="primary"):
        state.rr_mode = "generating"
        st.rerun()


# ── Generating view ──────────────────────────────────────────────

def _render_generating(engine, subject_id, state):
    st.subheader("Building your study plan...")
    st.caption("Analyzing document and building schedule — this may take a moment.")

    steps = ["Analyzing document", "Structuring topics", "Estimating effort",
             "Building schedule", "Preparing timeline"]
    cols = st.columns(len(steps))
    for i, (col, step) in enumerate(zip(cols, steps), start=1):
        with col:
            st.markdown(
                "<div style='text-align:center;'>"
                "<div style='width:28px;height:28px;border-radius:50%;margin:0 auto 4px;"
                "background:{bg};color:#fff;display:flex;align-items:center;"
                "justify-content:center;font-weight:700;font-size:0.85rem;'>"
                "{num}</div>"
                "<div style='font-size:0.75rem;'>{step}</div></div>".format(
                    bg="#2563eb" if i == 1 else "rgba(110,118,129,0.3)",
                    num=i, step=step),
                unsafe_allow_html=True,
            )

    db = get_session(engine)
    try:
        with st.spinner("Generating your roadmap..."):
            ai = AIService()
            ranker = TopicRanker(ai, db)
            svc = RoadmapService(ai, db, ranker)
            roadmap = svc.generate_from_document(
                document_id=state.rr_doc_id,
                available_hours_per_day=float(state.rr_hours),
            )
            state.rr_roadmap_id = roadmap["id"]
            state.rr_mode = "timeline"
            st.success("Roadmap generated!")
            st.rerun()
    except ValueError as e:
        st.error("Could not generate a roadmap: {}".format(e))
        state.rr_mode = "setup"
    except Exception as e:
        st.error("An unexpected error occurred: {}".format(e))
        logger.exception("Roadmap generation failed")
        state.rr_mode = "setup"
    finally:
        db.close()


# ── Timeline view ────────────────────────────────────────────────

def _render_timeline(engine, roadmap_id):
    db = get_session(engine)
    rm = db.query(Roadmap).filter(Roadmap.id == roadmap_id).first()
    if not rm:
        st.error("Roadmap not found.")
        return

    schedule = json.loads(rm.plan_json or "{}")
    days = schedule.get("days", schedule) if isinstance(schedule, dict) else schedule
    if isinstance(days, dict):
        days = days.get("days", [])

    sessions = (db.query(StudySession)
                .filter(StudySession.roadmap_id == rm.id)
                .order_by(StudySession.planned_date).all())
    sess_map = {(s.planned_date, s.topic_name): s for s in sessions}
    done_count = sum(1 for s in sessions if s.is_completed)
    total = max(1, len(sessions))
    pct = 100.0 * done_count / total

    # Header summary
    st.subheader(rm.title or "Your Study Plan")
    c1, c2, c3 = st.columns(3)
    with c1:
        st.metric("Study days", len(days))
    with c2:
        st.metric("Daily hours", "{:.1f}h".format(rm.available_hours_per_day or 0))
    with c3:
        st.metric("Progress", "{}/{} done".format(done_count, total))

    st.markdown(
        "<div class='sm-progress-track'><div class='sm-progress-fill' "
        "style='width:{:.1f}%'></div></div>".format(pct),
        unsafe_allow_html=True,
    )

    if schedule.get("completion_date") if isinstance(schedule, dict) else None:
        st.caption("Estimated completion: {}".format(schedule["completion_date"]))

    st.divider()

    # Day-by-day timeline
    today = date.today().isoformat()
    for day in days:
        day_date = day.get("date", "")
        status = "done" if day_date < today else ("current" if day_date == today else "upcoming")

        st.markdown(
            "<div class='sm-card'>"
            "<div class='sm-day-label'>"
            "<span class='sm-dot {status}'></span> "
            "<b>{label}</b>"
            "<span style='margin-left:auto;font-size:0.85rem;opacity:0.8;'>"
            "{hours:.1f}h</span>"
            "</div>".format(
                status=status,
                label=day.get("label", day_date),
                hours=day.get("hours", 0)),
            unsafe_allow_html=True,
        )

        for task in day.get("tasks", []):
            topic = task.get("topic", task.get("name", ""))
            key = (day_date, topic)
            sess = sess_map.get(key)
            is_done = bool(sess and sess.is_completed)

            badge = task.get("activity", "study")
            badge_cls = "sm-badge {}".format(badge.replace("-", ""))

            col_info, col_btn = st.columns([5, 1])
            with col_info:
                st.markdown(
                    "<div class='sm-task'>"
                    "<div>"
                    "<span class='sm-task-title' style='text-decoration:{deco};'>"
                    "{topic}</span><br>"
                    "<span style='font-size:0.78rem;opacity:0.75;'>{obj}</span><br>"
                    "<span class='{badge_cls}'>{badge}</span>"
                    "<span class='sm-task-meta' style='margin-left:8px;'>"
                    "{dur:.0f} min</span>"
                    "</div></div>".format(
                        deco="line-through" if is_done else "none",
                        topic=topic,
                        obj=task.get("objective", ""),
                        badge_cls=badge_cls, badge=badge,
                        dur=task.get("duration_minutes", 0)),
                    unsafe_allow_html=True,
                )
            with col_btn:
                if sess:
                    label = chr(10003) if is_done else "Mark done"
                    btn_type = "primary" if is_done else "secondary"
                    if st.button(label, key="sm_done_{}".format(sess.id),
                                 type=btn_type):
                        sess.is_completed = not is_done
                        db.commit()
                        st.rerun()

        st.markdown("</div>", unsafe_allow_html=True)

    # Footer actions
    st.divider()
    c1, c2, c3 = st.columns(3)
    with c1:
        if st.button("Regenerate plan", key="rr_regenerate"):
            st.session_state.rr_mode = "generating"
            st.rerun()
    with c2:
        if st.button("Back to setup", key="rr_back"):
            st.session_state.rr_mode = "setup"
            st.rerun()
    with c3:
        from services.ics_generator import generate_ics_from_roadmap
        ics_data = generate_ics_from_roadmap(rm.plan_json, rm.title or "Study Plan")
        st.download_button(
            label="📅 Export to Calendar (.ics)",
            data=ics_data,
            file_name=f"study_roadmap_{rm.id}.ics",
            mime="text/calendar",
        )

    db.close()
