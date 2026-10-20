# Aperture

Aperture is a full-stack messaging and communication application developed as a student project. It brings messaging, voice and video calls, user profiles, and accessibility-focused features together in one application.

## Live Demo

**Application:** https://aperture-app-project.vercel.app

The frontend is hosted on Vercel and the backend is hosted on Render. The application uses Supabase for authentication, PostgreSQL, and media storage.

The live deployment uses limited hosted-service resources. For evaluation, please avoid creating multiple accounts or uploading large or sensitive files. Account registration, email delivery, media storage, and availability may be affected by free-tier service limits.

## Project Objectives

- Build a working full-stack communication application.
- Learn how a frontend, backend API, database, authentication, and real-time communication work together.
- Support communication through text messages and one-to-one audio/video calls.
- Develop accessibility features that can make the application easier to use without relying only on a mouse and keyboard.

## Features and Current Status

### Implemented

- User registration and login using Supabase Authentication.
- Profile management and user search.
- Direct messaging and conversation history.
- Group conversations with member management and group administration features.
- Message read receipts.
- File and media attachments with server-side validation and Supabase Storage.
- One-to-one audio and video calls using WebRTC.
- Incoming and outgoing call flows, including accepting, rejecting, cancelling, and ending calls.
- Microphone and camera controls during calls.
- WebSocket-based communication for real-time application events and call signalling.
- STUN/TURN configuration for WebRTC connectivity. The deployed application uses Metered TURN credentials when configured.
- Responsive interface for desktop and mobile screens.
- Backend health endpoints for checking the API and database connection.

### In Progress

- **User presence:** showing when users are online or offline and keeping presence information up to date.
- **Voice Assist:** the project has an accessibility-focused interface and a browser-based speech input/output foundation. The complete flow for interpreting a user's intention, identifying the correct contact, displaying confidence, and safely carrying out the requested action is still being developed.
- **Friend requests and accepted friendships:** the code now includes friend requests, accept/reject actions, and friendship checks for direct messages and calls. This change needs its database migration and deployment before it is available in the live demo.

### Planned

- **Voice commands for messaging and calls:** a user should be able to say commands such as “Call Shivratn” or “Message Shivratn” and have Aperture interpret and carry out the intended action.
- **Confidence and contact selection:** show the raw speech transcript alongside Aperture's interpretation and a confidence level. Contact matching should consider the user's previous interactions. If a command could refer to more than one person, Aperture should ask the user to clarify instead of silently choosing the wrong contact.
- **Video Assist with hand-sign recognition:** recognize supported hand signs during a video call and convert them into displayed text or an interpreted sequence. The recognition prototype and the final behaviour are still being planned; integration into Aperture has not been completed.

The status above distinguishes existing application functionality from features that are still being developed or planned. Planned features should not be considered available in the live demo yet.

## Technology Stack

### Frontend

- HTML
- CSS
- JavaScript (ES modules)
- Bootstrap and Bootstrap Icons
- Vite for local development and production builds
- Browser Web Speech API for the current Voice Assist prototype

### Backend

- Python
- FastAPI
- SQLAlchemy with asynchronous database access
- Alembic for database migrations
- Pydantic Settings for environment configuration
- WebSockets for real-time events and call signalling

### Database, Authentication, and Storage

- PostgreSQL
- Supabase Authentication
- Supabase Storage for media and attachments

### Calling and Deployment

- WebRTC for audio/video communication
- STUN and Metered TURN for connectivity across different networks
- Render for backend hosting
- Vercel for frontend hosting

## How It Works

1. The browser loads the frontend application.
2. Supabase Authentication handles user sign-in and registration.
3. The frontend sends authenticated HTTP requests to the FastAPI backend for application data and actions.
4. The backend validates requests and works with PostgreSQL to store conversation, message, profile, call, and attachment metadata.
5. WebSockets carry real-time application events and call-signalling messages.
6. WebRTC carries audio and video between callers. STUN helps discover network connectivity, while TURN can relay media when a direct connection cannot be established.
7. Uploaded media is stored in Supabase Storage rather than being stored directly in the database.

## Repository Structure

```text
Aperture/
├── backend/
│   ├── alembic/             # Database migration files
│   ├── app/
│   │   ├── api/             # API and WebSocket routes
│   │   ├── core/            # Configuration and authentication helpers
│   │   ├── database/        # Database connection and session setup
│   │   ├── models/          # Database models
│   │   ├── schemas/         # Request and response schemas
│   │   └── services/        # Shared application services
│   ├── requirements.txt
│   └── alembic.ini
├── frontend/
│   ├── css/                 # Stylesheets
│   ├── js/
│   │   ├── assist/          # Voice Assist interface and controllers
│   │   ├── pages/           # Page-level application code
│   │   ├── realtime/        # WebSocket client and event routing
│   │   ├── services/        # API and application services
│   │   └── webrtc/          # Audio/video calling logic
│   ├── app.html
│   ├── login.html
│   ├── register.html
│   ├── package.json
│   └── vite.config.js
├── LICENSE
└── README.md
```

