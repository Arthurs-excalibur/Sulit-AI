import asyncio
from sqlalchemy.future import select
from app.database import SessionLocal, ProductAnalysis, init_db

async def check():
    async with SessionLocal() as db:
        result = await db.execute(select(ProductAnalysis))
        records = result.scalars().all()
        
        with open("scratch/db_dump.txt", "w", encoding="utf-8") as f:
            f.write(f"Total records in DB: {len(records)}\n")
            for r in records:
                f.write(f"ID: {r.id}\n")
                f.write(f"  Title: {r.title}\n")
                f.write(f"  Price: {r.price_str}\n")
                f.write(f"  Sulit Score: {r.sulit_score}\n")
                f.write(f"  Verdict: {r.verdict}\n")
                f.write(f"  Reviews Count: {r.raw_reviews_count}\n")
                f.write(f"  Job Status: {r.job_status}\n")
                f.write(f"  Job Error: {r.job_error}\n")
                f.write(f"  Seller Rating: {r.seller_rating}\n")
                f.write(f"  Product Rating: {r.product_rating}\n")
                f.write("-" * 40 + "\n")
        print("Successfully wrote database dump to scratch/db_dump.txt")

if __name__ == "__main__":
    asyncio.run(check())
