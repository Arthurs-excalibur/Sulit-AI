# Sulit AI Setup Guide

Here is the step-by-step guide to setting up and running both the backend and the Chrome Extension:

---

### Step 1: Set Up PostgreSQL

Sulit AI requires a PostgreSQL database to manage its async job queue and caching.

1. Ensure you have **PostgreSQL** installed and running on your machine.
2. Create a database named `sulit_ai`.
3. If your credentials differ from the default (`postgres:postgres` on `localhost:5432`), update the `DATABASE_URL` in `backend/app/config.py`:
   ```python
   DATABASE_URL: str = "postgresql+asyncpg://<user>:<password>@localhost:5432/sulit_ai"
   ```

---

### Step 2: Set Up and Run the Python Backend

1. Open your terminal and navigate to the `backend` directory:
   ```powershell
   cd backend
   ```
2. (Optional but recommended) Create and activate a Python virtual environment:
   ```powershell
   python -m venv venv
   .\venv\Scripts\Activate
   ```
3. Install the required Python packages (including the new `asyncpg` driver):
   ```powershell
   pip install -r requirements.txt
   ```
4. Start the FastAPI server:
   ```powershell
   python -m app.main
   ```
   *The backend will start running locally at `http://localhost:8000`.*

---

### Step 3: Set Up and Run the Chrome Extension

1. Open a new terminal session and navigate to the `extension` directory:
   ```powershell
   cd extension
   ```
2. Install the frontend dependencies:
   ```powershell
   npm install
   ```
3. Start the Plasmo development server:
   ```powershell
   npm run dev
   ```
   *Plasmo will compile the extension and generate a development build in the `extension/build/chrome-mv3-dev` directory.*

---

### Step 4: Load the Extension into Google Chrome

1. Open **Google Chrome** and navigate to `chrome://extensions/`.
2. Enable the **Developer mode** toggle in the top-right corner.
3. Click the **Load unpacked** button in the top-left corner.
4. Select the directory: `f:\Development\Sulit AI\extension\build\chrome-mv3-dev`.

The **Sulit AI** extension icon will now appear in your browser. You can click on it and perform analysis requests on Shopee PH product URLs!