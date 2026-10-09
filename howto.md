# How to Run Brihaspati

Brihaspati is a personal AI academic companion built with Python and Streamlit. Follow these steps to set up and run the application.

## Prerequisites

- [Python 3.10+](https://www.python.org/downloads/) installed.
- [Git](https://git-scm.com/) installed.

## Setup Instructions

1.  **Clone/Open the repository**:
    Ensure you are in the project root directory `C:\Users\haruw\Desktop\College\Training\Agentic AI\Brihaspati`.

2.  **Create a Virtual Environment**:
    Open your terminal in the project directory and run:
    ```bash
    python -m venv venv
    ```

3.  **Activate the Virtual Environment**:
    - **Windows (Command Prompt)**:
      ```cmd
      venv\Scripts\activate.bat
      ```
    - **Windows (Bash/Git Bash)**:
      ```bash
      source venv/Scripts/activate
      ```

4.  **Install Dependencies**:
    ```bash
    pip install -r requirements.txt
    ```

5.  **Configure Environment Variables**:
    - Ensure `.env` exists in the project root.
    - Set `AI_PROVIDER=ollama` and `OLLAMA_BASE_URL` as defined in the default `.env`.

6.  **Run the Application**:
    ```bash
    streamlit run app.py
    ```

## Expected Output

Upon running `streamlit run app.py`, the terminal should show:

```
  You can now view your Streamlit app in your browser.

  Local URL: http://localhost:8501
```

Open `http://localhost:8501` in your browser. You should see the Brihaspati title and sidebar, confirming the database is initialized and the app is ready for use.
