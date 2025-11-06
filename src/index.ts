import { app } from "./agent";
import { exact } from "x402/schemes";
import { findMatchingPaymentRequirements } from "x402/shared";
import { useFacilitator } from "x402/verify";
import { settleResponseHeader } from "x402/types";
import { PAYMENT_CALLBACK_EXPIRY_MS } from "./constants";
import {
  pendingTelegramCallbacks,
} from "./pending";
import { createTelegramBot } from "./telegram";

const port = Number(process.env.PORT ?? 8787);

// Payment constants
const USDC_DECIMALS = 6;
const DEFAULT_PRICE_USDC = BigInt(50000); // 0.05 USDC (50000 / 10^6)

// Clean up expired callbacks every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of pendingTelegramCallbacks.entries()) {
    if (data.expiresAt < now) {
      pendingTelegramCallbacks.delete(token);
    }
  }
}, 30 * 60 * 1000);

// Handle Telegram callback after payment
async function handleTelegramCallback(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { telegram_token, result } = body;

    if (!telegram_token) {
      return Response.json({ error: "Missing telegram_token" }, { status: 400 });
    }

    const decodedToken = decodeURIComponent(telegram_token);
    const callbackData = pendingTelegramCallbacks.get(decodedToken);
    if (!callbackData) {
      console.error(`[telegram-callback] Token not found or expired: ${decodedToken.substring(0, 30)}...`);
      return Response.json({ error: "Invalid or expired callback token" }, { status: 404 });
    }

    // Remove from pending immediately
    pendingTelegramCallbacks.delete(decodedToken);

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      console.error("[telegram] TELEGRAM_BOT_TOKEN not set");
      return Response.json({ error: "Telegram bot token missing" }, { status: 500 });
    }

    const output = result?.output || result;
    // Extract rant from BrookerBot
    const messageText = (output?.rant || "").trim();
    
    if (!messageText) {
      const fallbackText = `Right, so I tried to generate a rant about "${callbackData.topic || "the topic"}" and... nothing. The rage is there, the vitriol is there, but the words? The words have left the building. This is a meta-rant about the inability to rant, which is actually quite on-brand for BrookerBot.`;
      
      const sendUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
      await fetch(sendUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: callbackData.chatId,
          text: fallbackText,
        }),
      });
      
      return Response.json({ success: true });
    }
    
    const formattedMessage = `**BrookerBot Rant**\n\n${messageText}`;

    // Send to Telegram - try to complete it quickly, but don't block forever
    try {
      await Promise.race([
        (async () => {
          const sendUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
          const sendResponse = await fetch(sendUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: callbackData.chatId,
              text: formattedMessage,
              parse_mode: "Markdown",
            }),
          });

          if (!sendResponse.ok) {
            const errorText = await sendResponse.text();
            console.error(`[telegram] Failed to send message: ${sendResponse.status} ${errorText}`);
            return;
          }

          if (callbackData.paymentMessageId) {
            const deleteUrl = `https://api.telegram.org/bot${botToken}/deleteMessage`;
            const deleteResponse = await fetch(deleteUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: callbackData.chatId,
                message_id: callbackData.paymentMessageId,
              }),
            });

            if (!deleteResponse.ok) {
              const deleteError = await deleteResponse.text();
              console.warn(`[telegram] Failed to delete payment message: ${deleteResponse.status} ${deleteError}`);
            }
          }

          console.log(`[telegram] Successfully sent callback result to chat ${callbackData.chatId}`);
        })(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Telegram API timeout")), 5000)
        )
      ]);
    } catch (error: any) {
      // If timeout or error, log it but still return success
      console.error("[telegram] Error or timeout posting to Telegram:", error);
      // Fire off a background task to retry if needed
      setTimeout(async () => {
        try {
          const retryResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: callbackData.chatId,
              text: formattedMessage,
              parse_mode: "Markdown",
            }),
          });
          if (retryResponse.ok) {
            console.log(`[telegram] Successfully sent callback result on retry`);
          }
        } catch (retryError) {
          console.error("[telegram] Retry also failed:", retryError);
        }
      }, 100);
    }

    // Return success
    return Response.json({ success: true });
  } catch (error: any) {
    console.error("[telegram] Error handling callback:", error);
    return Response.json(
      { error: "Internal server error", message: error?.message },
      { status: 500 }
    );
  }
}

