import React, { useState, useEffect } from "react"
import "~style.css"

// Storage helpers matching content script
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

interface HistoryItem {
  id: string
  url: string
  title: string
  priceStr: string
  sulitScore: number
  verdict: string
  sellerName?: string
  sellerTrust: string
  productRating?: number | null
  productRatingCount?: number
  rawReviewsCount?: number
  topQuotes?: {
    author: string
    text: string
    rating: number
  }[]
}

function IndexPopup() {
  const [backendUrl, setBackendUrl] = useState("http://localhost:8000")
  const [status, setStatus] = useState<"idle" | "connected" | "disconnected">("idle")
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [activeTab, setActiveTab] = useState<"history" | "settings">("history")
  const [isSaving, setIsSaving] = useState(false)

  // Fetch Connection status & history
  useEffect(() => {
    getStorageValue("sulit_backend_url", "http://localhost:8000").then((url) => {
      setBackendUrl(url)
      checkStatusAndHistory(url)
    })
  }, [])

  const checkStatusAndHistory = async (url: string) => {
    try {
      // 1. Check status
      const statusRes = await fetch(`${url}/api/status`)
      if (statusRes.ok) {
        setStatus("connected")
      } else {
        setStatus("disconnected")
      }

      // 2. Fetch history
      const historyRes = await fetch(`${url}/api/history`)
      if (historyRes.ok) {
        const historyData = await historyRes.json()
        setHistory(historyData)
      }
    } catch (err) {
      setStatus("disconnected")
    }
  }

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSaving(true)
    await setStorageValue("sulit_backend_url", backendUrl)
    await checkStatusAndHistory(backendUrl)
    setTimeout(() => {
      setIsSaving(false)
      setActiveTab("history")
    }, 800)
  }

  const getScoreColor = (score: number) => {
    if (score >= 8.0) return "plasmo-text-emerald-700 plasmo-border-emerald-200 plasmo-bg-emerald-50"
    if (score >= 6.0) return "plasmo-text-amber-700 plasmo-border-amber-200 plasmo-bg-amber-50"
    return "plasmo-text-rose-700 plasmo-border-rose-200 plasmo-bg-rose-50"
  }

  const getImportantFeedback = (item: HistoryItem): string | null => {
    const quote = item.topQuotes?.find((candidate) => candidate.text?.trim().length > 0)
    return quote?.text || null
  }

  return (
    <div className="plasmo-w-[340px] plasmo-h-[460px] plasmo-bg-white plasmo-text-neutral-800 plasmo-flex plasmo-flex-col plasmo-font-sans plasmo-relative plasmo-overflow-hidden">
      
      {/* Popup Header */}
      <div className="plasmo-p-4 plasmo-border-b plasmo-border-neutral-200 plasmo-flex plasmo-items-center plasmo-justify-between">
        <div className="plasmo-flex plasmo-items-center plasmo-gap-2">
          <div className="plasmo-w-6 plasmo-h-6 plasmo-bg-[#ee4d2d] plasmo-rounded-md plasmo-flex plasmo-items-center plasmo-justify-center">
            <span className="plasmo-font-bold plasmo-text-[10px] plasmo-text-white">S</span>
          </div>
          <div>
            <h1 className="plasmo-font-bold plasmo-text-xs plasmo-tracking-wide plasmo-text-neutral-800">Sulit AI Dashboard</h1>
            <span className="plasmo-text-[9px] plasmo-text-neutral-400">Philippines Shopping Intelligence</span>
          </div>
        </div>

        {/* Server Connection Status Dot */}
        <div className="plasmo-flex plasmo-items-center plasmo-gap-1.5 plasmo-bg-neutral-50 plasmo-px-2.5 plasmo-py-1 plasmo-rounded-full plasmo-border plasmo-border-neutral-200">
          <span className={`plasmo-h-1.5 plasmo-w-1.5 plasmo-rounded-full ${
            status === 'connected' ? 'plasmo-bg-emerald-500' : 'plasmo-bg-rose-500'
          }`} />
          <span className="plasmo-text-[9px] plasmo-font-bold plasmo-text-neutral-600">
            {status === "connected" ? "Active" : "Offline"}
          </span>
        </div>
      </div>

      {/* Tabs Menu */}
      <div className="plasmo-flex plasmo-bg-neutral-50 plasmo-border-b plasmo-border-neutral-200">
        <button
          onClick={() => setActiveTab("history")}
          className={`plasmo-flex-1 plasmo-py-2.5 plasmo-text-center plasmo-text-[10px] plasmo-font-bold plasmo-tracking-wide plasmo-uppercase plasmo-border-b-2 plasmo-transition-all ${
            activeTab === 'history' 
              ? 'plasmo-text-[#ee4d2d] plasmo-border-[#ee4d2d]' 
              : 'plasmo-text-neutral-400 plasmo-border-transparent hover:plasmo-text-neutral-600'
          }`}
        >
          Recent Audits
        </button>
        <button
          onClick={() => setActiveTab("settings")}
          className={`plasmo-flex-1 plasmo-py-2.5 plasmo-text-center plasmo-text-[10px] plasmo-font-bold plasmo-tracking-wide plasmo-uppercase plasmo-border-b-2 plasmo-transition-all ${
            activeTab === 'settings' 
              ? 'plasmo-text-[#ee4d2d] plasmo-border-[#ee4d2d]' 
              : 'plasmo-text-neutral-400 plasmo-border-transparent hover:plasmo-text-neutral-600'
          }`}
        >
          Extension Settings
        </button>
      </div>

      {/* Panel Scroll Container */}
      <div className="plasmo-flex-1 plasmo-overflow-y-auto plasmo-p-4 plasmo-bg-white">
        
        {/* TAB 1: HISTORY STREAM */}
        {activeTab === "history" && (
          <div className="plasmo-space-y-3">
            {history.length === 0 ? (
              <div className="plasmo-text-center plasmo-py-12 plasmo-space-y-4">
                <div className="plasmo-w-10 plasmo-h-10 plasmo-bg-neutral-50 plasmo-rounded-full plasmo-flex plasmo-items-center plasmo-justify-center plasmo-mx-auto plasmo-border plasmo-border-neutral-200">
                  <svg className="plasmo-w-5 plasmo-h-5 plasmo-text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                  </svg>
                </div>
                <div className="plasmo-space-y-1">
                  <p className="plasmo-text-xs plasmo-text-neutral-700 plasmo-font-bold">No reviews audited yet</p>
                  <p className="plasmo-text-[10px] plasmo-text-neutral-400 plasmo-px-4">
                    Open any Shopee product page, and Sulit AI will automatically load review details!
                  </p>
                </div>

                <div className="plasmo-pt-2">
                  <a
                    href="https://shopee.ph"
                    target="_blank"
                    className="plasmo-inline-flex plasmo-items-center plasmo-gap-1 plasmo-px-3.5 plasmo-py-1.5 plasmo-bg-[#ee4d2d] hover:plasmo-bg-[#f53d2d] plasmo-text-white plasmo-font-bold plasmo-text-[10px] plasmo-rounded-md plasmo-transition-colors"
                  >
                    Go to Shopee PH
                    <svg className="plasmo-w-3 plasmo-h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                </div>
              </div>
            ) : (
              <div className="plasmo-space-y-2">
                <span className="plasmo-text-[9px] plasmo-font-bold plasmo-text-neutral-400 plasmo-uppercase plasmo-tracking-widest">Cached Analyses ({history.length})</span>
                {history.map((item) => (
                  <a
                    key={item.id}
                    href={item.url}
                    target="_blank"
                    className="plasmo-block plasmo-p-3 plasmo-bg-white hover:plasmo-bg-neutral-50 plasmo-border plasmo-border-neutral-200 plasmo-rounded-xl plasmo-transition-all plasmo-group"
                  >
                    <div className="plasmo-flex plasmo-items-start plasmo-justify-between plasmo-gap-3">
                      <div className="plasmo-space-y-1 plasmo-flex-1">
                        <h4 className="plasmo-text-[11px] plasmo-font-bold plasmo-text-neutral-800 plasmo-line-clamp-1 group-hover:plasmo-text-[#ee4d2d]">
                          {item.title}
                        </h4>
                        <div className="plasmo-flex plasmo-items-center plasmo-gap-2">
                          <span className="plasmo-text-[10px] plasmo-font-bold plasmo-text-[#ee4d2d]">{item.priceStr}</span>
                          <span className="plasmo-text-[9px] plasmo-text-neutral-300">•</span>
                          <span className="plasmo-text-[9px] plasmo-text-neutral-500 plasmo-truncate plasmo-max-w-[130px]">
                            {item.sellerName || "Shopee Store"} ({item.sellerTrust})
                          </span>
                        </div>
                        <div className="plasmo-flex plasmo-items-center plasmo-gap-2 plasmo-text-[9px] plasmo-text-neutral-500">
                          <span className="plasmo-flex plasmo-items-center plasmo-gap-0.5 plasmo-font-bold plasmo-text-neutral-700">
                            <span className="plasmo-text-[#ffc107]">★</span>
                            {typeof item.productRating === "number" ? item.productRating.toFixed(1) : "N/A"}
                          </span>
                          <span className="plasmo-text-neutral-300">•</span>
                          <span>{item.productRatingCount || item.rawReviewsCount || 0} ratings</span>
                        </div>
                        {getImportantFeedback(item) && (
                          <p className="plasmo-text-[10px] plasmo-text-neutral-500 plasmo-leading-snug plasmo-line-clamp-2 plasmo-mt-1">
                            "{getImportantFeedback(item)}"
                          </p>
                        )}
                      </div>

                      {/* Score display badge */}
                      <div className={`plasmo-flex plasmo-items-center plasmo-gap-1 plasmo-px-2 plasmo-py-1 plasmo-rounded-lg plasmo-border plasmo-text-[10px] plasmo-font-black ${getScoreColor(item.sulitScore)}`}>
                        {item.sulitScore.toFixed(1)}
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 2: SETTINGS FORM */}
        {activeTab === "settings" && (
          <form onSubmit={handleSaveSettings} className="plasmo-space-y-4">
            <div className="plasmo-bg-neutral-50 plasmo-border plasmo-border-neutral-200 plasmo-p-4 plasmo-rounded-xl plasmo-space-y-3.5">
              <h3 className="plasmo-text-xs plasmo-font-bold plasmo-text-neutral-700">Server Endpoint</h3>
              
              <div className="plasmo-space-y-1.5">
                <label className="plasmo-block plasmo-text-[10px] plasmo-text-neutral-400">Endpoint URL</label>
                <input
                  type="text"
                  required
                  value={backendUrl}
                  onChange={(e) => setBackendUrl(e.target.value)}
                  className="plasmo-w-full plasmo-bg-white plasmo-border plasmo-border-neutral-200 focus:plasmo-border-[#ee4d2d] plasmo-text-neutral-800 plasmo-px-3 plasmo-py-2 plasmo-rounded-lg plasmo-text-xs plasmo-outline-none"
                  placeholder="e.g. http://localhost:8000"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isSaving}
              className="plasmo-w-full plasmo-bg-[#ee4d2d] hover:plasmo-bg-[#f53d2d] disabled:plasmo-opacity-50 plasmo-text-white plasmo-font-bold plasmo-text-xs plasmo-py-2.5 plasmo-rounded-lg plasmo-transition-colors"
            >
              {isSaving ? "Saving Settings..." : "Save Settings & Test"}
            </button>
          </form>
        )}

      </div>

      {/* Footer Branding */}
      <div className="plasmo-p-3 plasmo-border-t plasmo-border-neutral-200 plasmo-flex plasmo-items-center plasmo-justify-between plasmo-bg-neutral-50">
        <span className="plasmo-text-[9px] plasmo-text-neutral-400 plasmo-font-bold">SULIT AI • MVP v1.0.0</span>
        <span className="plasmo-text-[9px] plasmo-text-neutral-400 plasmo-font-bold">PH SHOPPING ASSISTANT</span>
      </div>
    </div>
  )
}

export default IndexPopup
