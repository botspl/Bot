import type { Strategy } from './types';

/**
 * Filters a list of tokens based on the user's strategy settings.
 * All comments and variable names are in English for clarity.
 */
export function filterTokensByStrategy(tokens: any[], strategy: Strategy): any[] {
  if (!strategy || !Array.isArray(tokens)) return [];
  return tokens.filter(token => {
    // Price in USD
    const price = Number(token.priceUsd ?? token.price ?? token.priceNative ?? 0);
    if (strategy.minPrice !== undefined && price < strategy.minPrice) return false;
    if (strategy.maxPrice !== undefined && price > strategy.maxPrice) return false;

    // Market Cap
    const marketCap = Number(token.marketCap ?? token.fdv ?? 0);
    if (strategy.minMarketCap !== undefined && marketCap < strategy.minMarketCap) return false;

    // Liquidity
    const liquidity = Number(token.liquidity ?? 0);
    if (strategy.minLiquidity !== undefined && liquidity < strategy.minLiquidity) return false;

    // Volume
    const volume = Number(token.volume ?? token.volume24h ?? 0);
    if (strategy.minVolume !== undefined && volume < strategy.minVolume) return false;

    // Holders
    const holders = Number(token.holders ?? token.totalAmount ?? 0);
    if (strategy.minHolders !== undefined && holders < strategy.minHolders) return false;

    // Age in minutes (supports ms, s, or direct minutes)
    let ageMinutes = 0;
    if (token.age !== undefined && token.age !== null) {
      let ageVal = typeof token.age === 'string' ? Number(token.age) : token.age;
      if (ageVal > 1e12) { // ms timestamp
        ageMinutes = Math.floor((Date.now() - ageVal) / 60000);
      } else if (ageVal > 1e9) { // s timestamp
        ageMinutes = Math.floor((Date.now() - ageVal * 1000) / 60000);
      } else if (ageVal < 1e7 && ageVal > 0) { // already in minutes
        ageMinutes = ageVal;
      }
    }
    if (strategy.minAge !== undefined && ageMinutes < strategy.minAge) return false;

    // Verification
    const verified = token.verified === true || token.verified === 'true' ||
      (token.baseToken && (token.baseToken.verified === true || token.baseToken.verified === 'true'));
    if (strategy.onlyVerified === true && !verified) return false;

    // Strategy enabled
    if (strategy.enabled === false) return false;

    return true;
  });
}