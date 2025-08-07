import fs from 'fs';
import { Markup } from 'telegraf';

export function getErrorMessage(e: any): string {
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  return JSON.stringify(e);
}

export function limitHistory(user: any, max = 50) {
  if (user && Array.isArray(user.history) && user.history.length > max) {
    user.history = user.history.slice(-max);
  }
}

export function hasWallet(user: any): boolean {
  return !!(user && user.wallet && user.secret);
}

export function walletKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔑 Restore Wallet', 'restore_wallet')],
    [Markup.button.callback('🆕 Create Wallet', 'create_wallet')]
  ]);
}

export function loadUsers(): Record<string, any> {
  try {
    if (fs.existsSync('users.json')) {
      return JSON.parse(fs.readFileSync('users.json', 'utf8'));
    }
  } catch {}
  return {};
}

export function saveUsers(users: Record<string, any>) {
  try {
    fs.writeFileSync('users.json', JSON.stringify(users, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving users.json:', e);
  }
}