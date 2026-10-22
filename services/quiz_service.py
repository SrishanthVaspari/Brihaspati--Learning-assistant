
from __future__ import annotations

import json
import logging
from datetime import datetime

from database.models import Quiz, QuizAttempt, QuizQuestion

logger = logging.getLogger(__name__)

OBJECTIVE_TYPES = {"mcq", "truefalse", "fillblank"}
SUBJECTIVE_TYPES = {"short", "long", "numerical"}
ALL_QUESTION_TYPES = OBJECTIVE_TYPES | SUBJECTIVE_TYPES

QUESTION_TYPE_ALIASES = {
    "multiple_choice": "mcq",
    "multiple-choice": "mcq",
    "multiple choice": "mcq",
    "true_false": "truefalse",
    "true/false": "truefalse",
    "true-false": "truefalse",
    "fill_in_the_blank": "fillblank",
    "fill-in-the-blank": "fillblank",
    "short_answer": "short",
    "long_answer": "long",
}


class QuizService:
    """Generate and manage quizzes from document content."""

    def __init__(self, ai_service, db_session):
        self.ai = ai_service
        self.db = db_session

    # ---------------------------------------------------------
    # Generation
    # ---------------------------------------------------------

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
        """Generate questions from supplied document sections."""

        if num_questions < 1:
            raise ValueError("Number of questions must be at least 1.")

        if quiz_type != "mixed":
            quiz_type = self._normalize_question_type(quiz_type)

        if quiz_type != "mixed" and quiz_type not in ALL_QUESTION_TYPES:
            raise ValueError(f"Unsupported quiz type: {quiz_type}")

        context = self._build_context(source_sections or [])
        topic_line = ", ".join(topics) if topics else "general course topics"

        if context.strip():
            source_text = context[:12000]
        else:
            source_text = (
                "No extracted document text was provided. "
                "Generate questions only from established knowledge "
                "of the requested topics, and do not claim they came "
                "from a document."
            )

        requested_type = (
            "a balanced mix of supported question types"
            if quiz_type == "mixed"
            else quiz_type
        )

        prompt = f"""
Create {num_questions} useful exam questions for a college student.

Topics: {topic_line}
Difficulty: {difficulty}
Requested question type: {requested_type}

SOURCE MATERIAL:
{source_text}

Return ONLY a valid JSON array. Each element must be an object
with these fields:

{{
  "question_text": "Question text",
  "question_type": "mcq",
  "options": ["Option A", "Option B", "Option C", "Option D"],
  "correct_answer": "Exact correct option text",
  "explanation": "Explanation of the answer",
  "marks": 1.0,
  "source_page": null,
  "topic_name": "Topic name"
}}

Rules:
- Generate actual questions, never placeholders.
- Use only these question_type values:
  mcq, truefalse, fillblank, short, long, numerical.
- For mcq, provide four distinct options and one correct answer.
  correct_answer must match one option exactly.
- For truefalse, correct_answer must be True or False.
- For fillblank, provide the missing word or phrase as the answer.
- For short and long, provide a model answer as the grading rubric.
- For numerical, provide the numeric answer as a string and
  explain the calculation.
- For non-MCQ questions, options should be an empty array.
- Every question must have question_text, question_type,
  correct_answer, explanation, and marks.
- Use source_page only when the page number is actually known.
- Spread questions across the requested topics.
- Do not repeat the same question.
- Do not include Markdown fences or text outside the JSON array.
- If the source material contains relevant facts, ground questions
  in that material.
"""

        if quiz_type != "mixed":
            prompt += (
                f'\nEvery question must have question_type '
                f'"{quiz_type}".\n'
            )

        try:
            data = self.ai.generate_json(
                prompt,
                system=(
                    "You are a careful college exam question writer. "
                    "Return valid JSON only. Follow the requested "
                    "schema and generate real, answerable questions."
                ),
            )
        except Exception as exc:
            logger.exception("AI quiz generation failed")
            raise RuntimeError(
                "The AI could not generate the quiz. Check that "
                "Ollama is running, the configured model is available, "
                "and the terminal has no AI service errors."
            ) from exc

        questions = self._validate_questions(
            data,
            num_questions,
            quiz_type,
        )

        if not questions:
            logger.error(
                "AI response contained no valid quiz questions. "
                "Response type: %s; preview: %r",
                type(data).__name__,
                str(data)[:2000],
            )
            raise ValueError(
                "The AI responded, but no valid questions were found. "
                "Check the terminal log for the response preview."
            )

        if len(questions) < num_questions:
            logger.warning(
                "Requested %s questions but validated only %s.",
                num_questions,
                len(questions),
            )

        if total_marks is None:
            total_marks = float(sum(q["marks"] for q in questions))

        quiz = Quiz(
            subject_id=subject_id,
            title=(
                f"{'Mixed' if quiz_type == 'mixed' else quiz_type.upper()} "
                f"Quiz — {topic_line[:60]}"
            ),
            quiz_type=quiz_type,
            topic_names=json.dumps(topics),
            difficulty=difficulty,
            total_marks=total_marks,
            negative_marking_ratio=negative_marking,
            time_limit_minutes=time_limit or 0,
        )

        try:
            self.db.add(quiz)
            self.db.commit()
            self.db.refresh(quiz)

            for question in questions:
                self.db.add(
                    QuizQuestion(
                        quiz_id=quiz.id,
                        question_text=question["question_text"],
                        question_type=question["question_type"],
                        options_json=json.dumps(question["options"]),
                        correct_answer=question["correct_answer"],
                        explanation=question["explanation"],
                        marks=question["marks"],
                        source_document_id=question.get(
                            "source_document_id"
                        ),
                        source_page=question.get("source_page"),
                        topic_name=question["topic_name"],
                    )
                )

            self.db.commit()

        except Exception:
            self.db.rollback()
            logger.exception("Failed to save generated quiz")
            raise

        logger.info(
            "Created quiz %s with %s questions.",
            quiz.id,
            len(questions),
        )

        return {
            "quiz_id": quiz.id,
            "title": quiz.title,
            "questions": questions,
            "total_marks": total_marks,
            "negative_marking": negative_marking,
            "time_limit_minutes": time_limit or 0,
        }

    @staticmethod
    def _normalize_question_type(value) -> str:
        """Normalize common names returned by language models."""
        normalized = str(value or "mcq").strip().lower()
        return QUESTION_TYPE_ALIASES.get(normalized, normalized)

    def _build_context(self, sections: list[dict]) -> str:
        parts = []

        for section in sections:
            header = section.get("title", "")
            page = section.get("page_or_slide_num")
            location = f" [slide/page {page}]" if page else ""
            content = section.get("content", "")
            parts.append(f"{header}{location}\n{content}")

        return "\n\n".join(parts)

    def _validate_questions(
        self,
        data,
        num: int,
        quiz_type: str,
    ) -> list[dict]:
        """Normalize and validate questions returned by the AI."""

        if isinstance(data, dict):
            data = data.get("questions", [])

        if not isinstance(data, list):
            logger.warning(
                "Expected a list of questions; received %s.",
                type(data).__name__,
            )
            return []

        valid = []

        for index, item in enumerate(data):
            if not isinstance(item, dict):
                logger.warning("Skipping non-object question at index %s.", index)
                continue

            question_text = str(
                item.get("question_text") or item.get("question") or ""
            ).strip()

            if not question_text:
                logger.warning("Skipping question %s with no question text.", index)
                continue

            qtype = self._normalize_question_type(
                item.get("question_type", item.get("type", "mcq"))
            )

            if qtype not in ALL_QUESTION_TYPES:
                logger.warning(
                    "Skipping question %s with unsupported type %r.",
                    index,
                    qtype,
                )
                continue

            if quiz_type != "mixed" and qtype != quiz_type:
                logger.warning(
                    "Skipping question %s: requested %s, received %s.",
                    index,
                    quiz_type,
                    qtype,
                )
                continue

            options = item.get("options", []) or []

            # Support simple option objects as well as strings.
            if isinstance(options, list):
                normalized_options = []
                for option in options:
                    if isinstance(option, dict):
                        option = (
                            option.get("text")
                            or option.get("label")
                            or option.get("value")
                            or ""
                        )
                    option_text = str(option).strip()
                    if option_text:
                        normalized_options.append(option_text)
                options = normalized_options
            else:
                logger.warning("Skipping question %s: options is not a list.", index)
                continue

            answer = str(
                item.get("correct_answer")
                or item.get("answer")
                or ""
            ).strip()

            # If an MCQ answer is a letter, resolve it to the option text.
            if qtype == "mcq" and answer.upper() in {
                "A", "B", "C", "D"
            }:
                answer_index = ord(answer.upper()) - ord("A")
                if answer_index < len(options):
                    answer = options[answer_index]

            if qtype == "mcq":
                # Duplicate options are not useful choices.
                unique_options = []
                seen = set()

                for option in options:
                    key = option.casefold()
                    if key not in seen:
                        unique_options.append(option)
                        seen.add(key)

                options = unique_options[:6]

                if len(options) < 2:
                    logger.warning(
                        "Skipping MCQ %s: fewer than two valid options.",
                        index,
                    )
                    continue

                if not answer or answer.casefold() not in {
                    option.casefold() for option in options
                }:
                    logger.warning(
                        "Skipping MCQ %s: answer does not match any option.",
                        index,
                    )
                    continue

            elif qtype == "truefalse":
                answer_lower = answer.lower()
                if answer_lower in ("true", "t"):
                    answer = "True"
                elif answer_lower in ("false", "f"):
                    answer = "False"
                else:
                    logger.warning(
                        "Skipping true/false question %s: invalid answer.",
                        index,
                    )
                    continue
                options = []

            elif not answer:
                logger.warning(
                    "Skipping question %s: missing model answer.",
                    index,
                )
                continue

            try:
                marks = float(item.get("marks", 1.0) or 1.0)
            except (TypeError, ValueError):
                marks = 1.0

            if marks <= 0:
                marks = 1.0

            source_page = item.get("source_page")
            try:
                if source_page is not None:
                    source_page = int(source_page)
            except (TypeError, ValueError):
                source_page = None

            source_document_id = item.get("source_document_id")
            try:
                if source_document_id is not None:
                    source_document_id = int(source_document_id)
            except (TypeError, ValueError):
                source_document_id = None

            valid.append({
                "question_text": question_text[:2000],
                "question_type": qtype,
                "options": options,
                "correct_answer": answer[:500],
                "explanation": str(item.get("explanation", ""))[:1000],
                "marks": marks,
                "source_page": source_page,
                "source_document_id": source_document_id,
                "topic_name": str(
                    item.get("topic_name", "")
                    or (question_text[:100])
                )[:300],
            })

            if len(valid) >= num:
                break

        logger.info(
            "Validated %s of %s requested quiz questions.",
            len(valid),
            num,
        )
        return valid

    # ---------------------------------------------------------
    # Scoring
    # ---------------------------------------------------------

    def score_quiz(
        self,
        quiz_id: int,
        answers: dict[int, str],
        time_taken_seconds: int = 0,
    ) -> dict:
        """Score objective questions locally and subjective answers with AI."""

        quiz = self.db.get(Quiz, quiz_id)

        if quiz is None:
            raise ValueError(f"Quiz {quiz_id} was not found.")

        questions = (
            self.db.query(QuizQuestion)
            .filter(QuizQuestion.quiz_id == quiz_id)
            .order_by(QuizQuestion.id)
            .all()
        )

        per_question = []
        total_score = 0.0
        max_score = 0.0

        for question in questions:
            student_answer = (
                answers.get(question.id) or ""
            ).strip()

            max_score += question.marks
            awarded = 0.0
            is_correct = False

            if question.question_type in OBJECTIVE_TYPES:
                is_correct = self._is_correct(
                    student_answer,
                    question.correct_answer,
                    question.question_type,
                )

                if is_correct:
                    awarded = question.marks
                elif quiz.negative_marking_ratio > 0 and student_answer:
                    awarded = -(
                        question.marks * quiz.negative_marking_ratio
                    )

            elif student_answer:
                awarded = self._grade_subjective(
                    question,
                    student_answer,
                )
                is_correct = awarded >= 0.5 * question.marks

            awarded = max(awarded, -question.marks)
            total_score += awarded

            try:
                options = json.loads(question.options_json or "[]")
            except json.JSONDecodeError:
                options = []

            per_question.append({
                "question_id": question.id,
                "question_text": question.question_text,
                "question_type": question.question_type,
                "options": options,
                "student_answer": student_answer,
                "correct_answer": question.correct_answer,
                "explanation": question.explanation,
                "awarded_marks": round(awarded, 2),
                "max_marks": question.marks,
                "is_correct": is_correct,
                "topic_name": question.topic_name,
            })

        percentage = (
            round((total_score / max_score) * 100, 2)
            if max_score > 0
            else 0.0
        )

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
        self.db.refresh(attempt)

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
        student = student.strip().casefold()
        correct = correct.strip().casefold()

        if qtype == "truefalse":
            return student in (
                ("true", "t", "yes", "1")
                if correct in ("true", "t", "yes", "1")
                else ("false", "f", "no", "0")
            )

        if qtype == "fillblank":
            return student == correct

        return student == correct

    def _grade_subjective(
        self,
        question: QuizQuestion,
        student_answer: str,
    ) -> float:
        prompt = f"""
Grade this student answer as a strict but fair examiner.

Question: {question.question_text}
Model answer (rubric): {question.correct_answer}
Explanation: {question.explanation}
Maximum marks: {question.marks}

Student answer: {student_answer}

Return ONLY JSON:
{{"marks_awarded": 0, "feedback": "Brief explanation"}}

marks_awarded must be a number between 0 and the maximum marks.
"""

        try:
            result = self.ai.generate_json(
                prompt,
                system=(
                    "You grade academic answers fairly. "
                    "Return valid JSON only."
                ),
            )
        except Exception:
            logger.exception("AI subjective grading failed.")
            return 0.0

        if isinstance(result, dict):
            try:
                marks = float(result.get("marks_awarded", 0))
                return max(0.0, min(marks, question.marks))
            except (TypeError, ValueError):
                logger.warning("AI returned invalid grading marks.")

        return 0.0

    # ---------------------------------------------------------
    # History and analytics
    # ---------------------------------------------------------

    def get_quiz_history(
        self,
        subject_id: int | None = None,
    ) -> list[dict]:
        query = self.db.query(QuizAttempt).join(Quiz)

        if subject_id:
            query = query.filter(Quiz.subject_id == subject_id)

        attempts = (
            query.order_by(QuizAttempt.completed_at.desc())
            .all()
        )

        return [
            {
                "attempt_id": attempt.id,
                "quiz_id": attempt.quiz_id,
                "title": attempt.quiz.title if attempt.quiz else "",
                "subject_id": (
                    attempt.quiz.subject_id if attempt.quiz else None
                ),
                "score": attempt.total_score,
                "max_score": attempt.max_score,
                "percentage": attempt.percentage,
                "completed_at": (
                    attempt.completed_at.isoformat()
                    if attempt.completed_at
                    else None
                ),
                "time_taken_seconds": attempt.time_taken_seconds,
            }
            for attempt in attempts
        ]

    def get_topic_accuracy(self, subject_id: int) -> dict[str, float]:
        rows = (
            self.db.query(QuizAttempt, Quiz)
            .join(Quiz, QuizAttempt.quiz_id == Quiz.id)
            .filter(Quiz.subject_id == subject_id)
            .order_by(QuizAttempt.completed_at.desc())
            .all()
        )

        topic_scores: dict[str, list[float]] = {}

        for attempt, quiz in rows:
            try:
                answers = json.loads(attempt.answers_json or "[]")
            except json.JSONDecodeError:
                logger.warning(
                    "Invalid saved answers JSON for attempt %s.",
                    attempt.id,
                )
                continue

            for answer in answers:
                topic = answer.get("topic_name") or "General"
                topic_scores.setdefault(topic, []).append(
                    float(answer.get("awarded_marks", 0.0))
                )
                topic_scores.setdefault(f"{topic}__max", []).append(
                    float(answer.get("max_marks", 0.0))
                )

        accuracy = {}

        for topic, scores in topic_scores.items():
            if topic.endswith("__max"):
                continue

            earned = sum(scores)
            possible = sum(topic_scores.get(f"{topic}__max", []))
            accuracy[topic] = (
                round((earned / possible) * 100, 1)
                if possible
                else 0.0
            )

        return accuracy

    def get_weak_topics(
        self,
        subject_id: int,
        threshold: float = 60.0,
    ) -> list[str]:
        accuracy = self.get_topic_accuracy(subject_id)

        return sorted(
            [
                topic
                for topic, percentage in accuracy.items()
                if percentage < threshold
            ],
            key=lambda topic: accuracy[topic],
        )