## Running the Project Locally

You will need Python, Node.js with npm, and access to a configured Supabase project and PostgreSQL database. The commands below use PowerShell on Windows.

### 1. Configure the backend

Open a terminal in the repository root and run:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Create a `backend/.env` file. Fill in the values from your own Supabase and database configuration; do not use the placeholder values literally.

```dotenv
APP_NAME=Aperture API
APP_VERSION=0.1.0
DATABASE_URL=postgresql+asyncpg://USER:PASSWORD@HOST:PORT/DATABASE
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SECRET_KEY=YOUR_SERVER_SIDE_SECRET_KEY
SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLIC_PUBLISHABLE_KEY
CORS_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

Keep the backend secret key in the backend environment only. Never commit `.env` files or put backend secrets in frontend variables.

Before applying migrations, run the automated backend checks and the read-only data preflight:

```powershell
python -m pytest -q
python scripts/friendship_migration_preflight.py
```

The preflight reports duplicate direct conversations that will be consolidated and stops the migration workflow if a malformed direct conversation contains message history. Back up the database and test the migration against a separate staging database before applying it to production.

The chat-list endpoint batches participant, latest-message, attachment, and friendship lookups rather than issuing database queries per conversation. The friendship migration also adds indexes for conversation membership and newest-message lookups. These reduce database round trips and history scans as the number of chats grows.

Apply database migrations only after the preflight and backup are complete:

```powershell
alembic upgrade head
```

Start the backend:

```powershell
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

The backend should now be available at `http://127.0.0.1:8000`. FastAPI's API documentation is normally available at `http://127.0.0.1:8000/docs`.

### 2. Configure the frontend

Open a second terminal at the repository root and run:

```powershell
cd frontend
npm install
Copy-Item .env.example .env.local
```

Edit `frontend/.env.local` and enter your own public Supabase project values:

```dotenv
VITE_API_BASE_URL=http://localhost:8000
VITE_WS_BASE_URL=ws://localhost:8000
VITE_ENVIRONMENT=development
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLIC_PUBLISHABLE_KEY
```

If you configure Metered TURN for local calling, add the credential-scoped `VITE_METERED_API_KEY` value required by your setup. Do not use a Metered account-level secret key in the frontend.

Start the frontend:

```powershell
npm run dev
```

Open the local Vite URL printed in the terminal, usually `http://localhost:5173/app.html`.

### 3. Test the local application

- Register or sign in using your configured Supabase project.
- Open the application in two separate browser sessions with different accounts to test messaging and calls.
- Allow camera and microphone permissions when testing calls.
- Test attachment uploads with small, non-sensitive files.
- Check both the browser developer console and the backend terminal if a feature does not work.

Local setup depends on the environment variables, Supabase policies, database migrations, and browser permissions being configured correctly.

## Deployment

The main demo uses the following services:

- **Frontend:** Vercel — https://aperture-app-project.vercel.app
- **Backend:** Render — https://aperture-backend-l7pv.onrender.com
- **Authentication, PostgreSQL, and media storage:** Supabase
- **TURN service:** Metered

The deployed frontend must use the correct production API and WebSocket URLs. The backend must allow the deployed frontend origin through `CORS_ALLOWED_ORIGINS`. Required production environment variables should be configured in the hosting provider dashboards and must not be committed to the repository.

Useful backend checks:

- API health: https://aperture-backend-l7pv.onrender.com/api/v1/health/
- Database health: https://aperture-backend-l7pv.onrender.com/api/v1/health/database
- API documentation: https://aperture-backend-l7pv.onrender.com/docs

## Current Limitations

- Audio/video calling currently supports one-to-one calls, not group calls.
- Call quality and connection success depend on the browser, permissions, network, and TURN service availability.
- User presence and the complete Voice Assist command flow are still being developed.
- Video Assist hand-sign recognition has not yet been integrated into the main application.
- The friendship changes are prepared in the source code but are not active in the live demo until the database migration and backend/frontend deployments are completed.
- The live demo uses hosted services with limited resources. Large uploads and repeated account creation should be avoided during evaluation.
- Aperture is a student project and should not be treated as a production communication service for sensitive or critical conversations.

## Security Notes

- Keep `.env` and `.env.local` files out of Git.
- Use only public/publishable Supabase keys in frontend variables. Keep server-side Supabase credentials in the backend environment.
- Do not share passwords, private keys, database connection strings, or account-level TURN secrets in the repository.
- File validation and upload-size checks reduce some risks, but they are not a substitute for careful use of uploaded files.

## License

See the [LICENSE](LICENSE) file for license information.
