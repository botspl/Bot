import crypto from 'crypto';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import { STRATEGY_FIELDS, buildTokenMessage, autoFilterTokens, notifyUsers } from './src/utils/tokenUtils';
import { Markup, Telegraf } from 'telegraf';
import fetch from 'node-fetch';
import { loadUsers, saveUsers, walletKeyboard, getErrorMessage, limitHistory, hasWallet } from './src/bot/helpers';
import { helpMessages } from './src/helpMessages';
import { unifiedBuy, unifiedSell } from './src/tradeSources';
import { filterTokensByStrategy } from './src/bot/strategy';

console.log('Loaded TELEGRAM_BOT_TOKEN:', process.env.TELEGRAM_BOT_TOKEN);

// Define your bot with the token from environment variables
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
console.log('🚀 Telegram bot script loaded.');

// Users object to store user data
let users: Record<string, any> = loadUsers();

// SENT_TOKENS_DIR for message deduplication
const SENT_TOKENS_DIR = path.join(__dirname, 'sent_tokens');
fs.mkdirSync(SENT_TOKENS_DIR, { recursive: true });

// Get sent_tokens file name for each user
function getUserSentFile(userId: string): string {
  return path.join(SENT_TOKENS_DIR, `${userId}.json`);
}

// Simple file lock
function lockFile(file: string): Promise<void> {
  const lockPath = file + '.lock';
  return new Promise((resolve) => {
    const tryLock = () => {
      if (!fs.existsSync(lockPath)) {
        fs.writeFileSync(lockPath, String(Date.now()));
        setTimeout(resolve, 10); // Small delay
      } else {
        // If lock is old > 2 seconds, delete it
        try {
          const ts = Number(fs.readFileSync(lockPath, 'utf8'));
          if (Date.now() - ts > 2000) fs.unlinkSync(lockPath);
        } catch {}
        setTimeout(tryLock, 20);
      }
    };
    tryLock();
  });
}

function unlockFile(file: string) {
  const lockPath = file + '.lock';
  if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
}

// Hash a token address (normalized)
export function hashTokenAddress(addr: string): string {
  return crypto.createHash('sha256').update(addr.trim().toLowerCase()).digest('hex');
}

// Read all valid hashes for the user (with smart cleanup)
export async function readSentHashes(userId: string): Promise<Set<string>> {
  const file = getUserSentFile(userId);
  await lockFile(file);
  let hashes: string[] = [];
  const now = Date.now();
  let arr: any[] = [];
  let valid: any[] = [];
  try {
    if (fs.existsSync(file)) {
      arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(arr)) arr = [];
      // Remove expired (older than 1 day)
      valid = arr.filter((obj: any) => obj && obj.hash && (now - (obj.ts || 0) < 24 * 60 * 60 * 1000));
      hashes = valid.map(obj => obj.hash);
      // If length changed, rewrite with smart error handling
      if (valid.length !== arr.length) {
        let retry = 0;
        while (retry < 3) {
          try {
            fs.writeFileSync(file, JSON.stringify(valid));
            break;
          } catch (e) {
            retry++;
            await new Promise(res => setTimeout(res, 50 * retry));
            if (retry === 3) console.warn(`[sent_tokens] Failed to clean (read) ${file} after retries:`, e);
          }
        }
      }
    }
  } catch (e) {
    console.warn(`[sent_tokens] Failed to read/clean ${file}:`, e);
  }
  unlockFile(file);
  return new Set(hashes);
}

