"""Test core functionality."""
import os
import sys
sys.path.insert(0, os.getcwd())

print("Testing imports...")
from database.db import init_db, get_session
from services.ai_service import AIService
from services.document_processor import DocumentProcessor
from services.retrieval import RetrievalService

print("Testing database...")
engine = init_db("data/brihaspati.db")
session = get_session(engine)
print("Database initialized successfully")

print("Testing AI service...")
ai = AIService()
print(f"AI configured: {ai.is_configured()}")

print("Testing document processor...")
dp = DocumentProcessor()
print("Document processor initialized")

print("\nAll tests passed!")
