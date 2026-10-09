from __future__ import annotations
from database.models import Marks, Subject

class MarksCalculator:
    """GPA, CGPA, and marks analysis."""

    def __init__(self, db_session):
        self.db = db_session

    def add_marks(self, subject_id: int, assessment_name: str, assessment_type: str,
                  max_marks: float, obtained_marks: float, weightage: float = 1.0,
                  semester: int = 1, date: str = None) -> dict:
        """Record marks entry."""
        m = Marks(
            subject_id=subject_id,
            assessment_name=assessment_name,
            assessment_type=assessment_type,
            max_marks=max_marks,
            obtained_marks=obtained_marks,
            weightage=weightage,
            semester=semester,
        )
        self.db.add(m)
        self.db.commit()
        return {"id": m.id}

    def get_subject_marks(self, subject_id: int) -> dict:
        """All marks for a subject with percentage."""
        marks = self.db.query(Marks).filter(Marks.subject_id == subject_id).all()
        data = []
        total_obtained = 0.0
        total_max = 0.0
        for m in marks:
            pct = (m.obtained_marks / m.max_marks * 100) if m.max_marks > 0 else 0
            data.append({
                "name": m.assessment_name,
                "obtained": m.obtained_marks,
                "max": m.max_marks,
                "percentage": round(pct, 1),
            })
            total_obtained += m.obtained_marks * (m.weightage / 100.0)
            total_max += m.max_marks * (m.weightage / 100.0)

        overall = (total_obtained / total_max * 100) if total_max > 0 else 0
        return {"marks": data, "overall_percentage": round(overall, 1)}

    def calculate_gpa(self, semester: int, grading_rules: dict = None) -> dict:
        """Calculate semester GPA."""
        subjects = self.db.query(Subject).filter(Subject.semester == semester).all()
        # Default rules
        rules = grading_rules or {
            "grade_boundaries": [
                {"min": 90, "grade": "A+", "points": 10},
                {"min": 80, "grade": "A", "points": 9},
                {"min": 70, "grade": "B+", "points": 8},
                {"min": 60, "grade": "B", "points": 7},
                {"min": 50, "grade": "C", "points": 6},
                {"min": 40, "grade": "D", "points": 5},
                {"min": 0, "grade": "F", "points": 0},
            ]
        }

        subj_data = []
        total_points = 0.0
        total_credits = 0.0

        for subj in subjects:
            m = self.get_subject_marks(subj.id)
            pct = m.get("overall_percentage", 0)

            # Find grade
            grade = "F"
            points = 0
            for b in sorted(rules["grade_boundaries"], key=lambda x: x["min"], reverse=True):
                if pct >= b["min"]:
                    grade = b["grade"]
                    points = b["points"]
                    break

            subj_data.append({
                "name": subj.name,
                "percentage": pct,
                "grade": grade,
                "points": points,
                "credits": subj.credits
            })
            total_points += points * subj.credits
            total_credits += subj.credits

        gpa = round(total_points / total_credits, 2) if total_credits > 0 else 0.0
        return {"gpa": gpa, "subjects": subj_data, "total_credits": total_credits}
