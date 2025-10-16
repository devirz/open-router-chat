import { useEffect, useRef, useState } from 'react'
import './App.css'

type ChatMessage = { id: number; text: string; role: 'user' | 'bot'; modelId?: string; errorDetails?: string }

// Function to detect text direction and language
function detectTextDirection(text: string): 'rtl' | 'ltr' {
  const persianRegex = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/
  const englishRegex = /[a-zA-Z]/
  
  const persianCount = (text.match(persianRegex) || []).length
  const englishCount = (text.match(englishRegex) || []).length
  
  // If Persian characters are more dominant, use RTL
  if (persianCount > englishCount) return 'rtl'
  // If English characters are more dominant, use LTR
  if (englishCount > persianCount) return 'ltr'
  // Default to RTL for mixed or unclear content
  return 'rtl'
}

function App() {
  const [isLoaded, setIsLoaded] = useState(false)
  const [messages, setMessages] = useState<Array<ChatMessage>>([
    { id: 1, text: 'سلام! خوش اومدی 🌟', role: 'bot', modelId: undefined },
  ])
  const [input, setInput] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isModelOpen, setIsModelOpen] = useState(false)
  const [models, setModels] = useState<Array<{ id: string; name?: string; pricing?: any }>>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [modelSearch, setModelSearch] = useState('')
  const [selectedModel, setSelectedModel] = useState<string>('deepseek/deepseek-r1-0528-qwen3-8b:free')
  const nextIdRef = useRef(2)
  const chatEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const handleLoadComplete = () => setIsLoaded(true)

    if (document.readyState === 'complete') {
      setIsLoaded(true)
    } else {
      window.addEventListener('load', handleLoadComplete)
    }
    return () => {
      window.removeEventListener('load', handleLoadComplete)
    }
  }, [])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Fetch available models (prefer free)
  useEffect(() => {
    let cancelled = false
    async function fetchModels() {
      try {
        setModelsLoading(true)
        setModelsError(null)
        const apiKey = (import.meta as any).env?.VITE_OPENROUTER_API_KEY as string | undefined
        const res = await fetch('https://openrouter.ai/api/v1/models', {
          headers: {
            'Authorization': apiKey ? `Bearer ${apiKey}` : '',
          },
        })
        if (!res.ok) {
          throw new Error(`Models HTTP ${res.status}`)
        }
        const data = await res.json()
        const list: Array<{ id: string; name?: string; pricing?: any }> = data?.data || data?.models || []
        // Heuristic for free: id contains :free OR pricing.prompt === 0
        const free = list.filter((m) => m.id?.includes(':free') || m.pricing?.prompt === 0)
        if (!cancelled) setModels(free.length ? free : list)
      } catch (e: unknown) {
        if (!cancelled) setModelsError(e instanceof Error ? e.message : 'خطا در دریافت مدل‌ها')
      } finally {
        if (!cancelled) setModelsLoading(false)
      }
    }
    fetchModels()
    return () => { cancelled = true }
  }, [])

  async function sendMessage() {
    const trimmed = input.trim()
    if (!trimmed) return
    if (isSending) return
    setError(null)
    const id = nextIdRef.current++
    const userMsg: ChatMessage = { id, text: trimmed, role: 'user' as const }
    setMessages((prev) => [...prev, userMsg])
    setInput('')

    // Prepare OpenRouter request
    const apiKey = (import.meta as any).env?.VITE_OPENROUTER_API_KEY as string | undefined
    const model = selectedModel || 'deepseek/deepseek-r1-0528-qwen3-8b:free'
    const referer = window.location.origin
    const title = document.title || 'Open Router Chat'

    const openRouterMessages = [
      ...messages.map((m) => ({ role: m.role === 'bot' ? 'assistant' : 'user', content: m.text })),
      { role: 'user', content: trimmed },
    ]

    // Create a placeholder bot message for streaming
    const botId = nextIdRef.current++
    
    try {
      setIsSending(true)
      setIsStreaming(true)
      
      setMessages((prev) => [...prev, { id: botId, text: '', role: 'bot', modelId: model }])

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': apiKey ? `Bearer ${apiKey}` : '',
          'HTTP-Referer': referer,
          'X-Title': title,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: openRouterMessages,
          stream: true,
        }),
      })

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '')
        throw new Error(text || `HTTP ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      // Read SSE stream
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const parts = buffer.split('\n\n')
        buffer = parts.pop() || ''

        for (const part of parts) {
          const lines = part.split('\n')
          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            const data = line.replace(/^data:\s*/, '')
            if (data === '[DONE]') {
              setIsStreaming(false)
              break
            }
            try {
              const json = JSON.parse(data)
              const delta = json?.choices?.[0]?.delta?.content || ''
              if (delta) {
                setMessages((prev) => prev.map((m) => (m.id === botId ? { ...m, text: m.text + delta } : m)))
              }
            } catch {
              // ignore JSON parse errors for non-data lines
            }
          }
        }
      }

      setIsStreaming(false)
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'خطای ناشناخته'
      
      // Stop streaming state
      setIsStreaming(false)
      
      // Remove the placeholder bot message that was created
      setMessages((prev) => prev.filter((m) => m.id !== botId))
      
      // Add error message to chat
      const failId = nextIdRef.current++
      setMessages((prev) => [...prev, { 
        id: failId, 
        text: `متاسفانه مشکلی پیش آمد. دوباره تلاش کنید.`, 
        role: 'bot',
        errorDetails: errorMessage
      }])
      
      // Also set error state for display
      // setError(errorMessage)
    } finally {
      setIsSending(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      sendMessage()
    }
  }

  return (
    <div className="app-root">
      {/* Loading Overlay */}
      <div className={`loader ${isLoaded ? 'loader--hidden' : ''}`} aria-hidden={isLoaded}>
        <div className="spinner" />
        <div className="loader-text">در حال بارگذاری...</div>
      </div>

      {/* Navbar */}
      <nav className="navbar">
        <div className="navbar__brand">Open Router Chat</div>
        <div className="navbar__actions">
          <button className="model-btn" onClick={() => setIsModelOpen((v) => !v)}>
            {selectedModel}
          </button>
        </div>
      </nav>

      {/* Animated Background Ornaments */}
      <div className="bg-ornaments" aria-hidden>
        <div className="orb orb--1" />
        <div className="orb orb--2" />
        <div className="orb orb--3" />
        <div className="twinkle t1" />
        <div className="twinkle t2" />
        <div className="twinkle t3" />
      </div>

      {/* Main Content */}
      <main className="main">
        <section className="chat">
          {/* Model Selector Panel */}
          {isModelOpen && (
            <div className="model-panel">
              <div className="model-panel__header">
                <input
                  type="text"
                  placeholder="جستجوی مدل..."
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                />
                <button onClick={() => setIsModelOpen(false)}>بستن</button>
              </div>
              <div className="model-panel__list">
                {modelsLoading && <div className="model-panel__loading"><span className="spinner spinner--small" /> در حال دریافت...</div>}
                {modelsError && <div className="model-panel__error">{modelsError}</div>}
                {!modelsLoading && !modelsError && (
                  models
                    .filter((m) => {
                      const q = modelSearch.trim().toLowerCase()
                      return !q || m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q)
                    })
                    .slice(0, 50)
                    .map((m) => (
                      <button
                        key={m.id}
                        className={`model-item ${m.id === selectedModel ? 'model-item--active' : ''}`}
                        onClick={() => { setSelectedModel(m.id); setIsModelOpen(false) }}
                        title={m.name || m.id}
                      >
                        <span className="model-id">{m.id}</span>
                        {m.name && <span className="model-name">{m.name}</span>}
                      </button>
                    ))
                )}
              </div>
            </div>
          )}

          <div className="chat__messages">
            {messages.map((m, i) => (
              <div key={m.id} className={`message message--${m.role}`}>
                <div className="message__meta">
                  {m.role === 'user'
                    ? 'کاربر'
                    : (isStreaming && i === messages.length - 1
                        ? 'در حال نوشتن...'
                        : (m.modelId || 'هوش مصنوعی'))}
                </div>
                <div 
                  className={`message__bubble ${m.role === 'user' ? 'bubble-in-right' : 'bubble-in-left'}`}
                  dir={detectTextDirection(m.text)}
                  style={{
                    textAlign: detectTextDirection(m.text) === 'rtl' ? 'right' : 'left',
                    fontFamily: detectTextDirection(m.text) === 'rtl' ? 'var(--font-persian)' : '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif'
                  }}
                >
                  {m.text}
                  {m.errorDetails && (
                    <div className="error-details">
                      {m.errorDetails}
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <div className="chat__input">
            <input
              type="text"
              placeholder="پیام خود را بنویسید..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              aria-label="message"
              disabled={isSending}
              dir={detectTextDirection(input)}
              style={{
                textAlign: detectTextDirection(input) === 'rtl' ? 'right' : 'left',
                fontFamily: detectTextDirection(input) === 'rtl' ? 'var(--font-persian)' : '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif'
              }}
            />
            <button onClick={sendMessage} disabled={isSending}>
              {isSending ? (
                <span className="send-loading">
                  <span className="spinner spinner--small" />
                </span>
              ) : 'ارسال'}
            </button>
          </div>
          {isStreaming && (
            <div className="typing">
              <span className="dot" /><span className="dot" /><span className="dot" />
            </div>
          )}
          {error && <div className="chat__error">{error}</div>}
        </section>
      </main>
    </div>
  )
}

export default App
