# Aperture

**Aperture is a full-stack messaging and communication application built around accessible, user-controlled communication.** It brings direct and group messaging, one-to-one audio/video calls, friend requests, online presence, file attachments, and Voice Assist into one web application.

The project demonstrates how a modern web frontend, authenticated backend APIs, a relational database, real-time events, browser-based media, and accessibility-oriented interaction can work together.

## Contents

- [Live Demo](#live-demo)
- [Project Objectives](#project-objectives)
- [Features](#features)
  - [Accounts and Profiles](#accounts-and-profiles)
  - [Friends and Presence](#friends-and-presence)
  - [Messaging and Conversations](#messaging-and-conversations)
  - [Audio and Video Calls](#audio-and-video-calls)
  - [Voice Assist](#voice-assist)
  - [Video Assist: Planned Work](#video-assist-planned-work)
- [Technology Stack](#technology-stack)
- [How Aperture Works](#how-aperture-works)
- [Repository Structure](#repository-structure)
- [Using the Live Demo](#using-the-live-demo)
- [Running the Project Locally](#running-the-project-locally)
- [Deployment](#deployment)
- [Testing and Verification](#testing-and-verification)
- [Current Limitations](#current-limitations)
- [Security and Responsible Use](#security-and-responsible-use)
- [License](#license)

## Live Demo

- **Application:** [https://aperture-app-project.vercel.app](https://aperture-app-project.vercel.app)
- **Backend API:** [https://aperture-backend-l7pv.onrender.com](https://aperture-backend-l7pv.onrender.com)
- **API documentation:** [https://aperture-backend-l7pv.onrender.com/docs](https://aperture-backend-l7pv.onrender.com/docs)
- **API health:** [https://aperture-backend-l7pv.onrender.com/api/v1/health/](https://aperture-backend-l7pv.onrender.com/api/v1/health/)
- **Database health:** [https://aperture-backend-l7pv.onrender.com/api/v1/health/database](https://aperture-backend-l7pv.onrender.com/api/v1/health/database)

The frontend is hosted on Vercel, the backend on Render, and Supabase provides authentication, PostgreSQL, and media storage.

**Live-demo note:** The deployment uses hosted services with limited resources. Account registration, email delivery, storage, and availability may be affected by free-tier limits. For evaluation, avoid creating multiple accounts unnecessarily or uploading large or sensitive files.

## Project Objectives

- Build a working full-stack communication application.
- Demonstrate the integration of a frontend, backend API, database, authentication, and real-time communication.
- Support text-based communication and one-to-one audio/video calls.
- Explore accessibility-focused interaction so users can perform supported actions without relying exclusively on a mouse and keyboard.
- Apply separation of concerns across frontend modules, API routes, database models, and shared backend services.

## Features

The sections below describe the functionality implemented in the project and how an evaluator can try it. Some behavior depends on account relationships, browser permissions, network conditions, and the availability of the hosted services.

### Accounts and Profiles

- **Registration and sign-in:** User authentication is provided through Supabase Authentication.
- **Profiles:** Users can view and manage profile information supported by the application.
- **User search:** Find other registered users through the application's search experience.
- **Responsive interface:** The UI adapts to desktop and mobile-sized screens.

**How to try it:** Open the [live application](https://aperture-app-project.vercel.app), register or sign in, and explore the profile and user-search views. Registration may depend on Supabase and email-service availability.

### Friends and Presence

- **Friend requests:** Send, accept, and reject friend requests.
- **Relationship-aware communication:** Direct messaging and calls are guarded by friendship checks.
- **Online/offline presence:** The application provides presence indicators for users, subject to connection state and the applicable sharing/relationship rules.
- **Last-seen privacy:** Presence behavior respects the application's last-seen sharing setting where applicable.

**How to try it:** Use two test accounts, send a friend request from one account, and accept it from the other. Then check the available presence indicators and try the communication features between the accepted friends. Non-friends may intentionally be denied access to relationship-restricted presence information.

### Messaging and Conversations

- **Direct messages:** Exchange text messages in one-to-one conversations.
- **Group conversations:** Create and use group conversations with member-management and group-administration functionality.
- **Conversation history:** View messages available in a conversation.
- **Read receipts:** Message read status is supported.
- **File and media attachments:** Attachments use Supabase Storage, with backend validation and upload-size checks.
- **Real-time events:** WebSockets deliver supported live application events.
- **Conversation access checks:** Backend routes check whether a user is allowed to access the relevant conversation or attachment.

**How to try it:**
1. Sign in with an account.
2. Open an existing conversation or find an eligible contact.
3. Send a text message and verify it appears in the conversation.
4. If testing with a second account, sign in using a separate browser profile or session and exchange messages.
5. Try a small, non-sensitive attachment if storage is available.
6. For group conversations, explore the available group creation and member-management controls.

### Audio and Video Calls

- **One-to-one calls:** Audio and video communication use WebRTC.
- **Call lifecycle:** The app supports incoming and outgoing call flows, including accepting, rejecting, cancelling, and ending calls.
- **In-call controls:** Microphone and camera controls are available during calls.
- **Call signalling:** WebSockets carry the signalling messages needed to coordinate calls.
- **Network traversal:** STUN is used for connectivity discovery, and Metered TURN can be configured to relay media when a direct connection cannot be established.
- **Participant and relationship checks:** Call actions are checked by the backend for the relevant participants and relationship permissions.

**How to try it:**
1. Sign in to two different accounts that are eligible to communicate.
2. Open the relevant conversation/contact and start a call using the available call controls.
3. On the receiving account, test accepting or rejecting the incoming call.
4. During a connected call, test the microphone and camera controls, then end the call.
5. Test cancellation of an outgoing call where possible.

The browser must be allowed to access the microphone and camera. Call success and quality depend on browser support, permissions, network configuration, and TURN service availability.

### Voice Assist

**Voice Assist** is Aperture's accessibility-focused voice interaction feature. It combines browser speech recognition and speech synthesis with command interpretation, contact matching, and UI actions.

Implemented capabilities include:

- **Voice Assist overlay and profile control:** Use the floating Voice Assist interface when enabled. The feature can be turned off and back on from the Profile section; disabling it hides the floating control and overlay.
- **Indian English speech recognition:** Recognition is configured to use `en-IN` where supported by the browser.
- **American English spoken output:** Spoken responses use `en-US` where supported, preferring an available American English browser voice.
- **Command interpretation:** Supported spoken commands are interpreted to identify the intended action and relevant details.
- **Contact matching:** Spoken contact names are matched against saved contacts, including tolerant matching for common speech-recognition variations. When a contact can be identified confidently, supported navigation actions can proceed; uncertainty can trigger clarification.
- **Confirmation for consequential actions:** Messaging and calling actions can present the intended recipient/action for confirmation or cancellation before execution.
- **Open a chat by voice:** A supported command such as “open chat Ishwar” can navigate to the matched contact's conversation.
- **Navigate back:** “Go back” returns to the Chats view through the application's normal navigation flow.
- **Read messages aloud:** Voice Assist can read loaded text messages in chronological or reverse-chronological order.
- **Choose message order and count:** Supported forms include “read messages ascending 2” for the oldest two loaded text messages in chronological order and “read messages descending 5” for the five newest loaded text messages newest-first. A plain “read messages” command retains the default recent-message behavior.
- **Spoken-number tolerance:** The read-message command handles common speech-recognition substitutions for numbers and limits the requested count to a safe maximum.
- **Confirmation variants:** The confirmation flow tolerates supported speech-recognition variations and stops processing after a valid confirmation or cancellation is recognized.

Speech-recognition availability and exact voice choices vary by browser and operating system. Voice Assist is a browser-based feature, not a guarantee of perfect recognition in every environment.

#### How to use Voice Assist

1. Sign in and open the application.
2. Open **Profile** and enable Voice Assist if it is disabled.
3. Use the floating Voice Assist control to access the overlay.
4. Speak a supported command clearly and wait for the app to interpret it.
5. For an action that requires confirmation, review the proposed action and confirm or cancel it as prompted.
6. To navigate, try a supported command such as “open chat Ishwar” using the name of an eligible contact, or “go back” to return to Chats.
7. To listen to messages, try “read messages”, “read messages ascending 2”, or “read messages descending 5”.
8. To disable Voice Assist, return to Profile and switch it off. The floating control and overlay should disappear while the profile setting remains available to turn it on again.

**Tips:** Use a browser with Web Speech API support, grant microphone permission when prompted, speak in a reasonably quiet environment, and check the recognized command before confirming consequential actions. Recognition and voice availability are browser-dependent.

### Video Assist: Planned Work

### Planned

- **Enhanced sign-language recognition:** Improve recognition of supported hand signs during video calls, with the goal of translating recognized signs into displayed text or interpreted sequences and making communication more accessible for sign-language users.

Aperture combines real-time communication, messaging, calling, and accessibility-focused interaction in one platform. Its design emphasizes inclusive communication, reliable contact selection, clear action confirmation, and user control.

## Technology Stack

### Frontend

- HTML
- CSS
- JavaScript using ES modules
- Bootstrap and Bootstrap Icons
- Vite for local development and production builds
- Browser Web Speech API for the current Voice Assist implementation

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

## How Aperture Works

1. The browser loads the Vite-built frontend.
2. Supabase Authentication handles registration and sign-in.
3. The frontend sends requests to the FastAPI backend for protected application data and actions.
4. The backend validates requests, applies access checks, and interacts with PostgreSQL through SQLAlchemy.
5. WebSockets carry supported real-time events and call-signalling messages.
6. WebRTC carries audio/video between callers. STUN assists with network connectivity discovery, while TURN can relay media when a direct connection is unavailable.
7. Uploaded media is stored in Supabase Storage rather than directly in PostgreSQL; the database stores related application metadata.
8. Voice Assist uses browser speech APIs to recognize commands and speak responses, then invokes supported application actions through the frontend.

## Repository Structure

```text
Aperture/
├── backend/
│   ├── alembic/              # Database migration files
│   ├── app/
│   │   ├── api/              # API and WebSocket routes
│   │   ├── core/             # Configuration and authentication helpers
│   │   ├── database/         # Database connection and session setup
│   │   ├── models/           # Database models
│   │   ├── schemas/          # Request and response schemas
│   │   └── services/         # Shared application services
│   ├── scripts/              # Maintenance and migration preflight scripts
│   ├── tests/                # Automated backend tests
│   ├── requirements.txt
│   └── alembic.ini
├── frontend/
│   ├── css/                  # Stylesheets
│   ├── js/
│   │   ├── assist/           # Voice Assist interface and controllers
│   │   ├── pages/            # Page-level application code
│   │   ├── realtime/         # WebSocket client and event routing
│   │   ├── services/         # API and application services
│   │   └── webrtc/           # Audio/video calling logic
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

Create a `backend/.env` file. Replace the placeholders with values from your own Supabase and database configuration.

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

Before applying migrations, run the automated backend checks and the read-only migration data preflight:

```powershell
python -m pytest -q
python scripts/friendship_migration_preflight.py
```

The preflight reports duplicate direct conversations that will be consolidated and stops the migration workflow if a malformed direct conversation contains message history. Back up the database and test the migration against a separate staging database before applying it to production.

The chat-list endpoint batches participant, latest-message, attachment, and friendship lookups rather than issuing database queries per conversation. The friendship migration also adds indexes for conversation membership and newest-message lookups. These reduce database round trips and history scans as the number of chats grows.

**Migration safety:** Do not apply migrations to a production database until the preflight has been reviewed and a recoverable database backup has been taken. If you are setting up a fresh database, verify the project's migration history and environment configuration before running the command below.

Apply database migrations only after the preflight and backup are complete:

```powershell
alembic upgrade head
```

Start the backend:

```powershell
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

The backend should be available at `http://127.0.0.1:8000`. FastAPI's API documentation is normally available at `http://127.0.0.1:8000/docs`.

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

If you configure Metered TURN for local calling, add the credential-scoped `VITE_METERED_API_KEY` value required by your setup. Do not use a Metered account-level secret key in the frontend. Any variable prefixed with `VITE_` is exposed to the browser bundle, so only use credentials intended for client-side use.

Start the frontend:

```powershell
npm run dev
```

Open the local Vite URL printed in the terminal, usually `http://localhost:5173/app.html`.

For a clean dependency installation, you can use `npm ci` when the committed lockfile is present and you want the exact locked dependency versions. To verify a production build:

```powershell
npm run build
```

### 3. Test the local application

- Register or sign in using your configured Supabase project.
- Open the application in two separate browser sessions with different accounts to test messaging and calls.
- Establish the friendship relationship needed for relationship-restricted features.
- Allow camera and microphone permissions when testing calls or voice input.
- Test attachment uploads with small, non-sensitive files.
- Try the supported Voice Assist commands and verify the profile enable/disable behavior.
- Check both the browser developer console and the backend terminal if a feature does not work.

Local setup depends on environment variables, Supabase configuration and policies, database migrations, and browser permissions being configured correctly.

## Deployment

The main demo uses the following services:

- **Frontend:** [Vercel](https://aperture-app-project.vercel.app)
- **Backend:** [Render](https://aperture-backend-l7pv.onrender.com)
- **Authentication, PostgreSQL, and media storage:** [Supabase](https://supabase.com/)
- **TURN service:** [Metered](https://www.metered.ca/)

The deployed frontend must use the correct production API and WebSocket URLs. The backend must allow the deployed frontend origin through `CORS_ALLOWED_ORIGINS`. Required production environment variables should be configured in the hosting provider dashboards and must not be committed to the repository.

Useful backend checks:

- [API health](https://aperture-backend-l7pv.onrender.com/api/v1/health/)
- [Database health](https://aperture-backend-l7pv.onrender.com/api/v1/health/database)
- [API documentation](https://aperture-backend-l7pv.onrender.com/docs)

After deploying, test sign-in, messaging, friendship restrictions, attachment access, presence, and calls against the deployed services. A successful frontend build alone does not verify the live backend, database, or WebRTC connectivity.

## Testing and Verification

The backend includes automated tests under `backend/tests/`. Run them from the `backend` directory:

```powershell
python -m pytest -q
```

The frontend uses Vite for development and production builds. Run the production build from the `frontend` directory:

```powershell
npm ci
npm run build
```

These commands verify the automated backend tests and frontend compilation/build respectively. They do not replace manual end-to-end checks in a browser with two test accounts, nor do they prove that a remote deployment or TURN connection is available.

## Current Limitations

- Audio/video calling currently supports one-to-one calls, not group calls.
- Call quality and connection success depend on the browser, permissions, network, and TURN service availability.
- User presence and the complete Voice Assist command flow are still being developed.
- Video Assist hand-sign recognition has not yet been integrated into the main application.
- The friendship changes are prepared in the source code but are not active in the live demo until the database migration and backend/frontend deployments are completed.
- The live demo uses hosted services with limited resources. Large uploads and repeated account creation should be avoided during evaluation.
- Aperture is a student project and should not be treated as a production communication service for sensitive or critical conversations.

## Security and Responsible Use

- Keep `.env` and `.env.local` files out of Git.
- Use only public/publishable Supabase keys in frontend variables. Keep server-side Supabase credentials in the backend environment.
- Do not share passwords, private keys, database connection strings, or account-level TURN secrets in the repository.
- File validation and upload-size checks reduce some risks, but they are not a substitute for careful use of uploaded files.
- Use test accounts and non-sensitive sample content when evaluating the live demo.
- Do not run database migrations against a production database without reviewing the migration, performing the preflight, and taking a recoverable backup.

## License

See the [LICENSE](LICENSE) file for license information.
