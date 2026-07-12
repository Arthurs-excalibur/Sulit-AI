import asyncio
import logging
import sys
import re
import json
from sqlalchemy import text
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from typing import Any, Optional

from app.config import settings
from app.database import init_db, get_db, ProductAnalysis, SessionLocal
from app.scraper import extract_shop_and_item_id
from app.analyzer import analyze_product_reviews

logger = logging.getLogger("sulit-ai-main")
logging.basicConfig(level=logging.INFO)

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())


# Active Worker Tasks
active_workers: list[asyncio.Task] = []

async def garbage_collection_loop():
    logger.info("Garbage collection worker started.")
    while True:
        await asyncio.sleep(3600)  # Run every hour
        try:
            async with SessionLocal() as db:
                now = datetime.utcnow()
                result = await db.execute(select(ProductAnalysis).filter(ProductAnalysis.expires_at < now))
                expired = result.scalars().all()
                for record in expired:
                    await db.delete(record)
                if expired:
                    await db.commit()
                    logger.info(f"Garbage collection deleted {len(expired)} expired records.")
        except Exception as e:
            logger.error(f"Garbage collection failed: {e}")

def normalize_product_text(value: str | None) -> str:
    if not value:
        return ""
    normalized = re.sub(r"\s+", " ", value).strip().lower()
    return normalized[:80]

