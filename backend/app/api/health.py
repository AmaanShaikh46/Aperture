from fastapi import APIRouter
from sqlalchemy import text

from app.database.database import engine


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