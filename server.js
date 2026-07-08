import './src/loadEnv.js';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'crypto';

import { Collector } from './src/collector.js';
import { aggregateSnapshots, TIMEFRAMES } from './src/aggregateSnapshots.js';
import { HlEcoScraper } from './src/hlEcoScraper.js';
import { SnapshotStore, AlertsStore, ConfigStore, PresetsStore, AutoTradeStore } from './src/store.js';
import { TwapCache } from './src/twapCache.js';
import { AlertEngine } from './src/alertEngine.js';
import { AutoTradingEngine } from './src/autoTradingEngine.js';
import { createNordUserHelper } from './src/nordHelper.js';
import { HibachiCcxtAdapter } from './src/hibachiCcxtAdapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT ?? 4175);
const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS ?? 1_000);
const SNAPSHOT_FILE = process.env.SNAPSHOT_FILE ?? path.join(__dirname, 'data', 'snapshots.json');

const app = express();
const store = new SnapshotStore(SNAPSHOT_FILE);
const alertsStore = new AlertsStore(process.env.ALERTS_FILE ?? path.join(__dirname, 'data', 'alerts.json'));
const configStore = new ConfigStore(process.env.CONFIG_FILE ?? path.join(__dirname, 'data', 'config.json'));
const presetsStore = new PresetsStore(process.env.PRESETS_FILE ?? path.join(__dirname, 'data', 'presets.json'));
const autoTradeStore = new AutoTradeStore(
  path.join(__dirname, 'data', 'autotrade_config.json'),
  path.join(__dirname, 'data', 'autotrade_state.json')
);
const alertEngine = new AlertEngine({ alertsStore, configStore });
const autoTradingEngine = new AutoTradingEngine({ autoTradeStore, configStore });
const hibachiAdapter = new HibachiCcxtAdapter();

// Parse cookies helper
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    list[parts.shift().trim()] = decodeURIComponent(parts.join('='));
  });
  return list;
}

// Session helpers
function getSessionUser(req, botToken) {
  if (!botToken) return null;
  try {
    const cookies = parseCookies(req.headers.cookie);
    const sessionVal = cookies['tg_session'];
    if (!sessionVal) return null;

    const raw = Buffer.from(sessionVal, 'base64').toString('utf8');
    const { sessionData, signature } = JSON.parse(raw);

    const expectedSignature = crypto
      .createHmac('sha256', botToken)
      .update(sessionData)
      .digest('hex');

    if (signature !== expectedSignature) {
      return null;
    }

    return JSON.parse(sessionData) || null;
  } catch (err) {
    return null;
  }
}

// Verify Telegram Authentication signature
function verifyTelegramAuth(authData, botToken) {
  const { hash, ...data } = authData;
  const dataCheckArr = [];
  
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null) {
      dataCheckArr.push(`${key}=${value}`);
    }
  }
  
  dataCheckArr.sort();
  const dataCheckString = dataCheckArr.join('\n');

  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (computedHash !== hash) {
    return false;
  }

  const age = Math.floor(Date.now() / 1000) - Number(authData.auth_date);
  if (age > 30 * 86400) { // 30 days
    return false;
  }

  return true;
}

// Authorization middleware
async function authMiddleware(req, res, next) {
  try {
    let token = await configStore.get('telegram_bot_token');
    if (!token) token = process.env.TELEGRAM_BOT_TOKEN;

    const user = getSessionUser(req, token ? token.trim() : null);
    if (!user) {
      res.status(401).json({ error: 'Unauthorized: Telegram login required.' });
      return;
    }
    req.user = user;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Restrict access to Auto Trading to specified Telegram ID
async function restrictToOwner(req, res, next) {
  try {
    let token = await configStore.get('telegram_bot_token');
    if (!token) token = process.env.TELEGRAM_BOT_TOKEN;

    const user = getSessionUser(req, token ? token.trim() : null);
    if (!user || String(user.id) !== '388735415') {
      res.status(403).json({ error: 'Forbidden: You do not have access to Auto Trading.' });
      return;
    }
    req.user = user;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getBotUsername(botToken) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      signal: controller.signal
    });
    const data = await res.json();
    if (data.ok && data.result) {
      return data.result.username;
    }
  } catch (err) {
    console.error('Error fetching bot username from telegram:', err);
  } finally {
    clearTimeout(timeoutId);
  }
  return null;
}

