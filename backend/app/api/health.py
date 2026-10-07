from fastapi import APIRouter
from sqlalchemy import text
from app.core.security import get_current_user
from fastapi import Depends
from app.database.database import engine
from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.database import get_db
from app.models.profiles import Profile


router = APIRouter(
    prefix="/health",
    tags=["Health"]
)


@router.get("/")
async def health_check():
    return {"status": "ok"}


@router.get("/database")
async def database_health_check():
    async with engine.connect() as connection:
        result = await connection.execute(text("SELECT 1"))

    return {
        "database": "connected",
        "result": result.scalar()
    }

