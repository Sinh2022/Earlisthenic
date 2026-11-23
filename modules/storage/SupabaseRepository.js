/**
 * Earlisthenic Supabase Repository Client
 * 
 * Provides direct PostgREST communication with Supabase PostgreSQL,
 * with automatic offline queueing in IndexedDB / localStorage.
 */
class EarlisthenicSupabaseRepository {
  constructor(options = {}) {
    this.supabaseUrl = options.supabaseUrl || 'https://api.earlisthenic.com';
    this.anonKey = options.anonKey || '';
    this.token = options.token || null;
    this.offlineQueueKey = 'earlisthenic_supabase_offline_queue';
  }

  setAuthToken(token) {
    this.token = token;
  }

  _getHeaders() {
    const headers = {
      'apikey': this.anonKey,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  async getProfile(userId) {
    if (!userId) return null;
    const url = `${this.supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=*`;
    try {
      const res = await fetch(url, { method: 'GET', headers: this._getHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return (Array.isArray(data) && data[0]) ? data[0] : null;
    } catch (e) {
      // Offline fallback: check localStorage
      const cached = localStorage.getItem(`earlisthenic_profile_${userId}`);
      return cached ? JSON.parse(cached) : null;
    }
  }

  async upsertProfile(profile) {
    if (!profile || !profile.id) return null;
    const url = `${this.supabaseUrl}/rest/v1/profiles`;
    const headers = { ...this._getHeaders(), 'Prefer': 'resolution=merge-duplicates,return=representation' };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(profile)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      localStorage.setItem(`earlisthenic_profile_${profile.id}`, JSON.stringify(profile));
      return (Array.isArray(data) && data[0]) ? data[0] : profile;
    } catch (e) {
      this._enqueueOffline('upsertProfile', profile);
      localStorage.setItem(`earlisthenic_profile_${profile.id}`, JSON.stringify(profile));
      return profile;
    }
  }

  async saveTrainingSession(session) {
    if (!session) return false;
    const url = `${this.supabaseUrl}/rest/v1/training_sessions`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this._getHeaders(),
        body: JSON.stringify(session)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (e) {
      this._enqueueOffline('saveTrainingSession', session);
      return false;
    }
  }

  async syncJndThresholds(userId, jndBands) {
    if (!userId || !jndBands) return false;
    const url = `${this.supabaseUrl}/rest/v1/jnd_thresholds`;
    const headers = { ...this._getHeaders(), 'Prefer': 'resolution=merge-duplicates' };
    const payload = {
      user_id: userId,
      bands: jndBands,
      updated_at: new Date().toISOString()
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (e) {
      this._enqueueOffline('syncJndThresholds', payload);
      return false;
    }
  }

  _enqueueOffline(action, payload) {
    try {
      const queue = JSON.parse(localStorage.getItem(this.offlineQueueKey) || '[]');
      queue.push({ action, payload, queuedAt: Date.now() });
      localStorage.setItem(this.offlineQueueKey, JSON.stringify(queue.slice(-100)));
    } catch (e) {}
  }

  async flushOfflineQueue() {
    let queue = [];
    try {
      queue = JSON.parse(localStorage.getItem(this.offlineQueueKey) || '[]');
    } catch (e) {
      return 0;
    }
    if (!queue.length) return 0;

    let flushedCount = 0;
    const remaining = [];
    for (const item of queue) {
      try {
        if (item.action === 'upsertProfile') await this.upsertProfile(item.payload);
        else if (item.action === 'saveTrainingSession') await this.saveTrainingSession(item.payload);
        else if (item.action === 'syncJndThresholds') await this.syncJndThresholds(item.payload.user_id, item.payload.bands);
        flushedCount++;
      } catch (e) {
        remaining.push(item);
      }
    }
    try {
      localStorage.setItem(this.offlineQueueKey, JSON.stringify(remaining));
    } catch (e) {}
    return flushedCount;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EarlisthenicSupabaseRepository };
}
if (typeof window !== 'undefined') {
  window.EarlisthenicSupabaseRepository = EarlisthenicSupabaseRepository;
}
