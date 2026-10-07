import asyncio

from sqlalchemy import text

from app.database.database import engine


async def main():
    async with engine.connect() as connection:
        result = await connection.execute(
            text("""
                SELECT
                    column_name,
                    data_type,
                    is_nullable
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'contacts'
                ORDER BY ordinal_position;
            """)
        )

        print("Contacts columns:")

        for row in result:
            print(row)

    await engine.dispose()


asyncio.run(main())