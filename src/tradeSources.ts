// tradeSources.ts
// Unified trading source manager for Solana bot
// Language: English only


// --- Multi-Source Trading Logic (Promise.race, first-success-wins) ---
// Add your real source modules here. For now, placeholders are used.
// Example: import * as Jupiter from './sources/jupiter';
// Example: import * as Raydium from './sources/raydium';

type TradeSource = 'jupiter' | 'raydium' | 'dexscreener';


// --- Real Jupiter REST API integration ---
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
import type { BlockhashWithExpiryBlockHeight } from '@solana/web3.js';
const { createJupiterApiClient } = require('@jup-ag/api');
import { transactionSenderAndConfirmationWaiter } from './utils/jupiter.transaction.sender';

const Jupiter = {
  async buy(tokenMint: string, amount: number, secret: string, ctrl?: any) {
    if (ctrl?.cancelled) throw new Error('Cancelled');
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    // Use custom RPC if available
    const rpcUrl = process.env.HELIUS_RPC_URL || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new (require('@solana/web3.js').Connection)(rpcUrl, 'confirmed');
    console.log(`[Jupiter][buy] Using RPC: ${rpcUrl}`);
    let secretKey: Buffer;
    try {
      secretKey = Buffer.from(secret, 'base64');
    } catch (e) {
      console.error('[Jupiter][buy] Invalid base64 secret:', e);
      throw new Error('Invalid base64 secret');
    }
    const keypair = Keypair.fromSecretKey(secretKey);
    // Add delay before trade to avoid rate limit
    await new Promise(res => setTimeout(res, 5000));
    const userPublicKey = keypair.publicKey.toBase58();
    console.log('[Jupiter][buy] PublicKey:', userPublicKey);

    // Check SOL balance
    let solBalance = 0;
    try {
      solBalance = await connection.getBalance(keypair.publicKey);
      console.log(`[Jupiter][buy] SOL balance: ${solBalance / 1e9} SOL`);
    } catch (e) {
      console.error('[Jupiter][buy] Failed to fetch SOL balance:', e);
    }
    if (solBalance < amount * 1e9) {
      throw new Error(`Insufficient SOL balance. Required: ${amount}, Available: ${solBalance / 1e9}`);
    }

    // Validate mint address before any action
    if (tokenMint !== SOL_MINT) {
      try {
        const { PublicKey } = require('@solana/web3.js');
        const tokenMintPubkey = new PublicKey(tokenMint);
        // Mint validation: must exist and be owned by SPL Token program
        const mintInfo = await connection.getAccountInfo(tokenMintPubkey);
        if (!mintInfo || !mintInfo.owner || mintInfo.owner.toBase58() !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
          console.error(`[Jupiter][buy] Invalid mint: ${tokenMint}. Skipping swap.`);
          throw new Error(`Invalid SPL token mint: ${tokenMint}`);
        }
        // Token balance and ATA creation
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
          keypair.publicKey,
          { mint: tokenMintPubkey }
        );
        let tokenBalance = 0;
        if (tokenAccounts.value.length > 0) {
          tokenBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
        }
        console.log(`[Jupiter][buy] Token balance for ${tokenMint}: ${tokenBalance}`);
        // If no account, create associated token account before swap
        if (tokenAccounts.value.length === 0) {
          console.log(`[Jupiter][buy] Creating associated token account for mint: ${tokenMint}`);
          const { createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
          const ata = await (require('@solana/spl-token').getAssociatedTokenAddress)(tokenMintPubkey, keypair.publicKey);
          const ataIx = createAssociatedTokenAccountInstruction(
            keypair.publicKey,
            ata,
            keypair.publicKey,
            tokenMintPubkey
          );
          const tx = new (require('@solana/web3.js').Transaction)().add(ataIx);
          // Preflight simulation for ATA creation
          let ataSim = await connection.simulateTransaction(tx);
          if (ataSim.value.err) {
            console.error(`[Jupiter][buy] ATA creation simulation failed for mint ${tokenMint}:`, ataSim.value.err);
            throw new Error(`ATA creation simulation failed for mint ${tokenMint}`);
          }
          const sig = await connection.sendTransaction(tx, [keypair]);
          console.log(`[Jupiter][buy] ATA creation tx sent: ${sig}`);
          await connection.confirmTransaction(sig, 'confirmed');
          console.log(`[Jupiter][buy] ATA creation confirmed.`);
        }
        if (tokenBalance < 0) {
          throw new Error(`Insufficient token balance for mint ${tokenMint}`);
        }
      } catch (e) {
        console.error('[Jupiter][buy] Token mint validation or ATA creation failed:', e);
        throw e;
      }
    }

    // 1. Get Jupiter API client
    const jupiter = createJupiterApiClient();
    // 2. Get quote
    let quote;
    try {
      quote = await jupiter.quoteGet({
        inputMint: SOL_MINT,
        outputMint: tokenMint,
        amount: Math.floor(amount * 1e9),
        slippageBps: 100,
        prioritizationFeeLamports: 99999 // raise priority fee
      });
      console.log(`[Jupiter][buy] Using prioritizationFeeLamports: 99999`);
      console.log('[Jupiter][buy] Quote:', quote);
    } catch (e) {
      console.error('[Jupiter][buy] Failed to get quote:', e);
      throw new Error('Failed to get quote: ' + (e instanceof Error ? e.message : String(e)));
    }
    if (!quote || !quote.routePlan || !quote.outAmount) {
      throw new Error('No route found for this token');
    }
    // 3. Get swap transaction
    const swapRequest = {
      userPublicKey,
      wrapAndUnwrapSol: true,
      asLegacyTransaction: false,
      quoteResponse: quote
    };
    console.log('[Jupiter][buy] swapRequest:', swapRequest);
    let swapResp;
    try {
      swapResp = await jupiter.swapPost({ swapRequest });
      console.log('[Jupiter][buy] swapResp:', swapResp);
    } catch (e) {
      console.error('[Jupiter][buy] Failed to get swap transaction:', e);
      throw new Error('Failed to get swap transaction: ' + (e instanceof Error ? e.message : String(e)));
    }
    if (!swapResp || !swapResp.swapTransaction) {
      throw new Error('Failed to get swap transaction from Jupiter');
    }
    // 4. Sign and send transaction using robust sender
    const swapTxBuf = Buffer.from(swapResp.swapTransaction, 'base64');
    let txid = '';
    let blockhashWithExpiryBlockHeight: BlockhashWithExpiryBlockHeight;
    try {
      // Try to get blockhash info from quote or connection
      blockhashWithExpiryBlockHeight = quote?.blockhashWithExpiryBlockHeight;
      if (!blockhashWithExpiryBlockHeight) {
        blockhashWithExpiryBlockHeight = (await connection.getLatestBlockhashAndContext('confirmed')).value;
      }
      // Preflight simulation for swap transaction
      const { VersionedTransaction } = require('@solana/web3.js');
      let swapSimError = null;
      try {
        const txSim = await connection.simulateTransaction(new VersionedTransaction(swapTxBuf));
        if (txSim.value.err) {
          swapSimError = txSim.value.err;
          console.error(`[Jupiter][buy] Swap simulation failed for mint ${tokenMint}:`, swapSimError);
        }
      } catch (e) {
        swapSimError = e;
        console.error(`[Jupiter][buy] Swap simulation error for mint ${tokenMint}:`, e);
      }
      if (swapSimError) {
        throw new Error(`Swap simulation failed for mint ${tokenMint}`);
      }
      const txResult = await transactionSenderAndConfirmationWaiter({
        connection,
        serializedTransaction: swapTxBuf,
        blockhashWithExpiryBlockHeight,
      });
      if (!txResult || !txResult.transaction) throw new Error('Transaction failed or not confirmed');
      txid = txResult.transaction.signatures?.[0] || '';
      console.log('[Jupiter][buy] Transaction sent:', txid);
    } catch (e) {
      console.error('[Jupiter][buy] Robust sender failed:', e);
      if (typeof e === 'object' && e !== null && 'message' in e && typeof (e as any).message === 'string' && (e as any).message.includes('429')) {
        console.error('[Jupiter][buy] RPC rate limit (429 Too Many Requests). Use a private RPC or reduce trade frequency.');
      }
      // Print full error object for debugging
      console.error('[Jupiter][buy] Error details:', JSON.stringify(e, Object.getOwnPropertyNames(e), 2));
      throw new Error('Swap failed: ' + (e && typeof e === 'object' && 'message' in e ? (e as any).message : String(e)));
    }
    return { tx: txid, source: 'jupiter' };
  },
  async sell(tokenMint: string, amount: number, secret: string, ctrl?: any) {
    if (ctrl?.cancelled) throw new Error('Cancelled');
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    let secretKey: Buffer;
    try {
      secretKey = Buffer.from(secret, 'base64');
    } catch (e) {
      console.error('[Jupiter][sell] Invalid base64 secret:', e);
      throw new Error('Invalid base64 secret');
    }
    const keypair = Keypair.fromSecretKey(secretKey);
    const userPublicKey = keypair.publicKey.toBase58();
    // 1. Get Jupiter API client
    const jupiter = createJupiterApiClient();
    // 2. Get quote (token -> SOL)
    let quote;
    try {
      quote = await jupiter.quoteGet({
        inputMint: tokenMint,
        outputMint: SOL_MINT,
        amount: Math.floor(amount * 1e9),
        slippageBps: 100
      });
      console.log('[Jupiter][sell] Quote:', quote);
    } catch (e) {
      console.error('[Jupiter][sell] Failed to get quote:', e);
      throw new Error('Failed to get quote: ' + (e instanceof Error ? e.message : String(e)));
    }
    if (!quote || !quote.routePlan || !quote.outAmount) {
      throw new Error('No route found for this token');
    }
    // 3. Get swap transaction
    const swapRequest = {
      userPublicKey,
      wrapAndUnwrapSol: true,
      asLegacyTransaction: false,
      quoteResponse: quote
    };
    console.log('[Jupiter][sell] swapRequest:', swapRequest);
    let swapResp;
    try {
      swapResp = await jupiter.swapPost({ swapRequest });
      console.log('[Jupiter][sell] swapResp:', swapResp);
    } catch (e) {
      console.error('[Jupiter][sell] Failed to get swap transaction:', e);
      throw new Error('Failed to get swap transaction: ' + (e instanceof Error ? e.message : String(e)));
    }
    if (!swapResp || !swapResp.swapTransaction) {
      throw new Error('Failed to get swap transaction from Jupiter');
    }
    // 4. Sign and send transaction using robust sender
    const swapTxBuf = Buffer.from(swapResp.swapTransaction, 'base64');
    let txid = '';
    let blockhashWithExpiryBlockHeight: BlockhashWithExpiryBlockHeight;
    try {
      blockhashWithExpiryBlockHeight = quote?.blockhashWithExpiryBlockHeight;
      if (!blockhashWithExpiryBlockHeight) {
        blockhashWithExpiryBlockHeight = (await connection.getLatestBlockhashAndContext('confirmed')).value;
      }
      const txResult = await transactionSenderAndConfirmationWaiter({
        connection,
        serializedTransaction: swapTxBuf,
        blockhashWithExpiryBlockHeight,
      });
      if (!txResult || !txResult.transaction) throw new Error('Transaction failed or not confirmed');
      txid = txResult.transaction.signatures?.[0] || '';
      console.log('[Jupiter][sell] Transaction sent:', txid);
    } catch (e) {
      console.error('[Jupiter][sell] Robust sender failed:', e);
      throw new Error('Swap failed: ' + (e && typeof e === 'object' && 'message' in e ? (e as any).message : String(e)));
    }
    return { tx: txid, source: 'jupiter' };
  }
};