// Add a new hash for the user (with deduplication and cleanup)
export async function appendSentHash(userId: string, hash: string) {
  const file = getUserSentFile(userId);
  await lockFile(file);
  const now = Date.now();
  let arr: any[] = [];
  try {
    if (fs.existsSync(file)) {
      arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(arr)) arr = [];
    }
    // Remove expired (older than 1 day)
    arr = arr.filter((obj: any) => obj && obj.hash && (now - (obj.ts || 0) < 24 * 60 * 60 * 1000));
    // Prevent duplicates
    if (arr.some(obj => obj.hash === hash)) {
      unlockFile(file);
      return;
    }
    arr.push({ hash, ts: now });
    // If reached 3000 or more, delete oldest 10
    if (arr.length >= 3000) {
      arr = arr.slice(10);
    }
    // If exceeded max per user (6000), keep only last 6000
    if (arr.length > 6000) {
      arr = arr.slice(arr.length - 6000);
    }
    // Smart error handling on write
    let retry = 0;
    while (retry < 3) {
      try {
        fs.writeFileSync(file, JSON.stringify(arr));
        break;
      } catch (e) {
        retry++;
        await new Promise(res => setTimeout(res, 50 * retry));
        if (retry === 3) console.warn(`[sent_tokens] Failed to write ${file} after retries:`, e);
      }
    }
  } catch (e) {
    console.warn(`[sent_tokens] Failed to write ${file}:`, e);
  }
  unlockFile(file);
}

// Log every incoming update for tracing
bot.use((ctx: any, next: any) => {
  let text = undefined;
  let data = undefined;
  if ('message' in ctx && ctx.message && typeof ctx.message === 'object' && 'text' in ctx.message) {
    text = ctx.message.text;
  }
  if ('callbackQuery' in ctx && ctx.callbackQuery && typeof ctx.callbackQuery === 'object' && 'data' in ctx.callbackQuery) {
    data = ctx.callbackQuery.data;
  }
  console.log('📥 Incoming update:', {
    type: ctx.updateType,
    from: ctx.from?.id,
    text,
    data
  });
  return next();
});

// Helper: Register user if new, always returns the user object
function getOrRegisterUser(ctx: any): any {
  const userId = String(ctx.from?.id);
  if (!users[userId]) {
    users[userId] = {
      id: userId,
      username: ctx.from?.username || '',
      firstName: ctx.from?.first_name || '',
      registeredAt: Date.now(),
      trades: 0,
      activeTrades: 1,
      history: [],
    };
    saveUsers(users);
  }
  return users[userId];
}

// Restore Wallet button handler
const restoreWalletSessions: Record<string, boolean> = {};
bot.action('restore_wallet', async (ctx: any) => {
  const userId = String(ctx.from?.id);
  restoreWalletSessions[userId] = true;
  await ctx.answerCbQuery();
  await ctx.reply(
    '🔑 Please send your private key, mnemonic, or JSON array to restore your wallet.\n\n' +
    'Supported formats: base64, base58, hex, or 12/24-word mnemonic.\n' +
    '<b>Warning:</b> Never share your private key with anyone you do not trust!',
    { parse_mode: 'HTML' }
  );
});

// Handler for processing wallet restoration input
bot.on('text', async (ctx: any, next: any) => {
  const userId = String(ctx.from?.id);
  if (!restoreWalletSessions[userId]) return next();
  const input = ctx.message.text.trim();
  const { parseKey } = await import('./src/wallet');
  try {
    const keypair = parseKey(input);
    users[userId].wallet = keypair.publicKey.toBase58();
    users[userId].secret = Buffer.from(keypair.secretKey).toString('base64');
    users[userId].history = users[userId].history || [];
    users[userId].history.push('Restored wallet');
    saveUsers(users);
    delete restoreWalletSessions[userId];
    await ctx.reply('✅ Wallet restored successfully! Your address: ' + users[userId].wallet);
    await sendMainMenu(ctx);
  } catch (error: any) {
    await ctx.reply('❌ Failed to restore wallet. Supported formats: base58, base64, hex, mnemonic, JSON array, or comma-separated numeric array.\n\nError: ' + (error instanceof Error ? error.message : String(error)));
  }
});

