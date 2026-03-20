import Store from 'electron-store';
import type { AppSettings } from '../../shared/types';

const DEFAULT_SETTINGS: AppSettings = {
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    aiProvider: (process.env.AI_PROVIDER as 'openai' | 'gemini') || 'openai',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
    whisperModel: process.env.WHISPER_MODEL || 'whisper-1',
    enableScreenCapture: true,
    enableOcr: false,
    overlayShortcut: 'CommandOrControl+Shift+Space',
    askAiShortcut: 'CommandOrControl+Shift+A',
    overlayPosition: { x: 0, y: 0 },
    overlayWidth: 420,
    theme: 'system',
    // TinyHumans / Neocortex token env compatibility:
    // - MEMORY_API_TOKEN (preferred by this app)
    // - ALPHAHUMAN_TOKEN (present in your current .env)
    memoryApiToken: process.env.MEMORY_API_TOKEN || process.env.ALPHAHUMAN_TOKEN || '',
    memoryNamespacePrefix: process.env.MEMORY_NAMESPACE_PREFIX || 'video-agent',
};

class SettingsStore {
    private store: Store<AppSettings>;

    constructor() {
        this.store = new Store<AppSettings>({
            name: 'settings',
            defaults: DEFAULT_SETTINGS,
            encryptionKey: 'va-settings-key',
        });
    }

    get(): AppSettings {
        const saved = this.store.store;
        return {
            ...saved,
            // Prefer persisted values, but fall back to env vars when fields are empty.
            openaiApiKey: process.env.OPENAI_API_KEY || '',
            geminiApiKey: process.env.GEMINI_API_KEY || '',
            aiProvider: (process.env.AI_PROVIDER as 'openai' | 'gemini') || 'openai',
            openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
            geminiModel: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
            whisperModel: process.env.WHISPER_MODEL || 'whisper-1',
            memoryApiToken: process.env.MEMORY_API_TOKEN || process.env.ALPHAHUMAN_TOKEN || '',
            memoryBaseUrl: process.env.MEMORY_BASE_URL || process.env.ALPHAHUMAN_BASE_URL || undefined,
            memoryNamespacePrefix: process.env.MEMORY_NAMESPACE_PREFIX || 'video-agent',
        };
    }

    save(partial: Partial<AppSettings>): void {
        Object.entries(partial).forEach(([key, value]) => {
            this.store.set(key as keyof AppSettings, value as never);
        });
    }

    reset(): void {
        this.store.clear();
    }
}

export const settingsStore = new SettingsStore();