// Reduce parallel trades to 1 (sequential only)
const BUY_SOURCES = [Jupiter];
const SELL_SOURCES = [Jupiter];

// Helper: run all sources in parallel, return first success, cancel others
async function raceSources(sources: any[], fnName: 'buy'|'sell', ...args: any[]): Promise<{tx: string, source: TradeSource}> {
  // Sequential only: try sources one by one
  let errors: string[] = [];
  for (let i = 0; i < sources.length; i++) {
    try {
      if (typeof sources[i][fnName] !== 'function') throw new Error(`${fnName} not implemented in source`);
      return await sources[i][fnName](...args, { cancelled: false });
    } catch (e: any) {
      errors[i] = (typeof e === 'object' && e !== null && 'message' in e && typeof (e as any).message === 'string') ? (e as any).message : String(e);
      // Print full error object for debugging
      console.error(`[raceSources][${fnName}] Error details:`, JSON.stringify(e, Object.getOwnPropertyNames(e), 2));
    }
  }
  throw new Error('All sources failed: ' + errors.filter(Boolean).join(' | '));
}

// Unified buy: tries all sources in parallel, returns first success
/**
 * @param {string} tokenMint
 * @param {number} amount
 * @param {string} secret
 * @returns {Promise<{tx: string, source: TradeSource}>}
 */
async function unifiedBuy(tokenMint: string, amount: number, secret: string): Promise<{tx: string, source: TradeSource}> {
  return raceSources(BUY_SOURCES, 'buy', tokenMint, amount, secret);
}

/**
 * @param {string} tokenMint
 * @param {number} amount
 * @param {string} secret
 * @returns {Promise<{tx: string, source: TradeSource}>}
 */
async function unifiedSell(tokenMint: string, amount: number, secret: string): Promise<{tx: string, source: TradeSource}> {
  return raceSources(SELL_SOURCES, 'sell', tokenMint, amount, secret);
}

export { unifiedBuy, unifiedSell };