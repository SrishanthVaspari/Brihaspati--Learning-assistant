import json
import streamlit as st
import os
from database.db import get_session
from database.models import Subject, Document, Conversation, Message, Quiz, QuizQuestion
from services.document_processor import extract_text
from services.ai_service import AIService
from services import study_tool_service, quiz_service, anki_service

st.set_page_config(page_title="Study Workspace", layout="wide")

# Initialize session
session = get_session(st.session_state.engine)
retrieval = st.session_state.retrieval
ai_service = AIService()
q_service = quiz_service.QuizService(ai_service, session)
anki = anki_service.AnkiService()

# --- Dialogs for saved items ---
@st.dialog("Study Guide")
def show_guide(guide_content):
    st.markdown(guide_content)
    if st.button("Close"):
        st.session_state.active_dialog = None
        st.rerun()

@st.dialog("Flashcard Deck")
def show_flashcard_deck(deck_id):
    """Interactive flashcard review with answer entry and reveal."""
    cards = study_tool_service.get_flashcards(st.session_state.engine, deck_id)

    if not cards:
        st.write("No cards in this deck.")
    else:
        from services.spaced_repetition import is_card_due

        due_cards = [card for card in cards if is_card_due(card)]

        # Reset the position and answer whenever a different deck is opened.
        if st.session_state.get("active_flashcard_deck") != deck_id:
            st.session_state["active_flashcard_deck"] = deck_id
            st.session_state["card_idx"] = 0
            st.session_state["show_answer"] = False
            st.session_state["typed_flashcard_answer"] = ""
            st.session_state["flashcard_answer_feedback"] = None

        idx = st.session_state.get("card_idx", 0)

        if idx < len(due_cards):
            card = due_cards[idx]
            st.caption(f"Card {idx + 1} of {len(due_cards)} · Due today")
            st.progress((idx + 1) / len(due_cards))
            st.info(card.question)

            if not st.session_state.get("show_answer", False):
                st.text_area(
                    "Your answer",
                    key="typed_flashcard_answer",
                    placeholder="Try answering in your own words before revealing the answer...",
                    height=110,
                )
                if st.button("Check answer & reveal", type="primary", use_container_width=True):
                    typed_answer = st.session_state.get("typed_flashcard_answer", "").strip()
                    model_answer = str(card.answer or "").strip()
                    st.session_state["flashcard_answer_feedback"] = None

                    if not typed_answer:
                        st.session_state["flashcard_answer_feedback"] = {
                            "status": "empty",
                            "feedback": "You didn't enter an answer. Read the model answer, then rate how well you remembered it.",
                        }
                    else:
                        # Fast path: accept exact matches after basic normalization.
                        normalize = lambda value: " ".join(
                            "".join(ch.lower() if ch.isalnum() else " " for ch in value).split()
                        )
                        if normalize(typed_answer) == normalize(model_answer):
                            st.session_state["flashcard_answer_feedback"] = {
                                "status": "correct",
                                "feedback": "Your answer matches the model answer.",
                            }
                        else:
                            # Ask the configured AI to judge meaning, not exact wording.
                            try:
                                result = ai_service.generate_json(
                                    "Compare the student's answer with the model answer. "
                                    "Judge whether the student's answer is substantively correct. "
                                    "Accept equivalent wording, common abbreviations, and minor spelling/grammar differences "
                                    "when the meaning is correct. Do not accept an answer that reverses or omits the key idea. "
                                    "Return only JSON with keys is_correct (boolean) and feedback (brief string).\n\n"
                                    f"Question: {card.question}\n"
                                    f"Model answer: {model_answer}\n"
                                    f"Student answer: {typed_answer}",
                                    system="You are a fair educational flashcard answer checker. Be accurate and concise.",
                                )
                                if isinstance(result, list) and result and isinstance(result[0], dict):
                                    result = result[0]
                                if isinstance(result, dict):
                                    verdict = result.get("is_correct", False)
                                    if isinstance(verdict, str):
                                        verdict = verdict.strip().lower() in {"true", "yes", "correct", "1"}
                                    st.session_state["flashcard_answer_feedback"] = {
                                        "status": "correct" if verdict else "incorrect",
                                        "feedback": str(result.get("feedback") or ("Your answer is correct." if verdict else "Your answer doesn't fully match the model answer.")),
                                    }
                                else:
                                    raise ValueError("AI checker returned an unexpected response")
                            except Exception:
                                # If AI checking is unavailable, be honest rather than guessing.
                                st.session_state["flashcard_answer_feedback"] = {
                                    "status": "unchecked",
                                    "feedback": "Automatic checking is unavailable right now. Compare your answer with the model answer and choose your confidence honestly.",
                                }

                    st.session_state["show_answer"] = True
                    st.rerun()
            else:
                typed_answer = st.session_state.get("typed_flashcard_answer", "").strip()
                st.markdown("**Your answer**")
                st.write(typed_answer if typed_answer else "_No answer entered._")

                feedback = st.session_state.get("flashcard_answer_feedback") or {}
                status = feedback.get("status")
                message = feedback.get("feedback")
                if status == "correct":
                    st.success(f"✅ Correct — {message}")
                elif status == "incorrect":
                    st.error(f"❌ Not quite — {message}")
                elif message:
                    st.info(message)

                st.markdown("**Model answer**")
                st.success(card.answer)
                st.caption("How well did you remember?")

                c1, c2, c3 = st.columns(3)
                if c1.button("Hard 🔴", use_container_width=True):
                    study_tool_service.mark_flashcard_confidence(
                        st.session_state.engine, card.id, 1
                    )
                    # Reviewed cards normally stop being due, so keep the same index.
                    st.session_state["show_answer"] = False
                    st.session_state["typed_flashcard_answer"] = ""
                    st.session_state["flashcard_answer_feedback"] = None
                    st.rerun()
                if c2.button("Good 🟡", use_container_width=True):
                    study_tool_service.mark_flashcard_confidence(
                        st.session_state.engine, card.id, 2
                    )
                    st.session_state["show_answer"] = False
                    st.session_state["typed_flashcard_answer"] = ""
                    st.session_state["flashcard_answer_feedback"] = None
                    st.rerun()
                if c3.button("Easy 🟢", use_container_width=True):
                    study_tool_service.mark_flashcard_confidence(
                        st.session_state.engine, card.id, 3
                    )
                    st.session_state["show_answer"] = False
                    st.session_state["typed_flashcard_answer"] = ""
                    st.session_state["flashcard_answer_feedback"] = None
                    st.rerun()
        else:
            st.success("🎉 You've finished all due cards for this deck!")
            if len(due_cards) < len(cards):
                st.caption(
                    f"{len(cards) - len(due_cards)} cards are scheduled for later."
                )
            if st.button("Review this deck again", key="review_deck_again"):
                # This resets the UI only; cards not currently due remain scheduled.
                st.session_state["card_idx"] = 0
                st.session_state["show_answer"] = False
                st.session_state["typed_flashcard_answer"] = ""
                st.session_state["flashcard_answer_feedback"] = None
                st.rerun()

    if st.button("Close", key="close_fc"):
        st.session_state.active_dialog = None
        st.session_state["card_idx"] = 0
        st.session_state["show_answer"] = False
        st.session_state["typed_flashcard_answer"] = ""
        st.session_state["flashcard_answer_feedback"] = None
        st.session_state.pop("active_flashcard_deck", None)
        st.rerun()

