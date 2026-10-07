from fastapi import APIRouter
from app.api.health import router as health_router
from app.api.v1.users.router import router as users_router

router = APIRouter()

router.include_router(health_router)
router.include_router(users_router)