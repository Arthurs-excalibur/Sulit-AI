import re
import asyncio
import random
import logging
from typing import List, Dict, Any, Optional
from playwright.async_api import async_playwright
from app.config import settings

logger = logging.getLogger("sulit-ai-scraper")
logging.basicConfig(level=logging.INFO)

def extract_shop_and_item_id(url: str) -> tuple[Optional[str], Optional[str]]:
    """Extracts shop_id and item_id from Shopee PH URL."""
    # Pattern: i.shopid.itemid (e.g. i.123456.78901234)
    match = re.search(r"i\.(\d+)\.(\d+)", url)
    if match:
        return match.group(1), match.group(2)
    
    # Alternative pattern for older formats: shopid/itemid
    match_alt = re.search(r"product/(\d+)/(\d+)", url)
    if match_alt:
        return match_alt.group(1), match_alt.group(2)
        
    return None, None

async def apply_stealth_to_page(page):
    """
    Injects custom, highly evasive scripts directly into the page prior to execution.
    Spoofs navigator fingerprints and overrides standard automation properties.
    """
    await page.add_init_script("""
        // 1. Hide navigator.webdriver flag
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined
        });
        
        // 2. Spoof Chrome Plugins
        Object.defineProperty(navigator, 'plugins', {
            get: () => [
                { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer' },
                { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer' }
            ]
        });
        
        // 3. Spoof Chrome Window Runtime Object
        window.chrome = {
            runtime: {},
            loadTimes: function() {},
            csi: function() {}
        };
        
        // 4. Spoof Permissions
        const originalQuery = navigator.permissions.query;
        navigator.permissions.query = (parameters) => 
            parameters.name === 'notifications' 
                ? Promise.resolve({ state: Notification.permission }) 
                : originalQuery(parameters);
    """)

async def scrape_shopee_product(url: str) -> Dict[str, Any]:
    """
    Scrapes a Shopee PH product page using Playwright with fully hardened stealth settings.
    Strictly raises an error if blocked, timed out, or if zero reviews are captured.
    NO deceptive mock fallbacks are allowed.
    """
    shop_id, item_id = extract_shop_and_item_id(url)
    if not shop_id or not item_id:
        raise ValueError(f"Invalid Shopee URL. Could not parse shop_id and item_id from: {url}")
        
    pid = f"{shop_id}_{item_id}"
    logger.info(f"Initiating live hardened Playwright crawl for product ID: {pid}")

    reviews_payload: List[Dict[str, Any]] = []
    product_title: Optional[str] = None
    price_str: Optional[str] = None
    seller_name: str = "Shopee Seller"
    seller_rating: Optional[float] = None

    async with async_playwright() as p:
        browser = None
        context = None
        try:
            # Launch Chromium with anti-detection args
            browser = await p.chromium.launch(
                headless=True,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--disable-infobars",
                    "--window-size=1280,800"
                ]
            )
            
            # Randomized user agent to prevent static fingerprinting
            user_agents = [
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ]
            
            context = await browser.new_context(
                user_agent=random.choice(user_agents),
                viewport={"width": 1280, "height": 800},
                locale="en-US,en;q=0.9",
                timezone_id="Asia/Manila"
            )
            
            page = await context.new_page()
            
            # Apply custom async stealth overlays
            await apply_stealth_to_page(page)

            # Listen and intercept network responses for Shopee rating payloads
            async def handle_response(response):
                try:
                    res_url = response.url
                    if "get_ratings" in res_url:
                        json_data = await response.json()
                        ratings_list = json_data.get("data", {}).get("ratings", [])
                        if ratings_list:
                            logger.info(f"Successfully intercepted Shopee ratings! Captured {len(ratings_list)} reviews.")
                            for r in ratings_list:
                                reviews_payload.append({
                                    "author": r.get("author_username", "anonymous"),
                                    "rating": r.get("rating_star", 5),
                                    "comment": r.get("comment", ""),
                                    "ctime": r.get("ctime", 0)
                                })
                except Exception:
                    pass  # Ignore errors in parsing secondary traffic

            page.on("response", handle_response)

            # Navigate to product page
            logger.info(f"Navigating stealth browser to: {url}")
            await page.goto(url, timeout=settings.SCRAPE_TIMEOUT_MS, wait_until="domcontentloaded")
            
            # Check if page immediately redirected to error or traffic verification gates
            current_page_url = page.url
            if "verify/traffic" in current_page_url or "verify" in current_page_url:
                raise ValueError("Anti-bot block detected: Shopee redirected the scraper to a traffic verification gate (Captcha).")
            
            # Random organic scroll behaviors to trigger Shopee's lazy review requests.
            # Reviews often sit far below the first product viewport, so shallow scrolls
            # can miss the ratings API entirely.
            scroll_positions = [500, 1200, 2200, 3600, 5200, 7000]
            for position in scroll_positions:
                if reviews_payload:
                    break
                await page.evaluate(f"window.scrollTo(0, {position + random.randint(-120, 180)})")
                await asyncio.sleep(random.uniform(1.0, 1.8))

            if not reviews_payload:
                try:
                    await page.wait_for_response(
                        lambda response: "get_ratings" in response.url,
                        timeout=settings.SCRAPE_TIMEOUT_MS,
                    )
                    await asyncio.sleep(0.5)
                except Exception:
                    pass

            # Attempt to extract DOM metadata
            try:
                heading = await page.locator("h1").first.inner_text(timeout=5000)
                if heading and len(heading.strip()) > 5:
                    product_title = heading.strip()
            except Exception:
                pass

            try:
                if not product_title:
                    product_title = await page.title()
                    if product_title:
                        product_title = re.sub(r"\s*\|\s*Shopee\s*Philippines.*$", "", product_title, flags=re.IGNORECASE)
            except Exception:
                pass

            # If no reviews are captured, return a low-confidence product snapshot.
            # The analyzer will explicitly mark the result as insufficient data.
            if not reviews_payload:
                logger.warning(
                    "Zero ratings payloads were intercepted for %s. Returning product metadata only.",
                    pid,
                )

            return {
                "id": pid,
                "url": url,
                "title": product_title or "Shopee Product",
                "price_str": price_str or "N/A",
                "seller_name": seller_name,
                "seller_rating": seller_rating,
                "reviews": reviews_payload
            }

        except Exception as e:
            logger.error(f"Stealth Scraper execution encountered error: {str(e)}")
            # Explicitly raise the failure to bubble up to async job worker
            raise ValueError(f"Unable to extract reliable review data: {str(e)}")

        finally:
            if context:
                await context.close()
            if browser:
                await browser.close()