@st.dialog("Quiz Review", width="large")
def show_quiz(quiz_id):
    """Interactive quiz interface for answering and grading."""
    session = get_session(st.session_state.engine)
    quiz = session.query(Quiz).filter(Quiz.id == quiz_id).first()
    questions = session.query(QuizQuestion).filter(QuizQuestion.quiz_id == quiz_id).all()

    if not quiz or not questions:
        st.error("Quiz content not available.")
        return

    # Initialize state for this specific quiz session
    if "quiz_answers" not in st.session_state or st.session_state.get("current_quiz_id") != quiz_id:
        st.session_state["quiz_answers"] = {}
        st.session_state["quiz_submitted"] = False
        st.session_state["current_quiz_id"] = quiz_id

    st.subheader(quiz.title)

    # Progress indicator
    total_q = len(questions)
    ans_count = len(st.session_state["quiz_answers"])
    st.progress(ans_count / total_q, text=f"Progress: {ans_count}/{total_q}")

    if not st.session_state["quiz_submitted"]:
        # Quiz Taking Mode
        for i, q in enumerate(questions):
            st.write(f"**Q{i+1}:** {q.question_text}")

            q_type = q.question_type or "mcq"
            try:
                options = json.loads(q.options_json or "[]")
            except (TypeError, json.JSONDecodeError):
                options = []

            if q_type == "mcq" and options:
                choice = st.radio(f"Select answer", options, index=None, key=f"q_{q.id}", on_change=lambda id=q.id: st.session_state["quiz_answers"].update({id: st.session_state[f"q_{id}"]}))
            elif q_type == "truefalse":
                choice = st.radio(f"Select answer", ["True", "False"], index=None, key=f"q_{q.id}", on_change=lambda id=q.id: st.session_state["quiz_answers"].update({id: st.session_state[f"q_{id}"]}))
            else:
                text = st.text_input(f"Your answer", key=f"q_{q.id}", on_change=lambda id=q.id: st.session_state["quiz_answers"].update({id: st.session_state[f"q_{id}"]}))
            st.divider()

        if st.button("Submit Quiz"):
            st.session_state["quiz_submitted"] = True
            st.rerun()

    else:
        # Results/Review Mode
        st.success("Quiz Submitted!")

        # Calculate simplistic scoring (Note: Subjective AI grading skipped here to keep it fast,
        # or call it if needed, but let's just display for now as per minimal viable path)
        total = 0
        for i, q in enumerate(questions):
            user_ans = str(st.session_state["quiz_answers"].get(q.id, "") or "")
            correct_answer = str(q.correct_answer or "")
            is_correct = user_ans.strip().casefold() == correct_answer.strip().casefold()

            if is_correct:
                total += q.marks
                st.write(f"✅ **Q{i+1}**: Correct!")
            else:
                st.write(f"❌ **Q{i+1}**: Incorrect. Correct answer: {correct_answer}")

            if q.explanation:
                st.caption(f"Explanation: {q.explanation}")
            st.divider()

        st.subheader(f"Total Score: {total} / {quiz.total_marks}")

        if st.button("Retake Quiz"):
            st.session_state["quiz_submitted"] = False
            st.session_state["quiz_answers"] = {}
            st.rerun()

    if st.button("Close"):
        st.session_state.active_dialog = None
        st.rerun()
    session.close()