// Create Wallet button handler
bot.action('create_wallet', async (ctx: any) => {
  const user = getOrRegisterUser(ctx);
  const { generateKeypair } = await import('./src/wallet');
  try {
    const keypair = generateKeypair();
    user.wallet = keypair.publicKey.toBase58();
    user.secret = Buffer.from(keypair.secretKey).toString('base64');
    user.history = user.history || [];
    user.history.push('Created new wallet');
    saveUsers(users);
    await ctx.reply('✅ New wallet created! Your address: ' + user.wallet);
    await sendMainMenu(ctx);
  } catch (error: any) {
    await ctx.reply('❌ Failed to create wallet: ' + (error instanceof Error ? error.message : String(error)));
  }
});

// Show Wallet button handler
bot.action('my_wallet', async (ctx: any) => {
  const user = getOrRegisterUser(ctx);
  await ctx.answerCbQuery();
  let replyText = user.wallet
    ? `👛 Your wallet address:\n<code>${user.wallet}</code>`
    : 'You do not have a wallet yet. Use the "Create Wallet" button to generate one.';
  let buttons: { text: string; callback_data: string }[][] = [];
  if (user.wallet) {
    buttons.push([{ text: '🔑 Show Private Key', callback_data: 'show_private_key' }]);
  }
  await ctx.reply(replyText, {
    parse_mode: 'HTML',
    reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined
  });
});

// Show Private Key button handler
bot.action('show_private_key', async (ctx: any) => {
  const userId = String(ctx.from?.id);
  const user = users[userId];
  if (!user || !user.secret) {
    return await ctx.reply('❌ No wallet found. Please create or restore your wallet first.', walletKeyboard());
  }
  // Try to show in base64, base58, hex if possible
  let base64 = user.secret;
  let base58 = '';
  let hex = '';
  try {
    const { parseKey } = await import('./src/wallet');
    const keypair = parseKey(base64);
    const secretKey = Buffer.from(keypair.secretKey);
    base58 = require('bs58').encode(secretKey);
    hex = secretKey.toString('hex');
  } catch {}
  let msg = '⚠️ <b>Your private key:</b>\n';
  msg += `<b>Base64:</b> <code>${base64}</code>\n`;
  if (base58) msg += `<b>Base58:</b> <code>${base58}</code>\n`;
  if (hex) msg += `<b>Hex:</b> <code>${hex}</code>\n`;
  await ctx.reply(msg, { parse_mode: 'HTML' });
});

// Strategy fields
let strategyWizard: Record<string, { step: number; data: any }> = {};

// Start Strategy button handler
bot.action('set_strategy', async (ctx: any) => {
  const userId = String(ctx.from?.id);
  strategyWizard[userId] = { step: 0, data: {} };
  await ctx.answerCbQuery();
  await askStrategyField(ctx, userId);
});

// Cancel Strategy button handler
bot.action('cancel_strategy', async (ctx: any) => {
  const userId = String(ctx.from?.id);
  delete strategyWizard[userId];
  await ctx.answerCbQuery('Strategy setup cancelled.');
  await ctx.reply('❌ Strategy setup cancelled.');
  await sendMainMenu(ctx);
});

// Strategy field input handler
bot.on('text', async (ctx: any, next: any) => {
  const userId = String(ctx.from?.id);
  const wizard = strategyWizard[userId];
  if (!wizard) return next();
  
  const text = ctx.message.text.trim().toLowerCase();
  if (text === 'cancel') {
    delete strategyWizard[userId];
    await ctx.reply('❌ Strategy setup cancelled.');
    await sendMainMenu(ctx);
    return;
  }

  const field = STRATEGY_FIELDS[wizard.step];
  let value = ctx.message.text.trim();

  if (value.toLowerCase() === 'skip' && field.optional) {
    wizard.data[field.key] = undefined;
  } else if (field.type === 'number') {
    const num = Number(value);
    if (isNaN(num)) {
      await ctx.reply('❌ Please enter a valid number or type skip.');
      return;
    }
    wizard.data[field.key] = num;
  } else if (field.type === 'boolean') {
    if (['yes', 'y', 'true', '✅'].includes(value.toLowerCase())) {
      wizard.data[field.key] = true;
    } else if (['no', 'n', 'false', '❌'].includes(value.toLowerCase())) {
      wizard.data[field.key] = false;
    } else {
      await ctx.reply('❌ Please answer with Yes or No.');
      return;
    }
  } else {
    wizard.data[field.key] = value;
  }

  wizard.step++;
  if (wizard.step < STRATEGY_FIELDS.length) {
    await askStrategyField(ctx, userId);
  } else {
    await ctx.reply('📝 Please review your strategy below:', { parse_mode: 'HTML' });
    await ctx.reply(formatStrategySummary(wizard.data), {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirm', 'confirm_strategy'), Markup.button.callback('❌ Cancel', 'cancel_strategy')]
      ])
    });
  }
});

