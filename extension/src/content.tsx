import cssText from "data-text:~style.css"
import type { PlasmoCSConfig } from "plasmo"
import React, { useState, useEffect, useRef } from "react"

export const config: PlasmoCSConfig = {
  matches: ["https://shopee.ph/*", "https://*.shopee.ph/*"],
  run_at: "document_start"
}

/**
 * INTERCEPT STRATEGY:
 * Shopee blocks direct API calls to the ratings API with HTTP 403.
 * The fix: inject a script INTO the page's execution context (not the extension
 * isolated world) that monkey-patches window.fetch.
 * Shopee's own JS will call get_ratings with full auth tokens, we intercept
 * the response and pipe it back via window.postMessage.
 * This runs as soon as the content script loads, before any page JS runs.
 */
;(function installSulitRatingInterceptor() {
  const inject = () => {
    try {
      if (document.getElementById('__sulit_interceptor__')) return
      const s = document.createElement('script')
      s.id = '__sulit_interceptor__'
      // This code runs in the PAGE context (has access to Shopee's real fetch with tokens)
      s.textContent = `(function(){
  if(window.__sulitInterceptorReady)return;
  window.__sulitInterceptorReady=true;
  
  // 1. Fetch Interceptor
  var _realFetch=window.fetch;
  window.fetch=function(){
    var a=arguments;
    return _realFetch.apply(this,a).then(function(resp){
      try{
        var url=typeof a[0]==='string'?a[0]:(a[0]&&a[0].url)||'';
        if(url.indexOf('rating')!==-1){
          resp.clone().json().then(function(j){
            if(j&&j.data&&Array.isArray(j.data.ratings)&&j.data.ratings.length>0){
              window.postMessage({__sulitType:'RATINGS',ratings:j.data.ratings},window.location.origin);
              console.log('[SulitAI-PAGE] Intercepted '+j.data.ratings.length+' ratings from fetch: '+url);
            }
          }).catch(function(){});
        }
      }catch(e){}
      return resp;
    });
  };

  // 2. XMLHttpRequest Interceptor
  var _realXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    var xhr = new _realXHR();
    var _open = xhr.open;
    xhr.open = function(method, url) {
      this._url = url;
      return _open.apply(this, arguments);
    };
    xhr.addEventListener('load', function() {
      if (this._url && this._url.indexOf('rating') !== -1) {
        try {
          var j = JSON.parse(this.responseText);
          if(j&&j.data&&Array.isArray(j.data.ratings)&&j.data.ratings.length>0){
            window.postMessage({__sulitType:'RATINGS',ratings:j.data.ratings},window.location.origin);
            console.log('[SulitAI-PAGE] Intercepted '+j.data.ratings.length+' ratings from XHR: '+this._url);
          }
        } catch(e) {}
      }
    });
    return xhr;
  };
  
  console.log('[SulitAI-PAGE] Fetch and XHR interceptors installed.');
})();`
      ;(document.head || document.documentElement).prepend(s)
      s.remove()
    } catch(e) {
      console.warn('[SulitAI] Could not install page interceptor:', e)
    }
  }

  // document.documentElement always exists but head may not be ready yet
  if (document.documentElement) {
    inject()
  } else {
    document.addEventListener('DOMContentLoaded', inject, { once: true })
  }
})()

// Injects Tailwind into Plasmo's Shadow DOM and fixes scaling issues
export const getStyle = (): HTMLStyleElement => {
  const baseFontSize = 16
  let updatedCssText = cssText.replaceAll(":root", ":host(plasmo-csui)")
  const remRegex = /([\d.]+)rem/g
  updatedCssText = updatedCssText.replace(remRegex, (match, remValue) => {
    const pixelsValue = parseFloat(remValue) * baseFontSize
    return `${pixelsValue}px`
  })

  const styleElement = document.createElement("style")
  styleElement.textContent = updatedCssText
  return styleElement
}

// Storage Helpers that seamlessly toggle between Chrome Extension Storage and Web LocalStorage
const getStorageValue = async (key: string, defaultValue: string): Promise<string> => {
  return new Promise((resolve) => {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get([key], (result) => {
        resolve(result[key] || defaultValue)
      })
    } else {
      resolve(localStorage.getItem(key) || defaultValue)
    }
  })
}

const setStorageValue = async (key: string, value: string): Promise<void> => {
  return new Promise((resolve) => {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ [key]: value }, () => {
        resolve()
      })
    } else {
      localStorage.setItem(key, value)
      resolve()
    }
  })
}

interface ReviewQuote {
  author: string
  text: string
  rating: number
}

interface Confidence {
  score: number
  level: string
  reasons: string[]
}

interface AnalysisData {
  id: string
  url: string
  title: string
  priceStr: string
  sulitScore: number
  verdict: string
  pros: string[]
  cons: string[]
  warnings: string[]
  sellerName?: string
  sellerTrust: string
  sellerRating: number
  productRating?: number | null
  productRatingCount?: number
  priceStatus: string
  rawReviewsCount: number
  rating5Count?: number
  rating4Count?: number
  rating3Count?: number
  rating2Count?: number
  rating1Count?: number
  authenticityScore?: number
  categoryTag?: string
  responseRate?: string
  topQuotes?: ReviewQuote[]
  confidence: Confidence
  expiresAt?: string
}

interface BrowserReview {
  author: string
  rating: number
  comment: string
  ctime: number
}

interface BrowserScrapedData {
  id: string
  url: string
  title: string
  price_str: string
  seller_name: string
  seller_rating: number | null
  product_rating: number | null
  product_rating_count: number
  reviews: BrowserReview[]
}

