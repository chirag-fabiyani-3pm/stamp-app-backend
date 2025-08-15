# Node.js Backend for Stamp App

This directory contains the decoupled Node.js backend application for the Stamp App.
It exposes the following API endpoints:
- `/api/philaguide`
- `/api/realtime-session`
- `/api/realtime-stream`
- `/api/realtime-voice`
- `/api/speech-to-text`
- `/api/voice-chat`
- `/api/voice-stamp-search`
- `/api/voice-synthesis` (POST and GET)

## Setup

1.  **Navigate to the backend directory:**

    ```bash
    cd backend
    ```

2.  **Install Dependencies:**

    ```bash
    npm install
    ```

3.  **Build the TypeScript code:**

    ```bash
    npm run build
    ```

4.  **Set Environment Variables:**
    Create a `.env` file in the `backend` directory and add your OpenAI API key:

    ```
    OPENAI_API_KEY=your_openai_api_key_here
    ```

    *Note: Replace `your_openai_api_key_here` with your actual OpenAI API key.*

5.  **Run the Backend Server:**

    ```bash
    npm start
    ```

    This will start the Node.js server, typically on `http://localhost:3001`.

## Frontend Configuration

To connect the frontend to this new backend, ensure your Next.js frontend has the `NEXT_PUBLIC_BACKEND_URL` environment variable set to the backend's URL. For local development, add this to your frontend's `.env.local` file (in the root of your frontend project):

```
NEXT_PUBLIC_BACKEND_URL=http://localhost:3001
``` 