const server = Bun.serve({
  port,
  hostname: "0.0.0.0", // Bind to all interfaces (required for Railway)
  async fetch(req) {
    try {
      const url = new URL(req.url);

      // Health checks
      if (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/healthz") {
        return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } });
      }

    // Telegram payment callback endpoint
    if (url.pathname === "/telegram-callback" && req.method === "POST") {
      return handleTelegramCallback(req);
    }

    // Serve CumBot OG image
    if (url.pathname === "/assets/brookerbot-og.png" && req.method === "GET") {
      try {
        // Try multiple possible paths
        const possiblePaths = [
          `${import.meta.dir}/assets/brookerbot-og.png`,
          "./src/assets/brookerbot-og.png",
          "src/assets/brookerbot-og.png",
          "./public/assets/brookerbot-og.png",
          "public/assets/brookerbot-og.png",
          `${process.cwd()}/src/assets/brookerbot-og.png`,
          `${process.cwd()}/public/assets/brookerbot-og.png`,
        ];
        
        for (const imagePath of possiblePaths) {
          const file = Bun.file(imagePath);
          if (await file.exists()) {
            console.log(`[assets] Serving brookerbot-og.png from: ${imagePath}`);
            return new Response(file, {
              headers: {
                "Content-Type": "image/png",
                "Cache-Control": "public, max-age=86400",
              },
            });
          }
        }
        console.error("[assets] brookerbot-og.png not found in any of the expected paths:", possiblePaths);
        return new Response("OG image not found", { status: 404 });
      } catch (error) {
        console.error("[assets] Error serving brookerbot-og.png:", error);
        return new Response("Error serving OG image", { status: 500 });
      }
    }
    
    // Legacy route for cumbot-og.png (redirect to brookerbot-og.png)
    if (url.pathname === "/assets/cumbot-og.png" && req.method === "GET") {
      try {
        const file = Bun.file("public/assets/brookerbot-og.png");
        if (await file.exists()) {
          return new Response(file, {
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "public, max-age=86400",
            },
          });
        }
      } catch (error) {
        console.warn(`[assets] Could not load brookerbot-og.png: ${error}`);
      }
      // Return 404 if file doesn't exist
      return new Response("Image not found", { status: 404 });
    }

    if (url.pathname === "/assets/x402-card.svg" && req.method === "GET") {
      const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="50%" stop-color="#1e3a8a"/>
      <stop offset="100%" stop-color="#0b1120"/>
    </linearGradient>
    <radialGradient id="glow" cx="30%" cy="20%" r="70%">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="logoGradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#61f0ff"/>
      <stop offset="100%" stop-color="#2563eb"/>
    </linearGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="30" stdDeviation="40" flood-color="#0b1120" flood-opacity="0.6"/>
    </filter>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)" opacity="0.45"/>
  <g transform="translate(180 140)" filter="url(#shadow)">
    <path d="M154 0c90 0 164 75 164 168v40c0 93-74 168-164 168-23 0-44-4-64-12l-78 62c-12 9-28-5-20-18l41-69c-28-29-43-67-43-111v-60C-74 75 0 0 90 0h64z" fill="url(#logoGradient)"/>
    <rect x="66" y="108" width="176" height="116" rx="58" fill="#0f172a"/>
    <circle cx="116" cy="166" r="32" fill="#8be3ff"/>
    <circle cx="192" cy="166" r="32" fill="#8be3ff"/>
    <g fill="#7ff8ff">
      <circle cx="88" cy="36" r="22"/>
      <circle cx="220" cy="36" r="22"/>
      <rect x="150" y="10" width="8" height="52" rx="4"/>
      <rect x="150" y="10" width="8" height="52" rx="4" transform="rotate(12 154 36)"/>
    </g>
  </g>
  <g transform="translate(420 215)">
    <text x="0" y="0" font-family="'Inter', 'Segoe UI', system-ui, sans-serif" font-size="72" font-weight="700" fill="#f8fafc">x402 Summariser Bot</text>
    <text x="0" y="96" font-family="'Inter', 'Segoe UI', system-ui, sans-serif" font-size="34" fill="rgba(226,232,240,0.88)">Generate blistering Charlie Brooker-style rants via x402.</text>
  </g>
