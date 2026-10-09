from __future__ import annotations
from datetime import date
from database.models import Attendance, Subject

class AttendanceCalculator:
    """Track and analyze attendance."""

    def __init__(self, db_session):
        self.db = db_session

    def record_attendance(self, subject_id: int, date: date, attended: int, total: int):
        """Record daily attendance."""
        a = Attendance(
            subject_id=subject_id,
            date=date,
            classes_attended=attended,
            total_classes=total,
            record_type="daily",
        )
        self.db.add(a)
        self.db.commit()

    def get_subject_attendance(self, subject_id: int) -> dict:
        """Current attendance with percentage."""
        records = self.db.query(Attendance).filter(Attendance.subject_id == subject_id).all()
        total_attended = sum(r.classes_attended for r in records)
        total_classes = sum(r.total_classes for r in records)

        pct = (total_attended / total_classes * 100) if total_classes > 0 else 0.0

        return {
            "percentage": round(pct, 1),
            "attended": total_attended,
            "total": total_classes,
            "can_skip": max(0, int(total_classes * 0.75 - total_attended)) if total_classes > 0 else 0
        }
