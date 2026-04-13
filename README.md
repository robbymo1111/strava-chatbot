# Strava Coach AI

A mobile-first AI coaching chatbot that connects to your Strava account and answers training questions using Claude.

## Stack

- **Frontend**: Plain HTML + CSS + vanilla JS (no frameworks)
- **Backend**: Netlify Functions (Node.js serverless)
- **APIs**: Strava OAuth + Activities API, Anthropic Claude API

## Setup

### 1. Create a Strava App

1. Go to https://www.strava.com/settings/api
2. Create an application
3. Set **Authorization Callback Domain** to `strava-chatbot.netlify.app`
4. Note your **Client ID** and **Client Secret**

### 2. Get an Anthropic API Key

1. Go to https://console.anthropic.com
2. Create an API key

### 3. Deploy to Netlify

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Link to your Netlify site
netlify link

# Set environment variables
netlify env:set STRAVA_CLIENT_ID      your_client_id
netlify env:set STRAVA_CLIENT_SECRET  your_client_secret
netlify env:set ANTHROPIC_API_KEY     your_anthropic_key

# Deploy
netlify deploy --prod
```

### 4. Local Development

```bash
cp .env.example .env
# Fill in your values in .env

netlify dev
# App runs at http://localhost:8888
# For OAuth to work locally, temporarily change the redirect URI
# in netlify/functions/strava-auth-url.js to http://localhost:8888/callback
```

## Environment Variables

| Variable | Description |
|---|---|
| `STRAVA_CLIENT_ID` | Your Strava app's client ID |
| `STRAVA_CLIENT_SECRET` | Your Strava app's client secret |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |

## Architecture

```
User → index.html
     → [click "Connect with Strava"]
     → /.netlify/functions/strava-auth-url  (gets OAuth URL server-side)
     → Strava OAuth consent screen
     → /callback → callback.html
     → /.netlify/functions/strava-exchange  (code → access token)
     → chat.html  (token in sessionStorage only)
     → [user types question]
     → /.netlify/functions/chat
         ├── fetches last 20 Strava activities (30-day window)
         └── sends to Claude API → returns coaching reply
```

## File Structure

```
├── index.html                        # Landing / login page
├── callback.html                     # OAuth callback handler
├── chat.html                         # Chat UI
├── css/style.css                     # All styles
├── js/app.js                         # Chat frontend logic
├── netlify/functions/
│   ├── strava-auth-url.js            # Returns Strava OAuth URL (keeps client_id server-side)
│   ├── strava-exchange.js            # Exchanges OAuth code for access token
│   └── chat.js                       # Fetches activities + queries Claude
└── netlify.toml                      # Netlify config + /callback redirect
```