const SulitAIOverlay = () => {
  const [currentUrl, setCurrentUrl] = useState("")
  const [isOpen, setIsOpen] = useState(false)
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle")
  const [loadingStep, setLoadingStep] = useState(0)
  const [errorMsg, setErrorMsg] = useState("")
  const [data, setData] = useState<AnalysisData | null>(null)
  
  // Settings State
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [backendUrl, setBackendUrl] = useState("http://localhost:8000")

  const pollingRef = useRef<boolean>(false)

  const loadingMessages = [
    "Contacting trust gateway...",
    "Hardening evasion sandbox...",
    "Extracting seller reviews corpus...",
    "Running authentic confidence audit...",
    "Calculating composite Sulit Score..."
  ]

  // Detect SPA Route Changes on Shopee using popstate and MutationObserver (CPU load ~0%)
  useEffect(() => {
    const handleUrlChange = () => {
      setCurrentUrl(window.location.href)
    }

    // Capture popstate navigation
    window.addEventListener("popstate", handleUrlChange)

    // Capture pushState / replaceState calls
    const originalPushState = window.history.pushState
    window.history.pushState = function (...args) {
      originalPushState.apply(this, args)
      handleUrlChange()
    }

    const originalReplaceState = window.history.replaceState
    window.history.replaceState = function (...args) {
      originalReplaceState.apply(this, args)
      handleUrlChange()
    }

    // Title observer to handle silent SPA switches
    const observer = new MutationObserver(() => {
      if (window.location.href !== currentUrl) {
        handleUrlChange()
      }
    })
    
    observer.observe(document.querySelector("title") || document.documentElement, {
      subtree: true,
      childList: true
    })

    // Initial load
    setCurrentUrl(window.location.href)

    return () => {
      window.removeEventListener("popstate", handleUrlChange)
      window.history.pushState = originalPushState
      window.history.replaceState = originalReplaceState
      observer.disconnect()
    }
  }, [currentUrl])

  // Load Settings on Start
  useEffect(() => {
    getStorageValue("sulit_backend_url", "http://localhost:8000").then((val) => {
      setBackendUrl(val)
    })
  }, [])

  const isProductPage = (url: string): boolean => {
    return url.includes("-i.") || url.includes("product/")
  }

  const extractShopAndItemId = (url: string): [string | null, string | null] => {
    const modernMatch = url.match(/i\.(\d+)\.(\d+)/)
    if (modernMatch) return [modernMatch[1], modernMatch[2]]

    const legacyMatch = url.match(/product\/(\d+)\/(\d+)/)
    if (legacyMatch) return [legacyMatch[1], legacyMatch[2]]

    return [null, null]
  }

  const readText = (selector: string): string => {
    const element = document.querySelector(selector)
    return element?.textContent?.replace(/\s+/g, " ").trim() || ""
  }

  /**
   * Extracts the product title from Shopee's SPA DOM.
   * Shopee renders the title inside a <span> (not always an <h1>).
   * We try multiple known selectors with descending priority.
   */
  const extractProductTitle = (): string => {
    // Priority 1: Shopee uses a span with data-testid or aria-label on the product title
    const selectors = [
      "h1",
      "[data-testid='pdp-product-title']",
      "[class*='product-name'] span",
      "[class*='pdp-mod-product-badge-title']",
      "[class*='item-title']",
      "._2rn7Bd",        // Shopee PH class (may rotate)
      "._2Cs_Jl",        // Shopee PH class (may rotate)
      "[class*='hT8T-d']",  // Shopee PH class pattern
      "[class*='IZqQmV']",  // Shopee PH class pattern
    ]

    for (const sel of selectors) {
      const el = document.querySelector(sel)
      const txt = el?.textContent?.replace(/\s+/g, " ").trim() || ""
      if (txt && txt.length > 8 && !txt.toLowerCase().includes("shopee")) {
        console.log(`[SulitAI] Title found via selector "${sel}": ${txt.slice(0, 80)}`)
        return txt
      }
    }

    // Priority 2: scan all spans and find the longest visible text that looks like a product name
    const spans = Array.from(document.querySelectorAll("span, p"))
    const candidates = spans
      .map((el) => el.textContent?.replace(/\s+/g, " ").trim() || "")
      .filter((t) => t.length > 20 && t.length < 400 && !t.toLowerCase().includes("shopee") && !/^[\d₱%\s,.+-]+$/.test(t))

    if (candidates.length > 0) {
      console.log(`[SulitAI] Title found via span scan: ${candidates[0].slice(0, 80)}`)
      return candidates[0]
    }

    return ""
  }

  const extractPriceFromPage = (): string => {
    const candidates = Array.from(document.querySelectorAll("div, span"))
      .map((node) => node.textContent?.replace(/\s+/g, " ").trim() || "")
      .filter((text) => /^₱[\d,.]+(?:\s*-\s*₱?[\d,.]+)?$/.test(text))

    return candidates[0] || "N/A"
  }

  const extractVisibleRatingSummary = (): { rating: number | null; count: number } => {
    const bodyText = document.body?.innerText?.replace(/\s+/g, " ") || ""

    // Shopee renders ratings like: "4.8 Ratings | 2.3K Sold" or "4.8 (2,341 Ratings)"
    // Match the star rating (a decimal 1.0-5.0 near the word "Ratings")
    const ratingMatch = bodyText.match(/\b([1-5](?:\.\d{1,2})?)\s*(?:out of 5|\/5|Ratings?|\([\d,.]+\s*Ratings?\))/i)

    // Match the review count number preceding "Ratings"
    const countMatch = bodyText.match(/\b([\d,.]+[Kk]?)\s+Ratings?\b/i)

    const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null
    let count = 0
    if (countMatch) {
      const rawCount = countMatch[1].replace(/,/g, "")
      count = rawCount.toLowerCase().endsWith("k")
        ? Math.round(Number(rawCount.slice(0, -1)) * 1000)
        : Number(rawCount)
    }

    console.log(`[SulitAI] extractVisibleRatingSummary: rating=${rating}, count=${count}`)

    return {
      rating: rating !== null && Number.isFinite(rating) ? rating : null,
      count: Number.isFinite(count) ? count : 0
    }
  }

  const collectShopeePageData = async (targetUrl: string): Promise<BrowserScrapedData | null> => {
    const [shopId, itemId] = extractShopAndItemId(targetUrl)
    if (!shopId || !itemId) {
      console.error("[SulitAI] Could not extract shopId/itemId from URL:", targetUrl)
      return null
    }

    console.log(`[SulitAI] Starting data collection for shopId=${shopId} itemId=${itemId}`)

    // Wait for the DOM to render the product page (up to 8 seconds total)
    let title = ""
    let priceStr = "N/A"
    for (let i = 0; i < 16; i++) {
      title = extractProductTitle()
      priceStr = extractPriceFromPage()
      console.log(`[SulitAI] DOM poll ${i + 1}/16: title="${title.slice(0, 60)}" price="${priceStr}"`)
      if (title && priceStr !== "N/A") break
      await new Promise(r => setTimeout(r, 500))
    }

    // Final title fallback: strip Shopee branding from document.title
    if (!title || title.toLowerCase().includes("shopee")) {
      const rawDocTitle = document.title.replace(/\s*[|–—]\s*Shopee.*$/i, "").trim()
      if (rawDocTitle && rawDocTitle.length > 8) {
        title = rawDocTitle
        console.log(`[SulitAI] Title fallback to document.title: "${title.slice(0, 80)}"`)
      } else {
        console.warn("[SulitAI] WARNING: Could not extract a clean product title from DOM or document.title!")
      }
    }

    const sellerName = readText("a[href*='shop/']") || "Shopee Seller"
    const visibleRating = extractVisibleRatingSummary()
    const reviews: BrowserReview[] = []

    console.log(`[SulitAI] Final title: "${title.slice(0, 80)}" | price: ${priceStr} | seller: ${sellerName}`)
    console.log(`[SulitAI] Visible rating: ${visibleRating.rating} (${visibleRating.count} ratings)`)

    // -----------------------------------------------------------------------
    // INTERCEPT STRATEGY: We do NOT call get_ratings directly (Shopee returns
    // 403 to extension fetch calls). Instead, we wait for Shopee's own JS to
    // fire the request with its auth tokens. Our injected page-context script
    // will catch that response and relay it via window.postMessage.
    // We trigger synthetic scrolls to force the lazy-loaded reviews to load.
    // -----------------------------------------------------------------------
    const interceptedRatings = await new Promise<any[]>((resolve) => {
      // Timeout: if no ratings arrive within 12s, give up gracefully
      const timeoutId = setTimeout(() => {
        window.removeEventListener('message', onMessage)
        console.warn('[SulitAI] Rating interceptor timed out after 12s. Shopee reviews did not load.')
        resolve([])
      }, 12000)

      const onMessage = (event: MessageEvent) => {
        // Only accept messages from Shopee's own page origin
        if (event.origin !== window.location.origin) return
        if (event.data?.__sulitType === 'RATINGS' && Array.isArray(event.data.ratings)) {
          clearTimeout(timeoutId)
          window.removeEventListener('message', onMessage)
          console.log(`[SulitAI] ✅ Intercepted ${event.data.ratings.length} ratings from Shopee's own API call!`)
          resolve(event.data.ratings)
        }
      }

      window.addEventListener('message', onMessage)

      // Scroll down progressively to trigger Shopee's lazy-loaded reviews section.
      const scrollPositions = [400, 900, 1800, 3000, 4800, 6500]
      scrollPositions.forEach((pos, idx) => {
        setTimeout(() => {
          // Attempt to find the review section and scroll directly to it
          const reviewSection = document.querySelector('.product-ratings, #product-ratings, [data-testid="product-ratings"]')
          if (reviewSection) {
             reviewSection.scrollIntoView({ behavior: 'smooth', block: 'start' })
             console.log(`[SulitAI] Found review section, scrolled directly to it (step ${idx + 1})`)
          } else {
             window.scrollTo({ top: pos, behavior: 'smooth' })
             console.log(`[SulitAI] Scrolled to ${pos}px (step ${idx + 1}/${scrollPositions.length})`)
          }
        }, idx * 900)
      })
    })

    for (const r of interceptedRatings) {
      reviews.push({
        author: r.author_username || "anonymous",
        rating: Number(r.rating_star || 0),
        comment: r.comment || "",
        ctime: Number(r.ctime || 0)
      })
    }
    console.log(`[SulitAI] Reviews collected: ${reviews.length}`)

    const payload_summary = {
      id: `${shopId}_${itemId}`,
      title: title.slice(0, 80),
      price_str: priceStr,
      reviews_count: reviews.length
    }
    console.log("[SulitAI] Final payload to backend:", JSON.stringify(payload_summary))

    return {
      id: `${shopId}_${itemId}`,
      url: targetUrl,
      title,
      price_str: priceStr,
      seller_name: sellerName,
      seller_rating: null,
      product_rating: visibleRating.rating,
      product_rating_count: visibleRating.count,
      reviews
    }
  }

  // Trigger analysis when URL changes and it's a product page
  useEffect(() => {
    if (isProductPage(currentUrl)) {
      triggerAnalysis(currentUrl)
    } else {
      setStatus("idle")
      setData(null)
      setIsOpen(false)
      pollingRef.current = false
    }
  }, [currentUrl, backendUrl])

  // Simulate loading stages animation
  useEffect(() => {
    let timer: NodeJS.Timeout
    if (status === "loading") {
      setLoadingStep(0)
      const incrementStep = () => {
        setLoadingStep((prev) => {
          if (prev < loadingMessages.length - 1) {
            timer = setTimeout(incrementStep, 2000)
            return prev + 1
          }
          return prev
        })
      }
      timer = setTimeout(incrementStep, 2000)
    }
    return () => clearTimeout(timer)
  }, [status])

  const triggerAnalysis = async (targetUrl: string) => {
    // Prevent overlapping polling sessions
    pollingRef.current = true
    setStatus("loading")
    setErrorMsg("")
    setData(null)
    
    try {
      const scrapedData = await collectShopeePageData(targetUrl)

      // 1. Submit enqueue request
      const response = await fetch(`${backendUrl}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: targetUrl, scraped_data: scrapedData })
      })

      if (!response.ok) {
        throw new Error(`Trust gateway returned offline code: ${response.status}`)
      }

      const initData = await response.json()
      
      // If immediate Cache Hit was found
      if (initData.status === "completed") {
        if (!pollingRef.current) return
        setData(initData.result)
        setStatus("success")
        setIsOpen(true)
        return
      }

      const jobId = initData.job_id
      let isCompleted = false
      let pollCount = 0
      const maxPolls = 25 // 25 polls * 2s = 50s total timeout
      
      // 2. Poll the status route
      while (pollingRef.current && !isCompleted && pollCount < maxPolls) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        pollCount++
        
        if (!pollingRef.current) return

        const pollResponse = await fetch(`${backendUrl}/api/job/${jobId}`)
        if (!pollResponse.ok) {
          throw new Error(`Polling status check failed: ${pollResponse.status}`)
        }

        const pollData = await pollResponse.json()
        
        if (pollData.status === "completed") {
          setData(pollData.result)
          setStatus("success")
          setIsOpen(true)
          isCompleted = true
        } else if (pollData.status === "failed") {
          throw new Error(pollData.reason || "The scraper pipeline encountered an error.")
        } else if (pollData.status === "processing") {
          setLoadingStep(2) // Move visual text to reviews extraction
        }
      }

      if (pollingRef.current && !isCompleted) {
        throw new Error("Audit timed out: Shopee PH is taking too long to yield reviews payload.")
      }

    } catch (err: any) {
      if (pollingRef.current) {
        console.error("Sulit AI Refactor Error:", err)
        setErrorMsg(err.message || "Failed to establish a connection with the local hardened backend gateway.")
        setStatus("error")
      }
    }
  }

  const saveSettings = async (urlVal: string) => {
    setBackendUrl(urlVal)
    await setStorageValue("sulit_backend_url", urlVal)
    setIsSettingsOpen(false)
  }

  const getScoreColor = (score: number) => {
    if (score >= 8.0) return "plasmo-text-emerald-600 plasmo-border-emerald-500"
    if (score >= 6.0) return "plasmo-text-amber-600 plasmo-border-amber-500"
    return "plasmo-text-rose-600 plasmo-border-rose-500"
  }

  const getVerdictBadge = (verdict: string, score: number) => {
    if (score >= 8.0) return "plasmo-bg-emerald-50 plasmo-text-emerald-700 plasmo-border-emerald-200"
    if (score >= 6.0) return "plasmo-bg-amber-50 plasmo-text-amber-700 plasmo-border-amber-200"
    return "plasmo-bg-rose-50 plasmo-text-rose-700 plasmo-border-rose-200"
  }

  const getSellerTrustIcon = (trust: string) => {
    if (trust === "Trusted Seller") {
      return (
        <span className="plasmo-flex plasmo-items-center plasmo-gap-1.5 plasmo-text-emerald-700 plasmo-bg-emerald-50 plasmo-px-2 plasmo-py-1 plasmo-rounded-md plasmo-text-xs plasmo-font-bold plasmo-border plasmo-border-emerald-200">
          <svg className="plasmo-w-3.5 plasmo-h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          Trusted Seller
        </span>
      )
    } else if (trust === "Moderate Risk") {
      return (
        <span className="plasmo-flex plasmo-items-center plasmo-gap-1.5 plasmo-text-amber-700 plasmo-bg-amber-50 plasmo-px-2 plasmo-py-1 plasmo-rounded-md plasmo-text-xs plasmo-font-bold plasmo-border plasmo-border-amber-200">
          <svg className="plasmo-w-3.5 plasmo-h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          Moderate Risk
        </span>
      )
    } else {
      return (
        <span className="plasmo-flex plasmo-items-center plasmo-gap-1.5 plasmo-text-rose-700 plasmo-bg-rose-50 plasmo-px-2 plasmo-py-1 plasmo-rounded-md plasmo-text-xs plasmo-font-bold plasmo-border plasmo-border-rose-200">
          <svg className="plasmo-w-3.5 plasmo-h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M20.618 5.984A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016zM12 9v2m0 4h.01" />
          </svg>
          High Risk
        </span>
      )
    }
  }

  const getProductRating = (analysis: AnalysisData): number | null => {
    if (typeof analysis.productRating === "number") return analysis.productRating

    const ratingCounts = [
      [5, analysis.rating5Count || 0],
      [4, analysis.rating4Count || 0],
      [3, analysis.rating3Count || 0],
      [2, analysis.rating2Count || 0],
      [1, analysis.rating1Count || 0]
    ]
    const total = ratingCounts.reduce((sum, [, count]) => sum + count, 0)
    if (total === 0) return null

    const weightedTotal = ratingCounts.reduce((sum, [stars, count]) => sum + stars * count, 0)
    return Math.round((weightedTotal / total) * 10) / 10
  }

  const getRatingRows = (analysis: AnalysisData) => {
    const counts = [
      { stars: 5, count: analysis.rating5Count || 0 },
      { stars: 4, count: analysis.rating4Count || 0 },
      { stars: 3, count: analysis.rating3Count || 0 },
      { stars: 2, count: analysis.rating2Count || 0 },
      { stars: 1, count: analysis.rating1Count || 0 }
    ]
    const total = counts.reduce((sum, row) => sum + row.count, 0)

    return counts.map((row) => ({
      ...row,
      percent: total > 0 ? Math.round((row.count / total) * 100) : 0
    }))
  }

  const getImportantFeedback = (analysis: AnalysisData): ReviewQuote | null => {
    return analysis.topQuotes?.find((quote) => quote.text?.trim().length > 0) || null
  }

  if (!isProductPage(currentUrl)) return null

  return (
    <div className="plasmo-font-sans">
      {/* Floating Trigger Trigger */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="plasmo-fixed plasmo-top-[180px] plasmo-right-0 plasmo-z-[99999] plasmo-flex plasmo-items-center plasmo-gap-2 plasmo-bg-[#ee4d2d] hover:plasmo-bg-[#f53d2d] plasmo-text-white plasmo-pl-4 plasmo-pr-3 plasmo-py-2.5 plasmo-rounded-l-full plasmo-shadow-[0_4px_12px_rgba(238,77,45,0.3)] plasmo-transition-all plasmo-duration-200 plasmo-group"
      >
        <span className="plasmo-relative plasmo-flex plasmo-h-2 plasmo-w-2">
          <span className={`plasmo-animate-ping plasmo-absolute plasmo-inline-flex plasmo-h-full plasmo-w-full plasmo-rounded-full ${status === 'loading' ? 'plasmo-bg-orange-200' : 'plasmo-bg-white/70'}`}></span>
          <span className={`plasmo-relative plasmo-inline-flex plasmo-rounded-full plasmo-h-2 plasmo-w-2 ${status === 'loading' ? 'plasmo-bg-orange-100' : 'plasmo-bg-white'}`}></span>
        </span>
        
        {status === "loading" ? (
          <span className="plasmo-text-xs plasmo-font-bold plasmo-text-white">Analyzing...</span>
        ) : (
          <span className="plasmo-text-xs plasmo-font-bold plasmo-tracking-wide plasmo-text-white">SULIT AI</span>
        )}
        
        <svg className={`plasmo-w-4 plasmo-h-4 plasmo-text-white/80 group-hover:plasmo-text-white plasmo-transition-transform plasmo-duration-300 ${isOpen ? 'plasmo-rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      {/* Main Drawer Overlay */}
      <div
        className={`plasmo-fixed plasmo-top-0 plasmo-right-0 plasmo-z-[99998] plasmo-h-screen plasmo-w-[370px] plasmo-bg-white plasmo-border-l plasmo-border-neutral-200 plasmo-shadow-[-5px_0_25px_rgba(0,0,0,0.15)] plasmo-text-neutral-800 plasmo-transition-all plasmo-duration-300 plasmo-ease-in-out plasmo-flex plasmo-flex-col ${
          isOpen ? "plasmo-translate-x-0" : "plasmo-translate-x-full"
        }`}
      >
        {/* Drawer Header */}
        <div className="plasmo-p-4 plasmo-border-b plasmo-border-neutral-200 plasmo-flex plasmo-items-center plasmo-justify-between plasmo-relative plasmo-bg-white">
          <div className="plasmo-flex plasmo-items-center plasmo-gap-2">
            <div className="plasmo-w-7 plasmo-h-7 plasmo-bg-[#ee4d2d] plasmo-rounded-lg plasmo-flex plasmo-items-center plasmo-justify-center plasmo-shadow-[0_2px_8px_rgba(238,77,45,0.25)]">
              <span className="plasmo-font-bold plasmo-text-xs plasmo-text-white">S</span>
            </div>
            <div>
              <h2 className="plasmo-font-bold plasmo-text-sm plasmo-tracking-wide plasmo-text-neutral-800">Sulit AI</h2>
              <span className="plasmo-text-[10px] plasmo-text-[#ee4d2d] plasmo-font-bold plasmo-tracking-wider">PH SHOPPING TRUST</span>
            </div>
          </div>

          <div className="plasmo-flex plasmo-items-center plasmo-gap-1.5">
            <button
              onClick={() => setIsSettingsOpen(!isSettingsOpen)}
              className="plasmo-p-1.5 plasmo-rounded-lg plasmo-bg-neutral-100 hover:plasmo-bg-neutral-200 plasmo-text-neutral-500 hover:plasmo-text-neutral-800 plasmo-transition-colors"
            >
              <svg className="plasmo-w-4 plasmo-h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>

            <button
              onClick={() => triggerAnalysis(currentUrl)}
              disabled={status === "loading"}
              className="plasmo-p-1.5 plasmo-rounded-lg plasmo-bg-neutral-100 hover:plasmo-bg-neutral-200 plasmo-text-neutral-500 hover:plasmo-text-neutral-800 plasmo-transition-colors disabled:plasmo-opacity-50"
            >
              <svg className="plasmo-w-4 plasmo-h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 15H19" />
              </svg>
            </button>

            <button
              onClick={() => {
                pollingRef.current = false
                setIsOpen(false)
              }}
              className="plasmo-p-1.5 plasmo-rounded-lg plasmo-bg-neutral-100 hover:plasmo-bg-neutral-200 plasmo-text-neutral-500 hover:plasmo-text-neutral-800 plasmo-transition-colors"
            >
              <svg className="plasmo-w-4 plasmo-h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Drawer Content Body */}
        <div className="plasmo-flex-1 plasmo-overflow-y-auto plasmo-p-4 plasmo-relative plasmo-bg-white">
          
          {isSettingsOpen ? (
            <div className="plasmo-space-y-4 plasmo-bg-neutral-50 plasmo-p-4 plasmo-rounded-xl plasmo-border plasmo-border-neutral-200">
              <h3 className="plasmo-font-bold plasmo-text-xs plasmo-text-neutral-700 plasmo-tracking-wide plasmo-uppercase">Developer Settings</h3>
              
              <div className="plasmo-space-y-2">
                <label className="plasmo-block plasmo-text-xs plasmo-text-neutral-500">FastAPI Backend URL</label>
                <input
                  type="text"
                  value={backendUrl}
                  onChange={(e) => setBackendUrl(e.target.value)}
                  className="plasmo-w-full plasmo-bg-white plasmo-border plasmo-border-neutral-200 focus:plasmo-border-[#ee4d2d] plasmo-text-neutral-800 plasmo-px-3 plasmo-py-2 plasmo-rounded-lg plasmo-text-xs plasmo-outline-none"
                />
              </div>

              <div className="plasmo-flex plasmo-gap-2 plasmo-pt-2">
                <button
                  onClick={() => saveSettings(backendUrl)}
                  className="plasmo-flex-1 plasmo-bg-[#ee4d2d] hover:plasmo-bg-[#f53d2d] plasmo-text-white plasmo-font-bold plasmo-text-xs plasmo-py-2 plasmo-rounded-lg plasmo-transition-colors"
                >
                  Save settings
                </button>
                <button
                  onClick={() => setIsSettingsOpen(false)}
                  className="plasmo-flex-1 plasmo-bg-neutral-200 hover:plasmo-bg-neutral-300 plasmo-text-neutral-700 plasmo-font-semibold plasmo-text-xs plasmo-py-2 plasmo-rounded-lg plasmo-transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* LOADING STATE - Polling Progress */}
              {status === "loading" && (
                <div className="plasmo-space-y-5 plasmo-animate-pulse">
                  <div className="plasmo-flex plasmo-flex-col plasmo-items-center plasmo-justify-center plasmo-py-6">
                    <div className="plasmo-w-28 plasmo-h-28 plasmo-rounded-full plasmo-bg-neutral-50 plasmo-border-4 plasmo-border-neutral-200 plasmo-flex plasmo-items-center plasmo-justify-center">
                      <div className="plasmo-w-10 plasmo-h-6 plasmo-bg-neutral-200 plasmo-rounded" />
                    </div>
                    <div className="plasmo-w-24 plasmo-h-4 plasmo-bg-neutral-200 plasmo-rounded plasmo-mt-4" />
                  </div>

                  <div className="plasmo-bg-neutral-50 plasmo-border plasmo-border-neutral-200 plasmo-p-4 plasmo-rounded-xl plasmo-flex plasmo-items-center plasmo-gap-3">
                    <svg className="plasmo-animate-spin plasmo-h-4 plasmo-w-4 plasmo-text-[#ee4d2d]" fill="none" viewBox="0 0 24 24">
                      <circle className="plasmo-opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="plasmo-opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span className="plasmo-text-xs plasmo-text-neutral-600 plasmo-font-bold">
                      {loadingMessages[loadingStep]}
                    </span>
                  </div>

                  <div className="plasmo-space-y-3">
                    <div className="plasmo-h-16 plasmo-bg-neutral-50 plasmo-rounded-xl" />
                    <div className="plasmo-h-24 plasmo-bg-neutral-50 plasmo-rounded-xl" />
                  </div>
                </div>
              )}

              {/* TRUTH-FIRST HONEST ERROR STATE */}
              {status === "error" && (
                <div className="plasmo-text-center plasmo-py-6 plasmo-space-y-4">
                  <div className="plasmo-w-14 plasmo-h-14 plasmo-bg-rose-50 plasmo-border plasmo-border-rose-100 plasmo-rounded-full plasmo-flex plasmo-items-center plasmo-justify-center plasmo-mx-auto">
                    <svg className="plasmo-w-7 plasmo-h-7 plasmo-text-rose-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                  </div>
                  <div className="plasmo-space-y-2">
                    <h3 className="plasmo-font-black plasmo-text-sm plasmo-text-neutral-800">Scraping Access Blocked</h3>
                    <p className="plasmo-text-xs plasmo-text-neutral-500 plasmo-leading-relaxed plasmo-px-4">
                      {errorMsg}
                    </p>
                    <div className="plasmo-p-3 plasmo-bg-neutral-50 plasmo-border plasmo-border-neutral-200 plasmo-rounded-lg plasmo-text-[10px] plasmo-text-neutral-400 plasmo-text-left plasmo-leading-normal">
                      <strong>Why did this happen?</strong> Shopee Philippines deploys high-security anti-bot challenges (Cloudflare gates). Our crawler was flagged during execution. We never synthesize fake reviews to preserve analysis integrity.
                    </div>
                  </div>
                  <div className="plasmo-pt-2">
                    <button
                      onClick={() => triggerAnalysis(currentUrl)}
                      className="plasmo-px-4 plasmo-py-2.5 plasmo-bg-[#ee4d2d] hover:plasmo-bg-[#f53d2d] plasmo-text-white plasmo-text-xs plasmo-font-bold plasmo-rounded-lg plasmo-transition-colors plasmo-shadow-md"
                    >
                      Retry Trust Audit
                    </button>
                  </div>
                </div>
              )}

              {/* SUCCESS STATE */}
              {status === "success" && data && (
                <div className="plasmo-space-y-4">
                  {(() => {
                    const productRating = getProductRating(data)
                    const importantFeedback = getImportantFeedback(data)
                    const ratingRows = getRatingRows(data)

                    return (
                      <>
                  
                  {/* Product Details Header */}
                  <div className="plasmo-bg-neutral-50 plasmo-border plasmo-border-neutral-200 plasmo-p-3.5 plasmo-rounded-xl">
                    <h3 className="plasmo-text-xs plasmo-font-bold plasmo-text-neutral-800 plasmo-line-clamp-2 plasmo-leading-normal">
                      {data.title}
                    </h3>
                    <div className="plasmo-flex plasmo-items-baseline plasmo-gap-1.5 plasmo-mt-1.5">
                      <span className="plasmo-text-[#ee4d2d] plasmo-text-base plasmo-font-black">{data.priceStr}</span>
                    </div>
                    
                    <div className="plasmo-flex plasmo-items-center plasmo-justify-between plasmo-mt-2.5 plasmo-pt-2.5 plasmo-border-t plasmo-border-neutral-200/60 plasmo-text-[10px] plasmo-text-neutral-500">
                      <span className="plasmo-font-semibold plasmo-text-neutral-700 plasmo-truncate plasmo-max-w-[150px]">{data.sellerName}</span>
                      
                      {data.sellerRating && (
                        <div className="plasmo-flex plasmo-items-center plasmo-gap-0.5">
                          <span className="plasmo-text-[#ffc107]">★</span>
                          <span className="plasmo-font-bold plasmo-text-neutral-700">{data.sellerRating.toFixed(1)}</span>
                          <span className="plasmo-text-neutral-400">/5.0</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Circular Trust Dial */}
                  <div className="plasmo-flex plasmo-flex-col plasmo-items-center plasmo-justify-center plasmo-py-3">
                    <div className="plasmo-relative plasmo-w-28 plasmo-h-28 plasmo-flex plasmo-items-center plasmo-justify-center">
                      <div className="plasmo-absolute plasmo-inset-0 plasmo-rounded-full plasmo-border-[6px] plasmo-border-neutral-100 plasmo-shadow-inner"></div>
                      <div className={`plasmo-absolute plasmo-inset-0 plasmo-rounded-full plasmo-border-[6px] ${getScoreColor(data.sulitScore)}`}></div>
                      
                      <div className="plasmo-text-center plasmo-z-10">
                        <span className="plasmo-text-3xl plasmo-font-black plasmo-tracking-tighter plasmo-text-neutral-800">
                          {data.sulitScore.toFixed(1)}
                        </span>
                        <div className="plasmo-text-[9px] plasmo-font-bold plasmo-text-neutral-400 plasmo-tracking-widest plasmo-uppercase plasmo-mt-[-3px]">SCORE</div>
                      </div>
                    </div>

                    <span className={`plasmo-mt-4 plasmo-px-4 plasmo-py-1.5 plasmo-rounded-full plasmo-text-xs plasmo-font-black plasmo-tracking-wide plasmo-border ${getVerdictBadge(data.verdict, data.sulitScore)}`}>
                      {data.verdict.toUpperCase()}
                    </span>
                    
                    <p className="plasmo-text-[11px] plasmo-text-neutral-500 plasmo-mt-2.5 plasmo-text-center plasmo-px-8 plasmo-leading-relaxed">
                      Found <span className="plasmo-text-neutral-800 plasmo-font-semibold">{data.productRatingCount || data.rawReviewsCount || 0} Shopee ratings</span>
                      {data.rawReviewsCount > 0 ? (
                        <> and audited <span className="plasmo-text-neutral-800 plasmo-font-semibold">{data.rawReviewsCount} buyer comments</span>.</>
                      ) : (
                        <>. Buyer comments were not exposed to the extension.</>
                      )}
                    </p>
                  </div>

                  {/* Product Ratings */}
                  <div className="plasmo-bg-neutral-50 plasmo-border plasmo-border-neutral-200 plasmo-p-3.5 plasmo-rounded-xl plasmo-space-y-3">
                    <div className="plasmo-flex plasmo-items-center plasmo-justify-between">
                      <div>
                        <h4 className="plasmo-text-xs plasmo-font-black plasmo-uppercase plasmo-tracking-wider plasmo-text-neutral-800">Product Ratings</h4>
                        <p className="plasmo-text-[10px] plasmo-text-neutral-400 plasmo-mt-0.5">
                          Based on visible Shopee rating data
                        </p>
                      </div>
                      <div className="plasmo-flex plasmo-items-center plasmo-gap-1.5 plasmo-bg-white plasmo-border plasmo-border-neutral-200 plasmo-rounded-lg plasmo-px-2.5 plasmo-py-1.5">
                        <span className="plasmo-text-[#ffc107] plasmo-text-sm">★</span>
                        <span className="plasmo-text-sm plasmo-font-black plasmo-text-neutral-800">
                          {productRating !== null ? productRating.toFixed(1) : "N/A"}
                        </span>
                        <span className="plasmo-text-[10px] plasmo-text-neutral-400">/5</span>
                      </div>
                    </div>

                    <div className="plasmo-space-y-1.5">
                      {ratingRows.map((row) => (
                        <div key={row.stars} className="plasmo-grid plasmo-grid-cols-[28px_1fr_34px] plasmo-items-center plasmo-gap-2">
                          <span className="plasmo-text-[10px] plasmo-font-bold plasmo-text-neutral-500">{row.stars}★</span>
                          <div className="plasmo-h-1.5 plasmo-bg-neutral-200 plasmo-rounded-full plasmo-overflow-hidden">
                            <div
                              className="plasmo-h-full plasmo-bg-[#ee4d2d] plasmo-rounded-full"
                              style={{ width: `${row.percent}%` }}
                            />
                          </div>
                          <span className="plasmo-text-[10px] plasmo-text-neutral-400 plasmo-text-right">{row.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Important Buyer Feedback */}
                  {importantFeedback && (
                    <div className="plasmo-bg-white plasmo-border plasmo-border-neutral-200 plasmo-p-3.5 plasmo-rounded-xl plasmo-space-y-2">
                      <div className="plasmo-flex plasmo-items-center plasmo-justify-between">
                        <h4 className="plasmo-text-xs plasmo-font-black plasmo-uppercase plasmo-tracking-wider plasmo-text-neutral-800">Important Buyer Feedback</h4>
                        <div className="plasmo-flex plasmo-items-center plasmo-gap-0.5">
                          {Array.from({ length: 5 }).map((_, starIdx) => (
                            <span key={starIdx} className={`plasmo-text-[10px] ${starIdx < importantFeedback.rating ? 'plasmo-text-[#ffc107]' : 'plasmo-text-neutral-200'}`}>★</span>
                          ))}
                        </div>
                      </div>
                      <p className="plasmo-text-[11px] plasmo-text-neutral-600 plasmo-leading-relaxed">
                        "{importantFeedback.text}"
                      </p>
                      <span className="plasmo-block plasmo-text-[10px] plasmo-font-bold plasmo-text-neutral-400">
                        {importantFeedback.author}
                      </span>
                    </div>
                  )}

                  {/* HONEST CONFIDENCE AUDIT GAUGE */}
                  {data.confidence && (
                    <div className="plasmo-bg-neutral-50 plasmo-border plasmo-border-neutral-200 plasmo-p-3.5 plasmo-rounded-xl plasmo-space-y-2.5">
                      <div className="plasmo-flex plasmo-items-center plasmo-justify-between">
                        <div className="plasmo-flex plasmo-items-center plasmo-gap-1.5 plasmo-text-neutral-800">
                          <svg className="plasmo-w-4 plasmo-h-4 plasmo-text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                          </svg>
                          <h4 className="plasmo-text-xs plasmo-font-black plasmo-uppercase plasmo-tracking-wider">Intelligence Confidence</h4>
                        </div>
                        <span className={`plasmo-px-2.5 plasmo-py-0.5 plasmo-rounded-full plasmo-text-[10px] plasmo-font-black plasmo-border ${
                          data.confidence.level === 'High' 
                            ? 'plasmo-bg-emerald-50 plasmo-text-emerald-700 plasmo-border-emerald-200' 
                            : data.confidence.level === 'Moderate'
                            ? 'plasmo-bg-amber-50 plasmo-text-amber-700 plasmo-border-amber-200'
                            : 'plasmo-bg-rose-50 plasmo-text-rose-700 plasmo-border-rose-200'
                        }`}>
                          {data.confidence.level} ({Math.round(data.confidence.score * 100)}%)
                        </span>
                      </div>
                      
                      {/* Reason list */}
                      <ul className="plasmo-space-y-1.5">
                        {data.confidence.reasons.map((r, idx) => (
                          <li key={idx} className="plasmo-text-[10px] plasmo-text-neutral-500 plasmo-leading-normal plasmo-flex plasmo-items-start plasmo-gap-1.5">
                            <span className="plasmo-text-neutral-400 plasmo-font-black">•</span>
                            <span>{r}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Summary Metric Badges */}
                  <div className="plasmo-grid plasmo-grid-cols-2 plasmo-gap-2.5">
                    <div className="plasmo-bg-neutral-50 plasmo-border plasmo-border-neutral-200 plasmo-p-3 plasmo-rounded-xl plasmo-flex plasmo-flex-col plasmo-justify-between">
                      <span className="plasmo-text-[10px] plasmo-font-semibold plasmo-text-neutral-400 plasmo-uppercase plasmo-tracking-wider">Seller Trust</span>
                      <div className="plasmo-mt-1.5">{getSellerTrustIcon(data.sellerTrust)}</div>
                    </div>

                    <div className="plasmo-bg-neutral-50 plasmo-border plasmo-border-neutral-200 plasmo-p-3 plasmo-rounded-xl plasmo-flex plasmo-flex-col plasmo-justify-between">
                      <span className="plasmo-text-[10px] plasmo-font-semibold plasmo-text-neutral-400 plasmo-uppercase plasmo-tracking-wider">Price Value</span>
                      <div className="plasmo-mt-1.5">
                        <span className={`plasmo-inline-block plasmo-px-2.5 plasmo-py-1 plasmo-rounded-md plasmo-text-xs plasmo-font-bold plasmo-border ${
                          data.priceStatus === 'Good Deal' 
                            ? 'plasmo-bg-emerald-50 plasmo-text-emerald-700 plasmo-border-emerald-200' 
                            : data.priceStatus === 'Fair' 
                            ? 'plasmo-bg-amber-50 plasmo-text-amber-700 plasmo-border-amber-200' 
                            : 'plasmo-bg-rose-50 plasmo-text-rose-700 plasmo-border-rose-200'
                        }`}>
                          {data.priceStatus}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* WARNINGS PANEL */}
                  {data.warnings && data.warnings.length > 0 && (
                    <div className="plasmo-bg-amber-50 plasmo-border plasmo-border-amber-200 plasmo-p-3.5 plasmo-rounded-xl plasmo-space-y-2">
                      <div className="plasmo-flex plasmo-items-center plasmo-gap-1.5 plasmo-text-amber-600">
                        <svg className="plasmo-w-4 plasmo-h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        <h4 className="plasmo-text-xs plasmo-font-black plasmo-uppercase plasmo-tracking-wider">Risk Warnings</h4>
                      </div>
                      <ul className="plasmo-space-y-1.5">
                        {data.warnings.map((w, idx) => (
                          <li key={idx} className="plasmo-text-[11px] plasmo-text-amber-800/90 plasmo-leading-relaxed plasmo-flex plasmo-items-start plasmo-gap-1.5">
                            <span className="plasmo-text-amber-500 plasmo-font-bold plasmo-select-none">•</span>
                            <span>{w}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* PROS & CONS */}
                  <div className="plasmo-space-y-3">
                    <div className="plasmo-bg-emerald-50/40 plasmo-border plasmo-border-emerald-100 plasmo-p-3.5 plasmo-rounded-xl plasmo-space-y-2">
                      <div className="plasmo-flex plasmo-items-center plasmo-gap-1.5 plasmo-text-emerald-700">
                        <svg className="plasmo-w-4 plasmo-h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <h4 className="plasmo-text-xs plasmo-font-black plasmo-uppercase plasmo-tracking-wider">Consensus Pros</h4>
                      </div>
                      <ul className="plasmo-space-y-1.5">
                        {data.pros.map((p, idx) => (
                          <li key={idx} className="plasmo-text-[11px] plasmo-text-neutral-700 plasmo-leading-relaxed plasmo-flex plasmo-items-start plasmo-gap-1.5">
                            <span className="plasmo-text-emerald-600 plasmo-font-bold plasmo-select-none">+</span>
                            <span>{p}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className="plasmo-bg-rose-50/40 plasmo-border plasmo-border-rose-100 plasmo-p-3.5 plasmo-rounded-xl plasmo-space-y-2">
                      <div className="plasmo-flex plasmo-items-center plasmo-gap-1.5 plasmo-text-rose-700">
                        <svg className="plasmo-w-4 plasmo-h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 12H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <h4 className="plasmo-text-xs plasmo-font-black plasmo-uppercase plasmo-tracking-wider">Consensus Cons</h4>
                      </div>
                      <ul className="plasmo-space-y-1.5">
                        {data.cons.map((c, idx) => (
                          <li key={idx} className="plasmo-text-[11px] plasmo-text-neutral-700 plasmo-leading-relaxed plasmo-flex plasmo-items-start plasmo-gap-1.5">
                            <span className="plasmo-text-rose-600 plasmo-font-bold plasmo-select-none">-</span>
                            <span>{c}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  {/* Highlights */}
                  {data.topQuotes && data.topQuotes.length > 0 && (
                    <div className="plasmo-bg-neutral-50 plasmo-border plasmo-border-neutral-200 plasmo-p-3.5 plasmo-rounded-xl plasmo-space-y-2.5">
                      <div className="plasmo-flex plasmo-items-center plasmo-gap-1.5 plasmo-text-neutral-800">
                        <svg className="plasmo-w-4 plasmo-h-4 plasmo-text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                        </svg>
                        <h4 className="plasmo-text-xs plasmo-font-black plasmo-uppercase plasmo-tracking-wider">Highlighted Reviews</h4>
                      </div>
                      <div className="plasmo-space-y-2">
                        {data.topQuotes.map((quote, idx) => (
                          <div key={idx} className="plasmo-bg-white plasmo-border plasmo-border-neutral-100 plasmo-p-2.5 plasmo-rounded-lg">
                            <div className="plasmo-flex plasmo-items-center plasmo-justify-between plasmo-mb-1">
                              <span className="plasmo-text-[10px] plasmo-font-bold plasmo-text-neutral-500">{quote.author}</span>
                              <div className="plasmo-flex plasmo-items-center plasmo-gap-0.5">
                                {Array.from({ length: 5 }).map((_, starIdx) => (
                                  <span key={starIdx} className={`plasmo-text-[10px] ${starIdx < quote.rating ? 'plasmo-text-[#ffc107]' : 'plasmo-text-neutral-200'}`}>★</span>
                                ))}
                              </div>
                            </div>
                            <p className="plasmo-text-[11px] plasmo-text-neutral-600 plasmo-leading-relaxed plasmo-italic">
                              "{quote.text}"
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Cache Metadata Info */}
                  {data.expiresAt && (
                    <div className="plasmo-text-center plasmo-text-[9px] plasmo-text-neutral-400">
                      Active cache. Next scheduled audit: {new Date(data.expiresAt).toLocaleTimeString()}
                    </div>
                  )}

                      </>
                    )
                  })()}

                </div>
              )}
            </>
          )}

        </div>

        {/* Drawer Footer Branding */}
        <div className="plasmo-p-3.5 plasmo-border-t plasmo-border-neutral-200 plasmo-flex plasmo-items-center plasmo-justify-between plasmo-bg-neutral-50">
          <span className="plasmo-text-[9px] plasmo-text-neutral-400 plasmo-font-bold">SULIT AI • VER. 2.0.0 (STEALTH)</span>
          
          <div className="plasmo-flex plasmo-items-center plasmo-gap-1">
            <span className="plasmo-text-[9px] plasmo-text-neutral-400 plasmo-font-bold">PH TRUTH FIRST</span>
            <span className="plasmo-inline-flex plasmo-text-[9px] plasmo-rounded-sm plasmo-overflow-hidden">🇵🇭</span>
          </div>
        </div>

      </div>
    </div>
  )
}

export default SulitAIOverlay
