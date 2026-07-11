import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_MAX_SNAPSHOTS = process.env.MAX_SNAPSHOTS ? parseInt(process.env.MAX_SNAPSHOTS, 10) : 1_440;

export class SnapshotStore {
  constructor(filePath, maxSnapshots = DEFAULT_MAX_SNAPSHOTS) {
    this.filePath = filePath;
    this.maxSnapshots = maxSnapshots;
    this.supabaseUrl = process.env.SUPABASE_URL;
    this.supabaseKey = process.env.SUPABASE_KEY;
    this.isSupabase = !!(this.supabaseUrl && this.supabaseKey);
  }

  async readAll() {
    if (this.isSupabase) {
      try {
        let allRows = [];
        let offset = 0;
        const limit = 1000;
        let hasMore = true;

        while (hasMore && allRows.length < this.maxSnapshots) {
          const chunkLimit = Math.min(limit, this.maxSnapshots - allRows.length);
          const url = `${this.supabaseUrl}/rest/v1/hype_snapshots?select=data&order=timestamp.desc&limit=${chunkLimit}&offset=${offset}`;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000);
          try {
            const response = await fetch(url, {
              method: 'GET',
              headers: {
                'apikey': this.supabaseKey,
                'Authorization': `Bearer ${this.supabaseKey}`
              },
              signal: controller.signal
            });
            if (!response.ok) {
              const errText = await response.text();
              throw new Error(`Supabase read failed at offset ${offset}: ${response.status} ${response.statusText} - ${errText}`);
            }
            const rows = await response.json();
            if (rows.length === 0) {
              hasMore = false;
            } else {
              allRows = allRows.concat(rows);
              offset += rows.length;
              if (rows.length < chunkLimit) {
                hasMore = false;
              }
            }
          } finally {
            clearTimeout(timeoutId);
          }
        }

        // Auto-migration: if Supabase returns 0 snapshots, migrate existing local snapshots
        if (allRows.length === 0) {
          try {
            console.log('Supabase has 0 snapshots. Checking local file for migration...');
            const raw = await readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
              const sliced = parsed.slice(-this.maxSnapshots);
              console.log(`Found ${parsed.length} local snapshots. Migrating latest ${sliced.length} to Supabase...`);
              
              const url = `${this.supabaseUrl}/rest/v1/hype_snapshots`;
              const body = sliced.map(snapshot => ({
                timestamp: snapshot.timestamp,
                data: snapshot
              }));

              const migrationController = new AbortController();
              const migrationTimeoutId = setTimeout(() => migrationController.abort(), 15000);
              try {
                const response = await fetch(url, {
                  method: 'POST',
                  headers: {
                    'apikey': this.supabaseKey,
                    'Authorization': `Bearer ${this.supabaseKey}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'resolution=merge-duplicates'
                  },
                  body: JSON.stringify(body),
                  signal: migrationController.signal
                });

                if (!response.ok) {
                  const errText = await response.text();
                  throw new Error(`Bulk migration write failed: ${response.status} ${response.statusText} - ${errText}`);
                }

                console.log('Migration to Supabase completed successfully!');
                return sliced;
              } finally {
                clearTimeout(migrationTimeoutId);
              }
            }
          } catch (fileErr) {
            if (fileErr.code !== 'ENOENT') {
              console.error('Failed to migrate local snapshots to Supabase:', fileErr);
            }
          }
        }

        // Extracted objects are in descending order from DB. Reverse them to restore ascending order.
        return allRows.map(r => r.data).reverse();
      } catch (error) {
        console.error('Error reading from Supabase, falling back to local snapshots file:', error);
        try {
          const raw = await readFile(this.filePath, 'utf8');
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed : [];
        } catch (fileError) {
          if (fileError.code === 'ENOENT') return [];
          throw fileError;
        }
      }
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }

      throw error;
    }
  }

  async append(snapshot, currentSnapshots = null) {
    if (this.isSupabase) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const url = `${this.supabaseUrl}/rest/v1/hype_snapshots`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify({
            timestamp: snapshot.timestamp,
            data: snapshot
          }),
          signal: controller.signal
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Supabase write failed: ${response.status} ${response.statusText} - ${errText}`);
        }

        // Periodically trim old snapshots in the background (roughly once every 20 minutes)
        if (Math.random() < 0.05) {
          const cutoffMs = Date.now() - (this.maxSnapshots * 60_000);
          const cutoffIso = new Date(cutoffMs).toISOString();
          const deleteUrl = `${this.supabaseUrl}/rest/v1/hype_snapshots?timestamp=lt.${encodeURIComponent(cutoffIso)}`;
          const deleteController = new AbortController();
          const deleteTimeoutId = setTimeout(() => deleteController.abort(), 5000);
          fetch(deleteUrl, {
            method: 'DELETE',
            headers: {
              'apikey': this.supabaseKey,
              'Authorization': `Bearer ${this.supabaseKey}`
            },
            signal: deleteController.signal
          }).then(res => {
            if (!res.ok) {
              console.error('Failed to trim old Supabase snapshots:', res.statusText);
            }
          }).catch(err => {
            console.error('Error trimming old Supabase snapshots:', err);
          }).finally(() => {
            clearTimeout(deleteTimeoutId);
          });
        }
      } catch (error) {
        console.error('Error appending to Supabase:', error);
      } finally {
        clearTimeout(timeoutId);
      }

      if (currentSnapshots) {
        currentSnapshots.push(snapshot);
        if (currentSnapshots.length > this.maxSnapshots) {
          currentSnapshots.shift();
        }
        return currentSnapshots;
      }
      return await this.readAll();
    }

    const snapshots = currentSnapshots || await this.readAll();
    if (!currentSnapshots) {
      snapshots.push(snapshot);
    }
    const trimmed = snapshots.slice(-this.maxSnapshots);
    await this.writeAll(trimmed);
    return trimmed;
  }

  async writeAll(snapshots) {
    if (this.isSupabase) {
      // Direct bulk writing to Supabase is not strictly needed for minute increments, 
      // but if we ever need it, we can upsert all rows.
      console.warn('writeAll not implemented/needed for Supabase mode (append is used directly).');
      return;
    }

    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });

    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(snapshots, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }

  /**
   * Read snapshots within a specific time range, directly from Supabase
   * (or filtered from local file if not in Supabase mode).
   * @param {string} from - ISO 8601 start timestamp (inclusive)
   * @param {string} to   - ISO 8601 end timestamp (inclusive)
   * @returns {Promise<Array>}
   */
  async readRange(from, to) {
    if (this.isSupabase) {
      try {
        let allRows = [];
        let offset = 0;
        const limit = 1000;
        let hasMore = true;

        const fromEnc = encodeURIComponent(from);
        const toEnc   = encodeURIComponent(to);

        while (hasMore) {
          const url = `${this.supabaseUrl}/rest/v1/hype_snapshots` +
            `?select=data&timestamp=gte.${fromEnc}&timestamp=lte.${toEnc}` +
            `&order=timestamp.asc&limit=${limit}&offset=${offset}`;

          const controller = new AbortController();
          const timeoutId  = setTimeout(() => controller.abort(), 15000);
          try {
            const response = await fetch(url, {
              method: 'GET',
              headers: {
                'apikey': this.supabaseKey,
                'Authorization': `Bearer ${this.supabaseKey}`
              },
              signal: controller.signal
            });
            if (!response.ok) {
              const errText = await response.text();
              throw new Error(`Supabase readRange failed at offset ${offset}: ${response.status} - ${errText}`);
            }
            const rows = await response.json();
            if (rows.length === 0) {
              hasMore = false;
            } else {
              allRows = allRows.concat(rows);
              offset += rows.length;
              if (rows.length < limit) hasMore = false;
            }
          } finally {
            clearTimeout(timeoutId);
          }
        }

        return allRows.map(r => r.data);
      } catch (error) {
        console.error('Error in readRange from Supabase, falling back to local file:', error);
        // Fall through to local file fallback
      }
    }

    // Local file fallback: filter by date range
    try {
      const raw  = await readFile(this.filePath, 'utf8');
      const all  = JSON.parse(raw);
      if (!Array.isArray(all)) return [];
      const fromMs = new Date(from).getTime();
      const toMs   = new Date(to).getTime();
      return all.filter(s => {
        const t = new Date(s.timestamp).getTime();
        return t >= fromMs && t <= toMs;
      });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }
}

const DEFAULT_ALERTS = [
  {
    id: "preset-hl-depth-imbalance-bids",
    name: "Hyperliquid Depth Imbalance (Bids > Asks)",
    expression: {
      field1: "hl_bid_1_5",
      operator: "gt",
      compareType: "metric",
      field2: "hl_ask_1_5",
      value: 0
    },
    frequency_minutes: 15,
    trend_mode: "none",
    timeframe: "1m",
    active: true,
    telegram_user_id: null,
    created_at: "2026-06-01T00:00:00.000Z",
    last_triggered_at: null,
    last_trigger_price: null,
    last_trend_price: null,
    last_crossover_price: null,
    last_crossover_bucket_timestamp: null
  },
  {
    id: "preset-hl-depth-imbalance-asks",
    name: "Hyperliquid Depth Imbalance (Asks > Bids)",
    expression: {
      field1: "hl_ask_1_5",
      operator: "gt",
      compareType: "metric",
      field2: "hl_bid_1_5",
      value: 0
    },
    frequency_minutes: 15,
    trend_mode: "none",
    timeframe: "1m",
    active: true,
    telegram_user_id: null,
    created_at: "2026-06-01T00:00:00.000Z",
    last_triggered_at: null,
    last_trigger_price: null,
    last_trend_price: null,
    last_crossover_price: null,
    last_crossover_bucket_timestamp: null
  },
  {
    id: "preset-hype-twap-net-1h-acc",
    name: "HYPE TWAP Net 1H Accumulation (>20k)",
    expression: {
      field1: "twapNet1h",
      operator: "gt",
      compareType: "value",
      value: 20000,
      field2: ""
    },
    frequency_minutes: 30,
    trend_mode: "none",
    timeframe: "1m",
    active: true,
    telegram_user_id: null,
    created_at: "2026-06-01T00:00:00.000Z",
    last_triggered_at: null,
    last_trigger_price: null,
    last_trend_price: null,
    last_crossover_price: null,
    last_crossover_bucket_timestamp: null
  },
  {
    id: "preset-hype-twap-net-1h-dist",
    name: "HYPE TWAP Net 1H Distribution (<-20k)",
    expression: {
      field1: "twapNet1h",
      operator: "lt",
      compareType: "value",
      value: -20000,
      field2: ""
    },
    frequency_minutes: 30,
    trend_mode: "none",
    timeframe: "1m",
    active: true,
    telegram_user_id: null,
    created_at: "2026-06-01T00:00:00.000Z",
    last_triggered_at: null,
    last_trigger_price: null,
    last_trend_price: null,
    last_crossover_price: null,
    last_crossover_bucket_timestamp: null
  },
  {
    id: "preset-hype-buys-vs-sells-crossover",
    name: "Active Buy/Sell Count Crossover (Buys > Sells)",
    expression: {
      field1: "activeBuyCount",
      operator: "gt",
      compareType: "metric",
      field2: "activeSellCount",
      value: 0
    },
    frequency_minutes: 5,
    trend_mode: "none",
    timeframe: "1m",
    active: true,
    telegram_user_id: null,
    created_at: "2026-06-01T00:00:00.000Z",
    last_triggered_at: null,
    last_trigger_price: null,
    last_trend_price: null,
    last_crossover_price: null,
    last_crossover_bucket_timestamp: null
  }
];

export class AlertsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.supabaseUrl = process.env.SUPABASE_URL;
    this.supabaseKey = process.env.SUPABASE_KEY;
    this.isSupabase = !!(this.supabaseUrl && this.supabaseKey);
  }

  async readAll() {
    let list = [];
    if (this.isSupabase) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const url = `${this.supabaseUrl}/rest/v1/hype_alerts?select=*&order=created_at.desc`;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`
          },
          signal: controller.signal
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Supabase read alerts failed: ${response.status} - ${errText}`);
        }
        list = await response.json();
      } catch (error) {
        console.error('Error reading alerts from Supabase, returning empty array:', error);
        list = [];
      } finally {
        clearTimeout(timeoutId);
      }
    } else {
      try {
        const raw = await readFile(this.filePath, 'utf8');
        list = JSON.parse(raw);
      } catch (error) {
        if (error.code === 'ENOENT') list = [];
        else throw error;
      }
    }

    return list;
  }

  async save(alert) {
    if (this.isSupabase) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const url = `${this.supabaseUrl}/rest/v1/hype_alerts`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify(alert),
          signal: controller.signal
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Supabase save alert failed: ${response.status} - ${errText}`);
        }
        return true;
      } catch (error) {
        console.error('Error saving alert to Supabase:', error);
        return false;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    const alerts = await this.readAll();
    const existingIndex = alerts.findIndex(a => a.id === alert.id);
    if (existingIndex !== -1) {
      alerts[existingIndex] = alert;
    } else {
      alerts.push(alert);
    }
    await this.writeAll(alerts);
    return true;
  }

  async delete(id) {
    if (this.isSupabase) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const url = `${this.supabaseUrl}/rest/v1/hype_alerts?id=eq.${id}`;
        const response = await fetch(url, {
          method: 'DELETE',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`
          },
          signal: controller.signal
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Supabase delete alert failed: ${response.status} - ${errText}`);
        }
        return true;
      } catch (error) {
        console.error('Error deleting alert from Supabase:', error);
        return false;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    const alerts = await this.readAll();
    const filtered = alerts.filter(a => a.id !== id);
    await this.writeAll(filtered);
    return true;
  }

  async writeAll(alerts) {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(alerts, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }
}

export class ConfigStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.supabaseUrl = process.env.SUPABASE_URL;
    this.supabaseKey = process.env.SUPABASE_KEY;
    this.isSupabase = !!(this.supabaseUrl && this.supabaseKey);
  }

  async get(key) {
    let value = null;
    if (this.isSupabase) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const url = `${this.supabaseUrl}/rest/v1/hype_config?key=eq.${key}&select=value`;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`
          },
          signal: controller.signal
        });
        if (!response.ok) {
          if (response.status === 404) return null;
          throw new Error(`Supabase get config failed: ${response.status}`);
        }
        const data = await response.json();
        value = data[0]?.value ?? null;
      } catch (error) {
        console.error(`Error reading config ${key} from Supabase:`, error);
        value = null;
      } finally {
        clearTimeout(timeoutId);
      }
    } else {
      try {
        const raw = await readFile(this.filePath, 'utf8');
        const data = JSON.parse(raw);
        value = data[key] ?? null;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }

    if (key === 'telegram_bot_token') {
      if (!value || value === '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11') {
        value = process.env.TELEGRAM_BOT_TOKEN || value;
      }
    } else if (key === 'telegram_chat_id') {
      if (!value || value === '-100987654321') {
        value = process.env.TELEGRAM_CHAT_ID || value;
      }
    }

    return value;
  }

  async set(key, value) {
    if (this.isSupabase) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const url = `${this.supabaseUrl}/rest/v1/hype_config`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify({ key, value: typeof value === 'object' ? JSON.stringify(value) : value }),
          signal: controller.signal
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Supabase set config failed: ${response.status} - ${errText}`);
        }
        return true;
      } catch (error) {
        console.error(`Error writing config ${key} to Supabase:`, error);
        return false;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    try {
      let data = {};
      try {
        const raw = await readFile(this.filePath, 'utf8');
        data = JSON.parse(raw);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      data[key] = value;
      const directory = path.dirname(this.filePath);
      await mkdir(directory, { recursive: true });
      await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (error) {
      console.error('Error writing config locally:', error);
      return false;
    }
  }
}

export class PresetsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.supabaseUrl = process.env.SUPABASE_URL;
    this.supabaseKey = process.env.SUPABASE_KEY;
    this.isSupabase = !!(this.supabaseUrl && this.supabaseKey);
  }

  async readAll(telegramUserId) {
    if (!telegramUserId) return [];
    if (this.isSupabase) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const url = `${this.supabaseUrl}/rest/v1/hype_presets?telegram_user_id=eq.${telegramUserId}&select=*&order=created_at.desc`;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`
          },
          signal: controller.signal
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Supabase read presets failed: ${response.status} - ${errText}`);
        }
        const rows = await response.json();
        return rows.map(r => ({ name: r.name, preset_data: r.preset_data }));
      } catch (error) {
        console.error('Error reading presets from Supabase:', error);
        return [];
      } finally {
        clearTimeout(timeoutId);
      }
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      const userPresetsObj = data[telegramUserId] || {};
      return Object.keys(userPresetsObj).map(name => ({
        name,
        preset_data: userPresetsObj[name]
      }));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async save(telegramUserId, name, presetData) {
    if (!telegramUserId || !name) return false;
    if (this.isSupabase) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const url = `${this.supabaseUrl}/rest/v1/hype_presets`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify({
            telegram_user_id: telegramUserId,
            name: name,
            preset_data: presetData
          }),
          signal: controller.signal
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Supabase save preset failed: ${response.status} - ${errText}`);
        }
        return true;
      } catch (error) {
        console.error('Error saving preset to Supabase:', error);
        return false;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    try {
      let data = {};
      try {
        const raw = await readFile(this.filePath, 'utf8');
        data = JSON.parse(raw);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (!data[telegramUserId]) {
        data[telegramUserId] = {};
      }
      data[telegramUserId][name] = presetData;

      const directory = path.dirname(this.filePath);
      await mkdir(directory, { recursive: true });
      await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (error) {
      console.error('Error writing preset locally:', error);
      return false;
    }
  }

  async delete(telegramUserId, name) {
    if (!telegramUserId || !name) return false;
    if (this.isSupabase) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const url = `${this.supabaseUrl}/rest/v1/hype_presets?telegram_user_id=eq.${telegramUserId}&name=eq.${name}`;
        const response = await fetch(url, {
          method: 'DELETE',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`
          },
          signal: controller.signal
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Supabase delete preset failed: ${response.status} - ${errText}`);
        }
        return true;
      } catch (error) {
        console.error('Error deleting preset from Supabase:', error);
        return false;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      if (data[telegramUserId] && data[telegramUserId][name]) {
        delete data[telegramUserId][name];
        const directory = path.dirname(this.filePath);
        await mkdir(directory, { recursive: true });
        await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8');
      }
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      console.error('Error deleting preset locally:', error);
      return false;
    }
  }
}