def browser_payload_matches_cache(browser_scraped_data: dict[str, Any] | None, cached_record: ProductAnalysis) -> bool:
    if not browser_scraped_data:
        return True

    browser_title = normalize_product_text(browser_scraped_data.get("title"))
    cached_title = normalize_product_text(cached_record.title)
    if browser_title and cached_title and browser_title != cached_title:
        return False

    browser_price = normalize_product_text(browser_scraped_data.get("price_str"))
    cached_price = normalize_product_text(cached_record.price_str)
    if browser_price and browser_price != "n/a" and cached_price and browser_price != cached_price:
        return False

    return True

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Modern FastAPI lifespan handler replacing deprecated on_event hooks."""
    # Startup
    logger.info("Initializing SQL Database and enqueuing background workers...")
    await init_db()
    for i in range(2):  # 2 concurrent scraping workers
        worker = asyncio.create_task(queue_worker_loop())
        active_workers.append(worker)
    active_workers.append(asyncio.create_task(garbage_collection_loop()))
    logger.info("Async queue workers initialized.")
    
    yield  # App runs here
    
    # Shutdown
    logger.info("Shutting down background workers...")
    for worker in active_workers:
        worker.cancel()
    await asyncio.gather(*active_workers, return_exceptions=True)
    logger.info("Queue workers stopped successfully.")

app = FastAPI(
    title=settings.APP_NAME,
    description="Shopping Trust Intelligence engine for Philippine Ecommerce - Truth-First Production Hardened.",
    lifespan=lifespan
)

# Set CORS policy to enable Chrome Extension API calls
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class AnalysisRequest(BaseModel):
    url: str
    scraped_data: Optional[dict[str, Any]] = None

class StatusResponse(BaseModel):
    status: str
    database_ok: bool
    queue_backlog: int

async def queue_worker_loop():
    """
    Background worker loop that polls PostgreSQL for queued jobs using SKIP LOCKED,
    safely enabling concurrent multi-worker processing without a Redis dependency.
    """
    logger.info(f"Background Postgres queue worker started on {type(asyncio.get_running_loop()).__name__}.")
    while True:
        try:
            pid = None
            url = None
            browser_scraped_data = None
            
            async with SessionLocal() as db:
                # 1. Claim a job using FOR UPDATE SKIP LOCKED
                result = await db.execute(
                    text("SELECT id, url, scraped_payload FROM product_analyses WHERE job_status = 'queued' LIMIT 1 FOR UPDATE SKIP LOCKED")
                )
                row = result.fetchone()
                
                if not row:
                    await asyncio.sleep(1)
                    continue
                    
                pid, url, payload_str = row[0], row[1], row[2]
                browser_scraped_data = json.loads(payload_str) if payload_str else None
                
                # Update status to processing immediately
                await db.execute(
                    text("UPDATE product_analyses SET job_status = 'processing' WHERE id = :pid"),
                    {"pid": pid}
                )
                await db.commit()
            
            logger.info(f"Worker claimed job: {pid} for {url}")
            
            # Process job in a new session block
            async with SessionLocal() as db:
                try:
                    # 2. Prefer the extension's in-page Shopee payload
                    if browser_scraped_data and browser_scraped_data.get("reviews"):
                        logger.info(f"Using browser-sourced product payload for: {pid}")
                        scraped_data = browser_scraped_data
                    else:
                        logger.error(f"Frontend failed to extract reviews for: {pid}. Aborting analysis as Playwright fallback is removed.")
                        raise Exception("Scraping failed: Frontend interceptor timed out or failed to extract reviews from Shopee.")
                    
                    # 3. Analyze scraped corpus
                    logger.info(f"Queue executing LLM trust analyzer for: {pid}")
                    analysis_result = await analyze_product_reviews(scraped_data)
                
                    # 4. Save results to database cache
                    # Refetch record in case transaction state expired
                    result = await db.execute(select(ProductAnalysis).filter(ProductAnalysis.id == pid))
                    record = result.scalars().first()
                    if record:
                        record.title = scraped_data.get("title")
                        record.price_str = scraped_data.get("price_str")
                        record.sulit_score = analysis_result.get("sulitScore", 5.0)
                        record.verdict = analysis_result.get("verdict", "N/A")
                        record.seller_name = scraped_data.get("seller_name", "Shopee Seller")
                        record.seller_trust = analysis_result.get("sellerTrust", "Moderate Risk")
                        record.seller_rating = scraped_data.get("seller_rating")
                        record.price_status = analysis_result.get("priceStatus", "Fair")
                        reviews = scraped_data.get("reviews", [])
                        record.raw_reviews_count = len(reviews)
                        record.product_rating = scraped_data.get("product_rating")
                        record.product_rating_count = scraped_data.get("product_rating_count") or len(reviews)
                    
                        record.rating_5_count = sum(1 for r in reviews if r.get("rating") == 5)
                        record.rating_4_count = sum(1 for r in reviews if r.get("rating") == 4)
                        record.rating_3_count = sum(1 for r in reviews if r.get("rating") == 3)
                        record.rating_2_count = sum(1 for r in reviews if r.get("rating") == 2)
                        record.rating_1_count = sum(1 for r in reviews if r.get("rating") == 1)
                    
                        record.authenticity_score = analysis_result.get("authenticityScore", 85)
                        record.category_tag = analysis_result.get("categoryTag", "General")
                        record.response_rate = analysis_result.get("responseRate", "N/A")
                    
                        # Assign JSON lists
                        record.pros = analysis_result.get("pros", [])
                        record.cons = analysis_result.get("cons", [])
                        record.warnings = analysis_result.get("warnings", [])
                        record.top_quotes = analysis_result.get("topQuotes", [])
                    
                        # Confidence Scores
                        record.confidence_score = analysis_result.get("confidence_score", 1.0)
                        record.confidence_level = analysis_result.get("confidence_level", "High")
                        record.confidence_reasons_list = analysis_result.get("confidence_reasons", [])
                    
                        record.job_status = "completed"
                        record.job_error = None
                        record.created_at = datetime.utcnow()
                        record.expires_at = datetime.utcnow() + timedelta(hours=24) # 24 hours Cache TTL
                    
                        await db.commit()
                        logger.info(f"Successfully audited and cached product: {pid}")

                except Exception as e:
                    error_message = str(e) or repr(e)
                    logger.error(f"Worker pipeline failed for job {pid}: {error_message}", exc_info=True)
                    # Refetch to save failure reason
                    result = await db.execute(select(ProductAnalysis).filter(ProductAnalysis.id == pid))
                    record = result.scalars().first()
                    if record:
                        record.job_status = "failed"
                        record.job_error = error_message
                        await db.commit()
            
        except Exception as e:
            logger.error(f"Queue worker critical error: {e}")
            await asyncio.sleep(2)

@app.get("/api/status", response_model=StatusResponse)
async def get_status(db: AsyncSession = Depends(get_db)):
    db_ok = False
    backlog = 0
    try:
        result = await db.execute(text("SELECT count(*) FROM product_analyses WHERE job_status = 'queued'"))
        backlog = result.scalar()
        db_ok = True
    except Exception:
        pass
        
    return {
        "status": "healthy",
        "database_ok": db_ok,
        "queue_backlog": backlog
    }

@app.post("/api/analyze")
async def analyze_product(request: AnalysisRequest, db: AsyncSession = Depends(get_db)):
    url = request.url
    logger.info(f"Received analysis request for URL: {url}")
    
    shop_id, item_id = extract_shop_and_item_id(url)
    if not shop_id or not item_id:
        raise HTTPException(
            status_code=400,
            detail="Unsupported URL format. Must be a valid Shopee PH product link containing shopid and itemid."
        )
        
    pid = f"{shop_id}_{item_id}"
    browser_scraped_data = request.scraped_data or None
    browser_review_count = len(browser_scraped_data.get("reviews", [])) if browser_scraped_data else 0
    browser_rating_count = int(browser_scraped_data.get("product_rating_count") or 0) if browser_scraped_data else 0
    
    # Check Database Cache first
    result = await db.execute(select(ProductAnalysis).filter(ProductAnalysis.id == pid))
    cached_record = result.scalars().first()
    
    if cached_record:
        # Cache Hit - Check if it has completed and is not stale
        now = datetime.utcnow()
        if (
            cached_record.job_status == "completed"
            and cached_record.expires_at
            and cached_record.expires_at > now
            and browser_review_count <= (cached_record.raw_reviews_count or 0)
            and browser_rating_count <= (cached_record.product_rating_count or 0)
            and browser_payload_matches_cache(browser_scraped_data, cached_record)
            and cached_record.raw_reviews_count > 0  # Do not cache hit if we previously failed to get reviews
        ):
            logger.info(f"Active Cache Hit! Returning fresh cached result for: {pid}")
            return {
                "job_id": pid,
                "status": "completed",
                "result": cached_record.to_dict()
            }
        
        # If it is currently enqueued or processing, report state
        if cached_record.job_status in ["queued", "processing"]:
            logger.info(f"Active Job Pending! Product {pid} is currently {cached_record.job_status}")
            return {
                "job_id": pid,
                "status": cached_record.job_status
            }
            
        # If cache is expired or was marked as failed, delete or override it
        logger.info(f"Cache stale, expired, or marked as failed for: {pid}. Re-triggering crawl.")
        await db.delete(cached_record)
        await db.commit()

    # Create new analysis queue entry
    new_job = ProductAnalysis(
        id=pid,
        url=url,
        job_status="queued",
        scraped_payload=json.dumps(browser_scraped_data) if browser_scraped_data else None,
        created_at=datetime.utcnow()
    )
    db.add(new_job)
    await db.commit()
    
    logger.info(f"Enqueued job {pid} into Postgres queue.")
    
    return {
        "job_id": pid,
        "status": "queued"
    }

@app.get("/api/job/{job_id}")
async def get_job_status(job_id: str, db: AsyncSession = Depends(get_db)):
    """Polls the status or retrieves completed analysis of a queued background job."""
    result = await db.execute(select(ProductAnalysis).filter(ProductAnalysis.id == job_id))
    record = result.scalars().first()
    
    if not record:
        raise HTTPException(status_code=404, detail="Analysis job not found.")
        
    if record.job_status == "completed":
        return {
            "status": "completed",
            "result": record.to_dict()
        }
    elif record.job_status == "failed":
        return {
            "status": "failed",
            "reason": record.job_error or "An unknown scraper pipeline error occurred."
        }
    else:
        return {
            "status": record.job_status
        }

@app.get("/api/history")
async def get_history(db: AsyncSession = Depends(get_db)):
    """Returns the top 10 most recently completed product audits."""
    result = await db.execute(
        select(ProductAnalysis)
        .filter(ProductAnalysis.job_status == "completed")
        .order_by(ProductAnalysis.created_at.desc())
        .limit(10)
    )
    records = result.scalars().all()
    return [r.to_dict() for r in records]

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host=settings.HOST, port=settings.PORT, reload=False)