const twapCache = new TwapCache();
const scraper = process.env.PLAYWRIGHT_SCRAPER === '1'
  ? new HlEcoScraper({ headless: process.env.HEADLESS !== '0' })
  : null;
const collector = new Collector({
  store,
  scraper,
  twapCache,
  intervalMs: SNAPSHOT_INTERVAL_MS,
  alertEngine,
  autoTradingEngine
});

app.use('/api/ingest-hl-eco', express.text({ type: '*/*', limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }
}));

app.use('/api/ingest-hl-eco', (_request, response, next) => {
  response.setHeader('access-control-allow-origin', 'https://hl.eco');
  response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');
  next();
});

app.options('/api/ingest-hl-eco', (_request, response) => {
  response.sendStatus(204);
});

app.get('/chart', (_request, response) => {
  response.sendFile(path.join(__dirname, 'public', 'chart.html'));
});

app.get('/api/state', (_request, response) => {
  const state = collector.getState();
  response.json({
    latest: state.latest,
    status: state.status
  });
});

app.get('/api/snapshots', (_request, response) => {
  const timeframe = String(_request.query.timeframe ?? '1m');
  const snapshots = collector.getState().snapshots;

  if (!Object.hasOwn(TIMEFRAMES, timeframe)) {
    response.status(400).json({ error: `Unsupported timeframe: ${timeframe}` });
    return;
  }

  response.json(aggregateSnapshots(snapshots, timeframe));
});

