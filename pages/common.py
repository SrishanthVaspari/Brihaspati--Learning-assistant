"""Shared helpers for Streamlit pages."""
from __future__ import annotations

import json
from datetime import datetime, date, timedelta
import streamlit as st


def get_db_session():
    """Get a database session from session state."""
    from database.db import get_session
    engine = st.session_state.engine
    return get_session(engine)


def get_ai():
    return st.session_state.ai


def get_retrieval():
    return st.session_state.retrieval


def format_date(d) -> str:
    if d is None:
        return "—"
    if isinstance(d, str):
        return d
    return d.strftime("%Y-%m-%d")


def format_datetime(d) -> str:
    if d is None:
        return "—"
    if isinstance(d, str):
        return d
    return d.strftime("%Y-%m-%d %H:%M")


def days_until(d) -> int | None:
    if d is None:
        return None
    if isinstance(d, str):
        try:
            d = datetime.strptime(d, "%Y-%m-%d").date()
        except ValueError:
            return None
    if isinstance(d, datetime):
        d = d.date()
    if isinstance(d, date):
        return (d - date.today()).days
    return None


def pct(numerator: float, denominator: float) -> float:
    if not denominator:
        return 0.0
    return round(100.0 * numerator / denominator, 2)


def safe_json_loads(s: str, default=None):
    try:
        return json.loads(s) if s else default
    except (json.JSONDecodeError, TypeError):
        return default


def priority_label(p: int) -> str:
    return {1: "🔴 Urgent", 2: "🟠 High", 3: "🟡 Medium", 4: "🟢 Low", 5: "⚪ None"}.get(p, "⚪")


def mastery_color(score: float) -> str:
    if score >= 80:
        return "🟢"
    if score >= 50:
        return "🟡"
    return "🔴"


def empty_state(message: str, hint: str = ""):
    st.info(f"📭 {message}" + (f"\n\n💡 {hint}" if hint else ""))


def confirm_action(label: str, key: str) -> bool:
    """Two-click confirmation for destructive actions."""
    if st.session_state.get(f"confirm_{key}", False):
        st.warning(f"Are you sure? This will {label}.")
        col1, col2 = st.columns(2)
        with col1:
            if st.button("Yes, confirm", key=f"yes_{key}"):
                st.session_state[f"confirm_{key}"] = False
                return True
        with col2:
            if st.button("Cancel", key=f"no_{key}"):
                st.session_state[f"confirm_{key}"] = False
                st.rerun()
        return False
    st.button("Delete", key=f"ask_{key}", on_click=lambda: st.session_state.update({f"confirm_{key}": True}))
    return False
