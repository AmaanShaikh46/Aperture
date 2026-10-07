from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.conversations import router as conversations_router

from app.api.messages import router as messages_router

from app.api.websocket import router as websocket_router

from app.api.v1.router import router as v1_router
from app.core.config import settings

app = FastAPI(
    title=settings.app_name,
    version=settings.app_version
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(
    v1_router,
    prefix="/api/v1"
)

app.include_router(
    conversations_router,
    prefix="/api",
)

app.include_router(
    messages_router,
    prefix="/api",
)

app.include_router(websocket_router)

