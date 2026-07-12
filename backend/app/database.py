import json
from datetime import datetime
from sqlalchemy import Column, String, Float, Integer, DateTime, Text, text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.ext.declarative import declarative_base
from app.config import settings

connect_args = {}

db_url = settings.DATABASE_URL

engine = create_async_engine(db_url, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = async_sessionmaker(autocommit=False, autoflush=False, bind=engine, class_=AsyncSession)
Base = declarative_base()

class ProductAnalysis(Base):
    __tablename__ = "product_analyses"

    id = Column(String, primary_key=True, index=True) # formatted as "shopid_itemid"
    url = Column(String, nullable=False)
    title = Column(String, nullable=True)
    price_str = Column(String, nullable=True)
    
    # AI Output Metrics (Nullable if job is not completed yet)
    sulit_score = Column(Float, nullable=True)
    verdict = Column(String, nullable=True) # e.g. "Worth Buying", "High Risk", etc.
    
    # Store JSON arrays as Text in SQLite
    _pros = Column("pros", Text, nullable=False, default="[]")
    _cons = Column("cons", Text, nullable=False, default="[]")
    _warnings = Column("warnings", Text, nullable=False, default="[]")
    
    # Seller Metadata
    seller_name = Column(String, nullable=True)
    seller_trust = Column(String, nullable=True) # "Trusted Seller", "Moderate Risk", "High Risk"
    seller_rating = Column(Float, nullable=True)
    
    # Price Analysis
    price_status = Column(String, nullable=True) # "Good Deal", "Fair", "Overpriced"
    
    # Scraping Context
    raw_reviews_count = Column(Integer, default=0)
    product_rating = Column(Float, nullable=True)
    product_rating_count = Column(Integer, default=0)
    rating_5_count = Column(Integer, default=0)
    rating_4_count = Column(Integer, default=0)
    rating_3_count = Column(Integer, default=0)
    rating_2_count = Column(Integer, default=0)
    rating_1_count = Column(Integer, default=0)
    
    # Extended Product Intel
    authenticity_score = Column(Integer, default=85)  # 0-100 confidence the product is genuine
    category_tag = Column(String, nullable=True)  # e.g. "Drinkware", "Electronics", "Skincare"
    response_rate = Column(String, nullable=True)  # e.g. "95%", "Chat within minutes"
    _top_quotes = Column("top_quotes", Text, nullable=False, default="[]")  # highlighted buyer snippets
    
    # Async Task Queue State
    job_status = Column(String, default="completed", nullable=False)  # "queued", "processing", "completed", "failed"
    job_error = Column(String, nullable=True)
    scraped_payload = Column(Text, nullable=True)  # Stores frontend scraped JSON while in queue
    
    # Confidence Score Details
    confidence_score = Column(Float, default=1.0, nullable=False)  # 0.0 to 1.0
    confidence_level = Column(String, default="High", nullable=False)  # "High", "Moderate", "Low"
    confidence_reasons = Column(Text, default="[]", nullable=False)  # JSON list of reasoning strings
    
    created_at = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=True)

    # Properties to handle JSON serialization/deserialization transparently
    @property
    def pros(self):
        try:
            return json.loads(self._pros)
        except Exception:
            return []

    @pros.setter
    def pros(self, value):
        self._pros = json.dumps(value)

    @property
    def cons(self):
        try:
            return json.loads(self._cons)
        except Exception:
            return []

    @cons.setter
    def cons(self, value):
        self._cons = json.dumps(value)

    @property
    def warnings(self):
        try:
            return json.loads(self._warnings)
        except Exception:
            return []

    @warnings.setter
    def warnings(self, value):
        self._warnings = json.dumps(value)

    @property
    def top_quotes(self):
        try:
            return json.loads(self._top_quotes)
        except Exception:
            return []

    @top_quotes.setter
    def top_quotes(self, value):
        self._top_quotes = json.dumps(value)

    @property
    def confidence_reasons_list(self):
        try:
            return json.loads(self.confidence_reasons)
        except Exception:
            return []

    @confidence_reasons_list.setter
    def confidence_reasons_list(self, value):
        self.confidence_reasons = json.dumps(value)

    def product_rating_average(self):
        if self.product_rating is not None:
            return round(self.product_rating, 1)

        rating_counts = [
            (5, self.rating_5_count or 0),
            (4, self.rating_4_count or 0),
            (3, self.rating_3_count or 0),
            (2, self.rating_2_count or 0),
            (1, self.rating_1_count or 0),
        ]
        total_reviews = sum(count for _, count in rating_counts)
        if total_reviews == 0:
            return None

        weighted_total = sum(stars * count for stars, count in rating_counts)
        return round(weighted_total / total_reviews, 1)

    def to_dict(self):
        return {
            "id": self.id,
            "url": self.url,
            "title": self.title,
            "priceStr": self.price_str,
            "sulitScore": self.sulit_score if self.sulit_score is not None else 0.0,
            "verdict": self.verdict or "N/A",
            "pros": self.pros,
            "cons": self.cons,
            "warnings": self.warnings,
            "sellerName": self.seller_name or "Shopee Seller",
            "sellerTrust": self.seller_trust or "Moderate Risk",
            "sellerRating": self.seller_rating,
            "productRating": self.product_rating_average(),
            "productRatingCount": self.product_rating_count or self.raw_reviews_count or 0,
            "priceStatus": self.price_status or "Fair",
            "rawReviewsCount": self.raw_reviews_count,
            "rating5Count": self.rating_5_count,
            "rating4Count": self.rating_4_count,
            "rating3Count": self.rating_3_count,
            "rating2Count": self.rating_2_count,
            "rating1Count": self.rating_1_count,
            "authenticityScore": self.authenticity_score if self.authenticity_score is not None else 85,
            "categoryTag": self.category_tag or "General",
            "responseRate": self.response_rate or "N/A",
            "topQuotes": self.top_quotes,
            "jobStatus": self.job_status,
            "jobError": self.job_error,
            "confidence": {
                "score": round(self.confidence_score, 2),
                "level": self.confidence_level,
                "reasons": self.confidence_reasons_list
            },
            "createdAt": self.created_at.isoformat() if self.created_at else None,
            "expiresAt": self.expires_at.isoformat() if self.expires_at else None
        }

async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

async def get_db():
    async with SessionLocal() as db:
        try:
            yield db
        finally:
            await db.close()
