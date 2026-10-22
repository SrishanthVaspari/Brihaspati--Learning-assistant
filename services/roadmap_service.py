from __future__ import annotations

import json
import logging
import math
import re
from datetime import date, datetime, timedelta

from database.models import Document, Roadmap, StudySession, Subject
from services.topic_ranker import TopicRanker

logger = logging.getLogger(__name__)

MAX_ANALYSIS_CHARS = 15000


class RoadmapService:
    """Generate, schedule, and persist personalized study roadmaps."""

    def __init__(self, ai_service, db_session, topic_ranker: TopicRanker):
        self.ai = ai_service
        self.db = db_session
        self.ranker = topic_ranker

    # ── Document-first generation (Workspace modal) ─────────────

    def generate_from_document(
        self,
        document_id: int,
        available_hours_per_day: float,
        exam_date: date | None = None,
        title: str | None = None,
    ) -> dict:
        """Analyze one document and produce a complete scheduled roadmap.

        1. Structure the document into topics via AI (with a
           structure-based heuristic fallback).
        2. Build a dependency-aware day-by-day schedule that
           respects the daily hours cap.
        3. Persist the Roadmap and its StudySessions.
        """
        doc = self.db.get(Document, document_id)
        if not doc or not doc.text:
            raise ValueError("Document not found or has no extractable text.")

        subject_id = doc.subject_id
        subject = self.db.get(Subject, subject_id)
        if not subject:
            raise ValueError("Subject not found for this document.")

        if not exam_date:
            exam_date = self._resolve_exam_date(subject)

        # 1. Structure analysis.
        plan = self._analyze_document_structure(doc, subject)
        plan.setdefault("title", title or doc.original_filename)

        # 2. Scheduling.
        schedule = self._build_schedule(
            plan["topics"],
            available_hours_per_day=available_hours_per_day,
            start_date=date.today(),
            end_date=exam_date,
        )
        schedule["title"] = plan["title"]

        # 3. Persist.
        old = self.get_active_roadmap(subject_id)
        if old:
            old_rm = self.db.get(Roadmap, old["id"])
            if old_rm:
                old_rm.status = "abandoned"
                self.db.commit()

        roadmap = Roadmap(
            subject_id=subject_id,
            title=plan["title"],
            status="active",
            exam_date=exam_date.isoformat(),
            available_hours_per_day=float(available_hours_per_day),
            plan_json=json.dumps(schedule, default=str),
        )
        self.db.add(roadmap)
        self.db.commit()

        for day in schedule["days"]:
            for task in day["tasks"]:
                self.db.add(StudySession(
                    subject_id=subject_id,
                    topic_name=task["topic"],
                    planned_date=day["date"],
                    planned_duration_minutes=task["duration_minutes"],
                    roadmap_id=roadmap.id,
                ))
        self.db.commit()

        return self.get_roadmap_by_id(roadmap.id)

    # ── Scheduling ────────────────────────────────────────────────

    def _build_schedule(
        self,
        topics: list[dict],
        available_hours_per_day: float,
        start_date: date,
        end_date: date,
    ) -> dict:
        """Greedy, dependency-aware scheduler.

        Caps each day at ``available_hours_per_day`` (1–15 h), orders
        topics by prerequisites, tracks per-topic remaining hours so a
        topic continues across consecutive days, and inserts light
        revision days after every four completed study topics.
        """
        daily_cap = max(1.0, min(15.0, float(available_hours_per_day)))
        total_needed = sum(t.get("estimated_hours", 1.0) for t in topics)
        available_slots = max(1, (end_date - start_date).days)
        ideal_days = max(1, math.ceil(total_needed * 1.2 / daily_cap))

        if ideal_days > available_slots:
            logger.warning(
                "Workload %.1f h needs ~%d days at %.1f h/day, but only "
                "%d days remain before the deadline — schedule compressed.",
                total_needed, ideal_days, daily_cap, available_slots,
            )
        horizon = min(ideal_days, available_slots)

        ordered = self._order_by_dependencies(topics)
        leftover = {t["name"]: float(t.get("estimated_hours", 1.0))
                    for t in ordered}
        completed: set[str] = set()
        schedule_days: list[dict] = []
        current_date = start_date
        study_count = 0

        while current_date <= end_date and len(schedule_days) < horizon:
            hours_today = 0.0
            tasks: list[dict] = []

            for t in ordered:
                name = t["name"]
                if name in completed:
                    continue
                if any(p not in completed for p in t.get("prerequisites", [])):
                    continue
                remaining = leftover.get(name, 0.0)
                if remaining <= 0.001:
                    completed.add(name)
                    continue
                headroom = daily_cap - hours_today
                if headroom <= 0:
                    break
                take = min(remaining, headroom)
                tasks.append({
                    "topic": name,
                    "activity": t.get("activity", "study"),
                    "objective": t.get("objective", ""),
                    "duration_minutes": max(15, int(take * 60)),
                    "source": t.get("source", ""),
                })
                hours_today += take
                remaining = round(remaining - take, 3)
                leftover[name] = remaining
                if remaining <= 0.001:
                    completed.add(name)
                    leftover[name] = 0.0
                    study_count += 1

            if tasks:
                schedule_days.append({
                    "date": current_date.isoformat(),
                    "label": current_date.strftime("%a, %b %d"),
                    "tasks": tasks,
                    "hours": round(hours_today, 1),
                })
            else:
                break  # everything scheduled or a prerequisite deadlock
            current_date += timedelta(days=1)

        schedule_days = self._insert_revisions(schedule_days, end_date)

        return {
            "total_days": len(schedule_days),
            "total_hours": round(sum(d["hours"] for d in schedule_days), 1),
            "completion_date": schedule_days[-1]["date"] if schedule_days
                               else start_date.isoformat(),
            "days": schedule_days,
        }

    @staticmethod
    def _insert_revisions(schedule_days: list[dict], end_date: date) -> list[dict]:
        """Insert a light revision day after every four study days."""
        out: list[dict] = []
        study_days = 0
        for day in schedule_days:
            out.append(day)
            if any(t.get("activity") != "revision" for t in day["tasks"]):
                study_days += 1
            if study_days >= 4:
                rev_date = date.fromisoformat(day["date"]) + timedelta(days=1)
                if rev_date <= end_date:
                    out.append({
                        "date": rev_date.isoformat(),
                        "label": rev_date.strftime("%a, %b %d"),
                        "tasks": [{
                            "topic": "Revision: consolidate recent topics",
                            "activity": "revision",
                            "objective": "Review and reinforce recent topics.",
                            "duration_minutes": 60,
                            "source": "",
                        }],
                        "hours": 1.0,
                    })
                study_days = 0
        return out

    # ── Document structure analysis ──────────────────────────────

    def _analyze_document_structure(self, document, subject) -> dict:
        """Ask the AI to structure the document into a learning plan."""
        text = (document.text or "")[:MAX_ANALYSIS_CHARS]
        sample = text[:3000]

        prompt = f"""You are an expert curriculum designer. Analyze the following academic document and design a study plan for a college student.

Document: {document.original_filename} ({document.file_type})
Subject: {subject.name if subject else 'General'}

{sample}
... [content truncated for brevity; full text available] ...

Return ONLY a valid JSON object with this exact structure:
{{
  "title": "short plan title",
  "topics": [
    {{
      "name": "topic/chapter name",
      "objective": "one-line learning objective",
      "estimated_hours": 2.5,
      "activity": "read" | "lecture" | "practice" | "revision" | "self-assessment",
      "prerequisites": ["other topic name", ...],
      "source": "chapter/section reference in the document"
    }},
    ...
  ],
  "notes": "brief note about the plan"
}}

Guidelines:
- Base the plan strictly on the actual document content. Do not invent topics.
- Break the material into 5-15 manageable topics with a logical learning order.
- estimated_hours: realistic hours to study that topic fully.
- prerequisites: only topics that genuinely must come first.
- activity: the dominant learning activity for that topic.
- If the document is too large to cover fully, focus on core chapters and note gaps in notes."""

        data = self.ai.generate_json(
            prompt, system="You are a curriculum designer. Output valid JSON only.")

        topics = data.get("topics") if isinstance(data, dict) else None
        if not isinstance(topics, list) or not topics:
            return self._extract_topics_heuristic(document)

        valid: list[dict] = []
        seen: set[str] = set()
        for t in topics:
            if not isinstance(t, dict) or not t.get("name"):
                continue
            name = str(t["name"])[:200].strip()
            if name.lower() in seen:
                continue
            seen.add(name.lower())
            valid.append({
                "name": name,
                "objective": str(t.get("objective", "") or f"Study {name}.")[:500],
                "estimated_hours": float(t.get("estimated_hours", 1.0) or 1.0),
                "activity": str(t.get("activity", "read"))[:40],
                "prerequisites": [str(p)[:200]
                                  for p in (t.get("prerequisites") or [])][:10],
                "source": str(t.get("source", document.original_filename))[:200],
            })
        return {
            "title": str(data.get("title", document.original_filename))[:200],
            "topics": valid[:20],
            "notes": str(data.get("notes", ""))[:300],
        }

    def _extract_topics_heuristic(self, document) -> dict:
        """Fallback: derive topics from document headings/structure."""
        text = document.text or ""
        lines = text.splitlines()
        topics: list[dict] = []
        seen: set[str] = set()

        for line in lines[:400]:
            s = line.strip()
            if not s:
                continue
            m = re.match(r"^(PART|UNIT|MODULE|CHAPTER|SECTION)\s+[\d.:]?\s*",
                         s, re.I)
            if not m:
                continue
            name = re.sub(r"^(PART|UNIT|MODULE|CHAPTER|SECTION)\s+", "",
                          s, flags=re.I).strip()
            if not name or name.lower() in seen:
                continue
            seen.add(name.lower())
            topics.append({
                "name": name[:200],
                "objective": f"Study {name.lower()}.",
                "estimated_hours": 1.5,
                "activity": "read",
                "prerequisites": [],
                "source": document.original_filename,
            })

        if not topics:
            groups = re.split(r"\n\s*\n", text)
            for g in groups[:25]:
                first = g.strip().splitlines()[0].strip() if g.strip() else ""
                if len(first) < 10 or first[0].isdigit():
                    continue
                fl = first.lower()
                if fl in seen:
                    continue
                seen.add(fl)
                topics.append({
                    "name": first[:200],
                    "objective": f"Study the content of {first.lower()[:50]}.",
                    "estimated_hours": 1.0,
                    "activity": "read",
                    "prerequisites": [],
                    "source": document.original_filename,
                })

        return {
            "title": document.original_filename,
            "topics": topics[:20],
            "notes": "Plan derived from document structure (AI extraction unavailable).",
        }

    @staticmethod
    def _order_by_dependencies(topics: list[dict]) -> list[dict]:
        """Topological order by prerequisites; unreachable topics last."""
        ordered: list[dict] = []
        done: set[str] = set()
        by_name = {t["name"]: t for t in topics}

        def visit(t):
            if t["name"] in done:
                return
            done.add(t["name"])
            for p in t.get("prerequisites", []):
                prereq = by_name.get(p)
                if prereq is not None and prereq["name"] not in done:
                    visit(prereq)
            ordered.append(t)

        for t in topics:
            visit(t)
        for t in topics:
            if t["name"] not in done:
                ordered.append(t)
                done.add(t["name"])
        return ordered

    @staticmethod
    def _resolve_exam_date(subject) -> date:
        """Derive a deadline from the subject's exam date if present."""
        raw = getattr(subject, "exam_date", None)
        if isinstance(raw, str) and raw:
            try:
                return date.fromisoformat(raw)
            except ValueError:
                pass
        return date.today() + timedelta(days=21)

    # ── Legacy topic-ranked generator (Roadmaps page) ────────────

    def generate_roadmap(
        self,
        subject_id: int,
        exam_date: date,
        available_hours_per_day: float = 3.0,
        selected_document_ids: list[int] = None,
        include_revision: bool = True,
        include_quizzes: bool = True,
    ) -> dict:
        """Day-by-day generator driven by ranked topics."""
        old = self.get_active_roadmap(subject_id)
        if old:
            old_rm = self.db.get(Roadmap, old["id"])
            if old_rm:
                old_rm.status = "abandoned"
                self.db.commit()

        ranked = self.ranker.rank_topics(subject_id, document_ids=selected_document_ids)
        if not ranked:
            raise ValueError("No topics found for this subject/document selection. Please extract topics from your documents first.")
        topics = sorted(ranked, key=lambda t: t["priority_score"], reverse=True)

        days_available = max(1, (exam_date - date.today()).days)
        total_time_needed = sum(t["estimated_hours"] for t in topics) * 1.2
        daily_capacity_hrs = float(available_hours_per_day)

        roadmap_days = []
        current_date = date.today()
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
                    tasks.append({"topic": t["name"], "type": "study",
                                  "duration_minutes": int(needed * 60)})
                    hrs_today += needed
                    hours_remaining = 0.0
                    topic_idx += 1
                else:
                    can_do = daily_capacity_hrs - hrs_today
                    tasks.append({"topic": t["name"], "type": "study",
                                  "duration_minutes": int(can_do * 60)})
                    hrs_today += can_do
                    hours_remaining = needed - can_do
                    break

            if tasks:
                roadmap_days.append({"date": d_date.isoformat(), "tasks": tasks})

        rm = Roadmap(
            subject_id=subject_id,
            title="Study Plan",
            exam_date=exam_date,
            available_hours_per_day=available_hours_per_day,
            plan_json=json.dumps(roadmap_days),
        )
        self.db.add(rm)
        self.db.commit()

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

    # ── Session / roadmap persistence helpers ────────────────────

    def mark_session_complete(self, session_id: int, actual_duration: int = None) -> bool:
        session = self.db.get(StudySession, session_id)
        if session:
            session.is_completed = True
            if actual_duration:
                session.actual_duration_minutes = actual_duration
            self.db.commit()
            return True
        return False

    def get_active_roadmap(self, subject_id: int) -> dict | None:
        rm = (self.db.query(Roadmap)
              .filter(Roadmap.subject_id == subject_id, Roadmap.status == "active")
              .first())
        if not rm:
            return None
        return self._build_view_model(rm)

    def get_roadmap_by_id(self, roadmap_id: int) -> dict | None:
        rm = self.db.get(Roadmap, roadmap_id)
        return self._build_view_model(rm) if rm else None

    def _build_view_model(self, rm: Roadmap) -> dict:
        """Build the rich view model used by the modal timeline."""
        days = json.loads(rm.plan_json or "[]")
        sessions = (self.db.query(StudySession)
                    .filter(StudySession.roadmap_id == rm.id)
                    .order_by(StudySession.planned_date).all())
        session_map = {(s.planned_date, s.topic_name): s for s in sessions}

        completed = 0
        for day in days:
            for t in day.get("tasks", []):
                key = (day["date"], t.get("topic", t.get("name")))
                sess = session_map.get(key)
                t["_completed"] = bool(sess and sess.is_completed)
                t["_session_id"] = sess.id if sess else None
                if sess and sess.is_completed:
                    completed += 1

        total = len(sessions)
        return {
            "id": rm.id,
            "title": rm.title,
            "exam_date": rm.exam_date,
            "daily_hours": rm.available_hours_per_day,
            "total_days": len(days),
            "total_sessions": total,
            "completed_sessions": completed,
            "progress": round(100.0 * completed / max(1, total), 1),
            "plan": {"id": rm.id, "title": rm.title, "days": days},
        }