// Confirm Strategy button handler
bot.action('confirm_strategy', async (ctx: any) => {
  const userId = String(ctx.from?.id);
  const user = users[userId];
  const wizard = strategyWizard[userId];

  if (!user || !user.wallet) {
    await ctx.answerCbQuery('❌ You must create or restore a wallet first.');
    await ctx.reply('❌ You must create or restore a wallet first.', walletKeyboard());
    return;
  }

  if (!wizard || !wizard.data) {
    await ctx.answerCbQuery('No strategy to confirm.');
    return;
  }

  user.strategy = { ...wizard.data, enabled: true };
  saveUsers(users);
  delete strategyWizard[userId];

  await ctx.answerCbQuery('Strategy confirmed!');
  await ctx.reply('✅ Your strategy has been saved and activated.');
  await sendMainMenu(ctx);
});

// Show Activity button handler
bot.action('show_activity', async (ctx: any) => {
  const user = getOrRegisterUser(ctx);
  await ctx.answerCbQuery();

  if (!user.wallet || !user.secret) {
    await ctx.reply('❌ No wallet found. Please create or restore your wallet first.', walletKeyboard());
    return;
  }

  await ctx.reply('⏳ Fetching your wallet tokens and recent trades...');

  let tokensMsg = '<b>👛 Your Wallet Tokens:</b>\n';
  let hasTokens = false;

  try {
    const { getConnection } = await import('./src/wallet');
    const conn = getConnection();
    const { PublicKey } = await import('@solana/web3.js');
    const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
    
    const pk = new PublicKey(user.wallet);
    
    // Fetch SOL balance
    const solBalance = await conn.getBalance(pk);
    tokensMsg += `• <b>SOL:</b> <code>${(solBalance / 1e9).toFixed(4)}</code>\n`;
    
    // Fetch SPL token accounts
    const tokenAccounts = (await conn.getParsedTokenAccountsByOwner(pk, { programId: TOKEN_PROGRAM_ID })).value;
    
    if (tokenAccounts.length > 0) {
      for (const acc of tokenAccounts) {
        const info = acc.account.data.parsed.info;
        const mint = info.mint;
        const amount = info.tokenAmount.uiAmountString;
        if (Number(amount) > 0) {
          tokensMsg += `• <b>Token:</b> <code>${mint}</code> | <b>Balance:</b> <code>${amount}</code>\n`;
          hasTokens = true;
        }
      }
    }
    
    if (!hasTokens && solBalance === 0) {
      tokensMsg += '<i>No tokens or SOL found in your wallet.</i>\n';
    }
  } catch (error: any) {
    tokensMsg += '<i>Failed to fetch wallet tokens: ' + (error instanceof Error ? error.message : String(error)) + '</i>\n';
  }

  // Show last trades from history
  let tradesMsg = '\n<b>📈 Your Recent Trades:</b>\n';
  const tradeEntries = (user.history || []).filter((entry: string) => /ManualBuy|AutoBuy|Sell/i.test(entry));
  
  if (tradeEntries.length === 0) {
    tradesMsg += '<i>No trades found.</i>';
  } else {
    const lastTrades = tradeEntries.slice(-10).reverse();
    for (const t of lastTrades) {
      let formatted = t;
      const buyMatch = t.match(/(ManualBuy|AutoBuy): ([^|]+) \| Amount: ([^ ]+) SOL \| Source: ([^|]+) \| Tx: ([^\s]+)/);
      if (buyMatch) {
        formatted = `• <b>${buyMatch[1]}</b> <code>${buyMatch[2]}</code> | <b>Amount:</b> <code>${buyMatch[3]}</code> SOL | <b>Source:</b> <code>${buyMatch[4]}</code> | <a href='https://solscan.io/tx/${buyMatch[5]}'>View Tx</a>`;
      }
      const sellMatch = t.match(/Sell: ([^|]+) \| Amount: ([^ ]+) SOL \| Source: ([^|]+) \| Tx: ([^\s]+)/);
      if (sellMatch) {
        formatted = `• <b>Sell</b> <code>${sellMatch[1]}</code> | <b>Amount:</b> <code>${sellMatch[2]}</code> SOL | <b>Source:</b> <code>${sellMatch[3]}</code> | <a href='https://solscan.io/tx/${sellMatch[4]}'>View Tx</a>`;
      }
      tradesMsg += formatted + '\n';
    }
  }

  await ctx.reply(tokensMsg + tradesMsg, { parse_mode: 'HTML', disable_web_page_preview: true });
});