export class AutoTradeStore {
  constructor(configPath, statePath) {
    this.configPath = configPath;
    this.statePath = statePath;
    this.supabaseUrl = process.env.SUPABASE_URL;
    this.supabaseKey = process.env.SUPABASE_KEY;
    this.isSupabase = !!(this.supabaseUrl && this.supabaseKey);
  }

  async getConfig() {
    if (this.isSupabase) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const url = `${this.supabaseUrl}/rest/v1/hype_config?key=eq.autotrade_config&select=value`;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`
          },
          signal: controller.signal
        });
        if (!response.ok) {
          if (response.status === 404) return { strategies: [], wallets: [] };
          throw new Error(`Supabase get config failed: ${response.status}`);
        }
        const data = await response.json();
        const value = data[0]?.value;
        if (!value) return { strategies: [], wallets: [] };
        
        const parsed = (typeof value === 'string') ? JSON.parse(value) : value;
        return {
          strategies: parsed.strategies || [],
          wallets: parsed.wallets || []
        };
      } catch (error) {
        console.error('Error reading autotrade config from Supabase:', error);
        return { strategies: [], wallets: [] };
      } finally {
        clearTimeout(timeoutId);
      }
    }

    try {
      const raw = await readFile(this.configPath, 'utf8');
      const data = JSON.parse(raw);
      if (data && !data.strategies && data.alertId) {
        // Migrate old single-strategy config to multiple strategies
        const defaultStrategy = {
          id: 'default_strategy',
          name: 'Default Strategy',
          enabled: !!data.enabled,
          exchange: data.exchange || 'hl',
          testnet: data.testnet !== false,
          wallet: data.wallet || '',
          privateKey: data.privateKey || '',
          apiKey: data.apiKey || '',
          apiSecret: data.apiSecret || '',
          alertId: data.alertId || '',
          direction: data.direction || 'auto',
          orderCount: data.orderCount || 3,
          tradeAmount: data.tradeAmount || 60,
          legOffset1: data.legOffset1 ?? -0.3,
          legAmount1: data.legAmount1 ?? 10,
          legOffset2: data.legOffset2 ?? -1.0,
          legAmount2: data.legAmount2 ?? 20,
          legOffset3: data.legOffset3 ?? -2.0,
          legAmount3: data.legAmount3 ?? 30,
          tpMode: data.tpMode || 'percent',
          tpPercent: data.tpPercent ?? 1.5,
          tpAnchor: data.tpAnchor || 'avg',
          tpCloseSelect: data.tpCloseSelect || 'same',
          tpCustomExpr: data.tpCustomExpr || null,
          slMode: data.slMode || 'percent',
          slPercent: data.slPercent ?? 2.0,
          slCloseSelect: data.slCloseSelect || 'same',
          slCustomExpr: data.slCustomExpr || null
        };
        return { strategies: [defaultStrategy], wallets: [] };
      }
      if (!data) return { strategies: [], wallets: [] };
      return {
        strategies: data.strategies || [],
        wallets: data.wallets || []
      };
    } catch (error) {
      if (error.code === 'ENOENT') return { strategies: [], wallets: [] };
      throw error;
    }
  }

  async saveConfig(config) {
    if (this.isSupabase) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const url = `${this.supabaseUrl}/rest/v1/hype_config`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify({ key: 'autotrade_config', value: JSON.stringify(config) }),
          signal: controller.signal
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Supabase set config failed: ${response.status} - ${errText}`);
        }
        return true;
      } catch (error) {
        console.error('Error writing autotrade config to Supabase:', error);
        return false;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    const directory = path.dirname(this.configPath);
    await mkdir(directory, { recursive: true });
    await writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf8');
    return true;
  }

  async getState() {
    if (this.isSupabase) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const url = `${this.supabaseUrl}/rest/v1/hype_config?key=eq.autotrade_state&select=value`;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`
          },
          signal: controller.signal
        });
        if (!response.ok) {
          if (response.status === 404) return { activePositions: [], logs: [], tradeHistory: [] };
          throw new Error(`Supabase get state failed: ${response.status}`);
        }
        const data = await response.json();
        const value = data[0]?.value;
        if (!value) return { activePositions: [], logs: [], tradeHistory: [] };

        const parsed = (typeof value === 'string') ? JSON.parse(value) : value;
        return {
          activePositions: parsed.activePositions || [],
          logs: parsed.logs || [],
          tradeHistory: parsed.tradeHistory || []
        };
      } catch (error) {
        console.error('Error reading autotrade state from Supabase:', error);
        return { activePositions: [], logs: [], tradeHistory: [] };
      } finally {
        clearTimeout(timeoutId);
      }
    }

    try {
      const raw = await readFile(this.statePath, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          activePositions: [],
          logs: [],
          tradeHistory: []
        };
      }
      throw error;
    }
  }

  async saveState(state) {
    if (this.isSupabase) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const url = `${this.supabaseUrl}/rest/v1/hype_config`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify({ key: 'autotrade_state', value: JSON.stringify(state) }),
          signal: controller.signal
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Supabase set state failed: ${response.status} - ${errText}`);
        }
        return true;
      } catch (error) {
        console.error('Error writing autotrade state to Supabase:', error);
        return false;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    const directory = path.dirname(this.statePath);
    await mkdir(directory, { recursive: true });
    await writeFile(this.statePath, JSON.stringify(state, null, 2), 'utf8');
    return true;
  }
}
