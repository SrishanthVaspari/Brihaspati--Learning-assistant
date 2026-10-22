from sqlalchemy import Column, Integer, String, Float, ForeignKey, DateTime, Text, Boolean, func
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()

class StudentProfile(Base):
    __tablename__ = 'student_profile'
    id = Column(Integer, primary_key=True)
    name = Column(String, default='Student')
    college = Column(String)
    degree = Column(String)
    semester = Column(Integer, default=1)
    grading_system = Column(String, default='percentage')
    max_attendance_absence_pct = Column(Float, default=25.0)
    study_hours_per_day = Column(Float, default=4.0)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now())
    current_streak = Column(Integer, default=0)
    last_studied_date = Column(DateTime)

class Subject(Base):
    __tablename__ = 'subjects'
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    code = Column(String)
    semester = Column(Integer, default=1)
    credits = Column(Integer, default=4)
    exam_date = Column(String)
    created_at = Column(DateTime, server_default=func.now())

class Document(Base):
    __tablename__ = 'documents'
    id = Column(Integer, primary_key=True)
    subject_id = Column(Integer, ForeignKey('subjects.id'))
    filename = Column(String, nullable=False)
    file_type = Column(String, nullable=False)
    original_filename = Column(String, nullable=False)
    text = Column(String)
    page_count = Column(Integer, default=0)
    file_size = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())
    subject = relationship('Subject')

class DocumentSection(Base):
    __tablename__ = 'document_sections'
    id = Column(Integer, primary_key=True)
    document_id = Column(Integer, ForeignKey('documents.id'))
    title = Column(String)
    content = Column(Text)
    page = Column(Integer, default=0)
    document = relationship('Document')

class Topic(Base):
    __tablename__ = 'topics'
    id = Column(Integer, primary_key=True)
    subject_id = Column(Integer, ForeignKey('subjects.id'))
    name = Column(String, nullable=False)
    description = Column(Text)
    source_document_id = Column(Integer, ForeignKey('documents.id'), nullable=True)
    source_document_ids = Column(Text, nullable=True) # JSON store for multiple docs
    syllabus_weightage = Column(Float, default=0.0)
    estimated_hours = Column(Float, default=1.0)
    difficulty = Column(String, default='medium')
    mastery_score = Column(Float, default=0.0)
    prerequisite_topic_id = Column(Integer, ForeignKey('topics.id'), nullable=True)
    is_prerequisite_met = Column(Boolean, default=True)
    last_studied_at = Column(DateTime)
    priority_score = Column(Float, default=0.0)
    created_at = Column(DateTime, server_default=func.now())

class Quiz(Base):
    __tablename__ = 'quizzes'
    id = Column(Integer, primary_key=True)
    subject_id = Column(Integer, ForeignKey('subjects.id'))
    title = Column(String, nullable=False)
    quiz_type = Column(String)
    topic_names = Column(String) # JSON of topics
    difficulty = Column(String)
    total_marks = Column(Float, default=10.0)
    negative_marking_ratio = Column(Float, default=0.0)
    time_limit_minutes = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())

class QuizQuestion(Base):
    __tablename__ = 'quiz_questions'
    id = Column(Integer, primary_key=True)
    quiz_id = Column(Integer, ForeignKey('quizzes.id'))
    question_text = Column(Text, nullable=False)
    question_type = Column(String)
    options_json = Column(Text)
    correct_answer = Column(String)
    explanation = Column(Text)
    marks = Column(Float, default=1.0)
    source_document_id = Column(Integer, ForeignKey('documents.id'), nullable=True)
    source_page = Column(Integer)
    topic_name = Column(String)

class QuizAttempt(Base):
    __tablename__ = 'quiz_attempts'
    id = Column(Integer, primary_key=True)
    quiz_id = Column(Integer, ForeignKey('quizzes.id'))
    completed_at = Column(DateTime, server_default=func.now())
    total_score = Column(Float, default=0.0)
    max_score = Column(Float, default=0.0)
    percentage = Column(Float, default=0.0)
    time_taken_seconds = Column(Integer, default=0)
    answers_json = Column(Text)
    quiz = relationship('Quiz')