@st.dialog("Study Roadmap", width="large")
def show_study_roadmap(subject_id: int, doc_id: int | None = None):
    """Pop-up for the Study Roadmap tool.

    Opens the roadmap generator: pick a document, set daily hours,
    generate an animated study timeline. Progress persists in the DB.
    """
    from components.study_roadmap_modal import open_study_roadmap
    open_study_roadmap(st.session_state.engine, subject_id,
                        doc_id=doc_id, default_hours=3.0)

# --- End Dialogs ---

def generate_assistant_response(conv_id, prompt, subject_id, chat_container):
    """Helper to generate and persist assistant response."""
    with chat_container:
        with st.chat_message("assistant"):
            with st.spinner("Brihaspati is thinking..."):
                try:
                    hits = retrieval.search(prompt, subject_id=subject_id)
                    context = "\n\n".join([h["content"] for h in hits])
                    response = ai_service.call_ai(prompt, context=context)
                    st.markdown(response)

                    # Add assistant message to DB
                    assistant_msg = Message(conversation_id=conv_id, role="assistant", content=response)
                    session.add(assistant_msg)
                    session.commit()
                    return response
                except Exception as e:
                    st.error(f"Failed to get response: {e}")
                    return None

st.title("📚 Study Workspace")

# Subject selection
subjects = session.query(Subject).all()
subject_names = {s.name: s.id for s in subjects}
selected_subject_name = st.selectbox("Select Subject", list(subject_names.keys()))