// Helper function to format strategy summary
function formatStrategySummary(data: any): string {
  let msg = '<b>Strategy Summary:</b>\n';
  for (const field of STRATEGY_FIELDS) {
    let val = data[field.key];
    if (val === undefined) val = '<i>Not set</i>';
    let label = field.label;
    if (field.key === 'age') label = 'Minimum Age (minutes)';
    msg += `• <b>${label}:</b> <code>${val}</code>\n`;
  }
  return msg;
}

// Helper function to ask for strategy field
async function askStrategyField(ctx: any, userId: string) {
  const wizard = strategyWizard[userId];
  const field = STRATEGY_FIELDS[wizard.step];
  let msg = `Step ${wizard.step + 1}/${STRATEGY_FIELDS.length}\n`;
  msg += `Set <b>${field.label}</b>`;
  
  if (field.type === 'boolean') {
    msg += ` (Yes/No)`;
  } else if (field.optional) {
    msg += ` (or type skip)`;
  }
  
  let current = wizard.data[field.key];
  if (current !== undefined) {
    msg += `\nCurrent: <code>${current}</code>`;
  }
  
  msg += `\n<em>Type 'Cancel' anytime to exit.</em>`;
  
  await ctx.reply(msg, { 
    parse_mode: 'HTML',
    ...Markup.keyboard([['Cancel']]).oneTime().resize()
  });
}

// Show main menu
async function sendMainMenu(ctx: any) {
  await ctx.reply(
    '📱 Main Menu\nSelect an option:',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🟢 Buy', 'buy'), Markup.button.callback('🔴 Sell', 'sell')],
        [Markup.button.callback('⚙️ Strategy', 'set_strategy'), Markup.button.callback('🍯 Honey Points', 'honey_points')],
        [Markup.button.callback('📊 Activity', 'show_activity'), Markup.button.callback('👛 Wallet', 'my_wallet')],
        [Markup.button.callback('💰 Sell All', 'sell_all_wallet'), Markup.button.callback('📋 Copy Trade', 'copy_trade')],
        [Markup.button.callback('🔗 Invite Friends', 'invite_friends')],
        [Markup.button.callback('🪙 Show Tokens', 'show_tokens')],
        [Markup.button.callback('🔑 Restore Wallet', 'restore_wallet'), Markup.button.callback('🆕 Create Wallet', 'create_wallet')]
      ])
    }
  );
}

// Start command handler
bot.start(async (ctx: any) => {
  const user = getOrRegisterUser(ctx);
  await ctx.reply('👋 Welcome! You are now registered. Here is the main menu:', { parse_mode: 'HTML' });
  await sendMainMenu(ctx);
});

// Run the bot
if (require.main === module) {
  bot.launch()
    .then(() => console.log('✅ Telegram bot started and listening for users!'))
    .catch((err: any) => console.error('❌ Bot launch failed:', err));

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