class Marks(Base):
    __tablename__ = 'marks'
    id = Column(Integer, primary_key=True)
    subject_id = Column(Integer, ForeignKey('subjects.id'))
    assessment_name = Column(String)
    assessment_type = Column(String)
    max_marks = Column(Float, default=100.0)
    obtained_marks = Column(Float, default=0.0)
    weightage = Column(Float, default=100.0)
    semester = Column(Integer, default=1)

class Attendance(Base):
    __tablename__ = 'attendance'
    id = Column(Integer, primary_key=True)
    subject_id = Column(Integer, ForeignKey('subjects.id'))
    date = Column(String)
    classes_attended = Column(Integer, default=0)
    total_classes = Column(Integer, default=0)
    record_type = Column(String, default='daily')

class Roadmap(Base):
    __tablename__ = 'roadmaps'
    id = Column(Integer, primary_key=True)
    subject_id = Column(Integer, ForeignKey('subjects.id'))
    title = Column(String)
    status = Column(String, default='active')
    exam_date = Column(String)
    available_hours_per_day = Column(Float, default=0.0)
    plan_json = Column(Text)

class PreparationTracker(Base):
    __tablename__ = 'preparation_trackers'
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    goal = Column(String)
    created_at = Column(DateTime, server_default=func.now())

class TrackerTask(Base):
    __tablename__ = 'tracker_tasks'
    id = Column(Integer, primary_key=True)
    tracker_id = Column(Integer, ForeignKey('preparation_trackers.id'))
    title = Column(String, nullable=False)
    is_completed = Column(Boolean, default=False)
    due_date = Column(String)
    created_at = Column(DateTime, server_default=func.now())

class StudySession(Base):
    __tablename__ = 'study_sessions'
    id = Column(Integer, primary_key=True)
    subject_id = Column(Integer, ForeignKey('subjects.id'))
    topic_name = Column(String)
    planned_date = Column(String)
    planned_duration_minutes = Column(Integer, default=60)
    roadmap_id = Column(Integer, ForeignKey('roadmaps.id'))
    is_completed = Column(Boolean, default=False)
    actual_duration_minutes = Column(Integer)

class Task(Base):
    __tablename__ = 'tasks'
    id = Column(Integer, primary_key=True)
    title = Column(String, nullable=False)
    description = Column(Text, default='')
    task_type = Column(String, default='study')
    subject_id = Column(Integer, ForeignKey('subjects.id'), nullable=True)
    due_date = Column(String)
    priority = Column(String, default='medium')
    status = Column(String, default='pending')
    is_completed = Column(Boolean, default=False)
    created_at = Column(DateTime, server_default=func.now())
    completed_at = Column(DateTime)

class Conversation(Base):
    __tablename__ = 'conversations'
    id = Column(Integer, primary_key=True)
    subject_id = Column(Integer, ForeignKey('subjects.id'))
    title = Column(String)
    created_at = Column(DateTime, server_default=func.now())
    messages = relationship('Message', backref='conversation', cascade='all, delete-orphan')

class Message(Base):
    __tablename__ = 'messages'
    id = Column(Integer, primary_key=True)
    conversation_id = Column(Integer, ForeignKey('conversations.id'))
    role = Column(String) # user, assistant
    content = Column(Text)
    created_at = Column(DateTime, server_default=func.now())

class StudyGuide(Base):
    __tablename__ = 'study_guides'
    id = Column(Integer, primary_key=True)
    subject_id = Column(Integer, ForeignKey('subjects.id'))
    document_id = Column(Integer, ForeignKey('documents.id'), nullable=True)
    title = Column(String, nullable=False)
    content = Column(Text)
    created_at = Column(DateTime, server_default=func.now())

class FlashcardSet(Base):
    __tablename__ = 'flashcard_sets'
    id = Column(Integer, primary_key=True)
    subject_id = Column(Integer, ForeignKey('subjects.id'))
    document_id = Column(Integer, ForeignKey('documents.id'), nullable=True)
    title = Column(String, nullable=False)
    created_at = Column(DateTime, server_default=func.now())

class Flashcard(Base):
    __tablename__ = 'flashcards'
    id = Column(Integer, primary_key=True)
    set_id = Column(Integer, ForeignKey('flashcard_sets.id'))
    question = Column(Text, nullable=False)
    answer = Column(Text, nullable=False)
    confidence = Column(Integer, default=0) # 0=unreviewed, 1=hard, 2=ok, 3=easy
    review_count = Column(Integer, default=0)
    last_reviewed_at = Column(DateTime)