if selected_subject_name:
    subject_id = subject_names[selected_subject_name]

    col_sources, col_chat, col_studio = st.columns([1, 2, 1])

    # Left: Sources
    with col_sources:
        st.subheader("Sources")
        uploaded_file = st.file_uploader("Upload content")
        if uploaded_file:
            # (Keep existing upload logic...)
            # [I am truncating here to simplify the edit block - assume existing logic remains]
            existing_doc = session.query(Document).filter(
                Document.subject_id == subject_id,
                Document.original_filename == uploaded_file.name
            ).first()
            if existing_doc:
                st.warning(f"'{uploaded_file.name}' already exists.")
            else:
                file_path = os.path.join("data/documents", uploaded_file.name)
                os.makedirs(os.path.dirname(file_path), exist_ok=True)
                with open(file_path, "wb") as f:
                    f.write(uploaded_file.getbuffer())
                text, meta = extract_text(file_path)
                doc = Document(
                    subject_id=subject_id,
                    filename=uploaded_file.name,
                    original_filename=uploaded_file.name,
                    file_type=os.path.splitext(uploaded_file.name)[1].lower()[1:],
                    text=text,
                    page_count=meta.get("page_count") or meta.get("slide_count") or 0
                )
                session.add(doc)
                session.commit()
                retrieval.add_document_sections(doc.id, [{"title": "Full", "content": text, "page": 1, "subject_id": subject_id}])
                st.success("Uploaded!")
                st.rerun()

        # Checkbox selection for AI tools
        if 'selected_doc_ids' not in st.session_state:
            st.session_state.selected_doc_ids = set()

        docs = session.query(Document).filter(Document.subject_id == subject_id).all()
        for d in docs:
            c1, c2, c3 = st.columns([1, 6, 1])
            is_checked = c1.checkbox("", key=f"sel_{d.id}", value=d.id in st.session_state.selected_doc_ids)
            if is_checked:
                st.session_state.selected_doc_ids.add(d.id)
            else:
                st.session_state.selected_doc_ids.discard(d.id)
            c2.caption(f"📄 {d.original_filename}")
            if c3.button("🗑️", key=f"del_{d.id}", help="Delete source", use_container_width=True):
                retrieval.delete_document(d.id)
                session.delete(d)
                session.commit()
                st.rerun()

    # Center: Chat
    with col_chat:
        st.subheader("Ask Brihaspati")

        # Load conversations
        conversations = session.query(Conversation).filter(Conversation.subject_id == subject_id).all()
        if not conversations:
            new_conv = Conversation(subject_id=subject_id, title="New Conversation")
            session.add(new_conv)
            session.commit()
            conversations = [new_conv]

        # Conversation UI
        col_conv, col_new, col_del = st.columns([10, 1, 1], vertical_alignment="bottom")
        conv_titles = {f"{c.title} (ID: {c.id})": c.id for c in conversations}

        current_conv_key = col_conv.selectbox("Conversation", list(conv_titles.keys()), key="conv_select")
        conv_id = conv_titles[current_conv_key]

        with col_new:
            if st.button("➕", help="New Conversation"):
                new_conv = Conversation(subject_id=subject_id, title=f"Conversation {len(conversations)+1}")
                session.add(new_conv)
                session.commit()
                st.rerun()

        with col_del:
            if st.button("🗑️", help="Delete Conversation"):
                if len(conversations) > 1:
                    conv_to_del = session.query(Conversation).filter(Conversation.id == conv_id).first()
                    session.delete(conv_to_del)
                    session.commit()
                    st.rerun()
                else:
                    st.toast("Cannot delete the only conversation.", icon="⚠️")

        # Container for chat history
        chat_container = st.container(height=500)

        # Load messages
        messages = session.query(Message).filter(Message.conversation_id == conv_id).order_by(Message.created_at).all()

        with chat_container:
            for msg in messages:
                with st.chat_message(msg.role):
                    st.markdown(msg.content)
                    if msg.role == "assistant":
                        # Attempt to make regenerate button appear subtly or on hover
                        if st.button("🔄 Regenerate", key=f"retry_{msg.id}", help="Regenerate assistant response"):
                            # Find the last prompt message
                            prompt_msg = session.query(Message).filter(
                                Message.conversation_id == conv_id,
                                Message.role == "user",
                                Message.created_at < msg.created_at
                            ).order_by(Message.created_at.desc()).first()

                            if prompt_msg:
                                # Delete the old assistant message
                                session.delete(msg)
                                session.commit()
                                # Re-generate
                                generate_assistant_response(conv_id, prompt_msg.content, subject_id, chat_container)
                                st.rerun()
                            else:
                                st.error("Cannot regenerate: no user prompt found.")

        # Input area
        if prompt := st.chat_input("Ask about your notes..."):
            prompt = prompt.strip()
            if prompt:
                # Add user message to DB
                user_msg = Message(conversation_id=conv_id, role="user", content=prompt)
                session.add(user_msg)
                session.commit()

                # Display and generate response
                with chat_container:
                    with st.chat_message("user"):
                        st.markdown(prompt)

                    # Fix: Ensure generate_assistant_response is defined
                    generate_assistant_response(conv_id, prompt, subject_id, chat_container)
                    st.rerun()

    # Right: Studio
    with col_studio:
        st.subheader("Studio")

        if docs:
            # Global source context for the Studio
            doc_options = {d.original_filename: d.id for d in docs}
            st.markdown("**Active Source**")
            selected_doc = st.selectbox("Select document to process", list(doc_options.keys()), key="global_doc_sel", label_visibility="collapsed")
            active_doc_id = doc_options[selected_doc]

            st.markdown("### Generate")

            # Compact Tool Tiles Layout
            c1, c2 = st.columns(2)
            with c1:
                if st.button("🗺️ Roadmap", use_container_width=True, help="Create a study schedule"):
                    show_study_roadmap(subject_id, doc_id=active_doc_id)
                    st.rerun()
                if st.button("📘 Guide", use_container_width=True, help="Generate a study guide"):
                    doc = session.query(Document).filter(Document.id == active_doc_id).first()
                    with st.spinner("Generating Guide..."):
                        try:
                            guide = study_tool_service.generate_study_guide(
                                st.session_state.engine, subject_id, doc.id,
                                f"Guide - {doc.original_filename}", doc.text or ""
                            )
                            st.session_state.active_dialog = {"type": "Study Guide", "payload": guide.content}
                            st.rerun()
                        except Exception as e:
                            st.error(f"Failed: {e}")
            with c2:
                if st.button("📝 Quiz", use_container_width=True, help="Generate a custom quiz"):
                    doc = session.query(Document).filter(Document.id == active_doc_id).first()
                    with st.spinner("Generating Quiz..."):
                        try:
                            quiz_result = q_service.generate_quiz(
                                subject_id, [selected_doc],
                                source_sections=[{"title": "Full", "content": doc.text or ""}]
                            )
                            st.session_state.active_dialog = {"type": "Quiz", "payload": quiz_result["quiz_id"]}
                            st.rerun()
                        except Exception as e:
                            st.error(f"Failed: {e}")
                if st.button("🃏 Flashcards", use_container_width=True, help="Create Anki-ready flashcards"):
                    doc = session.query(Document).filter(Document.id == active_doc_id).first()
                    with st.spinner("Generating Cards..."):
                        try:
                            set_id = study_tool_service.generate_flashcards(
                                st.session_state.engine, subject_id, doc.id,
                                f"Flashcards - {doc.original_filename}", doc.text or ""
                            )
                            st.session_state.active_dialog = {"type": "Flashcard", "payload": set_id}
                            st.rerun()
                        except Exception as e:
                            st.error(f"Failed: {e}")

            # Anki Integration
            if anki.is_connected():
                st.markdown("**Anki Export**")
                decks = anki.get_decks()
                if decks:
                    c3, c4 = st.columns([3, 1])
                    with c3:
                        selected_deck = st.selectbox("Deck", decks, key="anki_deck_sel", label_visibility="collapsed")
                    with c4:
                        if st.button("Export", use_container_width=True, help="Send all flashcards to Anki"):
                            flashcard_sets = study_tool_service.get_flashcard_sets(st.session_state.engine, subject_id)
                            success, fail = 0, 0
                            for fs in flashcard_sets:
                                cards = study_tool_service.get_flashcards(st.session_state.engine, fs.id)
                                for card in cards:
                                    if anki.add_note(selected_deck, card.question, card.answer, tags=[subject_id]):
                                        success += 1
                                    else:
                                        fail += 1
                            if fail == 0 and success > 0:
                                st.toast(f"Exported {success} cards successfully!", icon="✅")
                            else:
                                st.toast(f"Exported: {success}, Failed: {fail}", icon="⚠️")
                else:
                    st.caption("No Anki decks found.")
        else:
            st.info("Upload a source from the left panel to use Study Tools.")

        # --- Saved Materials ---
        st.markdown("### 💾 Saved Materials")

        # Use caching to prevent redundant database queries
        @st.cache_data(ttl=600)
        def get_saved_items(subject_id):
            guides = study_tool_service.get_study_guides(st.session_state.engine, subject_id)
            flashcard_sets = study_tool_service.get_flashcard_sets(st.session_state.engine, subject_id)
            quizzes = session.query(Quiz).filter(Quiz.subject_id == subject_id).all()
            return guides, flashcard_sets, quizzes

        guides, flashcard_sets, quizzes = get_saved_items(subject_id)

        saved_items = []
        # Store item_id as payload for now, fetch content on click
        for g in guides: saved_items.append(("📘", g.title, "Study Guide", "guide_disp", g.id, g.id))
        for fs in flashcard_sets: saved_items.append(("🃏", fs.title, "Flashcard", "set_disp", fs.id, fs.id))
        for q in quizzes: saved_items.append(("📝", q.title, "Quiz", "quiz_disp", q.id, q.id))

        if saved_items:
            for icon, title, category, key_prefix, item_id, payload in sorted(saved_items, key=lambda x: x[1]):
                if st.button(f"{icon} {title} [{category}]", key=f"{key_prefix}_{item_id}"):
                    # Fetch detailed content on demand to preserve performance
                    actual_payload = payload
                    if category == "Study Guide":
                        actual_payload = study_tool_service.get_study_guide_content(st.session_state.engine, item_id)

                    st.session_state.active_dialog = {"type": category, "payload": actual_payload}
                    st.rerun()

        # Render active dialog if present
        if st.session_state.get("active_dialog"):
            active = st.session_state.active_dialog
            if active["type"] == "Study Guide":
                show_guide(active["payload"])
            elif active["type"] == "Flashcard":
                show_flashcard_deck(active["payload"])
            elif active["type"] == "Quiz":
                show_quiz(active["payload"])

session.close()
