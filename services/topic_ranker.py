from __future__ import annotations

import json
import logging
import re
from datetime import date, datetime

from database.models import Document, DocumentSection, Subject, Topic

logger = logging.getLogger(__name__)

# Scoring weights — transparent and configurable.
WEIGHTS = {
    "mastery_gap": 0.30,
    "syllabus_emphasis": 0.25,
    "exam_proximity": 0.20,
    "quiz_performance": 0.15,
    "prerequisite_status": 0.10,
}


class TopicRanker:
    """Rank topics by study priority using a transparent scoring formula."""

    def __init__(self, ai_service, db_session):
        self.ai = ai_service
        self.db = db_session

    # ── Topic extraction ───────────────────────────────────────

    def extract_topics(self, subject_id: int, document_ids: list[int]) -> list[dict]:
        """Use AI to identify major topics from selected documents."""
        # Fetch text content from Documents
        documents = self.db.query(Document).filter(Document.id.in_(document_ids)).all()
        context = "\n".join(
            f"{d.original_filename}\n{d.text}"
            for d in documents if d.text
        )[:10000]

        prompt = f"""Identify the major syllabus topics covered in this lecture material.

{context}

Respond with ONLY a JSON array. Each element:
{{"name": "topic name", "description": "one-line description",
  "estimated_hours": <number>, "prerequisites": ["topic", ...]}}

Rules: 5–12 topics, concrete names (not "Introduction"), prerequisites
must be topics from the same list or empty."""

        data = self.ai.generate_json(prompt,
                                     system="You extract course syllabi. Output valid JSON only.")
        topics = self._validate_topics(data)

        if not topics:
            topics = self._extract_topics_heuristic([{"title": d.original_filename, "content": d.text} for d in documents])

        # Persist topics (skip duplicates by name within subject).
        existing = {t.name.lower() for t in
                    self.db.query(Topic).filter(Topic.subject_id == subject_id).all()}
        name_to_id = {t.name: t.id for t in
                      self.db.query(Topic).filter(Topic.subject_id == subject_id).all()}

        created = []
        for t in topics:
            if t["name"].lower() in existing:
                continue
            prereq_ids = [name_to_id[p] for p in t.get("prerequisites", [])
                          if p in name_to_id]
            topic = Topic(
                subject_id=subject_id,
                name=t["name"],
                description=t.get("description", ""),
                estimated_hours=float(t.get("estimated_hours", 1.0) or 1.0),
                is_prerequisite_met=not prereq_ids,
                source_document_ids=json.dumps(document_ids),
            )
            self.db.add(topic)
            created.append(t)
        self.db.commit()

        # Wire prerequisites now that ids exist.
        all_topics = self.db.query(Topic).filter(Topic.subject_id == subject_id).all()
        name_to_id = {t.name: t.id for t in all_topics}
        for t in all_topics:
            for match in topics:
                if match["name"] == t.name and match.get("prerequisites"):
                    prereq_names = [p for p in match["prerequisites"]
                                    if p in name_to_id and name_to_id[p] != t.id]
                    if prereq_names:
                        t.is_prerequisite_met = False
        self.db.commit()

        return topics

    def _validate_topics(self, data) -> list[dict]:
        if not isinstance(data, list):
            return []
        valid = []
        for item in data:
            if not isinstance(item, dict) or not item.get("name"):
                continue
            valid.append({
                "name": str(item["name"])[:300],
                "description": str(item.get("description", ""))[:500],
                "estimated_hours": float(item.get("estimated_hours", 1.0) or 1.0),
                "prerequisites": [str(p)[:300] for p in
                                  (item.get("prerequisites") or [])][:10],
            })
        return valid[:15]

    def _extract_topics_heuristic(self, sections: list[dict]) -> list[dict]:
        """Fallback: treat heading-like lines as topics."""
        topics = []
        seen = set()
        for s in sections:
            title = (s.get("title") or "").strip()
            if title and title.lower() not in seen and len(title) < 80:
                seen.add(title.lower())
                topics.append({"name": title,
                               "description": "",
                               "estimated_hours": 1.0,
                               "prerequisites": []})
        return topics[:10]

    # ── Ranking ────────────────────────────────────────────────

    def rank_topics(self, subject_id: int, document_ids: list[int] = None) -> list[dict]:
        """Score all topics 0–100 with a transparent weighted formula."""
        subject = self.db.get(Subject, subject_id)
        query = self.db.query(Topic).filter(Topic.subject_id == subject_id)

        # Filter by selected documents if provided
        if document_ids:
            # Topic has source_document_ids (JSON string)
            # This is slow, but acceptable for now without changing DB schema
            import json
            def matches_doc(topic):
                try:
                    ids = json.loads(topic.source_document_ids or "[]")
                    # If topic has no doc IDs, treat it as belonging to ALL topics in this context,
                    # or handle appropriately depending on desired behavior.
                    if not ids:
                        return True
                    return any(id in document_ids for id in ids)
                except:
                    return False
            topics = [t for t in query.all() if matches_doc(t)]
        else:
            topics = query.order_by(Topic.name).all()

        if not topics:
            return []

        accuracy = self._topic_accuracy(subject_id)
        ranked = []
        for topic in topics:
            emphasis = self._calculate_emphasis_score(topic.name, subject_id)
            mastery_gap = 100.0 - (topic.mastery_score or 0.0)
            proximity = self._calculate_exam_proximity_score(subject.exam_date)
            quiz_perf = 100.0 - accuracy.get(topic.name, 100.0)
            prereq_bonus = 100.0 if topic.is_prerequisite_met else 20.0

            score = (
                WEIGHTS["mastery_gap"] * mastery_gap
                + WEIGHTS["syllabus_emphasis"] * emphasis
                + WEIGHTS["exam_proximity"] * proximity
                + WEIGHTS["quiz_performance"] * quiz_perf
                + WEIGHTS["prerequisite_status"] * prereq_bonus
            )
            score = round(max(0.0, min(100.0, score)), 1)
            topic.priority_score = score
            self.db.commit()

            ranked.append({
                "topic_id": topic.id,
                "name": topic.name,
                "description": topic.description,
                "priority_score": score,
                "mastery": round(topic.mastery_score or 0.0, 1),
                "estimated_hours": topic.estimated_hours,
                "prerequisites_met": bool(topic.is_prerequisite_met),
                "breakdown": {
                    "mastery_gap": round(mastery_gap, 1),
                    "syllabus_emphasis": round(emphasis, 1),
                    "exam_proximity": round(proximity, 1),
                    "quiz_performance": round(quiz_perf, 1),
                    "prerequisite_status": round(prereq_bonus, 1),
                },
                "recommended_action": self._recommended_action(
                    score, topic.mastery_score or 0.0, topic.is_prerequisite_met),
            })

        ranked.sort(key=lambda t: t["priority_score"], reverse=True)
        return ranked

    def _recommended_action(self, score: float, mastery: float,
                             prereqs_met: bool) -> str:
        if not prereqs_met:
            return "Study prerequisites first, then this topic."
        if mastery < 40:
            return "Study in depth and take a practice quiz."
        if mastery < 70 or score >= 70:
            return "Revise and solve practice questions."
        return "Quick revision only — you know this well."

    def update_mastery(self, subject_id: int, topic_name: str,
                       quiz_score: float) -> None:
        """Exponential moving average of quiz performance."""
        topic = (self.db.query(Topic)
                 .filter(Topic.subject_id == subject_id,
                         Topic.name == topic_name)
                 .first())
        if topic:
            topic.mastery_score = round(
                0.7 * (topic.mastery_score or 0.0) + 0.3 * quiz_score, 1)
            topic.last_studied_at = datetime.utcnow()
            self.db.commit()

    def apply_quiz_mastery(self, subject_id: int,
                           per_question: list[dict]) -> None:
        """Update mastery for every topic touched by a quiz attempt."""
        by_topic: dict[str, list[float]] = {}
        for ans in per_question:
            topic = ans.get("topic_name") or "General"
            by_topic.setdefault(topic, []).append(ans.get("awarded_marks", 0.0))
            by_topic.setdefault(f"{topic}__max", []).append(ans.get("max_marks", 0.0))
        for topic, scores in by_topic.items():
            if topic.endswith("__max"):
                continue
            possible = sum(by_topic.get(f"{topic}__max", [1]))
            score = (sum(scores) / possible) * 100 if possible else 0.0
            self.update_mastery(subject_id, topic, score)

    def _calculate_exam_proximity_score(self, exam_date) -> float:
        """0 if >60 days away or unknown, 100 if ≤3 days, linear between."""
        if not exam_date:
            return 30.0  # unknown date — mild priority
        if isinstance(exam_date, datetime):
            exam_date = exam_date.date()
        if isinstance(exam_date, str):
            try:
                exam_date = date.fromisoformat(exam_date)
            except ValueError:
                return 30.0
        days = (exam_date - date.today()).days
        if days < 0:
            return 100.0
        if days <= 3:
            return 100.0
        if days >= 60:
            return 0.0
        return round(100.0 * (60 - days) / 57.0, 1)

    def _calculate_emphasis_score(self, topic_name: str,
                                   subject_id: int) -> float:
        """How prominently the topic appears in uploaded documents."""
        sections = (self.db.query(DocumentSection, Document)
                    .join(Document, DocumentSection.document_id == Document.id)
                    .filter(Document.subject_id == subject_id)
                    .all())
        if not sections:
            return 20.0

        keywords = self._topic_keywords(topic_name)
        if not keywords:
            return 20.0

        hits = 0
        total = 0
        for section, _doc in sections:
            text = f"{section.title}\n{section.content}".lower()
            total += 1
            if any(kw in text for kw in keywords):
                hits += 1
        coverage = hits / total
        # Scale: mentioned in >50% of sections → 100, else proportional.
        return round(min(100.0, coverage * 200), 1)

    @staticmethod
    def _topic_keywords(topic_name: str) -> list[str]:
        words = re.findall(r"[a-z0-9]+", topic_name.lower())
        return [w for w in words if len(w) > 3]

    def _topic_accuracy(self, subject_id: int) -> dict[str, float]:
        from services.quiz_service import QuizService

        return QuizService(self.ai, self.db).get_topic_accuracy(subject_id)
