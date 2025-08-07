// userStrategy.ts
require('dotenv').config();
// Handles Honey Points strategy logic for Telegram bot

// No need to import fs since all operations are on the in-memory users object

export type HoneyToken = {
  address: string;
  buyAmount: number;
  profitPercents: number[]; // Profit percentages for each stage
  soldPercents: number[];   // Sell percentages for each stage
  lastEntryPrice?: number;
  lastSellPrice?: number;
  finished?: boolean;
  status?: 'pending' | 'active' | 'sold' | 'error'; // For bot UI feedback
  currentStage?: number; // Track which profit stage is next
  lastTxId?: string; // Last transaction ID for feedback
};

export type HoneySettings = {
  tokens: HoneyToken[];
  repeatOnEntry: boolean;
};

/**
 * Get user's Honey Points strategy settings
 */
export function getHoneySettings(userId: string, users: Record<string, any>): HoneySettings {
  if (!users[userId] || !users[userId].honeySettings) {
    return { tokens: [], repeatOnEntry: true };
  }
  // Ensure tokens is an array
  const settings = users[userId].honeySettings;
  return {
    tokens: Array.isArray(settings.tokens) ? settings.tokens : [],
    repeatOnEntry: typeof settings.repeatOnEntry === 'boolean' ? settings.repeatOnEntry : true
  };
}

/**
 * Save user's Honey Points strategy settings
 */
export function setHoneySettings(userId: string, settings: HoneySettings, users: Record<string, any>) {
  if (!users[userId]) users[userId] = {};
  users[userId].honeySettings = settings;
}

/**
 * Add a new token to the Honey Points strategy
 */
export function addHoneyToken(userId: string, token: HoneyToken, users: Record<string, any>) {
  const settings = getHoneySettings(userId, users);
  if (settings.tokens.length >= 10) throw new Error('Maximum 10 tokens allowed.');
  // Prevent duplicates
  if (settings.tokens.some(t => t.address === token.address)) {
    throw new Error('Token already exists in strategy.');
  }
  settings.tokens.push(token);
  setHoneySettings(userId, settings, users);
}

/**
 * Remove a token from the Honey Points strategy
 */
export function removeHoneyToken(userId: string, tokenAddress: string, users: Record<string, any>) {
  const settings = getHoneySettings(userId, users);
  settings.tokens = settings.tokens.filter(t => t.address !== tokenAddress);
  setHoneySettings(userId, settings, users);
}

/**
 * Reset all tokens in the Honey Points strategy
 */
export function resetHoneyTokens(userId: string, users: Record<string, any>) {
  setHoneySettings(userId, { tokens: [], repeatOnEntry: true }, users);
}

/**
 * Execute Honey Points strategy for the user (auto buy/sell by stages)
 */
export async function executeHoneyStrategy(
  userId: string,
  users: Record<string, any>,
  getPrice: (address: string) => Promise<number>,
  autoBuy: (address: string, amount: number, secret: string) => Promise<string>,
  autoSell: (address: string, amount: number, secret: string) => Promise<string>
) {
  const user = users[userId];
  if (!user || !user.secret) throw new Error('Wallet not found');
  const settings = getHoneySettings(userId, users);
  for (const token of settings.tokens) {
    // Ignore tokens with missing essential data
    if (!token.address || !token.buyAmount || !Array.isArray(token.profitPercents) || !Array.isArray(token.soldPercents) || token.profitPercents.length === 0 || token.soldPercents.length === 0) {
      token.status = 'error';
      continue;
    }
    if (token.finished) {
      token.status = 'sold';
      continue;
    }
    let currentPrice: number;
    try {
      currentPrice = await getPrice(token.address);
    } catch (e) {
      token.status = 'error';
      continue; // Skip token if price fetch fails
    }
    if (!token.lastEntryPrice) {
      // Initial buy
      try {
        const txId = await autoBuy(token.address, token.buyAmount, user.secret);
        token.lastEntryPrice = currentPrice;
        token.status = 'active';
        token.currentStage = 0;
        token.lastTxId = txId;
      } catch (e) {
        token.status = 'error';
        continue; // Skip if buy fails
      }
      continue;
    }
    // Profit stages
    for (let i = token.currentStage || 0; i < token.profitPercents.length; i++) {
      const target = token.lastEntryPrice * (1 + token.profitPercents[i] / 100);
      if (
        currentPrice >= target &&
        (!token.lastSellPrice || currentPrice > token.lastSellPrice)
      ) {
        const sellAmount = token.buyAmount * (token.soldPercents[i] / 100);
        try {
          const txId = await autoSell(token.address, sellAmount, user.secret);
          token.lastSellPrice = currentPrice;
          token.currentStage = i + 1;
          token.lastTxId = txId;
          if (token.currentStage >= token.profitPercents.length) {
            token.finished = true;
            token.status = 'sold';
          }
        } catch (e) {
          token.status = 'error';
          continue; // Skip if sell fails
        }
      }
    }
    // If all sold and price returns, repeat if allowed
    const totalSold = token.soldPercents.reduce((a, b) => a + b, 0);
    if (
      totalSold >= 100 &&
      settings.repeatOnEntry &&
      currentPrice <= (token.lastEntryPrice ?? 0)
    ) {
      token.finished = false;
      token.lastEntryPrice = undefined;
      token.lastSellPrice = undefined;
      token.status = 'pending';
      token.currentStage = 0;
      token.lastTxId = undefined;
    }
  }
  setHoneySettings(userId, settings, users);
}