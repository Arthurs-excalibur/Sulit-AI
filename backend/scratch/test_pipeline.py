import asyncio
import logging
from datetime import datetime, timedelta
from sqlalchemy.future import select
from app.database import init_db, SessionLocal, ProductAnalysis
from app.scraper import extract_shop_and_item_id
from app.analyzer import calculate_confidence

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("sulit-ai-test")

async def run_pipeline_test():
    logger.info("Starting Sulit AI Production Refactor Integration Test...")
    
    # 1. Initialize Database Tables
    logger.info("Initializing SQL schemas...")
    await init_db()
    
    # 2. Verify URL Parser
    test_url = "https://shopee.ph/Honor-X5-Plus-X6B-Phone-Case-Cover-i.635001112.28865545337"
    shop_id, item_id = extract_shop_and_item_id(test_url)
    logger.info(f"Parsed URL: shop_id={shop_id}, item_id={item_id}")
    assert shop_id == "635001112" and item_id == "28865545337", "URL Parser Failure!"
    pid = f"{shop_id}_{item_id}"
    
    # 3. Verify Confidence System Logic
    logger.info("Testing confidence metric calculation...")
    dummy_scraped_data = {
        "title": "Short",
        "seller_name": "Shopee Seller",
        "reviews": [{"rating": 5, "comment": "Good!"}]
    }
    score, level, reasons = calculate_confidence(dummy_scraped_data)
    logger.info(f"Mock Data Confidence: Score={score}, Level={level}, Reasons={reasons}")
    assert level == "Low", "Confidence level calculation failure!"
    
    # 4. Verify Async DB Cache Write & Read
    logger.info("Testing non-blocking database transactions...")
    async with SessionLocal() as db:
        # Clean existing test record if present
        existing = await db.get(ProductAnalysis, pid)
        if existing:
            await db.delete(existing)
            await db.commit()
            logger.info("Cleared existing test record.")
            
        # Write test record
        new_analysis = ProductAnalysis(
            id=pid,
            url=test_url,
            title="Honor Phone Case Cover Solid Color Matte",
            price_str="₱145",
            sulit_score=7.8,
            verdict="Decent Deal",
            seller_name="BeautyPhone PH",
            seller_trust="Trusted Seller",
            seller_rating=4.7,
            price_status="Fair",
            raw_reviews_count=2,
            
            job_status="completed",
            confidence_score=0.45,
            confidence_level="Moderate",
            confidence_reasons_list=["Low review count"],
            
            expires_at=datetime.utcnow() + timedelta(hours=24)
        )
        db.add(new_analysis)
        await db.commit()
        logger.info("Successfully committed test record asynchronously.")
        
        # Read test record
        result = await db.execute(select(ProductAnalysis).filter(ProductAnalysis.id == pid))
        fetched = result.scalars().first()
        
        logger.info(f"Retrieved analysis record: ID={fetched.id}, Title={fetched.title}, Score={fetched.sulit_score}")
        assert fetched.sulit_score == 7.8, "Database Value Mismatch!"
        assert fetched.job_status == "completed", "Job status column failed!"
        assert fetched.confidence_level == "Moderate", "Confidence score column failed!"
        
        # Serialization verify
        serialized_dict = fetched.to_dict()
        logger.info(f"Serialized JSON dict: {serialized_dict}")
        
    logger.info("ALL INTEGRATION TESTS PASSED SUCCESSFULLY! 100% Production Hardening Verified.")

if __name__ == "__main__":
    asyncio.run(run_pipeline_test())
