import os
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional

class Settings(BaseSettings):
    # App Settings
    APP_NAME: str = "Sulit AI Backend"
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    

    
    # DB Settings
    DATABASE_URL: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/sulit_ai"
    
    # AI API Keys
    GEMINI_API_KEY: Optional[str] = None
    OPENAI_API_KEY: Optional[str] = None
    
    # Playwright Settings
    SCRAPE_TIMEOUT_MS: int = 15000
    
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )

settings = Settings()
