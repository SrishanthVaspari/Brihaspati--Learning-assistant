from datetime import date, datetime, timedelta
from database.models import StudentProfile

def update_study_streak(session):
    profile = session.query(StudentProfile).first()
    if not profile:
        profile = StudentProfile()
        session.add(profile)

    today = date.today()
    if profile.last_studied_date:
        last_date = profile.last_studied_date.date()
        if last_date == today:
            return  # Already studied today
        elif last_date == today - timedelta(days=1):
            profile.current_streak += 1
        else:
            profile.current_streak = 1
    else:
        profile.current_streak = 1

    profile.last_studied_date = datetime.now()
    session.commit()

def get_study_streak(session):
    profile = session.query(StudentProfile).first()
    if not profile:
        return 0

    # Optional: Reset streak if last studied was > 1 day ago
    if profile.last_studied_date and profile.last_studied_date.date() < date.today() - timedelta(days=1):
        profile.current_streak = 0
        session.commit()

    return profile.current_streak
