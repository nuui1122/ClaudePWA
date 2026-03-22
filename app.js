'use strict';

// ========== 定数 ==========
const DB_NAME    = 'ClaudePWA';
const DB_VERSION = 3;
const API_URL    = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

const PRESET_MODELS = [
  { id: 'claude-sonnet-4-6',          label: 'Sonnet 4.6 ★推奨' },
  { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
  { id: 'claude-haiku-4-5-20251001',  label: 'Haiku 4.5（高速）' },
  { id: 'claude-sonnet-4-20250514',   label: 'Sonnet 4' },
];

const DEFAULT_SETTINGS = {
  apiKey:                '',
  model:                 DEFAULT_MODEL,
  additionalModels:      '',
  systemPrompt:          '',
  maxTokens:             4096,
  temperature:           1.0,
  topK:                  '',      // '' = 送信しない（API任せ）
  topP:                  '',      // '' = 送信しない（API任せ）
  thinkingMode:          'adaptive', // 'disabled' | 'adaptive' | 'enabled'
  thinkingEffort:        'high',     // 'low' | 'medium' | 'high' | 'max'
  thinkingBudget:        10000,
  includeThoughts:       false,
  dummyUserPrompt:           '',
  dummyModelPrompt:          '',
  swapDummyOrder:            false,
  concatenateDummyModel:     false,
  proofreadingEnabled:       false,
  proofreadingModel:         'claude-haiku-4-5-20251001',
  proofreadingSystemPrompt:  '',
  summaryEnabled:            false,
  summaryModel:              'claude-haiku-4-5-20251001',
  summarySystemPrompt:       '',
  memoryEnabled:             false,
  memoryInterval:            10,   // 0 = 自動学習OFF
  darkMode:                  true,
  enterSend:                 false,
  autoScroll:                true,
};

// ========== ユーティリティ ==========

function generateId() { return crypto.randomUUID(); }

function formatDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function mergeConsecutiveRoles(messages) {
  const merged = [];
  for (const msg of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role && typeof prev.content === 'string' && typeof msg.content === 'string') {
      prev.content = prev.content + '\n' + msg.content;
    } else {
      merged.push({ ...msg });
    }
  }
  return merged;
}

// ========== Database ==========
class Database {
  constructor() { this.db = null; }

  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('appSettings')) db.createObjectStore('appSettings', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('profiles'))    db.createObjectStore('profiles',    { keyPath: 'id'  });
        if (!db.objectStoreNames.contains('memories'))    db.createObjectStore('memories',    { keyPath: 'id'  });
      };
      req.onsuccess = (e) => { this.db = e.target.result; resolve(); };
      req.onerror   = () => reject(req.error);
    });
  }

  _tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(store, mode).objectStore(store)[fn[0]](...fn.slice(1));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => reject(req.error);
    });
  }

  async getSessions() {
    const all = await this._tx('sessions', 'readonly', ['getAll']);
    return (all || []).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }
  getSession(id)    { return this._tx('sessions', 'readonly',  ['get', id]); }
  saveSession(s)    { return this._tx('sessions', 'readwrite', ['put', s]);  }
  deleteSession(id) { return this._tx('sessions', 'readwrite', ['delete', id]); }

  getSetting(key)    { return this._tx('appSettings', 'readonly',  ['get', key]).then(r => r?.value ?? null); }
  setSetting(key, v) { return this._tx('appSettings', 'readwrite', ['put', { key, value: v }]); }
  async getAllSettings() {
    const all = await this._tx('appSettings', 'readonly', ['getAll']);
    return Object.fromEntries((all || []).map(i => [i.key, i.value]));
  }

  async getProfiles() { return (await this._tx('profiles', 'readonly', ['getAll'])) || []; }
  getProfile(id)      { return this._tx('profiles', 'readonly',  ['get', id]); }
  saveProfile(p)      { return this._tx('profiles', 'readwrite', ['put', p]);  }
  deleteProfile(id)   { return this._tx('profiles', 'readwrite', ['delete', id]); }

  async getMemories(profileId) {
    const all = await this._tx('memories', 'readonly', ['getAll']);
    return (all || []).filter(m => m.profileId === profileId);
  }
  saveMemory(m)   { return this._tx('memories', 'readwrite', ['put', m]); }
  deleteMemory(id){ return this._tx('memories', 'readwrite', ['delete', id]); }
}

// ========== Claude API ==========
class ClaudeAPI {
  buildApiMessages(historyMessages, userMessage, settings) {
    const { dummyUserPrompt, dummyModelPrompt, swapDummyOrder, concatenateDummyModel } = settings;
    const history      = historyMessages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
    const hasDummyUser  = dummyUserPrompt  && dummyUserPrompt.trim();
    const hasDummyModel = dummyModelPrompt && dummyModelPrompt.trim();
    let messages;
    if (concatenateDummyModel && hasDummyModel) {
      messages = [
        ...history,
        { role: 'user',      content: hasDummyUser ? `${dummyUserPrompt.trim()}\n${userMessage}` : userMessage },
        { role: 'assistant', content: dummyModelPrompt.trim() },
      ];
    } else if (swapDummyOrder) {
      messages = [
        ...history,
        ...(hasDummyModel ? [{ role: 'assistant', content: dummyModelPrompt.trim() }] : []),
        ...(hasDummyUser  ? [{ role: 'user',      content: dummyUserPrompt.trim()  }] : []),
        { role: 'user', content: userMessage },
      ];
    } else {
      messages = [
        ...history,
        ...(hasDummyUser  ? [{ role: 'user',      content: dummyUserPrompt.trim()  }] : []),
        ...(hasDummyModel ? [{ role: 'assistant', content: dummyModelPrompt.trim() }] : []),
        { role: 'user', content: userMessage },
      ];
    }
    return mergeConsecutiveRoles(messages);
  }

  /**
   * SSEストリーミングでAPIにリクエストを送信する。
   * thinking_delta を受け取った場合は onThinkingChunk を呼ぶ。
   */
  async streamMessage({ messages, settings, systemPrompt, signal, onChunk, onThinkingChunk, onUsage }) {
    const { apiKey, model, maxTokens, temperature, topK, topP,
            thinkingMode, thinkingEffort, thinkingBudget } = settings;

    if (!apiKey?.trim()) throw new Error('APIキーが設定されていません。設定画面でAPIキーを入力してください。');

    const isThinkingEnabled = thinkingMode === 'adaptive' || thinkingMode === 'enabled';

    const payload = {
      model:      model || DEFAULT_MODEL,
      max_tokens: maxTokens || 4096,
      stream:     true,
      messages,
    };

    if (systemPrompt?.trim()) payload.system = systemPrompt.trim();

    // Thinking 設定
    if (thinkingMode === 'adaptive') {
      payload.thinking = { type: 'adaptive' };
      if (thinkingEffort) payload.thinking.effort = thinkingEffort;
    } else if (thinkingMode === 'enabled') {
      const budget = parseInt(thinkingBudget);
      if (budget >= 1024) payload.thinking = { type: 'enabled', budget_tokens: budget };
    }

    // パラメータ: Thinking 有効時は temperature/top_k/top_p を送らない（API仕様）
    if (!isThinkingEnabled) {
      if (temperature !== null && temperature !== undefined && temperature !== '') {
        payload.temperature = parseFloat(temperature);
      }
      const kVal = parseInt(topK);
      if (!isNaN(kVal) && kVal > 0) payload.top_k = kVal;
      const pVal = parseFloat(topP);
      if (!isNaN(pVal) && topP !== '') payload.top_p = pVal;
    }

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-api-key':     apiKey.trim(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      let errMsg = `APIエラー: HTTP ${response.status}`;
      try { errMsg = (await response.json()).error?.message || errMsg; } catch (_) {}
      throw new Error(errMsg);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta') {
            if (parsed.delta?.type === 'text_delta') {
              onChunk(parsed.delta.text);
            } else if (parsed.delta?.type === 'thinking_delta') {
              onThinkingChunk?.(parsed.delta.thinking);
            }
          } else if (parsed.type === 'message_delta' && parsed.usage) {
            onUsage?.(parsed.usage);
          }
        } catch (_) {}
      }
    }
  }
}

// ========== メインアプリ ==========
class App {
  constructor() {
    this.db              = new Database();
    this.api             = new ClaudeAPI();
    this.settings        = { ...DEFAULT_SETTINGS };
    this.sessions        = [];
    this.currentSession  = null;
    this.profiles        = [];
    this.currentProfile  = null;
    this.memories        = [];
    this.isGenerating    = false;
    this.isSummarizing   = false;
    this.abortController = null;
    this.activePanel     = 'chat';
    this.touchStartX     = 0;
    this.touchStartY     = 0;
    this._confirmCallback = null;
    this._toastTimer      = null;
  }

