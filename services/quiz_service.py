from __future__ import annotations

import json
import logging
import random
from datetime import datetime

from database.models import Quiz, QuizAttempt, QuizQuestion

logger = logging.getLogger(__name__)

OBJECTIVE_TYPES = {"mcq", "truefalse", "fillblank"}
SUBJECTIVE_TYPES = {"short", "long", "numerical"}


class QuizService:
    """Generate and manage quizzes from document content."""

    def __init__(self, ai_service, db_session):
        self.ai = ai_service
        self.db = db_session

    # ── Generation ───────────────────────────────────────────────────

    def generate_quiz(
        self,
        subject_id: int,
        topics: list[str],
        quiz_type: str = "mcq",
        num_questions: int = 10,
        difficulty: str = "medium",
        total_marks: float | None = None,
        negative_marking: float = 0.0,
        time_limit: int | None = None,
        source_sections: list[dict] | None = None,
    ) -> dict:
        """Use AI to generate quiz questions from document sections."""
        context = self._build_context(source_sections or [])
        topic_line = ", ".join(topics) if topics else "general"

        prompt = f"""Generate a quiz for a college student studying: {topic_line}.

Difficulty: {difficulty}
Question type: {quiz_type}
Number of questions: {num_questions}

Source material (cite slide/page in source_page field when known):
{context[:12000]}

Respond with ONLY a JSON array. Each element must have exactly these keys:
{{
  "question_text": "the question",
  "question_type": "mcq" | "truefalse" | "fillblank" | "short" | "long" | "numerical",
  "options": ["A", "B", "C", "D"]          (only for mcq),
  "correct_answer": "the correct answer text",
  "explanation": "why this is correct",
  "marks": 1.0,
  "source_page": 1,
  "topic_name": "topic this question covers"
}}

Rules:
- For mcq: provide 4 options, exactly one correct. correct_answer must be the option text.
- For truefalse: correct_answer is exactly "True" or "False".
- For fillblank: correct_answer is the missing word/phrase.
- For short/long: correct_answer is a model answer used as grading rubric.
- For numerical: correct_answer is the numeric value (as string), explanation shows steps.
- Spread questions across the topics.
- difficulty {difficulty}: {"basic recall" if difficulty == "easy" else "conceptual understanding" if difficulty == "medium" else "application and analysis"}."""

        if quiz_type != "mixed":
            prompt += f"\n- Every question must be of type \"{quiz_type}\"."

        data = self.ai.generate_json(prompt, system="You are an expert exam preparer. Output valid JSON only.")
        questions = self._validate_questions(data, num_questions, quiz_type)

        if not questions:
            questions = self._fallback_questions(topics, num_questions, quiz_type)

        if total_marks is None:
            total_marks = float(sum(q["marks"] for q in questions))

        quiz = Quiz(
            subject_id=subject_id,
            title=f"{'Mixed' if quiz_type == 'mixed' else quiz_type.upper()} Quiz — {topic_line[:60]}",
            quiz_type=quiz_type,
            topic_names=json.dumps(topics),
            difficulty=difficulty,
            total_marks=total_marks,
            negative_marking_ratio=negative_marking,
            time_limit_minutes=time_limit or 0,
        )
        self.db.add(quiz)
        self.db.commit()

        for q in questions:
            self.db.add(
                QuizQuestion(
                    quiz_id=quiz.id,
                    question_text=q["question_text"],
                    question_type=q["question_type"],
                    options_json=json.dumps(q.get("options", [])),
                    correct_answer=q["correct_answer"],
                    explanation=q.get("explanation", ""),
                    marks=q.get("marks", 1.0),
                    source_document_id=q.get("source_document_id"),
                    source_page=q.get("source_page"),
                    topic_name=q.get("topic_name", ""),
                )
            )
        self.db.commit()

        return {"quiz_id": quiz.id, "title": quiz.title, "questions": questions,
                "total_marks": total_marks, "negative_marking": negative_marking,
                "time_limit_minutes": time_limit or 0}

    def _build_context(self, sections: list[dict]) -> str:
        parts = []
        for s in sections:
            header = s.get("title", "")
            page = s.get("page_or_slide_num")
            loc = f" [slide {page}]" if page else ""
            parts.append(f"{header}{loc}\n{s.get('content', '')}")
        return "\n\n".join(parts)

    def _validate_questions(self, data, num: int, quiz_type: str) -> list[dict]:
        if not isinstance(data, list):
            return []
        valid = []
        for item in data:
            if not isinstance(item, dict) or not item.get("question_text"):
                continue
            qtype = item.get("question_type", "mcq")
            if quiz_type != "mixed" and qtype != quiz_type:
                continue
            q = {
                "question_text": str(item["question_text"])[:2000],
                "question_type": qtype if qtype in OBJECTIVE_TYPES | SUBJECTIVE_TYPES else "mcq",
                "options": item.get("options", []) or [],
                "correct_answer": str(item.get("correct_answer", ""))[:500],
                "explanation": str(item.get("explanation", ""))[:1000],
                "marks": float(item.get("marks", 1.0) or 1.0),
                "source_page": item.get("source_page"),
                "source_document_id": item.get("source_document_id"),
                "topic_name": str(item.get("topic_name", ""))[:300],
            }
            if q["question_type"] == "mcq":
                opts = [str(o) for o in q["options"] if str(o).strip()]
                if len(opts) < 2:
                    continue
                q["options"] = opts[:6]
            valid.append(q)
            if len(valid) >= num:
                break
        return valid

    def _fallback_questions(self, topics: list[str], num: int, quiz_type: str) -> list[dict]:
        """Template questions used only when AI is unavailable."""
        topic = topics[0] if topics else "the course"
        questions = []
        for i in range(min(num, 5)):
            if quiz_type in ("mcq", "mixed"):
                questions.append({
                    "question_text": f"Which statement about {topic} is correct?",
                    "question_type": "mcq",
                    "options": ["Option A", "Option B", "Option C", "Option D"],
                    "correct_answer": "Option A",
                    "explanation": "Fallback question — replace with AI-generated content.",
                    "marks": 1.0, "source_page": None, "topic_name": topic,
                })
            elif quiz_type == "truefalse":
                questions.append({
                    "question_text": f"{topic} is a core concept of this course.",
                    "question_type": "truefalse",
                    "options": [], "correct_answer": "True",
                    "explanation": "Fallback question.", "marks": 1.0,
                    "source_page": None, "topic_name": topic,
                })
            else:
                questions.append({
                    "question_text": f"Explain {topic} in your own words.",
                    "question_type": "short",
                    "options": [], "correct_answer": f"A clear explanation of {topic}.",
                    "explanation": "Model answer used as grading rubric.",
                    "marks": 5.0, "source_page": None, "topic_name": topic,
                })
        return questions

    # ── Scoring ──────────────────────────────────────────────────────

    def score_quiz(self, quiz_id: int, answers: dict[int, str],
                   time_taken_seconds: int = 0) -> dict:
        """Score a quiz attempt. Objective questions scored in Python;
        subjective questions graded by AI."""
        quiz = self.db.get(Quiz, quiz_id)
        questions = (self.db.query(QuizQuestion)
                     .filter(QuizQuestion.quiz_id == quiz_id)
                     .order_by(QuizQuestion.id)
                     .all())

        per_question = []
        total_score = 0.0
        max_score = 0.0

        for q in questions:
            student_answer = (answers.get(q.id) or "").strip()
            max_score += q.marks
            awarded = 0.0
            is_correct = False

            if q.question_type in OBJECTIVE_TYPES:
                is_correct = self._is_correct(student_answer, q.correct_answer,
                                              q.question_type)
                if is_correct:
                    awarded = q.marks
                elif quiz.negative_marking_ratio > 0 and student_answer:
                    awarded = -(q.marks * quiz.negative_marking_ratio)
            elif student_answer:
                awarded = self._grade_subjective(q, student_answer)
                is_correct = awarded >= 0.5 * q.marks

            awarded = max(awarded, -q.marks)  # floor: never lose more than full marks
            total_score += awarded
            per_question.append({
                "question_id": q.id,
                "question_text": q.question_text,
                "question_type": q.question_type,
                "options": json.loads(q.options_json or "[]"),
                "student_answer": student_answer,
                "correct_answer": q.correct_answer,
                "explanation": q.explanation,
                "awarded_marks": round(awarded, 2),
                "max_marks": q.marks,
                "is_correct": is_correct,
                "topic_name": q.topic_name,
            })

        percentage = round((total_score / max_score) * 100, 2) if max_score > 0 else 0.0

        attempt = QuizAttempt(
            quiz_id=quiz_id,
            completed_at=datetime.utcnow(),
            total_score=round(max(total_score, 0.0), 2),
            max_score=max_score,
            percentage=percentage,
            time_taken_seconds=time_taken_seconds,
            answers_json=json.dumps(per_question),
        )
        self.db.add(attempt)
        self.db.commit()

        return {
            "attempt_id": attempt.id,
            "total_score": round(max(total_score, 0.0), 2),
            "max_score": max_score,
            "percentage": percentage,
            "per_question": per_question,
            "time_taken_seconds": time_taken_seconds,
        }

    @staticmethod
    def _is_correct(student: str, correct: str, qtype: str) -> bool:
        student, correct = student.strip().lower(), correct.strip().lower()
        if qtype == "truefalse":
            s = "true" if student.startswith("t") else "false" if student.startswith("f") else student
            return s == correct
        if qtype == "fillblank":
            return student == correct or student in correct
        return student == correct

    def _grade_subjective(self, question: QuizQuestion, student_answer: str) -> float:
        prompt = f"""Grade this student answer as a strict but fair examiner.

Question: {question.question_text}
Model answer (rubric): {question.correct_answer}
Explanation: {question.explanation}
Maximum marks: {question.marks}

Student answer: {student_answer}

Respond with ONLY JSON: {{"marks_awarded": <number>, "feedback": "<1-2 sentences>"}}"""
        result = self.ai.generate_json(prompt, system="You grade academic answers. Output valid JSON only.")
        if isinstance(result, dict):
            try:
                marks = float(result.get("marks_awarded", 0))
                return max(0.0, min(marks, question.marks))
            except (TypeError, ValueError):
                pass
        return 0.0

    # ── History & analytics ──────────────────────────────────────────

    def get_quiz_history(self, subject_id: int | None = None) -> list[dict]:
        query = self.db.query(QuizAttempt).join(Quiz)
        if subject_id:
            query = query.filter(Quiz.subject_id == subject_id)
        attempts = query.order_by(QuizAttempt.completed_at.desc()).all()
        return [
            {
                "attempt_id": a.id,
                "quiz_id": a.quiz_id,
                "title": a.quiz.title if a.quiz else "",
                "subject_id": a.quiz.subject_id if a.quiz else None,
                "score": a.total_score,
                "max_score": a.max_score,
                "percentage": a.percentage,
                "completed_at": a.completed_at.isoformat() if a.completed_at else None,
                "time_taken_seconds": a.time_taken_seconds,
            }
            for a in attempts
        ]

    def get_topic_accuracy(self, subject_id: int) -> dict[str, float]:
        rows = (self.db.query(QuizAttempt, Quiz)
                .join(Quiz, QuizAttempt.quiz_id == Quiz.id)
                .filter(Quiz.subject_id == subject_id)
                .order_by(QuizAttempt.completed_at.desc())
                .all())
        topic_scores: dict[str, list[float]] = {}
        for attempt, quiz in rows:
            try:
                answers = json.loads(attempt.answers_json or "[]")
            except json.JSONDecodeError:
                continue
            for ans in answers:
                topic = ans.get("topic_name") or "General"
                topic_scores.setdefault(topic, []).append(ans.get("awarded_marks", 0.0))
                topic_scores.setdefault(f"{topic}__max", []).append(ans.get("max_marks", 0.0))

        accuracy = {}
        for topic, scores in topic_scores.items():
            if topic.endswith("__max"):
                continue
            earned = sum(scores)
            possible = sum(topic_scores.get(f"{topic}__max", [1]))
            accuracy[topic] = round((earned / possible) * 100, 1) if possible else 0.0
        return accuracy

    def get_weak_topics(self, subject_id: int, threshold: float = 60.0) -> list[str]:
        accuracy = self.get_topic_accuracy(subject_id)
        return sorted([t for t, pct in accuracy.items() if pct < threshold],
                      key=lambda t: accuracy[t])