</svg>`;
      return new Response(svg, {
        headers: {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    // Payment page - handles GET requests and shows payment UI
    if (url.pathname === "/pay" && req.method === "GET") {
      const source = url.searchParams.get("source") ?? "telegram";
      const chatId = url.searchParams.get("chatId");
      const topic = url.searchParams.get("topic");
      const command = url.searchParams.get("command");
      const telegramCallback = url.searchParams.get("telegram_callback");

      if (!topic || command !== "rant") {
        return Response.json({ error: "Missing topic parameter for rant command" }, { status: 400 });
      }

      // Ensure AGENT_URL has https:// prefix if it's just a domain
      let agentBaseUrl = process.env.AGENT_URL || `https://brookerbot-production.up.railway.app`;
      if (!agentBaseUrl.startsWith("http://") && !agentBaseUrl.startsWith("https://")) {
        agentBaseUrl = `https://${agentBaseUrl}`;
      }
      const entrypointPath = "rant";
      const entrypointUrl = `${agentBaseUrl}/entrypoints/${entrypointPath}/invoke`;
      const price = process.env.ENTRYPOINT_PRICE || "0.05";
      const currency = process.env.PAYMENT_CURRENCY || "USDC";

      const heading = `🔥 BrookerBot Rant`;
      const entityLabel = "Topic";
      const postPaymentPrompt = "After payment, your rant will automatically appear in Telegram.";

      const origin = url.origin.replace(/^http:/, "https:");
      const logoUrl = `${origin}/assets/brookerbot-og.png`;

      const pageConfig = {
        source,
        chatId,
        topic,
        command,
        entrypointUrl,
        telegramCallback,
      };

      return new Response(`<!DOCTYPE html>
<html>
<head>
  <title>${heading.replace(/<[^>]+>/g, "")}</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { 
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; 
      max-width: 600px; 
      margin: 50px auto; 
      padding: 20px;
      background: #000000;
      color: #e2e8f0;
    }
    .container { 
      background: linear-gradient(145deg, rgba(0, 0, 0, 0.85), rgba(20, 20, 20, 0.95));
      border: 1px solid rgba(148, 163, 184, 0.1);
      padding: 30px; 
      border-radius: 16px;
      box-shadow: 0 24px 48px rgba(0, 0, 0, 0.8);
    }
    .logo {
      width: 120px;
      height: 120px;
      margin: 0 auto 20px;
      background-image: url("${logoUrl}");
      background-size: contain;
      background-position: center;
      background-repeat: no-repeat;
    }
    h1 { 
      color: #e2e8f0; 
      margin-top: 0;
      text-align: center;
      font-size: 1.75rem;
    }
    .info { 
      background: linear-gradient(160deg, rgba(20, 20, 20, 0.9), rgba(0, 0, 0, 0.95));
      border: 1px solid rgba(148, 163, 184, 0.1);
      padding: 15px; 
      border-radius: 8px; 
      margin: 20px 0;
      color: #cbd5f5;
    }
    .button { 
      background: linear-gradient(120deg, #ffffff, #e0e0e0);
      color: #000000;
      padding: 12px 24px; 
      border: none; 
      border-radius: 6px; 
      cursor: pointer; 
      font-size: 16px; 
      margin-top: 20px;
      width: 100%;
      font-weight: 600;
      box-shadow: 0 12px 32px rgba(255, 255, 255, 0.2);
    }
    .button:hover { 
      background: linear-gradient(120deg, #ffffff, #f5f5f5);
      box-shadow: 0 18px 28px rgba(255, 255, 255, 0.3);
    }
    #status {
      color: #cbd5f5;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo"></div>
    <h1>${heading}</h1>
    <div class="info">
      <p><strong>Price:</strong> $${price} ${currency}</p>
      <p><strong>${entityLabel}:</strong> ${topic}</p>
    </div>
    <p style="text-align: center; color: #cbd5f5;">Click below to pay via x402. ${postPaymentPrompt}</p>
    <button class="button" onclick="pay()">Pay $${price} ${currency}</button>
    <div id="status" style="margin-top: 20px;"></div>
  </div>
  <script type="importmap">
    {
      "imports": {
        "x402-fetch": "https://esm.sh/x402-fetch@0.7.0?bundle",
        "x402/types": "https://esm.sh/x402@0.7.0/types?bundle",
        "x402/client": "https://esm.sh/x402@0.7.0/client?bundle",
        "x402/shared": "https://esm.sh/x402@0.7.0/shared?bundle",
        "viem": "https://esm.sh/viem@2.21.26?bundle",
        "viem/chains": "https://esm.sh/viem@2.21.26/chains?bundle"
      }
    }
  </script>
  <script type="module">
    const PAGE_CONFIG = ${JSON.stringify(pageConfig)};
    PAGE_CONFIG.price = '${price}';
    PAGE_CONFIG.currency = '${currency}';

    let wrapFetchWithPayment;
    let createWalletClient;
    let custom;
    let base;
    let moduleLoaded = false;
    
    // Load x402-fetch and viem using import map (esm.sh with bundle flag handles dependencies)
    (async () => {
      try {
        const [x402Module, viemModule, chainsModule] = await Promise.all([
          import('x402-fetch'),
          import('viem'),
          import('viem/chains')
        ]);
        wrapFetchWithPayment = x402Module.wrapFetchWithPayment;
        createWalletClient = viemModule.createWalletClient;
        custom = viemModule.custom;
        base = chainsModule.base;
        
        if (wrapFetchWithPayment && createWalletClient && custom && base) {
          console.log('✅ x402-fetch and viem loaded successfully');
          moduleLoaded = true;
        } else {
          console.error('❌ Missing exports. wrapFetchWithPayment:', !!wrapFetchWithPayment, 'createWalletClient:', !!createWalletClient, 'custom:', !!custom, 'base:', !!base);
        }
      } catch (importError) {
        console.error('❌ Failed to import modules:', importError);
        console.error('Error details:', importError.message);
      }
    })();
    
    async function pay() {
      const cfg = PAGE_CONFIG;
      const status = document.getElementById('status');
      
      // Wait a bit for module to load if it hasn't yet
      if (!moduleLoaded && !wrapFetchWithPayment) {
        status.innerHTML = '<p>⏳ Loading payment library...</p>';
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      if (!wrapFetchWithPayment || !createWalletClient || !custom || !base) {
        status.innerHTML = '<p style="color: red;">⚠️ Error: Could not load payment libraries.</p><p style="font-size: 12px; color: #666;">Please refresh the page and try again.</p>';
        console.error('❌ Required modules not available. wrapFetchWithPayment:', !!wrapFetchWithPayment, 'createWalletClient:', !!createWalletClient);
        return;
      }
      
      status.innerHTML = '<p>🔌 Connecting wallet...</p>';
      
      try {
        // Check if window.ethereum (MetaMask) or other wallet is available
        if (typeof window.ethereum === 'undefined' && typeof window.x402 === 'undefined') {
          throw new Error('No wallet found. Please install MetaMask or an x402-compatible wallet extension.');
        }
        
        // Get wallet provider
        const walletProvider = window.ethereum || window.x402;
        
        // Request wallet connection (required for MetaMask)
        let accountAddress;
        if (walletProvider.request) {
          try {
            const accounts = await walletProvider.request({ method: 'eth_requestAccounts' });
            console.log('✅ Wallet connected');
            
            if (!accounts || accounts.length === 0) {
              throw new Error('No accounts found. Please unlock your wallet.');
            }
            
            accountAddress = accounts[0];
            
            // Ensure we're on Base network (required for payment)
            status.innerHTML = '<p>🔗 Checking network...</p>';
            const BASE_CHAIN_ID = 8453;
            const BASE_CHAIN_ID_HEX = '0x' + BASE_CHAIN_ID.toString(16);
            
            try {
              const currentChainIdHex = await walletProvider.request({ method: 'eth_chainId' });
              const currentChainId = parseInt(currentChainIdHex, 16);
              
              if (currentChainId !== BASE_CHAIN_ID) {
                status.innerHTML = '<p>⚠️ Switching to Base network...</p>';
                console.warn('⚠️ Wrong network. Current:', currentChainId, 'Required:', BASE_CHAIN_ID);
                
                try {
                  // Try to switch to Base network
                  await walletProvider.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: BASE_CHAIN_ID_HEX }],
                  });
                  status.innerHTML = '<p>✅ Switched to Base network</p>';
                } catch (switchError) {
                  // If the error is 4902, the chain is not added to MetaMask
                  if (switchError.code === 4902) {
                    console.warn('⚠️ Base network not found in wallet. Adding...');
                    status.innerHTML = '<p>➕ Adding Base network to wallet...</p>';
                    
                    await walletProvider.request({
                      method: 'wallet_addEthereumChain',
                      params: [{
                        chainId: BASE_CHAIN_ID_HEX,
                        chainName: 'Base',
                        nativeCurrency: {
                          name: 'Ethereum',
                          symbol: 'ETH',
                          decimals: 18
                        },
                        rpcUrls: ['https://mainnet.base.org'],
                        blockExplorerUrls: ['https://basescan.org']
                      }],
                    });
                  } else if (switchError.code === 4001) {
                    throw new Error('Network switch rejected. Please switch to Base network manually in MetaMask.');
                  } else {
                    throw new Error('Failed to switch network. Please switch to Base network manually in MetaMask.');
                  }
                }
              } else {
                status.innerHTML = '<p>✅ Already on Base network</p>';
              }
            } catch (networkError) {
              console.error('❌ Network check error:', networkError);
              throw new Error('Network error: ' + (networkError.message || 'Please ensure you are on Base network'));
            }
          } catch (connError) {
            if (connError.code === 4001) {
              throw new Error('Wallet connection rejected. Please approve the connection to continue.');
            }
            throw connError;
          }
        }
        
        // Create a viem wallet client (x402-fetch expects this format)
        const walletClient = createWalletClient({
          account: accountAddress,
          chain: base,
          transport: custom(walletProvider)
        });
        
        // Wrap fetch with payment handling (pass viem wallet client)
        // maxValue: 0.05 USDC = 50000 (6 decimals)
        // Note: x402 uses EIP-3009 for gasless transactions - facilitator pays gas
        const x402Fetch = wrapFetchWithPayment(fetch, walletClient, BigInt(50000));
        
        const entrypointUrl = cfg.entrypointUrl;
        
        status.innerHTML = '<p>🪙 Processing payment (gasless via facilitator)...</p>';
        
        const requestInput = {
          topic: cfg.topic
        };

        console.log('📋 Request details:', {
          url: entrypointUrl,
          method: 'POST',
          input: requestInput,
        });
        
        // Check USDC balance before payment to verify transaction processing
        const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base
        let balanceBefore = null;
        try {
          // ERC-20 balanceOf(address) - function selector: 0x70a08231
          const balanceData = await walletProvider.request({
            method: 'eth_call',
            params: [{
              to: USDC_ADDRESS,
              data: '0x70a08231' + accountAddress.slice(2).padStart(64, '0')
            }, 'latest']
          });
          balanceBefore = BigInt(balanceData);
        } catch (balanceError) {
          console.warn('⚠️ Could not check USDC balance:', balanceError);
        }
        
        // Log before the request to track when MetaMask should prompt
        console.log('⏳ Calling x402Fetch - MetaMask should prompt for EIP-3009 signature (not a transaction)...');
        console.log('📝 Note: x402 uses EIP-3009 permits - you are signing a message, not sending a transaction.');
        console.log('📝 The facilitator will process the permit and create a transaction.');
        
        let response;
        try {
          response = await x402Fetch(entrypointUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              input: requestInput,
            }),
          });
          
          // Check USDC balance after payment to verify transaction processed
          if (balanceBefore !== null) {
            try {
              await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s for transaction to process
              const balanceDataAfter = await walletProvider.request({
                method: 'eth_call',
                params: [{
                  to: USDC_ADDRESS,
                  data: '0x70a08231' + accountAddress.slice(2).padStart(64, '0')
                }, 'latest']
              });
              const balanceAfter = BigInt(balanceDataAfter);
            } catch (balanceError) {
              console.warn('⚠️ Could not check USDC balance after payment:', balanceError);
            }
          }
        } catch (paymentError) {
          console.error('❌ Payment processing error:', paymentError);
          console.error('❌ Payment error details:', {
            message: paymentError.message,
            stack: paymentError.stack,
            name: paymentError.name,
            code: paymentError.code,
            data: paymentError.data
          });
          throw new Error('Payment failed: ' + (paymentError.message || 'Unknown error. Please check the console for details.'));
        }

        // Check for transaction hash in X-PAYMENT-RESPONSE header
        const paymentResponseHeader = response.headers.get('X-PAYMENT-RESPONSE');
        
        const data = await response.json();
        
        // Extract transaction hash from various possible locations
        let txHash = null;
        let explorerUrl = null;
        
        if (paymentResponseHeader) {
          try {
            const decodedHeader = window.atob(paymentResponseHeader);
            const paymentInfo = JSON.parse(decodedHeader);
            txHash = paymentInfo.txHash || paymentInfo.transactionHash || paymentInfo.hash;
          } catch (e) {
            console.warn('⚠️ Could not parse X-PAYMENT-RESPONSE header:', e);
          }
        }
        
        // Check in response data recursively
        if (!txHash && data.payment) {
          txHash = data.payment.txHash || data.payment.transactionHash || data.payment.hash;
        }
        
        if (!txHash && data.txHash) {
          txHash = data.txHash;
        }
        
        if (!txHash && data.transactionHash) {
          txHash = data.transactionHash;
        }
        
        // Check in nested locations (x402 might store it differently)
        if (!txHash && data.metadata && data.metadata.payment) {
          txHash = data.metadata.payment.txHash || data.metadata.payment.transactionHash || data.metadata.payment.hash;
        }
        
        if (!txHash && data.context && data.context.payment) {
          const paymentCtx = data.context.payment;
          txHash = paymentCtx.txHash || paymentCtx.transactionHash || paymentCtx.hash;
        }
        
        // Check for any field containing "tx" or "hash"
        if (!txHash) {
          for (const key in data) {
            if (key.toLowerCase().includes('tx') || key.toLowerCase().includes('hash')) {
              const value = data[key];
              if (typeof value === 'string' && value.startsWith('0x')) {
                txHash = value;
                break;
              }
            }
          }
        }
        
        const successMarkup = (hash) => {
          const destination = 'Telegram';
          if (!hash) {
            return '<div style="color: #117a39;">' +
              '<p style="font-size: 20px; margin: 0 0 8px;">✅ Payment complete!</p>' +
              '<p style="font-size: 13px; color: #1f5132; margin: 0;">Check ' + destination + ' for your rant.</p>' +
              '</div>';
          }

          const explorer = 'https://basescan.org/tx/' + hash;
          return '<div style="color: #117a39;">' +
            '<p style="font-size: 20px; margin: 0 0 8px;">✅ Payment complete!</p>' +
            '<p style="margin: 0 0 12px;">View on BaseScan: <a href="' + explorer + '" target="_blank" rel="noopener" style="color: #0b5e27;">' + hash + '</a></p>' +
            '<p style="font-size: 13px; color: #1f5132; margin: 0;">Check ' + destination + ' for your rant.</p>' +
            '</div>';
        };

        if (txHash) {
          console.log('✅ Transaction hash found:', txHash);
          status.innerHTML = successMarkup(txHash);
        } else {
          status.innerHTML = successMarkup(null);
        }
        
        if (response.ok) {
          if (cfg.telegramCallback) {
            fetch('/telegram-callback', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                telegram_token: cfg.telegramCallback,
                result: data,
              }),
            }).catch(function(err) {
              console.error('❌ Telegram callback error:', err);
              status.innerHTML += '<p style="color: orange;">⚠️ Payment successful but failed to send to Telegram. Please contact support.</p>';
            });
          }
        } else if (response.status === 402) {
          status.innerHTML = '<p style="color: orange;">💳 Payment required. Please connect your x402 wallet and approve the transaction.</p>';
        } else {
          const errorMsg = data.error ? (data.error.message || JSON.stringify(data)) : JSON.stringify(data);
          status.innerHTML = '<p style="color: red;">❌ Error: ' + errorMsg + '</p>';
        }
      } catch (error) {
        console.error('❌ Payment error:', error);
        status.innerHTML = '<p style="color: red;">❌ Error: ' + error.message + '</p>';
        if (error.message.includes('wallet') || error.message.includes('user rejected') || error.message.includes('User rejected')) {
          status.innerHTML += '<p style="font-size: 12px; color: #666;">Make sure you have an x402 wallet browser extension installed and approved the transaction.</p>';
        } else if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
          status.innerHTML += '<p style="font-size: 12px; color: #666;">Network error. Please check your connection and try again.</p>';
        } else {
          status.innerHTML += '<p style="font-size: 12px; color: #666;">Check browser console (F12) for more details.</p>';
        }
      }
    }
    
    window.pay = pay;
  </script>
</body>
</html>`, {
        headers: { "Content-Type": "text/html" },
      });
    }

    if (url.pathname === "/download" && req.method === "GET") {
      const origin = url.origin.replace(/^http:/, "https:");
      const ogImageUrl = `${origin}/assets/brookerbot-og.png`;
      return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BrookerBot - Generate blistering Charlie Brooker-style rants via x402</title>
  <meta name="description" content="Generate blistering Charlie Brooker-style rants via x402">
  <meta property="og:title" content="BrookerBot - Generate blistering Charlie Brooker-style rants via x402">
  <meta property="og:description" content="Generate blistering Charlie Brooker-style rants via x402">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${origin}/download">
  <meta property="og:image" content="${ogImageUrl}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="BrookerBot - Generate blistering Charlie Brooker-style rants via x402">
  <meta name="twitter:description" content="Generate blistering Charlie Brooker-style rants via x402">
  <meta name="twitter:image" content="${ogImageUrl}">
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #000000 fixed;
      color: #e2e8f0;
      display: flex;
      justify-content: center;
      padding: 48px 16px 96px;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      background: #000000;
      pointer-events: none;
      z-index: -2;
    }
    body::after {
      content: "";
      position: fixed;
      inset: 0;
      background: linear-gradient(180deg, rgba(0, 0, 0, 0.95), rgba(0, 0, 0, 1));
      z-index: -1;
    }
    .page {
      width: min(840px, 100%);
      position: relative;
    }
    .page::before {
      content: "";
      position: absolute;
      inset: -40px;
      background: rgba(0, 0, 0, 0.8);
      filter: blur(120px);
      z-index: -1;
    }
    header {
      margin-bottom: 48px;
      text-align: center;
    }
    h1 {
      margin: 0 0 16px;
      font-size: clamp(2rem, 6vw, 3.2rem);
      letter-spacing: -0.03em;
    }
    p.lead {
      margin: 0 auto;
      max-width: 620px;
      font-size: 1.1rem;
      line-height: 1.6;
      color: #cbd5f5;
    }
    .logo {
      width: 200px;
      aspect-ratio: 1;
      margin: 0 auto 24px;
      position: relative;
      background: transparent;
      border-radius: 0;
      box-shadow: none;
      background-image: url("${ogImageUrl}");
      background-size: contain;
      background-position: center;
      background-repeat: no-repeat;
    }
    section {
      background: linear-gradient(145deg, rgba(0, 0, 0, 0.85), rgba(20, 20, 20, 0.95));
      border: 1px solid rgba(148, 163, 184, 0.1);
      border-radius: 16px;
      padding: 32px;
      margin-bottom: 32px;
      backdrop-filter: blur(14px);
      box-shadow: 0 24px 48px rgba(0, 0, 0, 0.8);
    }
    section h2 {
      margin-top: 0;
      font-size: 1.5rem;
      color: #93c5fd;
    }
    .steps {
      counter-reset: step;
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      gap: 16px;
    }
    .steps li {
      padding: 20px 24px;
      border-radius: 12px;
      background: linear-gradient(160deg, rgba(20, 20, 20, 0.9), rgba(0, 0, 0, 0.95));
      border: 1px solid rgba(148, 163, 184, 0.1);
      position: relative;
      line-height: 1.5;
    }
    .steps li::before {
      counter-increment: step;
      content: counter(step);
      position: absolute;
      left: -14px;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      font-weight: 600;
      background: #ffffff;
      color: #000000;
      box-shadow: 0 8px 18px rgba(255, 255, 255, 0.2);
    }
    .actions {
      display: grid;
      gap: 20px;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    }
    .action-card {
      padding: 28px;
      border-radius: 14px;
      background: linear-gradient(160deg, rgba(0, 0, 0, 0.95), rgba(20, 20, 20, 0.85));
      border: 1px solid rgba(148, 163, 184, 0.15);
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .action-card h3 {
      margin: 0;
      font-size: 1.25rem;
      color: #bfdbfe;
    }
    .action-card p {
      margin: 0;
      color: #cbd5f5;
      line-height: 1.5;
    }
    a.button,
    span.button-disabled {
      margin-top: auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 14px 20px;
      border-radius: 999px;
      font-weight: 600;
      text-decoration: none;
      transition: transform 0.18s ease, box-shadow 0.18s ease;
    }
    a.button {
      background: linear-gradient(120deg, #ffffff, #e0e0e0);
      color: #000000;
      box-shadow: 0 12px 32px rgba(255, 255, 255, 0.2);
    }
    a.button:hover {
      transform: translateY(-1px);
      box-shadow: 0 18px 28px rgba(255, 255, 255, 0.3);
      background: linear-gradient(120deg, #ffffff, #f5f5f5);
    }
    span.button-disabled {
      background: rgba(148, 163, 184, 0.18);
      color: rgba(226, 232, 240, 0.6);
      border: 1px dashed rgba(148, 163, 184, 0.35);
      cursor: not-allowed;
    }
    footer {
      margin-top: 48px;
      text-align: center;
      font-size: 0.85rem;
      color: rgba(226, 232, 240, 0.6);
    }
  </style>
</head>
<body>
  <main class="page">
    <header>
      <div class="logo"></div>
      <h1>BrookerBot</h1>
      <p class="lead">Generate blistering Charlie Brooker-style rants about any topic or person.<br><br>A vitriolic AI that channels the spirit of Black Mirror's creator.</p>
    </header>

    <section>
      <h2>How It Works</h2>
      <ol class="steps">
        <li>Install the bot into your Telegram chat.</li>
        <li>Use <code>/rant &lt;topic&gt;</code> to request a blistering Charlie Brooker-style rant.</li>
        <li>Pay securely via x402 ($1.00), then receive your vitriolic rant right in your chat.</li>
      </ol>
    </section>

    <section>
      <h2>Download</h2>
      <div class="actions">
        <div class="action-card">
          <h3>Telegram Bot</h3>
          <p>Add the bot to your chats and request blistering rants directly inside Telegram.</p>
          <a class="button" href="https://t.me/x402BrookerBot" target="_blank" rel="noopener">Open in Telegram</a>
        </div>
      </div>
    </section>

    <footer>Need help or want early access elsewhere? Contact @lordcumberlord on X.</footer>
  </main>
</body>
</html>`, {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Agent app routes
    if (url.pathname.includes("/entrypoints/") && url.pathname.includes("/invoke")) {
      const isRantEndpoint = url.pathname.includes("rant");
      
      if (isRantEndpoint) {
        const hasPaymentHeader = req.headers.get("X-PAYMENT");
        console.log(`[payment] Entrypoint called: ${url.pathname}`);

        // Determine source label and price based on endpoint
        let sourceLabel: string;
        let defaultPrice: string;
        
        if (isRantEndpoint) {
          sourceLabel = "BrookerBot - Rant";
          defaultPrice = "0.05";
        } else {
          sourceLabel = "BrookerBot";
          defaultPrice = "0.05";
        }

        const payToAddress = (
          process.env.PAY_TO || "0xc989ead84f34a0532a74cb4d6dd8fcdb91a6aa69"
        ).toLowerCase();
        const facilitatorUrl =
          process.env.FACILITATOR_URL || "https://facilitator.x402.rs";
          // Ensure AGENT_URL has https:// prefix if it's just a domain
          let agentBaseUrl = process.env.AGENT_URL || `https://brookerbot-production.up.railway.app`;
          if (!agentBaseUrl.startsWith("http://") && !agentBaseUrl.startsWith("https://")) {
            agentBaseUrl = `https://${agentBaseUrl}`;
          }
        // Construct full entrypoint URL without query parameters (resource should be clean)
        const fullEntrypointUrl = agentBaseUrl + url.pathname;
        const price = process.env.ENTRYPOINT_PRICE || defaultPrice || "0.05";
        const currency = process.env.PAYMENT_CURRENCY || "USDC";
        const x402Version = 1.0;

        const paymentRequirement = {
          scheme: "exact" as const,
          resource: fullEntrypointUrl,
          description: `${sourceLabel} - Pay $${price} ${currency}`,
          mimeType: "application/json",
          payTo: payToAddress,
          maxAmountRequired: "50000", // 0.05 USDC (50000 / 10^6)
          maxTimeoutSeconds: 300,
          network: "base" as const,
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          extra: {
            name: "USD Coin",
            version: "2",
          },
        };
        const paymentRequirements = [paymentRequirement];

        if (!hasPaymentHeader) {
          console.log(`[payment] Returning 402 Payment Required for: ${fullEntrypointUrl}`);
          return Response.json(
            {
              x402Version,
              accepts: paymentRequirements,
            },
            { status: 402 }
          );
        }

        let decodedPayment;
        try {
          decodedPayment = exact.evm.decodePayment(hasPaymentHeader);
          decodedPayment.x402Version = x402Version;
        } catch (error) {
          console.error("[payment] Failed to decode X-PAYMENT header", error);
          return Response.json(
            {
              error: "Invalid or malformed payment header",
              accepts: paymentRequirements,
              x402Version,
            },
            { status: 402 }
          );
        }

        const selectedPaymentRequirements = findMatchingPaymentRequirements(
          paymentRequirements,
          decodedPayment
        );

        if (!selectedPaymentRequirements) {
          console.error("[payment] Unable to match payment requirements", decodedPayment);
          return Response.json(
            {
              error: "Unable to match payment requirements",
              accepts: paymentRequirements,
              x402Version,
            },
            { status: 402 }
          );
        }

        const facilitatorClient = useFacilitator({
          url: facilitatorUrl as `${string}://${string}`,
        });
        console.log("[payment] 📋 Payment verification inputs:", {
          facilitatorUrl,
          decodedPaymentKeys: Object.keys(decodedPayment),
          paymentAmount: decodedPayment.amount,
          paymentResource: decodedPayment.resource,
          selectedRequirements: {
            resource: selectedPaymentRequirements.resource,
            maxAmountRequired: selectedPaymentRequirements.maxAmountRequired,
            payTo: selectedPaymentRequirements.payTo,
          },
        });
        
        let verification;
        try {
          verification = await facilitatorClient.verify(
            decodedPayment,
            selectedPaymentRequirements
          );
          console.log("[payment] ✅ Verification result:", {
            isValid: verification.isValid,
            invalidReason: verification.invalidReason,
            payer: verification.payer,
            keys: Object.keys(verification),
          });
        } catch (error: any) {
          console.error("[payment] ❌ Facilitator verification error", error);
          console.error("[payment] Verification error details:", {
            message: error?.message,
            name: error?.name,
            response: error?.response ? {
              status: error.response.status,
              statusText: error.response.statusText,
              data: typeof error.response.data === 'string' 
                ? error.response.data.substring(0, 500)
                : JSON.stringify(error.response.data).substring(0, 500),
            } : undefined,
          });
          return Response.json(
            {
              error: "Failed to verify payment",
              accepts: paymentRequirements,
              x402Version,
            },
            { status: 402 }
          );
        }

        if (!verification.isValid) {
          console.error("[payment] ❌ Payment verification failed", verification);
          return Response.json(
            {
              error: verification.invalidReason || "Payment verification failed",
              accepts: paymentRequirements,
              payer: verification.payer,
              x402Version,
            },
            { status: 402 }
          );
        }
        
        console.log("[payment] ✅ Payment verified successfully, proceeding to handler...");

        const appResponse = await app.fetch(req);

        if (appResponse.status >= 400) {
          return appResponse;
        }

        const appResponseClone = appResponse.clone();
        let settlement;
        let settlementTimedOut = false;
        try {
          console.log("[payment] 🔄 Attempting settlement...");
          console.log("[payment] Settlement inputs:", {
            decodedPaymentKeys: Object.keys(decodedPayment),
            paymentAmount: decodedPayment.amount,
            paymentResource: decodedPayment.resource,
            selectedRequirements: {
              resource: selectedPaymentRequirements.resource,
              maxAmountRequired: selectedPaymentRequirements.maxAmountRequired,
              payTo: selectedPaymentRequirements.payTo,
            },
          });
          
          // Add timeout wrapper for settlement (30 seconds)
          settlement = await Promise.race([
            facilitatorClient.settle(
              decodedPayment,
              selectedPaymentRequirements
            ),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error("Settlement timeout after 30 seconds")), 30000)
            )
          ]) as any;
          
          console.log("[payment] Settlement response:", {
            success: settlement.success,
            hasError: !!settlement.errorReason,
            errorReason: settlement.errorReason,
            payer: settlement.payer,
            keys: Object.keys(settlement),
          });
        } catch (error: any) {
          // Check if it's a timeout error
          const isTimeout = error?.name === "TimeoutError" || 
                           error?.message?.includes("timeout") || 
                           error?.message?.includes("Timeout");
          
          if (isTimeout) {
            console.warn("[payment] ⚠️ Settlement timed out, but payment was verified - proceeding with response");
            console.warn("[payment] Settlement timeout details:", {
              message: error?.message,
              name: error?.name,
            });
            settlementTimedOut = true;
            // Continue execution - payment was already verified, handler already ran
            // Settlement can be retried later or handled separately
          } else {
            console.error("[payment] ❌ Facilitator settlement error", error);
            console.error("[payment] Error details:", {
              message: error?.message,
              name: error?.name,
              stack: error?.stack?.substring(0, 500),
              response: error?.response ? {
                status: error.response.status,
                statusText: error.response.statusText,
                data: typeof error.response.data === 'string' 
                  ? error.response.data.substring(0, 500)
                  : JSON.stringify(error.response.data).substring(0, 500),
              } : undefined,
            });
            // For non-timeout errors, still return error (could be invalid payment)
            return Response.json(
              {
                error: "Failed to settle payment",
                accepts: paymentRequirements,
                x402Version,
              },
              { status: 402 }
            );
          }
        }

        // Only check settlement.success if we actually got a settlement response
        if (!settlementTimedOut && settlement && !settlement.success) {
          console.error("[payment] Settlement failed", settlement);
          return Response.json(
            {
              error: settlement.errorReason || "Failed to settle payment",
              accepts: paymentRequirements,
              payer: settlement.payer,
              x402Version,
            },
            { status: 402 }
          );
        }

        const headers = new Headers(appResponse.headers);
        
        // Only set settlement header if we successfully settled
        if (!settlementTimedOut && settlement) {
          const settlementHeader = settleResponseHeader(settlement);
          console.log(`[payment] Settlement succeeded:`, settlement);
          headers.set("X-PAYMENT-RESPONSE", settlementHeader);
        } else {
          console.warn("[payment] ⚠️ Proceeding without settlement header due to timeout");
        }
        const responseWithHeader = new Response(appResponse.body, {
          status: appResponse.status,
          statusText: appResponse.statusText,
          headers,
        });

        return responseWithHeader;
      }
    }
    
    // Agent app routes
    return app.fetch(req);
    } catch (error: any) {
      console.error("[server] Unhandled error in fetch:", error);
      return new Response(
        JSON.stringify({ error: "Internal server error", message: error?.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
  error(error) {
    console.error("[server] Server error:", error);
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(
  `🚀 Agent ready at http://${server.hostname}:${server.port}/.well-known/agent.json`
);

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
// Ensure PUBLIC_WEB_URL has https:// prefix if it's just a domain
const getPublicBaseUrl = () => {
  const publicUrl = process.env.PUBLIC_WEB_URL || process.env.AGENT_URL;
  if (publicUrl) {
    // If it's just a domain (no http:// or https://), add https://
    if (!publicUrl.startsWith("http://") && !publicUrl.startsWith("https://")) {
      return `https://${publicUrl}`;
    }
    return publicUrl;
  }
  return `http://${server.hostname}:${server.port}`;
};
const publicBaseUrl = getPublicBaseUrl();

if (telegramToken) {
  if (!publicBaseUrl.startsWith("http")) {
    console.warn(
      "[telegram] PUBLIC_WEB_URL or AGENT_URL should be set to a full URL for Telegram payment links"
    );
  }

  (async () => {
    try {
      // Delete any existing webhook first (webhooks prevent polling from working)
      try {
        await fetch(`https://api.telegram.org/bot${telegramToken}/deleteWebhook`, {
          method: "POST",
          body: JSON.stringify({ drop_pending_updates: true }),
          headers: { "Content-Type": "application/json" },
        });
        console.log("[telegram] Deleted any existing webhook to enable polling");
      } catch (webhookError: any) {
        if (webhookError?.response?.status === 404) {
          console.log("[telegram] No existing webhook to delete (this is fine)");
        } else {
          console.warn("[telegram] Error deleting webhook (continuing anyway):", webhookError?.message);
        }
      }

      const bot = createTelegramBot({
        token: telegramToken,
        baseUrl: publicBaseUrl,
      });
      await bot.start();
      console.log("🤖 Telegram bot ready and polling for commands");
    } catch (err: any) {
      // Handle 409 conflict gracefully (multiple instances running)
      if (err?.error_code === 409) {
        console.warn("[telegram] Bot already running elsewhere (409 conflict). Skipping local bot start.");
        console.warn("[telegram] This is normal if the bot is running on Railway or in another terminal.");
        return;
      }
      // Handle 404 errors - usually means invalid token or bot doesn't exist
      if (err?.error_code === 404) {
        if (err?.method === "deleteWebhook") {
          console.warn("[telegram] No webhook to delete (404) - this is normal for new bots");
        } else if (err?.method === "getMe") {
          console.error("[telegram] Bot token appears invalid (404 on getMe). Check TELEGRAM_BOT_TOKEN in Railway.");
        } else {
          console.warn(`[telegram] 404 error on ${err?.method || "unknown method"}: ${err?.description || "Not Found"}`);
        }
        // Don't crash server - continue without Telegram bot
        return;
      }
      // For any other errors, log but don't crash
      console.error("[telegram] Failed to start bot:", err?.message || err);
    }
  })();
} else {
  console.log("[telegram] TELEGRAM_BOT_TOKEN not set; Telegram bot disabled");
}
