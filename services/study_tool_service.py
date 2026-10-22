"""Study material generation service.

Generates study guides, flashcards, and quizzes from uploaded document
content and persists them so they can be reopened without another AI call.
"""

import json
import logging

from database.models import StudyGuide, FlashcardSet, Flashcard
from services.ai_service import call_ai
from database.db import get_session

logger = logging.getLogger(__name__)

STUDY_GUIDE_PROMPT = (
    "Create a comprehensive study guide on the given topic based ONLY on the "
    "provided context. Use clear Markdown headings, bullet points, and a short "
    "summary at the end. If the context does not contain enough information, "
    "state that explicitly."
)


def generate_study_guide(engine, subject_id, document_id, title, content_context):
    """Generate a study guide with the AI and persist it. Returns the StudyGuide row."""
    from database.db import get_session

    prompt = f"{STUDY_GUIDE_PROMPT}\n\nContext:\n\n{content_context}"
    content = call_ai(prompt)

    session = get_session(engine)
    try:
        guide = StudyGuide(
            subject_id=subject_id,
            document_id=document_id,
            title=title,
            content=content,
        )
        session.add(guide)
        session.commit()
        session.refresh(guide)
        return guide
    except Exception as e:
        session.rollback()
        logger.error("Failed to save study guide: %s", e)
        raise
    finally:
        session.close()


def get_study_guides(engine, subject_id):
    """Return all saved study guides for a subject (metadata only)."""
    from database.db import get_session

    session = get_session(engine)
    try:
        return (
            session.query(StudyGuide.id, StudyGuide.title)
            .filter(StudyGuide.subject_id == subject_id)
            .order_by(StudyGuide.created_at.desc())
            .all()
        )
    finally:
        session.close()

def get_study_guide_content(engine, guide_id):
    """Fetch content for a specific study guide."""
    from database.db import get_session
    session = get_session(engine)
    try:
        guide = session.query(StudyGuide).filter(StudyGuide.id == guide_id).first()
        return guide.content if guide else ""
    finally:
        session.close()


def delete_study_guide(engine, guide_id):
    """Delete a saved study guide by id."""
    from database.db import get_session

    session = get_session(engine)
    try:
        guide = session.query(StudyGuide).filter(StudyGuide.id == guide_id).first()
        if guide:
            session.delete(guide)
            session.commit()
            return True
        return False
    finally:
        session.close()


FLASHCARD_PROMPT = (
    "Create 5-10 flashcards based ONLY on the provided context.\n\n"
    "Return a JSON array of objects, each with exactly these keys:\n"
    '[{"question": "...", "answer": "..."}]\n\n'
    "Rules:\n"
    "- Return ONLY the JSON array. No markdown, no code fences, no commentary.\n"
    "- Each question and answer must be a non-empty string.\n"
    "- Do not include any other fields or text outside the JSON array."
)


def _extract_json_array(text: str) -> str | None:
    """Extract the first complete JSON array from a model response.

    Handles markdown fences, prose before/after the JSON, and nested
    braces by scanning for the outermost balanced [ ... ] pair.
    """
    import re

    cleaned = text.strip()
    # Strip code fences if present.
    fence = re.search(r"```(?:json)?\s*(.*?)\s*```", cleaned, re.DOTALL)
    if fence:
        cleaned = fence.group(1).strip()

    start = cleaned.find("[")
    if start == -1:
        return None

    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(cleaned)):
        ch = cleaned[i]
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return cleaned[start : i + 1]
    return None


def _normalize_cards(cards_data) -> list[dict]:
    """Validate and normalize a parsed JSON array into canonical cards."""
    if not isinstance(cards_data, list):
        raise ValueError("Expected a JSON array")
    normalized = []
    for card in cards_data:
        if not isinstance(card, dict):
            continue
        question = str(card.get("question", "")).strip()
        answer = str(card.get("answer", "")).strip()
        if not question or not answer:
            continue
        normalized.append({"question": question[:1000], "answer": answer[:2000]})
    return normalized


def generate_flashcards(engine, subject_id, document_id, title, content_context):
    """Generate flashcards with the AI and persist them. Returns the set id."""
    import logging

    logger = logging.getLogger(__name__)

    # Force array structure
    prompt = f"{FLASHCARD_PROMPT}\n\nContext:\n\n{content_context}\n\nReturn a JSON array of objects:"
    response = call_ai(prompt)

    array_text = _extract_json_array(response or "")
    if array_text is None:
        logger.warning(
            "Flashcard AI response contained no JSON array. Response head: %r",
            (response or "")[:300],
        )
        raise ValueError("AI did not return valid flashcard JSON. Please retry.")

    try:
        cards_data = json.loads(array_text)
    except json.JSONDecodeError as e:
        logger.warning("Flashcard JSON parse failed: %s. Raw: %r", e, array_text[:300])
        raise ValueError("AI did not return valid flashcard JSON. Please retry.")

    cards = _normalize_cards(cards_data)
    if not cards:
        logger.warning("Flashcard JSON valid but contained no usable cards.")
        raise ValueError("AI did not return valid flashcard JSON. Please retry.")

    session = get_session(engine)
    try:
        flashcard_set = FlashcardSet(subject_id=subject_id, document_id=document_id, title=title)
        session.add(flashcard_set)
        session.flush()  # get the set id

        for card in cards:
            session.add(Flashcard(
                set_id=flashcard_set.id,
                question=card["question"],
                answer=card["answer"],
            ))

        session.commit()
        return flashcard_set.id
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_flashcard_sets(engine, subject_id):
    """Return all flashcard sets for a subject."""
    from database.db import get_session

    session = get_session(engine)
    try:
        return (
            session.query(FlashcardSet)
            .filter(FlashcardSet.subject_id == subject_id)
            .order_by(FlashcardSet.created_at.desc())
            .all()
        )
    finally:
        session.close()


def get_flashcards(engine, set_id):
    """Return all flashcards in a set."""
    from database.db import get_session

    session = get_session(engine)
    try:
        return (
            session.query(Flashcard)
            .filter(Flashcard.set_id == set_id)
            .order_by(Flashcard.id)
            .all()
        )
    finally:
        session.close()


def mark_flashcard_confidence(engine, card_id, confidence):
    """Record a confidence rating (1=hard, 2=good, 3=easy) leveraging spaced repetition."""
    from database.db import get_session
    from services.spaced_repetition import mark_review

    session = get_session(engine)
    try:
        card = session.query(Flashcard).filter(Flashcard.id == card_id).first()
        if card:
            mark_review(card, confidence)
            session.commit()
            return True
        return False
    finally:
        session.close()
