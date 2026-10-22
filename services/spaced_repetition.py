
from datetime import datetime, timedelta

from database.models import Flashcard


# Confidence levels:
# 1 = Hard
# 2 = Good
# 3 = Easy

REVIEW_INTERVALS = {
    1: 1,   # Hard: review tomorrow
    2: 3,   # Good: review in 3 days initially
    3: 7,   # Easy: review in 7 days initially
}


def is_card_due(card: Flashcard) -> bool:
    """Return True if a flashcard is due for review."""

    if not card.last_reviewed_at or not card.review_count:
        return True

    confidence = card.confidence or 2

    if confidence == 1:
        interval_days = 1
    elif confidence == 2:
        interval_days = max(3, card.review_count * 2)
    elif confidence == 3:
        interval_days = max(7, card.review_count * 4)
    else:
        interval_days = 1

    next_review_date = (
        card.last_reviewed_at + timedelta(days=interval_days)
    )

    return datetime.now() >= next_review_date


def mark_review(card: Flashcard, confidence: int) -> None:
    """
    Update the card after a review.

    1 = Hard: reset progress
    2 = Good: increment review count
    3 = Easy: increment review count by two
    """

    if confidence not in (1, 2, 3):
        raise ValueError(
            "Confidence must be 1 (Hard), 2 (Good), or 3 (Easy)."
        )

    card.confidence = confidence
    card.last_reviewed_at = datetime.now()

    if confidence == 1:
        card.review_count = 1
    elif confidence == 2:
        card.review_count = max(0, card.review_count or 0) + 1
    else:
        card.review_count = max(0, card.review_count or 0) + 2
