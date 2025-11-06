# BrookerBot

A Telegram bot that generates blistering Charlie Brooker-style rants about any topic or person. Channel the vitriolic spirit of Black Mirror's creator on demand.

## Features

- **`/rant <topic>`** - Generate a blistering, rambling rant in Charlie Brooker's signature style
- **x402 Payments** - Pay $1.00 USDC via x402 for each rant
- **Telegram Integration** - Works directly in Telegram chats

## Quick Start

1. **Install dependencies:**
   ```sh
   bun install
   ```

2. **Set up environment variables:**
   Create a `.env` file with:
   ```
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token
   AGENT_URL=your_agent_url
   FACILITATOR_URL=https://facilitator.x402.rs
   PAY_TO=your_payment_address
   ENTRYPOINT_PRICE=1.00
   PAYMENT_CURRENCY=USDC
   ```

3. **Run the bot:**
   ```sh
   bun run dev
   ```

## Usage

1. Add the bot to your Telegram chat
2. Send `/rant <topic>` or `/rant <person>` 
3. Pay $1.00 USDC via x402
4. Receive your vitriolic rant in the chat

## Project Structure

- `src/agent.ts` – Defines the agent manifest and rant entrypoint
- `src/index.ts` – HTTP server with payment handling and Telegram callbacks
- `src/telegram.ts` – Telegram bot command handlers
- `src/pending.ts` – Payment callback state management

## Available Scripts

- `bun run dev` – Start the bot in watch mode
- `bun run start` – Start the bot once
- `bun run agent` – Run the agent module directly
- `bunx tsc --noEmit` – Type-check the project

## Deployment

Deploy to any Bun-compatible platform (e.g., Railway, Fly.io). Make sure to set all required environment variables in your deployment platform.
