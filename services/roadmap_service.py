from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any

from database.models import Roadmap, StudySession
from services.topic_ranker import TopicRanker


class RoadmapService:
    """Generate personalized study roadmaps."""

    def __init__(self, ai_service, db_session, topic_ranker: TopicRanker):
        self.ai = ai_service
        self.db = db_session
        self.ranker = topic_ranker

    def generate_roadmap(
        self,
        subject_id: int,
        exam_date: date,
        available_hours_per_day: float = 3.0,
        include_revision: bool = True,
        include_quizzes: bool = True,
    ) -> dict:
        """Create a day-by-day study plan."""
        # Clean up existing roadmap
        old = self.get_active_roadmap(subject_id)
        if old:
            old_rm = self.db.get(Roadmap, old["id"])
            if old_rm:
                old_rm.status = "abandoned"
                self.db.commit()

        ranked = self.ranker.rank_topics(subject_id)
        # Sort by priority desc
        topics = sorted(ranked, key=lambda t: t["priority_score"], reverse=True)

        days_available = max(1, (exam_date - date.today()).days)
        total_time_needed = sum(t["estimated_hours"] for t in topics)
        # Add buffer
        total_time_needed *= 1.2
        # Daily capacity
        daily_capacity_hrs = available_hours_per_day

        # Primitive scheduling: just allocate day by day
        roadmap_days = []
        current_date = date.today()

        # Simple allocation
        topic_idx = 0
        hours_remaining = 0.0

        for d in range(days_available):
            d_date = current_date + timedelta(days=d)
            if d_date >= exam_date:
                break

            tasks = []
            hrs_today = 0.0

            while hrs_today < daily_capacity_hrs and topic_idx < len(topics):
                t = topics[topic_idx]
                needed = t["estimated_hours"] - hours_remaining
                if needed <= (daily_capacity_hrs - hrs_today):
                    # fits in today
                    tasks.append({"topic": t["name"], "type": "study",
                                  "duration_minutes": int(needed * 60)})
                    hrs_today += needed
                    hours_remaining = 0.0
                    topic_idx += 1
                else:
                    # part of topic fits
                    can_do = daily_capacity_hrs - hrs_today
                    tasks.append({"topic": t["name"], "type": "study",
                                  "duration_minutes": int(can_do * 60)})
                    hrs_today += can_do
                    hours_remaining = needed - can_do
                    break

            if tasks:
                roadmap_days.append({"date": d_date.isoformat(), "tasks": tasks})

        # Save Roadmap
        rm = Roadmap(
            subject_id=subject_id,
            title="Study Plan",
            exam_date=exam_date,
            available_hours_per_day=available_hours_per_day,
            plan_json=json.dumps(roadmap_days),
        )
        self.db.add(rm)
        self.db.commit()

        # Save StudySessions
        for day in roadmap_days:
            for task in day["tasks"]:
                self.db.add(StudySession(
                    subject_id=subject_id,
                    topic_name=task["topic"],
                    planned_date=date.fromisoformat(day["date"]),
                    planned_duration_minutes=task["duration_minutes"],
                    roadmap_id=rm.id,
                ))
        self.db.commit()

        return {"id": rm.id, "title": rm.title, "days": roadmap_days}

    def mark_session_complete(self, session_id: int, actual_duration: int = None):
        """Mark a study session as done."""
        session = self.db.get(StudySession, session_id)
        if session:
            session.is_completed = True
            if actual_duration:
                session.actual_duration_minutes = actual_duration
            self.db.commit()

    def get_active_roadmap(self, subject_id: int) -> dict | None:
        rm = (self.db.query(Roadmap)
              .filter(Roadmap.subject_id == subject_id, Roadmap.status == "active")
              .first())
        if not rm:
            return None
        return {"id": rm.id, "title": rm.title, "days": json.loads(rm.plan_json or "[]")}