// Alerts Configuration APIs
app.get('/api/config/telegram', async (req, res) => {
  try {
    let token = await configStore.get('telegram_bot_token') || process.env.TELEGRAM_BOT_TOKEN || '';
    let chatId = await configStore.get('telegram_chat_id') || process.env.TELEGRAM_CHAT_ID || '';

    if (token) {
      token = token.slice(0, 6) + '...' + token.slice(-4);
    }
    res.json({
      telegramBotTokenMasked: token,
      telegramChatId: chatId,
      isConfigured: !!(token && chatId)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/config/telegram', express.json(), async (req, res) => {
  try {
    const { token, chatId } = req.body;
    if (token !== undefined && !token.includes('...')) {
      await configStore.set('telegram_bot_token', token.trim());
    }
    if (chatId !== undefined) {
      await configStore.set('telegram_chat_id', chatId.trim());
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Authentication Endpoints ---

app.get('/api/auth/telegram/config', async (req, res) => {
  try {
    let token = await configStore.get('telegram_bot_token');
    if (!token) token = process.env.TELEGRAM_BOT_TOKEN;

    const botUsername = token ? await getBotUsername(token.trim()) : null;
    const user = getSessionUser(req, token ? token.trim() : null);

    res.json({
      botUsername,
      user
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/telegram', express.json(), async (req, res) => {
  try {
    let token = await configStore.get('telegram_bot_token');
    if (!token) token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
      res.status(400).json({ error: 'Telegram bot token is not configured on the server.' });
      return;
    }

    const authData = req.body;
    if (!authData || !authData.hash) {
      res.status(400).json({ error: 'Missing authentication parameters.' });
      return;
    }

    const isValid = verifyTelegramAuth(authData, token.trim());
    if (!isValid) {
      res.status(401).json({ error: 'Telegram signature validation failed.' });
      return;
    }

    const sessionData = JSON.stringify({
      id: authData.id,
      username: authData.username || '',
      first_name: authData.first_name || '',
      photo_url: authData.photo_url || ''
    });

    const signature = crypto
      .createHmac('sha256', token.trim())
      .update(sessionData)
      .digest('hex');

    const cookieValue = Buffer.from(JSON.stringify({ sessionData, signature })).toString('base64');
    
    res.setHeader('Set-Cookie', `tg_session=${cookieValue}; Path=/; HttpOnly; Max-Age=${30 * 86400}; SameSite=Lax; Secure`);
    res.json({ ok: true, user: JSON.parse(sessionData) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  res.setHeader('Set-Cookie', 'tg_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax; Secure');
  res.json({ ok: true });
});

app.post('/api/auth/dev-login', async (req, res) => {
  const isLocal = req.hostname === 'localhost' || req.hostname === '127.0.0.1' || req.ip === '::1' || req.ip === '127.0.0.1';
  if (!isLocal && process.env.NODE_ENV === 'production') {
    res.status(403).json({ error: 'Developer login only allowed on localhost' });
    return;
  }

  let token = await configStore.get('telegram_bot_token');
  if (!token || token === '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11') {
    token = process.env.TELEGRAM_BOT_TOKEN || 'mock_token';
  }

  const sessionData = JSON.stringify({
    id: 388735415,
    username: 'dev_user',
    first_name: 'Developer',
    photo_url: ''
  });

  const signature = crypto
    .createHmac('sha256', token.trim())
    .update(sessionData)
    .digest('hex');

  const cookieValue = Buffer.from(JSON.stringify({ sessionData, signature })).toString('base64');
  
  res.setHeader('Set-Cookie', `tg_session=${cookieValue}; Path=/; HttpOnly; Max-Age=${30 * 86400}; SameSite=Lax; Secure`);
  res.json({ ok: true, user: JSON.parse(sessionData) });
});

// --- Presets API ---

app.get('/api/presets', authMiddleware, async (req, res) => {
  try {
    const presets = await presetsStore.readAll(String(req.user.id));
    res.json(presets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/presets', express.json(), authMiddleware, async (req, res) => {
  try {
    const { name, preset_data } = req.body;
    if (!name || !preset_data) {
      res.status(400).json({ error: 'Name and preset_data are required' });
      return;
    }
    const success = await presetsStore.save(String(req.user.id), name, preset_data);
    if (!success) throw new Error('Save preset failed');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/presets/:name', authMiddleware, async (req, res) => {
  try {
    const { name } = req.params;
    if (!name) {
      res.status(400).json({ error: 'Preset name is required' });
      return;
    }
    const success = await presetsStore.delete(String(req.user.id), name);
    if (!success) throw new Error('Delete preset failed');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Alerts API ---

app.get('/api/alerts', async (req, res) => {
  try {
    let token = await configStore.get('telegram_bot_token');
    if (!token) token = process.env.TELEGRAM_BOT_TOKEN;

    const user = getSessionUser(req, token ? token.trim() : null);
    if (!user) {
      const alerts = await alertsStore.readAll();
      const defaultAlerts = alerts.filter(a => !a.telegram_user_id);
      res.json(defaultAlerts);
      return;
    }

    const alerts = await alertsStore.readAll();
    const userAlerts = alerts.filter(a => a.telegram_user_id === String(user.id) || !a.telegram_user_id);
    res.json(userAlerts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/alerts', express.json(), authMiddleware, async (req, res) => {
  try {
    const { name, expression, frequency_minutes, trend_mode, timeframe } = req.body;

    if (!name || !expression || frequency_minutes === undefined) {
      res.status(400).json({ error: 'Missing name, expression or frequency_minutes' });
      return;
    }

    const newAlert = {
      id: crypto.randomUUID(),
      name,
      expression,
      frequency_minutes: Number(frequency_minutes),
      trend_mode: trend_mode || 'none',
      timeframe: timeframe || '1m',
      telegram_user_id: String(req.user.id),
      last_crossover_price: null,
      last_crossover_bucket_timestamp: null,
      last_triggered_at: null,
      active: true,
      created_at: new Date().toISOString()
    };

    const ok = await alertsStore.save(newAlert);
    if (ok) {
      res.json(newAlert);
    } else {
      res.status(500).json({ error: 'Failed to save alert' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/alerts/:id', express.json(), authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, expression, frequency_minutes, trend_mode, timeframe } = req.body;

    if (!name || !expression || frequency_minutes === undefined) {
      res.status(400).json({ error: 'Missing name, expression or frequency_minutes' });
      return;
    }

    const alerts = await alertsStore.readAll();
    const alert = alerts.find(a => a.id === id);
    if (!alert) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }

    if (alert.telegram_user_id && alert.telegram_user_id !== String(req.user.id)) {
      res.status(403).json({ error: 'Forbidden: You do not own this alert.' });
      return;
    }

    const expressionChanged = JSON.stringify(alert.expression) !== JSON.stringify(expression);
    const timeframeChanged = alert.timeframe !== timeframe;

    alert.name = name;
    alert.expression = expression;
    alert.frequency_minutes = Number(frequency_minutes);
    alert.trend_mode = trend_mode || 'none';
    alert.timeframe = timeframe || '1m';
    if (!alert.telegram_user_id) {
      alert.telegram_user_id = String(req.user.id);
    }
    if (expressionChanged || timeframeChanged || alert.trend_mode !== (trend_mode || 'none')) {
      alert.last_crossover_price = null;
      alert.last_crossover_bucket_timestamp = null;
    }

    const ok = await alertsStore.save(alert);
    if (ok) {
      res.json(alert);
    } else {
      res.status(500).json({ error: 'Failed to update alert' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/alerts/:id/toggle', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const alerts = await alertsStore.readAll();
    const alert = alerts.find(a => a.id === id);
    if (!alert) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }

    if (alert.telegram_user_id && alert.telegram_user_id !== String(req.user.id)) {
      res.status(403).json({ error: 'Forbidden: You do not own this alert.' });
      return;
    }

    if (!alert.telegram_user_id) {
      alert.telegram_user_id = String(req.user.id);
    }
    alert.active = !alert.active;
    const ok = await alertsStore.save(alert);
    if (ok) {
      res.json(alert);
    } else {
      res.status(500).json({ error: 'Failed to toggle alert' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/alerts/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const alerts = await alertsStore.readAll();
    const alert = alerts.find(a => a.id === id);
    if (!alert) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }

    if (alert.telegram_user_id && alert.telegram_user_id !== String(req.user.id)) {
      res.status(403).json({ error: 'Forbidden: You do not own this alert.' });
      return;
    }

    const ok = await alertsStore.delete(id);
    if (ok) {
      res.json({ ok: true });
    } else {
      res.status(500).json({ error: 'Failed to delete alert' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/alerts/test', express.json(), async (req, res) => {
  try {
    let { token, chatId } = req.body || {};
    const savedConfig = await alertEngine.getTelegramConfig();

    if (token && token.includes('...')) {
      token = savedConfig.token;
    }

    const finalToken = (token || savedConfig.token || '').trim();
    const finalChatId = (chatId || savedConfig.chatId || '').trim();

    if (!finalToken || !finalChatId) {
      res.status(400).json({ error: 'Telegram bot not configured.' });
      return;
    }

    const testMsg = `🔔 <b>HYPE Alert Test Bot</b>\nConnection successful! Your alerts are ready.`;
    const url = `https://api.telegram.org/bot${finalToken}/sendMessage`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: finalChatId, text: testMsg, parse_mode: 'HTML' })
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Telegram error: ${response.status} - ${errText}`);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Auto-Trading API ---

app.get('/api/autotrade/config', restrictToOwner, async (req, res) => {
  try {
    const config = await autoTradeStore.getConfig();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/autotrade/config', express.json(), restrictToOwner, async (req, res) => {
  try {
    await autoTradeStore.saveConfig(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const balanceCache = new Map(); // key -> { balance: number, timestamp: number, promise?: Promise }

function triggerBackgroundBalanceFetch(wallet, subaccountIndex, testnet) {
  const cacheKey = `${wallet.id}_${subaccountIndex}`;
  const now = Date.now();
  const cached = balanceCache.get(cacheKey);

  if (cached && (now - cached.timestamp < 180_000 || cached.promise)) {
    return; // Already fresh or fetching
  }

  const fetchPromise = (async () => {
    try {
      let balance = 0;
      if (wallet.exchangeType === 'hibachi_ccxt') {
        const subaccounts = await hibachiAdapter.fetchSubaccounts({
          apiKey: wallet.apiKey,
          accountId: wallet.accountId || String(subaccountIndex),
          privateKey: wallet.privateKey
        });
        if (subaccounts && subaccounts[0]) {
          balance = subaccounts[0].balance;
        }
      } else if (wallet.exchangeType === 'hl_solana') {
        // Initialize Nord connection
        const isTestnet = testnet === true;
        const webServerUrl = isTestnet ? 'https://zo-devnet.n1.xyz' : 'https://zo-mainnet.n1.xyz';
        const appKey = 'zoau54n5U24GHNKqyoziVaVxgsiQYnPMx33fKmLLCT5';

        const { Connection } = await import("@solana/web3.js");
        const { Nord } = await import("@n1xyz/nord-ts");

        const urls = isTestnet 
          ? ['https://api.devnet.solana.com'] 
          : [
              'https://api.mainnet-beta.solana.com',
              'https://rpc.ankr.com/solana',
              'https://solana-mainnet.g.allnodes.com'
            ];

        let connection;
        let nord;
        for (const url of urls) {
          try {
            connection = new Connection(url, 'confirmed');
            nord = await Nord.new({
              app: appKey,
              solanaConnection: connection,
              webServerUrl,
            });
            break;
          } catch (e) {
            // ignore
          }
        }

        if (nord) {
          const user = await createNordUserHelper(nord, wallet.address, wallet.privateKey);
          await user.updateAccountId();
          await user.fetchInfo();
          const subaccountId = user.accountIds[subaccountIndex || 0];
          if (subaccountId) {
            const balances = user.balances[subaccountId] || [];
            const usdcBalanceObj = balances.find(b => b.symbol === 'USDC' || b.symbol === 'USDT' || b.symbol === 'USDC.e');
            balance = usdcBalanceObj ? parseFloat(usdcBalanceObj.balance) : 0;
          }
        }
      }
      balanceCache.set(cacheKey, { balance, timestamp: Date.now(), promise: null });
    } catch (err) {
      console.error(`Error background-fetching balance for ${cacheKey}:`, err);
      const prevBalance = cached ? cached.balance : 0;
      balanceCache.set(cacheKey, { balance: prevBalance, timestamp: Date.now(), promise: null });
    }
  })();

  if (!cached) {
    balanceCache.set(cacheKey, { balance: 0, timestamp: 0, promise: fetchPromise });
  } else {
    cached.promise = fetchPromise;
  }
}

function getCachedBalance(wallet, subaccountIndex, testnet) {
  const cacheKey = `${wallet.id}_${subaccountIndex}`;
  triggerBackgroundBalanceFetch(wallet, subaccountIndex, testnet);
  return balanceCache.get(cacheKey)?.balance ?? 0;
}

app.get('/api/autotrade/status', restrictToOwner, async (req, res) => {
  try {
    const config = await autoTradeStore.getConfig();
    const state = await autoTradeStore.getState();
    const snapshots = collector.state.snapshots;
    const currentPrice = snapshots.length > 0 ? snapshots.at(-1).price : 0;

    const strategiesWithBalances = (config.strategies || []).map(strat => {
      const wallet = (config.wallets || []).find(w => w.id === strat.walletId);
      let balance = 0;
      if (wallet) {
        const isTestnet = strat.testnet === true || String(strat.testnet).toLowerCase() === 'true';
        balance = getCachedBalance(wallet, strat.subaccountIndex, isTestnet);
      }
      return {
        ...strat,
        balance
      };
    });

    res.json({
      enabled: !!(config && config.strategies && config.strategies.some(s => s.enabled)),
      strategies: strategiesWithBalances,
      wallets: config.wallets || [],
      currentPrice,
      activePositions: state.activePositions || [],
      logs: state.logs || [],
      tradeHistory: state.tradeHistory || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/autotrade/subaccounts', restrictToOwner, async (req, res) => {
  try {
    const { walletId, testnet } = req.query;
    if (!walletId) {
      res.status(400).json({ error: 'Wallet ID is required' });
      return;
    }

    const config = await autoTradeStore.getConfig();
    const wallets = config.wallets || [];
    const wallet = wallets.find(w => w.id === walletId);
    if (!wallet) {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }

    const privateKey = wallet.privateKey;
    if (!privateKey) {
      res.status(400).json({ error: 'Selected wallet does not have a private key' });
      return;
    }

    if (wallet.exchangeType === 'hibachi_ccxt') {
      if (!wallet.apiKey || !wallet.accountId || !wallet.privateKey) {
        res.status(400).json({ error: 'Hibachi API key, account ID, and private key are required.' });
        return;
      }

      const subaccounts = await hibachiAdapter.fetchSubaccounts({
        apiKey: wallet.apiKey,
        accountId: wallet.accountId,
        privateKey: wallet.privateKey
      });
      res.json({ subaccounts });
      return;
    }

    if (wallet.exchangeType !== 'hl_solana') {
      res.json({ subaccounts: [] });
      return;
    }

    // Initialize Nord connection
    const isTestnet = testnet === 'true';
    const webServerUrl = isTestnet ? 'https://zo-devnet.n1.xyz' : 'https://zo-mainnet.n1.xyz';
    const appKey = 'zoau54n5U24GHNKqyoziVaVxgsiQYnPMx33fKmLLCT5';

    const { Connection } = await import("@solana/web3.js");
    const { Nord } = await import("@n1xyz/nord-ts");

    const urls = isTestnet 
      ? ['https://api.devnet.solana.com'] 
      : [
          'https://api.mainnet-beta.solana.com',
          'https://rpc.ankr.com/solana',
          'https://solana-mainnet.g.allnodes.com'
        ];

    let connection;
    let nord;
    let lastError;

    for (const url of urls) {
      try {
        connection = new Connection(url, 'confirmed');
        nord = await Nord.new({
          app: appKey,
          solanaConnection: connection,
          webServerUrl,
        });
        break; // Success
      } catch (e) {
        console.warn(`Failed to connect to Solana RPC ${url}:`, e.message);
        lastError = e;
      }
    }

    if (!nord) {
      throw new Error(`Failed to connect to any Solana RPC endpoint. Last error: ${lastError?.message}`);
    }

    const user = await createNordUserHelper(nord, wallet.address, privateKey);
    
    await user.updateAccountId();
    await user.fetchInfo();
    
    const subaccounts = (user.accountIds || []).map((id, index) => {
      const balances = user.balances[id] || [];
      const usdcBalanceObj = balances.find(b => b.symbol === 'USDC' || b.symbol === 'USDT' || b.symbol === 'USDC.e');
      const balance = usdcBalanceObj ? parseFloat(usdcBalanceObj.balance) : 0;
      return {
        index,
        id,
        balance
      };
    });

    res.json({ subaccounts });
  } catch (err) {
    console.error('Error fetching subaccounts:', err);
    const detailedMessage = err.cause ? `${err.message} (Cause: ${err.cause.message})` : err.message;
    res.status(500).json({ error: detailedMessage });
  }
});

app.post('/api/autotrade/close', express.json(), restrictToOwner, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      res.status(400).json({ error: 'Position ID is required' });
      return;
    }
    const snapshots = collector.state.snapshots;
    const currentPrice = snapshots.length > 0 ? snapshots.at(-1).price : 0;
    const success = await autoTradingEngine.closePosition(id, currentPrice);
    if (success) {
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: 'Active position not found' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/collect-now', async (_request, response) => {
  try {
    const latest = await collector.collectOnce();
    response.json({ ok: true, latest });
  } catch (error) {
    response.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/ingest-hl-eco', (request, response) => {
  try {
    const metrics = twapCache.updateFromText(String(request.body ?? ''));
    response.json({ ok: true, metrics });
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message });
  }
});

const server = app.listen(PORT, async () => {
  console.log(`HYPE TWAP dashboard: http://127.0.0.1:${PORT}`);
  try {
    await collector.start();
  } catch (error) {
    console.error('Initial collection failed:', error);
  }
});

async function shutdown() {
  collector.stop();
  await scraper?.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  // Don't exit — let Railway restart only if truly unrecoverable
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
  // Log but keep running
});
