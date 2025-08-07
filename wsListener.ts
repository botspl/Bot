



import { fetchDexScreenerTokens } from './src/utils/tokenUtils';
import { saveUsers } from './src/bot/helpers';
import { unifiedBuy, unifiedSell } from './src/tradeSources';

/**
 * Entry point for market monitoring and user notifications
 */
function registerWsNotifications(bot: any, users: Record<string, any>) {
  async function pollAndNotify() {
    try {
      // Fetch only Solana tokens, limit to 100, and filter by min liquidity at API level if supported
      const tokens = await fetchDexScreenerTokens('solana', { limit: '100' });
      // Filter tokens: exclude tokens with low liquidity or marked as scam
      // Still filter for scam tokens locally
      const filteredTokens = tokens.filter((token: any) => {
        const notScam = !(token.baseToken?.symbol?.toLowerCase().includes('scam') || token.baseToken?.name?.toLowerCase().includes('scam'));
        return notScam;
      });

      // Import required functions
      const { buildTokenMessage } = await import('./src/utils/tokenUtils');
      const { filterTokensByStrategy } = await import('./src/bot/strategy');

      // Import hash and sent-tokens helpers from telegramBot.ts
      const { hashTokenAddress, readSentHashes, appendSentHash } = await import('./telegramBot');

      for (const userId of Object.keys(users)) {
        const user = users[userId];
        // Robustly check user, wallet, and strategy
        if (!user || !user.wallet || !user.secret || !user.strategy || !user.strategy.enabled) continue;
        // Filter tokens for each user based on their actual strategy
        let userTokens = filterTokensByStrategy(filteredTokens, user.strategy);
        // Exclude tokens already sent to this user
        const sentHashes = await readSentHashes(userId);
        userTokens = userTokens.filter(token => {
          const addr = token.pairAddress || token.address || token.tokenAddress || '';
          const hash = hashTokenAddress(addr);
          return !sentHashes.has(hash);
        });
        if (!userTokens || userTokens.length === 0) continue;
        // Limit number of tokens sent (e.g. first 10)
        const limitedTokens = userTokens.slice(0, 10);
        const botUsername = bot.botInfo?.username || process.env.BOT_USERNAME || 'YourBotUsername';
        for (const token of limitedTokens) {
          const addr = token.pairAddress || token.address || token.tokenAddress || '';
          const hash = hashTokenAddress(addr);
          const { msg, inlineKeyboard } = buildTokenMessage(token, botUsername, addr);
          // --- AUTO-BUY/SELL/STOP-LOSS LOGIC ---
          try {
            const buyAmount = Number(user.strategy.buyAmount);
            if (!isNaN(buyAmount) && buyAmount > 0 && user.strategy.autoBuy !== false) {
              // Only buy if not already bought (not in sentHashes)
              const result = await unifiedBuy(addr, buyAmount, user.secret);
              if (!user.history) user.history = [];
              user.history.push(`AutoBuy: ${addr} | Amount: ${buyAmount} SOL | Source: ${result.source} | Tx: ${result.tx}`);
              saveUsers(users);
              await bot.telegram.sendMessage(userId, `✅ <b>AutoBuy Executed</b>\nToken: <code>${addr}</code>\nAmount: <b>${buyAmount}</b> SOL\nSource: <b>${result.source}</b>\n<a href='https://solscan.io/tx/${result.tx}'>View Tx</a>`, { parse_mode: 'HTML', disable_web_page_preview: false });

              // --- AUTO-SELL/STOP-LOSS LOGIC ---
              const buyPrice = Number(token.priceUsd || token.price || 0);
              const profitTargetPercent = Number(user.strategy.profitTargetPercent || user.strategy.sellPercent1 || 0);
              const stopLossPercent = Number(user.strategy.stopLossPercent || 0);
              let sold = false;
              let pollCount = 0;
              const maxPolls = 60; // e.g. check for 1 hour (60 min)
              while (!sold && pollCount < maxPolls) {
                await new Promise(res => setTimeout(res, 60 * 1000)); // 1 min
                pollCount++;
                // Fetch latest price
                const freshTokens = await fetchDexScreenerTokens('solana', { limit: '100' });
                const fresh = freshTokens.find((t: any) => (t.pairAddress || t.address || t.tokenAddress || '') === addr);
                if (!fresh) continue;
                const currentPrice = Number(fresh.priceUsd || fresh.price || 0);
                if (!currentPrice || !buyPrice) continue;
                const changePercent = ((currentPrice - buyPrice) / buyPrice) * 100;
                // Check profit target
                if (profitTargetPercent && changePercent >= profitTargetPercent) {
                  try {
                    const sellResult = await unifiedSell(addr, buyAmount, user.secret);
                    user.history.push(`AutoSell: ${addr} | Amount: ${buyAmount} SOL | Source: ${sellResult.source} | Tx: ${sellResult.tx}`);
                    saveUsers(users);
                    await bot.telegram.sendMessage(userId, `💰 <b>AutoSell (Profit Target) Executed</b>\nToken: <code>${addr}</code>\nProfit: <b>${changePercent.toFixed(2)}%</b>\n<a href='https://solscan.io/tx/${sellResult.tx}'>View Tx</a>`, { parse_mode: 'HTML', disable_web_page_preview: false });
                    sold = true;
                    break;
                  } catch (err) {
                    await bot.telegram.sendMessage(userId, `❌ <b>AutoSell Failed</b>\nToken: <code>${addr}</code>\nError: ${(err as Error).message || err}`, { parse_mode: 'HTML' });
                  }
                }
                // Check stop loss
                if (stopLossPercent && changePercent <= -Math.abs(stopLossPercent)) {
                  try {
                    const sellResult = await unifiedSell(addr, buyAmount, user.secret);
                    user.history.push(`AutoSell (StopLoss): ${addr} | Amount: ${buyAmount} SOL | Source: ${sellResult.source} | Tx: ${sellResult.tx}`);
                    saveUsers(users);
                    await bot.telegram.sendMessage(userId, `🛑 <b>AutoSell (Stop Loss) Executed</b>\nToken: <code>${addr}</code>\nLoss: <b>${changePercent.toFixed(2)}%</b>\n<a href='https://solscan.io/tx/${sellResult.tx}'>View Tx</a>`, { parse_mode: 'HTML', disable_web_page_preview: false });
                    sold = true;
                    break;
                  } catch (err) {
                    await bot.telegram.sendMessage(userId, `❌ <b>AutoSell (Stop Loss) Failed</b>\nToken: <code>${addr}</code>\nError: ${(err as Error).message || err}`, { parse_mode: 'HTML' });
                  }
                }
              }
              // --- END AUTO-SELL/STOP-LOSS LOGIC ---
            }
          } catch (err) {
            await bot.telegram.sendMessage(userId, `❌ <b>AutoBuy Failed</b>\nToken: <code>${addr}</code>\nError: ${(err as Error).message || err}`, { parse_mode: 'HTML' });
          }
          // --- END AUTO-BUY/SELL/STOP-LOSS LOGIC ---
          if (msg && typeof msg === 'string') {
            try {
              await bot.telegram.sendMessage(userId, msg, {
                parse_mode: 'HTML',
                disable_web_page_preview: false,
                reply_markup: { inline_keyboard: inlineKeyboard }
              });
              await appendSentHash(userId, hash);
            } catch (err) {
              console.error(`Failed to send message to user ${userId}:`, err);
            }
          }
        }
      }
    } catch (err) {
      console.error('Error in pollAndNotify:', err);
    }
  }
  setInterval(pollAndNotify, 60 * 1000);
  pollAndNotify();
}

export { registerWsNotifications };