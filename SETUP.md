# CumBot Setup Guide

## Step 1: Discord Bot Setup

1. Go to https://discord.com/developers/applications
2. Click "New Application"
3. Name it "CumBot" (or whatever you want)
4. Go to "Bot" tab
5. Click "Add Bot" and confirm
6. Under "TOKEN", click "Reset Token" or "Copy" to get your bot token
7. Under "Privileged Gateway Intents", enable:
   - ✅ MESSAGE CONTENT INTENT (required to read messages)
8. Go to "OAuth2" → "URL Generator"
   - Select scopes: `bot`
   - Select bot permissions: 
     - ✅ Read Messages/View Channels
     - ✅ Send Messages
     - ✅ Use Slash Commands
   - Copy the generated URL at the bottom
   - Use this URL to invite the bot to your server

**Save these values:**
- `DISCORD_BOT_TOKEN` - from Bot tab
- `DISCORD_APPLICATION_ID` - from "General Information" tab (Application ID)
- `DISCORD_PUBLIC_KEY` - from "General Information" tab (Public Key)

## Step 2: Telegram Bot Setup

1. Open Telegram and search for @BotFather
2. Send `/newbot`
3. Choose a name: `CumBot`
4. Choose a username: `CumBot` (must end with "bot", e.g., `CumBotBot` or `cum_for_bot`)
5. BotFather will give you a token like: `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`

**Save this value:**
- `TELEGRAM_BOT_TOKEN` - from BotFather

6. Send `/setprivacy` to BotFather
7. Select your bot
8. Choose `Disable` (so bot can see all messages in groups)

## Step 3: Railway Setup

1. Go to https://railway.app
2. Create a new project
3. Connect your GitHub repo (or deploy from local)
4. Go to "Variables" tab and add:

**Required Environment Variables:**

```
# Discord
DISCORD_BOT_TOKEN=your_discord_bot_token_here
DISCORD_APPLICATION_ID=your_discord_application_id_here
DISCORD_PUBLIC_KEY=your_discord_public_key_here

# Telegram
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here

# Payment (same as summariser bot)
PAY_TO=0xb308ed39d67D0d4BAe5BC2FAEF60c66BBb6AE429
FACILITATOR_URL=https://facilitator.x402.rs
NETWORK=base
DEFAULT_PRICE=1.00
ENTRYPOINT_PRICE=1.00

# LLM Provider (same as summariser bot)
AX_API_KEY=your_llm_api_key_here
AX_MODEL=your_model_name
AX_PROVIDER=your_provider

# URLs
PUBLIC_WEB_URL=https://your-cumbot-app.up.railway.app
AGENT_URL=https://your-cumbot-app.up.railway.app
```

## Step 4: Deploy

1. Push your code to GitHub (if using GitHub)
2. Railway will auto-deploy
3. Check logs to ensure bot started successfully

## Step 5: Register Discord Slash Command

After deployment, run:

```bash
cd /Users/cumberlord/cumbot
export DISCORD_BOT_TOKEN=your_token
export DISCORD_APPLICATION_ID=your_app_id
bun run scripts/register-slash-command.ts
```

## Step 6: Test

1. Invite bot to Discord server using the URL from Step 1
2. Add bot to Telegram group
3. Try: `/Cum for money` or `/Cum for @username`
4. Complete payment flow
5. Receive response!

