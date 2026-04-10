# 🤖 Scalping Bot — Alpaca Edition
Ollama (local AI) or Claude AI + Alpaca | US Stocks & Crypto

---

## What's New in v2

- **Ollama support** — runs a local AI model on your Mac, completely free and private
- **AI abstraction layer** (`ai.js`) — swap between Ollama and Anthropic with one env var
- **Health check at startup** — clear error messages if Ollama isn't running or model isn't pulled
- **Cleaner architecture** — prompt building, parsing, and provider logic all in `ai.js`

---

## Quick Start — Ollama (Recommended for M1 MacBook Air)

### 1. Install & Start Ollama
```bash
brew install ollama
ollama serve              # start the server (keep this terminal open)
```

### 2. Pull a Model
```bash
# Recommended for M1 16GB — Fast & Reliable
ollama pull llama3.2:3b    # extremely fast (50+ tok/s), solid reasoning ✅ recommended
ollama pull qwen2.5:7b     # great at following JSON instructions

# Reasoning models (high quality, but slower)
ollama pull deepseek-r1:8b # best reasoning, has /think mode
```

### 3. Get Your Alpaca API Keys
1. Log in at https://app.alpaca.markets
2. Click **API Keys** in the right sidebar
3. Generate a key pair under **Paper Trading**
4. Copy your **Key ID** and **Secret Key**

### 4. Set Environment Variables
Create a `.env` file:
```
APCA_API_KEY_ID=your-alpaca-key-id
APCA_API_SECRET_KEY=your-alpaca-secret-key

# Optional — only needed if using Anthropic Claude
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxx
```

### 5. Install & Run
```bash
npm install
npm start               # BTC/USD, monitor only, Ollama
npm run btc-auto        # BTC/USD, auto-execute, Ollama
npm run spy             # SPY stocks, monitor only
```

---

## Switching AI Providers

| Provider | Command | Cost |
|---|---|---|
| Ollama (local) | `npm start` | Free |
| Ollama (specific model) | `OLLAMA_MODEL=phi4 npm start` | Free |
| Anthropic Claude | `npm run cloud` | Per token |

---

## All Commands

| Command | What it does |
|---|---|
| `npm start` | Default symbol, monitor only (Ollama) |
| `npm run auto` | Default symbol, auto-execute |
| `npm run spy` | SPY, monitor only |
| `npm run spy-auto` | SPY, auto-execute |
| `npm run tsla` | TSLA, monitor only |
| `npm run btc` | BTC/USD, monitor only |
| `npm run btc-auto` | BTC/USD, auto-execute |
| `npm run eth-auto` | ETH/USD, auto-execute |
| `npm run cloud` | Use Anthropic Claude instead of Ollama |
| `npm run cloud-btc` | Claude + BTC/USD |

Custom symbol:
```bash
node index.js --symbol NVDA --auto-execute
node index.js --symbol SOL/USD
OLLAMA_MODEL=phi4 node index.js --symbol BTC/USD
```

---

## Files

| File | Purpose |
|---|---|
| `index.js` | Main loop — fetch, analyse, execute |
| `ai.js` | AI client — Ollama + Anthropic, prompt builder |
| `alpaca.js` | Alpaca REST API client |
| `indicators.js` | EMA, RSI, ATR calculations |
| `formatter.js` | Terminal output |
| `config.js` | All settings |

---

## Stocks vs Crypto — Key Differences

| | Stocks (SPY, TSLA...) | Crypto (BTC/USD...) |
|---|---|---|
| Hours | 9:30am–4pm ET, Mon–Fri | 24/7 |
| Position size | Whole shares only | Fractional (e.g. 0.0015 BTC) |
| Order type | Day order | GTC (good till cancelled) |
| Best time | Morning + afternoon session | Avoid low-volume overnight |

---

## Model Guide for M1 MacBook Air 16GB

| Model | Size | Speed | Memory | Best for |
|---|---|---|---|---|
| `llama3.2:3b` | ~2GB | 50-70 tok/s | ~2.5GB | **Speed & Parallelism** ✅ |
| `qwen2.5:7b` | ~5GB | 15-20 tok/s | ~6.0GB | **Instruction Following** |
| `deepseek-r1:8b` | ~5GB | 10-15 tok/s | ~6.0GB | **Deep Reasoning** |

> **Ollama Efficiency Tips:**
> 1. **Avoid Swapping:** If trading multiple symbols, use `llama3.2:3b`. Two 8b models can exceed the 16GB "unified" limit shared with macOS/browsers, causing a massive slowdown.
> 2. **Prompt Caching:** The bot uses the `/api/chat` endpoint which caches the system prompt. This makes the "prefill" phase nearly instant after the first tick.
> 3. **Keep-alive:** The `keepAlive` setting in `config.js` keeps the model in VRAM, avoiding the 5-10s "load time" on every tick.
> 4. **Reasoning Models:** Models like `deepseek-r1` use a `<think>` block. While smart, this can take 20-30s extra. For scalping, a fast `instruct` model like `llama3.2` is often better.

---

## ⚠️ Risk Warnings
- Start on **paper trading** always
- Default risk is 1% per trade
- **Fees Awareness**: Crypto trading on Alpaca has a fee (approx 0.3% per side). The bot is configured to only take trades where the target profit significantly exceeds the round-trip fee. Low-volatility periods (low ATR) might result in few to no signals.
- Stocks: avoid trading the first 30 min after open (choppy)
- Crypto: lower volume overnight means wider spreads
- Short selling stocks requires a margin account
- Local models are less capable than Claude — monitor signals closely before enabling auto-execute
- This is not financial advice
