import asyncio
from app.database import SessionLocal, ProductAnalysis

async def clear_db():
    async with SessionLocal() as db:
        await db.execute(ProductAnalysis.__table__.delete())
        await db.commit()
    print("DB Cleared Successfully")

if __name__ == "__main__":
    asyncio.run(clear_db())