  // ========== 初期化 ==========

  async init() {
    try {
      await this.db.init();
      await this.initProfiles();
      await this.loadMemories();
      await this.loadSessions();
      this.applyTheme();
      this.bindEvents();
      this.registerServiceWorker();
      this.configureMarked();
      if (this.sessions.length > 0) await this.loadSession(this.sessions[0].id);
      else this.newChat();
    } catch (err) {
      console.error('初期化エラー:', err);
      this.showToast('初期化に失敗しました: ' + err.message, 'error');
    }
  }

  configureMarked() {
    if (typeof marked !== 'undefined') marked.setOptions({ breaks: true, gfm: true });
  }

  // ========== プロファイル ==========

  async initProfiles() {
    let profiles = await this.db.getProfiles();
    if (profiles.length === 0) {
      const legacy = await this.db.getAllSettings();
      const settings = { ...DEFAULT_SETTINGS };
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (legacy[k] !== undefined) settings[k] = legacy[k];
      }
      const def = { id: generateId(), name: 'デフォルト', icon: null, settings };
      await this.db.saveProfile(def);
      await this.db.setSetting('currentProfileId', def.id);
      profiles = [def];
    }
    this.profiles = profiles;
    const savedId = await this.db.getSetting('currentProfileId');
    this.currentProfile = profiles.find(p => p.id === savedId) || profiles[0];
    await this.db.setSetting('currentProfileId', this.currentProfile.id);
    this.settings = { ...DEFAULT_SETTINGS, ...this.currentProfile.settings };
    this.syncSettingsToUI();
    this.renderProfileSelect();
    this.updateProfileIconDisplay();
  }

  async saveSettings() {
    if (!this.currentProfile) return;
    this.currentProfile.settings = { ...this.settings };
    await this.db.saveProfile(this.currentProfile);
  }

  syncSettingsToUI() {
    const s = this.settings;
    this.setVal('setting-api-key',           s.apiKey);
    this.setVal('setting-system-prompt',     s.systemPrompt);
    this.setVal('setting-max-tokens',        s.maxTokens);
    this.setVal('setting-additional-models', s.additionalModels);
    // Temperature
    const temp = s.temperature ?? 1.0;
    this.setVal('setting-temperature',        temp);
    this.setVal('setting-temperature-slider', temp);
    const tempDisp = document.getElementById('temperature-display');
    if (tempDisp) tempDisp.textContent = parseFloat(temp).toFixed(2);
    // Top K / Top P
    this.setVal('setting-top-k', s.topK ?? '');
    this.setVal('setting-top-p', s.topP ?? '');
    // Dummy
    this.setVal('setting-dummy-user',  s.dummyUserPrompt);
    this.setVal('setting-dummy-model', s.dummyModelPrompt);
    this.setChecked('setting-dark-mode',         s.darkMode);
    this.setChecked('setting-enter-send',         s.enterSend);
    this.setChecked('setting-auto-scroll',        s.autoScroll);
    this.setChecked('setting-swap-dummy',         s.swapDummyOrder);
    this.setChecked('setting-concatenate-dummy',  s.concatenateDummyModel);
    // 校正機能
    this.setChecked('setting-proofreading-enabled', s.proofreadingEnabled);
    this.setVal('setting-proofreading-model',  s.proofreadingModel  || 'claude-haiku-4-5-20251001');
    this.setVal('setting-proofreading-prompt', s.proofreadingSystemPrompt || '');
    // 要約機能
    this.setChecked('setting-summary-enabled', s.summaryEnabled);
    this.setVal('setting-summary-model',  s.summaryModel  || 'claude-haiku-4-5-20251001');
    this.setVal('setting-summary-prompt', s.summarySystemPrompt || '');
    // メモリ機能
    this.setChecked('setting-memory-enabled', s.memoryEnabled);
    this.setVal('setting-memory-interval', s.memoryInterval ?? 10);
    // Thinking
    this.setVal('setting-thinking-mode',   s.thinkingMode   || 'adaptive');
    this.setVal('setting-thinking-effort', s.thinkingEffort || 'high');
    this.setVal('setting-thinking-budget', s.thinkingBudget ?? 10000);
    this.setChecked('setting-include-thoughts', s.includeThoughts);
    this.updateModelSelect();
    this._updateThinkingUI();
  }

  updateModelSelect() {
    const select = document.getElementById('setting-model');
    while (select.options.length > PRESET_MODELS.length) select.remove(select.options.length - 1);
    const presetIds = PRESET_MODELS.map(m => m.id);
    (this.settings.additionalModels || '').split(',').map(s => s.trim())
      .filter(s => s && !presetIds.includes(s))
      .forEach(m => { const o = document.createElement('option'); o.value = o.textContent = m; select.appendChild(o); });
    select.value = this.settings.model;
    if (!select.value) select.value = DEFAULT_MODEL;
  }

  readSettingsFromUI() {
    this.settings.apiKey                = this.getVal('setting-api-key');
    this.settings.systemPrompt          = this.getVal('setting-system-prompt');
    this.settings.maxTokens             = parseInt(this.getVal('setting-max-tokens')) || 4096;
    this.settings.additionalModels      = this.getVal('setting-additional-models');
    this.settings.model                 = document.getElementById('setting-model').value || DEFAULT_MODEL;
    // Temperature
    const tempStr = this.getVal('setting-temperature');
    this.settings.temperature = tempStr !== '' ? parseFloat(tempStr) : 1.0;
    // Top K / Top P（空文字 = 送信しない）
    this.settings.topK = this.getVal('setting-top-k');
    this.settings.topP = this.getVal('setting-top-p');
    // Dummy
    this.settings.dummyUserPrompt       = this.getVal('setting-dummy-user');
    this.settings.dummyModelPrompt      = this.getVal('setting-dummy-model');
    this.settings.swapDummyOrder           = this.getChecked('setting-swap-dummy');
    this.settings.concatenateDummyModel   = this.getChecked('setting-concatenate-dummy');
    // 校正機能
    this.settings.proofreadingEnabled      = this.getChecked('setting-proofreading-enabled');
    this.settings.proofreadingModel        = this.getVal('setting-proofreading-model') || 'claude-haiku-4-5-20251001';
    this.settings.proofreadingSystemPrompt = this.getVal('setting-proofreading-prompt');
    // 要約機能
    this.settings.summaryEnabled      = this.getChecked('setting-summary-enabled');
    this.settings.summaryModel        = this.getVal('setting-summary-model') || 'claude-haiku-4-5-20251001';
    this.settings.summarySystemPrompt = this.getVal('setting-summary-prompt');
    // メモリ機能
    this.settings.memoryEnabled  = this.getChecked('setting-memory-enabled');
    this.settings.memoryInterval = parseInt(this.getVal('setting-memory-interval')) || 0;
    this.settings.darkMode       = this.getChecked('setting-dark-mode');
    this.settings.enterSend             = this.getChecked('setting-enter-send');
    this.settings.autoScroll            = this.getChecked('setting-auto-scroll');
    // Thinking
    this.settings.thinkingMode    = this.getVal('setting-thinking-mode')   || 'adaptive';
    this.settings.thinkingEffort  = this.getVal('setting-thinking-effort') || 'high';
    this.settings.thinkingBudget  = parseInt(this.getVal('setting-thinking-budget')) || 10000;
    this.settings.includeThoughts = this.getChecked('setting-include-thoughts');
  }

  applyTheme() {
    const app = document.getElementById('app');
    app.classList.toggle('dark',  !!this.settings.darkMode);
    app.classList.toggle('light', !this.settings.darkMode);
  }

  /**
   * Thinking モードに応じて設定UIの表示を切り替える。
   * effort行: adaptive時のみ表示
   * budget行: enabled時のみ表示
   * include行: 無効以外で表示
   * temperature行: thinking有効時はグレーアウト
   */
  _updateThinkingUI() {
    const mode = this.getVal('setting-thinking-mode');
    const isEnabled = mode !== 'disabled';

    const show = (id, visible) => {
      const el = document.getElementById(id);
      if (el) el.style.display = visible ? '' : 'none';
    };
    show('thinking-effort-row',  mode === 'adaptive');
    show('thinking-budget-row',  mode === 'enabled');
    show('thinking-include-row', isEnabled);

    // Temperature: thinking有効時はグレーアウト
    const tempItem = document.getElementById('temperature-item');
    if (tempItem) tempItem.classList.toggle('param-disabled', isEnabled);
  }

  // ========== プロファイル管理 ==========

  renderProfileSelect() {
    const select = document.getElementById('profile-select');
    select.innerHTML = '';
    this.profiles.forEach(p => {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.name; select.appendChild(o);
    });
    if (this.currentProfile) select.value = this.currentProfile.id;
  }

  updateProfileIconDisplay() {
    if (!this.currentProfile) return;
    const initialEl = document.getElementById('profile-icon-initial');
    const imgEl     = document.getElementById('profile-icon-img');
    const nameInput = document.getElementById('profile-name-input');
    if (nameInput) nameInput.value = this.currentProfile.name;
    if (this.currentProfile.icon) {
      imgEl.src = this.currentProfile.icon; imgEl.style.display = 'block'; initialEl.style.display = 'none';
    } else {
      imgEl.style.display = 'none'; initialEl.style.display = 'block';
      initialEl.textContent = (this.currentProfile.name || '?')[0].toUpperCase();
    }
  }

  async switchProfile(id) {
    this.readSettingsFromUI();
    await this.saveSettings();
    const profile = await this.db.getProfile(id);
    if (!profile) return;
    this.currentProfile = profile;
    this.profiles       = await this.db.getProfiles();
    this.settings       = { ...DEFAULT_SETTINGS, ...profile.settings };
    await this.db.setSetting('currentProfileId', id);
    await this.loadMemories();
    this.syncSettingsToUI();
    this.renderProfileSelect();
    this.updateProfileIconDisplay();
    this.applyTheme();
    this.showToast(`プロファイル「${profile.name}」に切り替えました`);
  }

  async createNewProfile() {
    const name = window.prompt('新しいプロファイルの名前を入力:', '新しいプロファイル');
    if (!name?.trim()) return;
    const p = { id: generateId(), name: name.trim(), icon: null, settings: { ...DEFAULT_SETTINGS } };
    await this.db.saveProfile(p);
    this.profiles = await this.db.getProfiles();
    await this.switchProfile(p.id);
    this.showToast(`プロファイル「${p.name}」を作成しました`);
  }

  async duplicateCurrentProfile() {
    if (!this.currentProfile) return;
    this.readSettingsFromUI();
    const name = window.prompt('複製後の名前を入力:', this.currentProfile.name + ' のコピー');
    if (!name?.trim()) return;
    const p = { id: generateId(), name: name.trim(), icon: this.currentProfile.icon, settings: { ...this.settings } };
    await this.db.saveProfile(p);
    this.profiles = await this.db.getProfiles();
    await this.switchProfile(p.id);
    this.showToast('プロファイルを複製しました');
  }

  async deleteCurrentProfile() {
    if (this.profiles.length <= 1) { this.showToast('最後のプロファイルは削除できません', 'error'); return; }
    const name = this.currentProfile.name;
    this.showConfirm(`プロファイル「${name}」を削除しますか？`, async () => {
      await this.db.deleteProfile(this.currentProfile.id);
      this.profiles = await this.db.getProfiles();
      await this.switchProfile(this.profiles[0].id);
      this.showToast(`プロファイル「${name}」を削除しました`);
    });
  }

  exportCurrentProfile() {
    if (!this.currentProfile) return;
    this.readSettingsFromUI();
    const blob = new Blob([JSON.stringify({ version: 1, type: 'claude-pwa-profile',
      profile: { name: this.currentProfile.name, icon: this.currentProfile.icon, settings: { ...this.settings } }
    }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `profile-${this.currentProfile.name.replace(/[^\w\u3000-\u9fff]/g, '_')}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    this.showToast('プロファイルを書き出しました');
  }

  async importProfile(file) {
    try {
      const data = JSON.parse(await file.text());
      if (data.type !== 'claude-pwa-profile' || !data.profile) throw new Error('形式が正しくありません');
      const { name, icon, settings } = data.profile;
      const p = { id: generateId(), name: name || 'インポート', icon: icon || null,
        settings: { ...DEFAULT_SETTINGS, ...(settings || {}) } };
      await this.db.saveProfile(p);
      this.profiles = await this.db.getProfiles();
      await this.switchProfile(p.id);
      this.showToast(`プロファイル「${p.name}」を読み込みました`);
    } catch (err) {
      this.showToast('読み込みに失敗しました: ' + err.message, 'error');
    }
  }

  async compressImage(file) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = e => {
        const img = new Image();
        img.onload = () => {
          const SIZE = 64, canvas = document.createElement('canvas');
          canvas.width = canvas.height = SIZE;
          const ctx = canvas.getContext('2d'), min = Math.min(img.width, img.height);
          ctx.drawImage(img, (img.width - min) / 2, (img.height - min) / 2, min, min, 0, 0, SIZE, SIZE);
          resolve(canvas.toDataURL('image/webp', 0.85));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ========== セッション管理 ==========

  async loadSessions() {
    this.sessions = await this.db.getSessions();
    this.renderHistoryList();
  }

  async loadSession(id) {
    const session = await this.db.getSession(id);
    if (!session) return;
    this.currentSession = session;
    document.getElementById('chat-title').textContent = session.title;
    this.renderMessages();
    this.updateTokenInfo();
    this.updateSummaryButton();
    this.renderHistoryList();
    this.showPanel('chat');
  }

  newChat() {
    this.currentSession = {
      id: generateId(), title: '新しいチャット',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      profileId: this.currentProfile?.id || null,
      systemPrompt: '', summary: null, summaryIndex: null, tokenCount: 0, messages: [],
    };
    document.getElementById('chat-title').textContent = this.currentSession.title;
    this.renderMessages(); this.updateTokenInfo(); this.updateSummaryButton(); this.showPanel('chat');
  }

  async saveCurrentSession() {
    if (!this.currentSession) return;
    this.currentSession.updatedAt = new Date().toISOString();
    await this.db.saveSession(this.currentSession);
    await this.loadSessions();
  }

  async deleteSession(id) {
    await this.db.deleteSession(id);
    await this.loadSessions();
    if (this.currentSession?.id === id) {
      if (this.sessions.length > 0) await this.loadSession(this.sessions[0].id);
      else this.newChat();
    }
  }

  // ========== セッション エクスポート / インポート ==========

  async exportSession(id) {
    const session = await this.db.getSession(id);
    if (!session) return;
    const safeName = session.title.replace(/[^\w\u3000-\u9fff]/g, '_').slice(0, 30);
    const blob = new Blob([JSON.stringify({
      version: 1, type: 'claude-pwa-session',
      exportedAt: new Date().toISOString(),
      session,
    }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `session-${safeName}_${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    this.showToast(`「${session.title}」をエクスポートしました`);
  }

  async exportAllSessions() {
    const sessions = await this.db.getSessions();
    if (sessions.length === 0) { this.showToast('エクスポートするセッションがありません', 'error'); return; }
    const blob = new Blob([JSON.stringify({
      version: 1, type: 'claude-pwa-sessions',
      exportedAt: new Date().toISOString(),
      sessions,
    }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sessions-all_${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    this.showToast(`${sessions.length}件のセッションをエクスポートしました`);
  }

  async importSessions(file) {
    try {
      const data = JSON.parse(await file.text());
      let sessionsToImport = [];
      if (data.type === 'claude-pwa-session' && data.session) {
        sessionsToImport = [data.session];
      } else if (data.type === 'claude-pwa-sessions' && Array.isArray(data.sessions)) {
        sessionsToImport = data.sessions;
      } else {
        throw new Error('形式が正しくありません（claude-pwa-session/sessions 形式のみ対応）');
      }
      const existingIds = new Set(this.sessions.map(s => s.id));
      let imported = 0;
      let firstId = null;
      for (const session of sessionsToImport) {
        if (!session.id || !Array.isArray(session.messages)) continue;
        if (existingIds.has(session.id)) session.id = generateId();
        if (!firstId) firstId = session.id;
        await this.db.saveSession(session);
        imported++;
      }
      await this.loadSessions();
      this.showToast(`${imported}件のセッションをインポートしました`);
      if (imported > 0 && sessionsToImport.length === 1 && firstId) await this.loadSession(firstId);
    } catch (err) {
      this.showToast('インポートに失敗しました: ' + err.message, 'error');
    }
  }

  async renameSession(id, newTitle) {
    const session = await this.db.getSession(id);
    if (!session) return;
    session.title = newTitle; session.updatedAt = new Date().toISOString();
    await this.db.saveSession(session);
    if (this.currentSession?.id === id) {
      this.currentSession.title = newTitle;
      document.getElementById('chat-title').textContent = newTitle;
    }
    await this.loadSessions();
  }

  // ========== 生成ヘルパー ==========

  _makeMessage(role, content = '') {
    return {
      id: generateId(), role, content, thinking: null,
      timestamp: new Date().toISOString(), isEdited: false,
      alternatives:         role === 'assistant' ? [] : undefined,
      activeAlternativeIndex: role === 'assistant' ? 0 : undefined,
    };
  }

  _getPrefixText() {
    return (this.settings.concatenateDummyModel && this.settings.dummyModelPrompt)
      ? this.settings.dummyModelPrompt.trim() : '';
  }

  _onUsage(usage) {
    const total = (usage.input_tokens || 0) + (usage.output_tokens || 0);
    this.currentSession.tokenCount = (this.currentSession.tokenCount || 0) + total;
    this.updateTokenInfo();
  }

  /**
   * alternatives のエントリを取得する。
   * 旧形式（文字列）と新形式（{content, thinking}オブジェクト）の両方に対応。
   */
  _getAlt(alternatives, idx) {
    const alt = alternatives?.[idx];
    if (!alt) return { content: '', thinking: null };
    if (typeof alt === 'string') return { content: alt, thinking: null };
    return alt;
  }

  /**
   * ストリーミング生成の共通ヘルパー。
   * thinking_delta を受け取ったら「思考中」インジケーターを表示する。
   * @returns {Promise<{content: string, thinking: string|null}>}
   */
  async _doGenerate({ apiMessages, systemPrompt, prefixText = '', contentEl, signal, onProgress, onUsage }) {
    let accumulated      = '';
    let thinkingText     = '';
    let thinkingStreamEl = null;

    await this.api.streamMessage({
      messages: apiMessages, settings: this.settings, systemPrompt, signal,
      onChunk: (chunk) => {
        // 思考ストリームインジケーターを除去（テキスト開始時）
        if (thinkingStreamEl) { thinkingStreamEl.remove(); thinkingStreamEl = null; }
        accumulated += chunk;
        const current = prefixText + accumulated;
        contentEl.innerHTML = this.renderMarkdown(current);
        const msgEl = contentEl.closest('.message');
        if (msgEl) this.highlightCode(msgEl);
        if (this.settings.autoScroll) this.scrollToBottom();
        onProgress?.(current);
      },
      onThinkingChunk: (chunk) => {
        thinkingText += chunk;
        // 初回: 思考中インジケーターを作成
        if (!thinkingStreamEl) {
          thinkingStreamEl = document.createElement('div');
          thinkingStreamEl.className = 'thinking-stream';
          thinkingStreamEl.innerHTML = `
            <div class="thinking-stream-label">思考中</div>
            <div class="thinking-stream-dots"><span></span><span></span><span></span></div>
          `;
          contentEl.parentElement.insertBefore(thinkingStreamEl, contentEl);
        }
      },
      onUsage,
    });

    // ストリーム終了後もインジケーターが残っていたら除去
    thinkingStreamEl?.remove();

    return { content: prefixText + accumulated, thinking: thinkingText || null };
  }

  // ========== 要約機能 ==========

  /**
   * セッションのシステムプロンプトを構築する。
   * summary がある場合は summary を末尾に追加する。
   */
  _buildSystemPrompt() {
    let sp = (this.currentSession?.systemPrompt || this.settings.systemPrompt || '').trim();
    if (this.currentSession?.summary) {
      const section = '## これまでの会話の要約\n' + this.currentSession.summary;
      sp = sp ? sp + '\n\n' + section : section;
    }
    if (this.settings.memoryEnabled && this.memories?.length > 0) {
      const memSection = '## ユーザーの記憶・好み\n' +
        this.memories.map(m => `- ${m.key}: ${m.value}`).join('\n');
      sp = sp ? sp + '\n\n' + memSection : memSection;
    }
    return sp;
  }

  /**
   * summary がある場合、API送信用履歴を「冒頭5件 + 要約後の最新15件」に絞る。
   * historyMsgs の最後の要素は必ず保持する（現在のユーザーメッセージ）。
   */
  _buildContextMessages(historyMsgs) {
    if (!historyMsgs || historyMsgs.length === 0) return historyMsgs;
    const { summary, summaryIndex } = this.currentSession || {};
    if (!summary || summaryIndex == null) return historyMsgs;

    const HEAD = 5, TAIL = 15;
    const lastMsg   = historyMsgs[historyMsgs.length - 1]; // 現在のユーザーメッセージ
    const priorMsgs = historyMsgs.slice(0, -1);            // それ以前の全メッセージ

    const head        = priorMsgs.slice(0, HEAD);
    const afterSummary = priorMsgs.slice(summaryIndex + 1);
    const tail        = afterSummary.slice(-TAIL);

    const headIds   = new Set(head.map(m => m.id));
    const uniqueTail = tail.filter(m => !headIds.has(m.id));
    return [...head, ...uniqueTail, lastMsg];
  }

  /** メッセージが要約済み範囲かどうか判定する */
  _isMsgSummarized(msgId) {
    const { summaryIndex } = this.currentSession || {};
    if (summaryIndex == null) return false;
    const idx = this.currentSession.messages.findIndex(m => m.id === msgId);
    return idx !== -1 && idx <= summaryIndex;
  }

  /** 要約ボタンの表示・有効/無効を更新する */
  updateSummaryButton() {
    const btn = document.getElementById('btn-summarize');
    if (!btn) return;
    const enabled = this.settings.summaryEnabled;
    btn.style.display = enabled ? '' : 'none';
    if (!enabled) return;
    const count = this.currentSession?.messages?.length || 0;
    btn.disabled = count < 50;
    btn.title = count < 50 ? `会話を要約（${count}/50件）` : '会話を要約';
  }

  /** 要約を生成してモーダルに表示する */
  async runSummary() {
    if (this.isSummarizing || this.isGenerating || !this.currentSession) return;
    const msgs = this.currentSession.messages;
    if (!msgs || msgs.length === 0) return;

    const modal      = document.getElementById('summary-modal');
    const textarea   = document.getElementById('summary-modal-textarea');
    const confirmBtn = document.getElementById('summary-modal-confirm');
    modal.classList.remove('hidden');
    textarea.value       = '';
    textarea.disabled    = true;
    textarea.placeholder = '要約を生成中...';
    confirmBtn.disabled  = true;

    this.isSummarizing = true;
    const summarySettings = {
      ...this.settings,
      model: this.settings.summaryModel || 'claude-haiku-4-5-20251001',
      thinkingMode: 'disabled',
    };
    const convText = msgs.map(m =>
      `[${m.role === 'user' ? 'ユーザー' : 'AI'}]:\n${m.content}`
    ).join('\n\n---\n\n');
    const sysPrompt = this.settings.summarySystemPrompt?.trim()
      || '以下の会話履歴を要約してください。小説執筆に関わる重要な情報（ストーリーの進捗、登場人物の状況、設定、決定事項など）を漏らさず、簡潔にまとめてください。';

    try {
      let summary = '';
      await this.api.streamMessage({
        messages: [{ role: 'user', content: convText }],
        settings: summarySettings,
        systemPrompt: sysPrompt,
        signal: null,
        onChunk: (chunk) => { summary += chunk; textarea.value = summary; },
      });
      textarea.disabled    = false;
      textarea.placeholder = '';
      confirmBtn.disabled  = false;
      textarea.focus();
    } catch (err) {
      modal.classList.add('hidden');
      this.showToast('要約の生成に失敗しました: ' + err.message, 'error');
    } finally {
      this.isSummarizing = false;
    }
  }

  /** 要約を確定してセッションに保存する */
  async applySummary(summaryText) {
    if (!summaryText?.trim() || !this.currentSession) return;
    this.currentSession.summary      = summaryText.trim();
    this.currentSession.summaryIndex = this.currentSession.messages.length - 1;
    await this.saveCurrentSession();
    this.renderMessages();
    this.updateSummaryButton();
    this.showToast('要約を保存しました');
  }

  // ========== メモリ機能 ==========

  /** 現在プロファイルのメモリをDBからキャッシュに読み込む */
  async loadMemories() {
    if (!this.currentProfile) { this.memories = []; return; }
    this.memories = await this.db.getMemories(this.currentProfile.id);
  }

  /**
   * 最近の会話を別モデルに送り、ユーザーの特徴を抽出してDBに保存する。
   * バックグラウンド実行（awaitなし）を想定。
   */
  async runMemoryExtraction() {
    if (!this.currentProfile || !this.currentSession) return;
    const msgs = this.currentSession.messages;
    const interval = this.settings.memoryInterval || 10;
    const recentMsgs = msgs.slice(-(interval * 2));

    const convText = recentMsgs.map(m =>
      `[${m.role === 'user' ? 'ユーザー' : 'AI'}]: ${m.content}`
    ).join('\n\n');

    const extractSettings = {
      ...this.settings,
      model: this.settings.summaryModel || 'claude-haiku-4-5-20251001',
      thinkingMode: 'disabled',
      maxTokens: 1024,
    };
    const sysPrompt = '以下の会話からユーザーの好み・特徴・要望・癖を抽出してください。JSON配列形式のみで返してください: [{"key": "特徴名", "value": "内容"}]';

    try {
      let responseText = '';
      await this.api.streamMessage({
        messages: [{ role: 'user', content: convText }],
        settings: extractSettings,
        systemPrompt: sysPrompt,
        signal: null,
        onChunk: (chunk) => { responseText += chunk; },
      });

      const match = responseText.match(/\[[\s\S]*\]/);
      if (!match) return;
      const items = JSON.parse(match[0]);
      if (!Array.isArray(items)) return;

      const existing  = await this.db.getMemories(this.currentProfile.id);
      const byKey     = Object.fromEntries(existing.map(m => [m.key, m]));

      for (const item of items) {
        if (!item.key?.trim() || !item.value?.trim()) continue;
        if (byKey[item.key]) {
          byKey[item.key].value = item.value;
          await this.db.saveMemory(byKey[item.key]);
        } else {
          await this.db.saveMemory({ id: generateId(), profileId: this.currentProfile.id, key: item.key, value: item.value });
        }
      }
      await this.loadMemories();
    } catch (err) {
      console.warn('メモリ抽出エラー:', err);
    }
  }

  /** 記憶管理モーダルを開く */
  async showMemoryModal() {
    await this.loadMemories();
    this.renderMemoryList();
    document.getElementById('memory-modal').classList.remove('hidden');
  }

  /** モーダル内の記憶リストを再描画する */
  renderMemoryList() {
    const list = document.getElementById('memory-list');
    if (!list) return;
    list.innerHTML = '';
    if (this.memories.length === 0) {
      list.innerHTML = '<div class="memory-empty">記憶がありません</div>'; return;
    }
    for (const mem of this.memories) {
      const item = document.createElement('div');
      item.className = 'memory-item';
      item.innerHTML = `
        <span class="memory-key">${this.escapeHtml(mem.key)}</span>
        <span class="memory-sep">:</span>
        <span class="memory-value">${this.escapeHtml(mem.value)}</span>
        <button class="icon-btn sm danger" data-mem-del="${mem.id}" title="削除">✕</button>
      `;
      list.appendChild(item);
    }
  }

  /**
   * 生成完了後に校正モデルへ別リクエストを送り、結果でバブルを上書きする。
   * @param {object} assistantMsg - 対象のメッセージオブジェクト（content を上書きする）
   * @param {HTMLElement} bubbleEl - 対象のバブル要素
   */
  async _runProofreading(assistantMsg, bubbleEl) {
    const { proofreadingModel, proofreadingSystemPrompt } = this.settings;
    if (!proofreadingModel?.trim()) {
      this.showToast('校正用モデル名が設定されていません', 'error'); return;
    }

    const indicator = document.createElement('div');
    indicator.className = 'proofreading-indicator';
    indicator.textContent = '校正中...';
    bubbleEl.querySelector('.bubble').appendChild(indicator);

    const contentEl = bubbleEl.querySelector('.bubble-content');
    // 校正用に Thinking を無効化したコピー設定を使用
    const proofSettings = { ...this.settings, model: proofreadingModel, thinkingMode: 'disabled' };
    const sysPrompt = proofreadingSystemPrompt?.trim()
      || '以下のテキストを校正してください。誤字脱字・文法の誤りを修正し、原文のスタイルと意図を保ちながら読みやすく整えてください。';

    try {
      let proofText = '';
      await this.api.streamMessage({
        messages: [{ role: 'user', content: assistantMsg.content }],
        settings: proofSettings,
        systemPrompt: sysPrompt,
        signal: null,
        onChunk: (chunk) => {
          proofText += chunk;
          contentEl.innerHTML = this.renderMarkdown(proofText);
          const msgEl = contentEl.closest('.message');
          if (msgEl) this.highlightCode(msgEl);
          if (this.settings.autoScroll) this.scrollToBottom();
        },
      });

      // 校正結果で上書き
      assistantMsg.content = proofText;
      const activeIdx = assistantMsg.activeAlternativeIndex || 0;
      if (assistantMsg.alternatives?.[activeIdx]) {
        assistantMsg.alternatives[activeIdx] = {
          content: proofText,
          thinking: assistantMsg.alternatives[activeIdx].thinking,
        };
      }
      await this.saveCurrentSession();
      indicator.remove();
      this.updateBubble(bubbleEl, assistantMsg);
      this.showToast('校正が完了しました');
    } catch (err) {
      indicator.remove();
      this.showToast('校正に失敗しました: ' + err.message, 'error');
    }
  }

  // ========== メッセージ送信 ==========

  async sendMessage() {
    const input = document.getElementById('input-text');
    const text  = input.value.trim();
    if (!text || this.isGenerating) return;
    if (!this.settings.apiKey?.trim()) {
      this.showToast('APIキーを設定してください', 'error');
      this.showPanel('settings');
      return;
    }

    input.value = ''; input.style.height = 'auto';
    this.isGenerating = true; this.updateSendButton();

    const userMsg = this._makeMessage('user', text);
    this.currentSession.messages.push(userMsg);
    this.appendMessageBubble(userMsg);

    const assistantMsg = this._makeMessage('assistant');
    this.currentSession.messages.push(assistantMsg);
    const bubble    = this.appendMessageBubble(assistantMsg, true);
    const contentEl = bubble.querySelector('.bubble-content');

    const systemPrompt = this._buildSystemPrompt();
    const apiMessages  = this.api.buildApiMessages(
      this._buildContextMessages(this.currentSession.messages.slice(0, -1)), text, this.settings
    );
    const prefixText = this._getPrefixText();
    this.abortController = new AbortController();
    let partial = { content: '', thinking: null };

    try {
      const result = await this._doGenerate({
        apiMessages, systemPrompt, prefixText, contentEl,
        signal: this.abortController.signal,
        onProgress: (t) => { partial.content = t; },
        onUsage:    (u) => this._onUsage(u),
      });

      assistantMsg.content             = result.content;
      assistantMsg.thinking            = result.thinking;
      assistantMsg.alternatives        = [{ content: result.content, thinking: result.thinking }];
      assistantMsg.activeAlternativeIndex = 0;

      if (this.currentSession.title === '新しいチャット' && this.currentSession.messages.length === 2) {
        const auto = text.slice(0, 30) + (text.length > 30 ? '…' : '');
        this.currentSession.title = auto;
        document.getElementById('chat-title').textContent = auto;
      }
      await this.saveCurrentSession();
      this.updateBubble(bubble, assistantMsg);
      this.updateSummaryButton();
      // メモリ自動抽出（バックグラウンド実行）
      if (this.settings.memoryEnabled && this.settings.memoryInterval > 0) {
        const count = this.currentSession.messages.length;
        if (count > 0 && count % this.settings.memoryInterval === 0) this.runMemoryExtraction();
      }
      // 校正が有効なら実行
      if (this.settings.proofreadingEnabled) await this._runProofreading(assistantMsg, bubble);

    } catch (err) {
      if (err.name === 'AbortError') {
        if (partial.content.trim()) {
          assistantMsg.content      = partial.content;
          assistantMsg.thinking     = partial.thinking;
          assistantMsg.alternatives = [{ content: partial.content, thinking: partial.thinking }];
          await this.saveCurrentSession();
          this.updateBubble(bubble, assistantMsg);
        } else {
          this.currentSession.messages.pop(); bubble.remove();
        }
      } else {
        this.showToast(err.message, 'error');
        this.currentSession.messages.pop(); bubble.remove();
      }
    } finally {
      this.isGenerating = false; this.abortController = null; this.updateSendButton();
    }
  }

  stopGeneration() { if (this.abortController) this.abortController.abort(); }

  // ========== 再生成 ==========

  async regenerateAssistantMessage(msgId) {
    if (this.isGenerating) return;
    const msgIndex = this.currentSession.messages.findIndex(m => m.id === msgId);
    if (msgIndex < 0) return;
    const msg      = this.currentSession.messages[msgIndex];
    const bubbleEl = document.querySelector(`.message[data-id="${msgId}"]`);
    if (!bubbleEl) return;

    const history  = this.currentSession.messages.slice(0, msgIndex);
    const lastUser = history[history.length - 1];
    if (!lastUser || lastUser.role !== 'user') return;

    // ローディング状態に変える
    const contentEl  = bubbleEl.querySelector('.bubble-content');
    const actionsEl  = bubbleEl.querySelector('.message-actions');
    bubbleEl.querySelector('.alt-nav')?.remove();
    bubbleEl.querySelector('.edited-badge')?.remove();
    contentEl.innerHTML = '';
    actionsEl.innerHTML = '';
    const typingEl = document.createElement('div');
    typingEl.className = 'typing-indicator';
    typingEl.innerHTML = '<span></span><span></span><span></span>';
    bubbleEl.querySelector('.bubble').appendChild(typingEl);

    this.isGenerating = true; this.updateSendButton();
    const systemPrompt = this._buildSystemPrompt();
    const apiMessages  = this.api.buildApiMessages(this._buildContextMessages(history), lastUser.content, this.settings);
    const prefixText   = this._getPrefixText();
    this.abortController = new AbortController();
    let partial = { content: '', thinking: null };

    try {
      const result = await this._doGenerate({
        apiMessages, systemPrompt, prefixText, contentEl,
        signal: this.abortController.signal,
        onProgress: (t) => { partial.content = t; },
        onUsage:    (u) => this._onUsage(u),
      });
      typingEl.remove();

      if (!msg.alternatives || msg.alternatives.length === 0) {
        msg.alternatives = [{ content: msg.content, thinking: msg.thinking }];
      }
      msg.alternatives.push({ content: result.content, thinking: result.thinking });
      msg.activeAlternativeIndex = msg.alternatives.length - 1;
      msg.content  = result.content;
      msg.thinking = result.thinking;

      await this.saveCurrentSession();
      this.updateBubble(bubbleEl, msg);
      // 校正が有効なら実行
      if (this.settings.proofreadingEnabled) await this._runProofreading(msg, bubbleEl);

    } catch (err) {
      typingEl.remove();
      if (err.name === 'AbortError') {
        if (partial.content.trim()) {
          if (!msg.alternatives || msg.alternatives.length === 0)
            msg.alternatives = [{ content: msg.content, thinking: msg.thinking }];
          msg.alternatives.push({ content: partial.content, thinking: partial.thinking });
          msg.activeAlternativeIndex = msg.alternatives.length - 1;
          msg.content = partial.content; msg.thinking = partial.thinking;
          await this.saveCurrentSession();
        }
      } else {
        this.showToast(err.message, 'error');
      }
      this.updateBubble(bubbleEl, msg);
    } finally {
      this.isGenerating = false; this.abortController = null; this.updateSendButton();
    }
  }

  // ========== 代替版ナビゲーション ==========

  navigateAlternative(msgId, direction) {
    if (this._isMsgSummarized(msgId)) return;
    const msg = this.currentSession.messages.find(m => m.id === msgId);
    if (!msg?.alternatives) return;
    const newIdx = (msg.activeAlternativeIndex || 0) + direction;
    if (newIdx < 0 || newIdx >= msg.alternatives.length) return;
    const alt = this._getAlt(msg.alternatives, newIdx);
    msg.activeAlternativeIndex = newIdx;
    msg.content  = alt.content;
    msg.thinking = alt.thinking;
    const bubbleEl = document.querySelector(`.message[data-id="${msgId}"]`);
    if (bubbleEl) this.updateBubble(bubbleEl, msg);
    this.saveCurrentSession();
  }

  // ========== メッセージ編集 ==========

  enterEditMode(bubbleEl, msg) {
    if (this._isMsgSummarized(msg.id)) return;
    if (bubbleEl.querySelector('.edit-area')) return;
    const contentEl   = bubbleEl.querySelector('.bubble-content');
    const actionsEl   = bubbleEl.querySelector('.message-actions');
    const altNavEl    = bubbleEl.querySelector('.alt-nav');
    const editedBadge = bubbleEl.querySelector('.edited-badge');
    const thinkingEl  = bubbleEl.querySelector('.thinking-block');

    contentEl.style.display  = 'none';
    actionsEl.style.display  = 'none';
    if (altNavEl)    altNavEl.style.display    = 'none';
    if (editedBadge) editedBadge.style.display = 'none';
    if (thinkingEl)  thinkingEl.style.display  = 'none';

    const editArea = document.createElement('div');
    editArea.className = 'edit-area';
    editArea.innerHTML = `
      <textarea class="edit-textarea" aria-label="メッセージを編集">${this.escapeHtml(msg.content)}</textarea>
      <div class="edit-actions">
        <span class="edit-hint">Ctrl+Enter: 保存 / Esc: キャンセル</span>
        <button class="action-btn edit-cancel-btn">キャンセル</button>
        <button class="action-btn edit-save-btn">保存</button>
      </div>
    `;
    bubbleEl.querySelector('.bubble').appendChild(editArea);

    const textarea = editArea.querySelector('.edit-textarea');
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 400) + 'px';
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    const restore = () => {
      editArea.remove();
      contentEl.style.display  = '';
      actionsEl.style.display  = '';
      if (altNavEl)    altNavEl.style.display    = '';
      if (editedBadge) editedBadge.style.display = '';
      if (thinkingEl)  thinkingEl.style.display  = '';
    };
    const doSave = () => { const v = textarea.value; restore(); this.saveEdit(bubbleEl, msg, v); };

    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 400) + 'px';
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSave(); }
      else if (e.key === 'Escape') { e.preventDefault(); restore(); }
    });
    editArea.querySelector('.edit-save-btn').addEventListener('click', doSave);
    editArea.querySelector('.edit-cancel-btn').addEventListener('click', restore);
  }

  async saveEdit(bubbleEl, msg, newContent) {
    if (newContent === msg.content) return;
    msg.content  = newContent;
    msg.isEdited = true;
    if (msg.role === 'assistant') {
      if (!msg.alternatives || msg.alternatives.length === 0) {
        msg.alternatives = [{ content: newContent, thinking: msg.thinking }];
        msg.activeAlternativeIndex = 0;
      } else {
        const idx = msg.activeAlternativeIndex || 0;
        const alt = this._getAlt(msg.alternatives, idx);
        msg.alternatives[idx] = { content: newContent, thinking: alt.thinking };
      }
    }
    this.updateBubble(bubbleEl, msg);
    await this.saveCurrentSession();
    if (msg.role === 'user') {
      const msgIndex = this.currentSession.messages.findIndex(m => m.id === msg.id);
      if (msgIndex >= 0 && msgIndex < this.currentSession.messages.length - 1) {
        this.showConfirm('この編集以降のメッセージを削除して再生成しますか？',
          () => this.editUserAndRegenerate(msgIndex));
      }
    }
  }

  async editUserAndRegenerate(msgIndex) {
    if (this.isGenerating) return;
    this.currentSession.messages = this.currentSession.messages.slice(0, msgIndex + 1);
    this.renderMessages();

    const userMsg = this.currentSession.messages[msgIndex];
    const assistantMsg = this._makeMessage('assistant');
    this.currentSession.messages.push(assistantMsg);
    const bubble    = this.appendMessageBubble(assistantMsg, true);
    const contentEl = bubble.querySelector('.bubble-content');

    const systemPrompt = this._buildSystemPrompt();
    const apiMessages  = this.api.buildApiMessages(
      this._buildContextMessages(this.currentSession.messages.slice(0, -1)), userMsg.content, this.settings
    );
    const prefixText = this._getPrefixText();
    this.isGenerating = true; this.updateSendButton();
    this.abortController = new AbortController();
    let partial = { content: '', thinking: null };

    try {
      const result = await this._doGenerate({
        apiMessages, systemPrompt, prefixText, contentEl,
        signal: this.abortController.signal,
        onProgress: (t) => { partial.content = t; },
        onUsage:    (u) => this._onUsage(u),
      });
      assistantMsg.content             = result.content;
      assistantMsg.thinking            = result.thinking;
      assistantMsg.alternatives        = [{ content: result.content, thinking: result.thinking }];
      assistantMsg.activeAlternativeIndex = 0;
      await this.saveCurrentSession();
      this.updateBubble(bubble, assistantMsg);
      // 校正が有効なら実行
      if (this.settings.proofreadingEnabled) await this._runProofreading(assistantMsg, bubble);
    } catch (err) {
      if (err.name === 'AbortError') {
        if (partial.content.trim()) {
          assistantMsg.content      = partial.content;
          assistantMsg.thinking     = partial.thinking;
          assistantMsg.alternatives = [{ content: partial.content, thinking: partial.thinking }];
          await this.saveCurrentSession();
          this.updateBubble(bubble, assistantMsg);
        } else {
          this.currentSession.messages.pop(); bubble.remove();
        }
      } else {
        this.showToast(err.message, 'error');
        this.currentSession.messages.pop(); bubble.remove();
      }
    } finally {
      this.isGenerating = false; this.abortController = null; this.updateSendButton();
    }
  }

  // ========== UI描画 ==========

  renderMessages() {
    const container = document.getElementById('messages');
    container.innerHTML = '';
    if (!this.currentSession) return;
    const { summaryIndex } = this.currentSession;
    const msgs = this.currentSession.messages;
    for (let i = 0; i < msgs.length; i++) {
      const div = this.appendMessageBubble(msgs[i]);
      if (summaryIndex != null && i <= summaryIndex) div.classList.add('summarized');
      if (summaryIndex != null && i === summaryIndex) {
        const boundary = document.createElement('div');
        boundary.className = 'summary-boundary';
        boundary.textContent = '― 以上は要約済み（API送信では省略） ―';
        container.appendChild(boundary);
      }
    }
    this.scrollToBottom();
  }

  appendMessageBubble(msg, isStreaming = false) {
    const container = document.getElementById('messages');
    const div = document.createElement('div');
    div.className = `message ${msg.role}`; div.dataset.id = msg.id;

    const rendered = msg.role === 'assistant'
      ? this.renderMarkdown(msg.content)
      : this.escapeHtml(msg.content).replace(/\n/g, '<br>');

    div.innerHTML = `
      <div class="bubble">
        <div class="bubble-content">${rendered}</div>
        ${isStreaming ? '<div class="typing-indicator"><span></span><span></span><span></span></div>' : ''}
      </div>
      <div class="message-actions"></div>
    `;

    if (!isStreaming) this._attachBubbleExtras(div, msg);
    container.appendChild(div);
    if (this.settings.autoScroll) this.scrollToBottom();
    return div;
  }

  updateBubble(bubbleEl, msg) {
    const rendered = msg.role === 'assistant'
      ? this.renderMarkdown(msg.content)
      : this.escapeHtml(msg.content).replace(/\n/g, '<br>');

    const hasAlts = msg.alternatives && msg.alternatives.length > 1;
    const idx     = msg.activeAlternativeIndex || 0;

    const altNavHTML = hasAlts ? `
      <div class="alt-nav">
        <button class="alt-btn alt-prev" ${idx === 0 ? 'disabled' : ''} aria-label="前のバージョン">◀</button>
        <span class="alt-indicator">${idx + 1} / ${msg.alternatives.length}</span>
        <button class="alt-btn alt-next" ${idx >= msg.alternatives.length - 1 ? 'disabled' : ''} aria-label="次のバージョン">▶</button>
      </div>` : '';

    // 思考プロセスブロック（includeThoughts ON かつ thinking テキストあり）
    const thinkingHTML = (this.settings.includeThoughts && msg.thinking) ? `
      <details class="thinking-block">
        <summary>思考プロセス（クリックで展開）</summary>
        <div class="thinking-content">${this.escapeHtml(msg.thinking)}</div>
      </details>` : '';

    const editedHTML = msg.isEdited ? '<span class="edited-badge">編集済み</span>' : '';

    bubbleEl.querySelector('.bubble').innerHTML = `
      ${thinkingHTML}
      <div class="bubble-content">${rendered}</div>
      ${altNavHTML}
      ${editedHTML}
    `;
    bubbleEl.querySelector('.message-actions').innerHTML = '';
    this._attachBubbleExtras(bubbleEl, msg);
  }

  _attachBubbleExtras(bubbleEl, msg) {
    this.highlightCode(bubbleEl);
    this.renderMessageActions(bubbleEl, msg);
    bubbleEl.querySelector('.alt-prev')?.addEventListener('click', () => this.navigateAlternative(msg.id, -1));
    bubbleEl.querySelector('.alt-next')?.addEventListener('click', () => this.navigateAlternative(msg.id,  1));
  }

  renderMessageActions(bubbleEl, msg) {
    const actionsEl = bubbleEl.querySelector('.message-actions');
    actionsEl.innerHTML = '';
    bubbleEl.querySelector('.typing-indicator')?.remove();
    if (this._isMsgSummarized(msg.id)) return; // 要約済み範囲は操作無効

    const make = (label, onClick, cls = '') => {
      const btn = document.createElement('button');
      btn.className = `action-btn${cls ? ' ' + cls : ''}`;
      btn.textContent = label; btn.addEventListener('click', onClick);
      return btn;
    };
    if (msg.role === 'assistant') {
      actionsEl.appendChild(make('再生成', () => this.regenerateAssistantMessage(msg.id)));
    }
    actionsEl.appendChild(make('編集', () => this.enterEditMode(bubbleEl, msg)));
    actionsEl.appendChild(make('コピー', () => {
      navigator.clipboard.writeText(msg.content)
        .then(() => this.showToast('クリップボードにコピーしました'))
        .catch(() => this.showToast('コピーに失敗しました', 'error'));
    }));
    actionsEl.appendChild(make('削除', () => {
      this.showConfirm('このメッセージを削除しますか？', async () => {
        this.currentSession.messages = this.currentSession.messages.filter(m => m.id !== msg.id);
        bubbleEl.remove();
        await this.saveCurrentSession();
      });
    }, 'danger'));
  }

  renderHistoryList() {
    const list = document.getElementById('history-list');
    list.innerHTML = '';
    if (this.sessions.length === 0) {
      list.innerHTML = '<div class="history-empty">履歴がありません</div>'; return;
    }
    for (const session of this.sessions) {
      const item = document.createElement('div');
      item.className = `history-item${this.currentSession?.id === session.id ? ' active' : ''}`;
      item.setAttribute('role', 'listitem');
      item.innerHTML = `
        <div class="history-item-info" data-id="${session.id}" role="button" tabindex="0">
          <div class="history-item-title">${this.escapeHtml(session.title)}</div>
          <div class="history-item-meta">${formatDate(session.updatedAt)} · ${(session.tokenCount || 0).toLocaleString()} tok</div>
        </div>
        <div class="history-item-actions">
          <button class="icon-btn sm" data-action="rename" data-id="${session.id}" title="名前変更">✏</button>
          <button class="icon-btn sm" data-action="export" data-id="${session.id}" title="エクスポート">↓</button>
          <button class="icon-btn sm danger" data-action="delete" data-id="${session.id}" title="削除">✕</button>
        </div>
      `;
      list.appendChild(item);
    }
  }

  updateTokenInfo() {
    const el = document.getElementById('token-info');
    if (this.currentSession) el.textContent = `累積: ${(this.currentSession.tokenCount || 0).toLocaleString()} tok`;
    else el.textContent = '';
  }

  updateSendButton() {
    const btn = document.getElementById('btn-send');
    if (this.isGenerating) {
      btn.classList.add('stop'); btn.setAttribute('aria-label', '生成を停止');
      btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
    } else {
      btn.classList.remove('stop'); btn.setAttribute('aria-label', '送信');
      btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
    }
  }

  // ========== パネル管理 ==========
  showPanel(panel) { document.getElementById('app').dataset.panel = panel; this.activePanel = panel; }

  // ========== Markdown / コードハイライト ==========
  renderMarkdown(text) {
    if (!text) return '';
    try { return typeof marked !== 'undefined' ? marked.parse(text) : this.escapeHtml(text).replace(/\n/g, '<br>'); }
    catch (_) { return this.escapeHtml(text).replace(/\n/g, '<br>'); }
  }
  highlightCode(el) {
    if (typeof Prism !== 'undefined') el.querySelectorAll('pre code[class*="language-"]').forEach(b => Prism.highlightElement(b));
  }

  // ========== ユーティリティ ==========
  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  getVal(id)        { return document.getElementById(id)?.value ?? ''; }
  setVal(id, val)   { const el = document.getElementById(id); if (el) el.value = val ?? ''; }
  getChecked(id)    { return document.getElementById(id)?.checked ?? false; }
  setChecked(id, v) { const el = document.getElementById(id); if (el) el.checked = !!v; }
  scrollToBottom()  { const m = document.getElementById('messages'); m.scrollTop = m.scrollHeight; }

  showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message; toast.className = `toast ${type} show`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
  }
  showConfirm(message, onConfirm) {
    document.getElementById('modal-message').textContent = message;
    document.getElementById('modal-overlay').classList.remove('hidden');
    this._confirmCallback = onConfirm;
  }

  // ========== PWA ==========
  registerServiceWorker() {
    if ('serviceWorker' in navigator)
      navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW登録失敗:', e));
  }

  // ========== イベントバインド ==========
  bindEvents() {
    // パネル切り替え
    document.getElementById('btn-open-history').addEventListener('click',   () => this.showPanel(this.activePanel === 'history'  ? 'chat' : 'history'));
    document.getElementById('btn-open-settings').addEventListener('click',  () => this.showPanel(this.activePanel === 'settings' ? 'chat' : 'settings'));
    document.getElementById('btn-close-history').addEventListener('click',  () => this.showPanel('chat'));
    document.getElementById('btn-close-settings').addEventListener('click', () => this._saveAndCloseSettings());
    document.getElementById('btn-save-settings').addEventListener('click',  () => {
      this.readSettingsFromUI(); this._saveProfileNameFromUI();
      this.saveSettings(); this.applyTheme(); this.updateModelSelect(); this.updateSummaryButton();
      this.showToast('設定を保存しました');
    });
    document.getElementById('backdrop').addEventListener('click', () => {
      if (this.activePanel === 'settings') this._saveAndCloseSettings();
      else this.showPanel('chat');
    });

    // 新規チャット / 送信
    document.getElementById('btn-new-chat').addEventListener('click', () => this.newChat());
    document.getElementById('btn-send').addEventListener('click', () => {
      if (this.isGenerating) this.stopGeneration(); else this.sendMessage();
    });

    // テキスト入力
    const input = document.getElementById('input-text');
    input.addEventListener('keydown', (e) => {
      const mobile  = window.matchMedia('(max-width: 799px)').matches;
      const sendKey = mobile          ? (e.key === 'Enter' && (e.ctrlKey || e.metaKey))
                    : this.settings.enterSend ? (e.key === 'Enter' && !e.shiftKey)
                    : (e.key === 'Enter' && (e.ctrlKey || e.metaKey));
      if (sendKey) { e.preventDefault(); if (!this.isGenerating) this.sendMessage(); }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    });

    // スクロール
    document.getElementById('btn-scroll-top').addEventListener('click',    () => { document.getElementById('messages').scrollTop = 0; });
    document.getElementById('btn-scroll-bottom').addEventListener('click', () => this.scrollToBottom());

    // 要約ボタン
    document.getElementById('btn-summarize').addEventListener('click', () => this.runSummary());
    // 要約モーダル
    document.getElementById('summary-modal-confirm').addEventListener('click', async () => {
      const text = document.getElementById('summary-modal-textarea').value;
      document.getElementById('summary-modal').classList.add('hidden');
      await this.applySummary(text);
    });
    document.getElementById('summary-modal-cancel').addEventListener('click', () => {
      document.getElementById('summary-modal').classList.add('hidden');
    });

    // チャットタイトル
    const titleEl = document.getElementById('chat-title');
    titleEl.addEventListener('blur', async () => {
      const t = titleEl.textContent.trim();
      if (t && this.currentSession && t !== this.currentSession.title) await this.renameSession(this.currentSession.id, t);
      else if (!t && this.currentSession) titleEl.textContent = this.currentSession.title;
    });
    titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); } });

    // 履歴リスト
    document.getElementById('history-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]'), info = e.target.closest('.history-item-info');
      if (btn) {
        const { id, action } = btn.dataset;
        if (action === 'delete') this.showConfirm('このチャットを削除しますか？', () => this.deleteSession(id));
        else if (action === 'rename') {
          const s = this.sessions.find(s => s.id === id);
          const t = window.prompt('新しいタイトルを入力:', s?.title || '');
          if (t?.trim()) await this.renameSession(id, t.trim());
        } else if (action === 'export') {
          await this.exportSession(id);
        }
      } else if (info) await this.loadSession(info.dataset.id);
    });
    document.getElementById('history-list').addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') { const el = e.target.closest('.history-item-info'); if (el) await this.loadSession(el.dataset.id); }
    });

    // モーダル
    document.getElementById('modal-confirm').addEventListener('click', () => {
      document.getElementById('modal-overlay').classList.add('hidden');
      if (this._confirmCallback) { this._confirmCallback(); this._confirmCallback = null; }
    });
    document.getElementById('modal-cancel').addEventListener('click', () => {
      document.getElementById('modal-overlay').classList.add('hidden');
      this._confirmCallback = null;
    });

    // 設定: 即時反映
    document.getElementById('setting-additional-models').addEventListener('blur', () => {
      this.settings.additionalModels = this.getVal('setting-additional-models');
      this.updateModelSelect();
    });
    document.getElementById('setting-dark-mode').addEventListener('change', () => {
      this.settings.darkMode = this.getChecked('setting-dark-mode'); this.applyTheme();
    });

    // Temperature スライダー同期
    const tempSlider = document.getElementById('setting-temperature-slider');
    const tempInput  = document.getElementById('setting-temperature');
    const tempDisp   = document.getElementById('temperature-display');
    const syncTemp = (val) => {
      const v = parseFloat(val);
      if (isNaN(v)) return;
      if (tempSlider) tempSlider.value = v;
      if (tempInput)  tempInput.value  = v;
      if (tempDisp)   tempDisp.textContent = v.toFixed(2);
    };
    tempSlider?.addEventListener('input', () => syncTemp(tempSlider.value));
    tempInput?.addEventListener('input',  () => syncTemp(tempInput.value));

    // Thinking モード変更 → UI切り替え
    document.getElementById('setting-thinking-mode')?.addEventListener('change', () => this._updateThinkingUI());

    // プロファイル
    document.getElementById('profile-select').addEventListener('change', (e) => {
      if (e.target.value !== this.currentProfile?.id) this.switchProfile(e.target.value);
    });
    document.getElementById('profile-icon-display').addEventListener('click', () =>
      document.getElementById('profile-icon-file').click());
    document.getElementById('profile-icon-display').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') document.getElementById('profile-icon-file').click();
    });
    document.getElementById('profile-icon-file').addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      this.currentProfile.icon = await this.compressImage(file);
      await this.db.saveProfile(this.currentProfile);
      this.updateProfileIconDisplay(); e.target.value = '';
      this.showToast('アイコンを更新しました');
    });
    // メモリ管理
    document.getElementById('btn-memory-manage').addEventListener('click', () => this.showMemoryModal());
    document.getElementById('memory-modal-close').addEventListener('click', () => {
      document.getElementById('memory-modal').classList.add('hidden');
    });
    document.getElementById('btn-memory-add').addEventListener('click', async () => {
      const keyEl = document.getElementById('memory-key-input');
      const valEl = document.getElementById('memory-value-input');
      const key = keyEl.value.trim(), value = valEl.value.trim();
      if (!key || !value) { this.showToast('キーと値を入力してください', 'error'); return; }
      await this.db.saveMemory({ id: generateId(), profileId: this.currentProfile?.id, key, value });
      await this.loadMemories();
      this.renderMemoryList();
      keyEl.value = ''; valEl.value = '';
      this.showToast('記憶を追加しました');
    });
    document.getElementById('memory-list').addEventListener('click', async (e) => {
      const id = e.target.closest('[data-mem-del]')?.dataset.memDel;
      if (!id) return;
      await this.db.deleteMemory(id);
      await this.loadMemories();
      this.renderMemoryList();
      this.showToast('記憶を削除しました');
    });

    // セッション エクスポート/インポート
    document.getElementById('btn-export-all').addEventListener('click', () => this.exportAllSessions());
    document.getElementById('session-import-file').addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      await this.importSessions(file); e.target.value = '';
    });

    document.getElementById('btn-profile-new').addEventListener('click',    () => this.createNewProfile());
    document.getElementById('btn-profile-copy').addEventListener('click',   () => this.duplicateCurrentProfile());
    document.getElementById('btn-profile-export').addEventListener('click', () => this.exportCurrentProfile());
    document.getElementById('btn-profile-delete').addEventListener('click', () => this.deleteCurrentProfile());
    document.getElementById('profile-import-file').addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      await this.importProfile(file); e.target.value = '';
    });

    // スワイプ
    const appEl = document.getElementById('app');
    appEl.addEventListener('touchstart', (e) => {
      this.touchStartX = e.touches[0].clientX; this.touchStartY = e.touches[0].clientY;
    }, { passive: true });
    appEl.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - this.touchStartX;
      const dy = e.changedTouches[0].clientY - this.touchStartY;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
        if (dx > 0) this.showPanel(this.activePanel === 'settings' ? 'chat' : 'history');
        else        this.showPanel(this.activePanel === 'history'  ? 'chat' : 'settings');
      }
    }, { passive: true });
  }

  _saveAndCloseSettings() {
    this.readSettingsFromUI(); this._saveProfileNameFromUI();
    this.saveSettings(); this.applyTheme(); this.updateModelSelect(); this.updateSummaryButton();
    this.showPanel('chat'); this.showToast('設定を保存しました');
  }

  _saveProfileNameFromUI() {
    if (!this.currentProfile) return;
    const name = document.getElementById('profile-name-input')?.value.trim();
    if (name && name !== this.currentProfile.name) {
      this.currentProfile.name = name;
      this.renderProfileSelect(); this.updateProfileIconDisplay();
    }
  }
}

// ========== 起動 ==========
const app = new App();
document.addEventListener('DOMContentLoaded', () => app.init());
