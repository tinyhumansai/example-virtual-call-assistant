import type {
    AlphahumanMemoryClient,
    DeleteMemoryParams,
    InsertMemoryParams,
    QueryMemoryParams,
    RecallMemoryParams,
    RecallMemoriesParams,
} from '@tinyhumansai/neocortex';
import { settingsStore } from './settings-store';

const SHOULD_LOG_TINYHUMANS = false;

function maskToken(token: string | undefined): string {
    if (!token) return '[empty]';
    if (token.length <= 12) return token[0] + '...' + token[token.length - 1];
    const start = token.slice(0, 6);
    const end = token.slice(-4);
    return `${start}...${end}`;
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function truncate(text: string, maxChars: number): string {
    const t = text.trim();
    if (t.length <= maxChars) return t;
    return t.slice(0, maxChars);
}

function chunkToText(chunk: Record<string, unknown>): string {
    const asAny = chunk as any;
    const candidate =
        asAny.content ??
        asAny.text ??
        asAny.chunk ??
        asAny.excerpt ??
        asAny.message;
    if (typeof candidate === 'string') return candidate.trim();
    try {
        return JSON.stringify(chunk);
    } catch {
        return String(chunk);
    }
}

class MemoryStore {
    private client: AlphahumanMemoryClient | null = null;
    private clientToken: string | null = null;
    private clientBaseUrl: string | undefined;
    private clientPromise: Promise<AlphahumanMemoryClient | null> | null = null;

    private getPrefix(): string {
        return settingsStore.get().memoryNamespacePrefix || 'video-agent';
    }

    sessionNamespace(sessionId: string): string {
        return `${this.getPrefix()}:session:${sessionId}`;
    }

    meetingsNamespace(): string {
        return `${this.getPrefix()}:meetings:longterm`;
    }

    companyKbNamespace(): string {
        return `${this.getPrefix()}:company-kb:longterm`;
    }

    private async buildClientIfNeeded(): Promise<AlphahumanMemoryClient | null> {
        const { memoryApiToken, memoryBaseUrl } = settingsStore.get();
        if (!memoryApiToken) return null;

        if (
            this.client &&
            this.clientToken === memoryApiToken &&
            this.clientBaseUrl === memoryBaseUrl
        ) {
            return this.client;
        }

        if (!this.clientPromise) {
            this.clientPromise = (async () => {
                // TinyHumans SDK is ESM-only; dynamic import is required in CommonJS builds.
                // Important: TypeScript may downlevel `import()` to `require()` in CJS output,
                // which breaks ESM-only packages. Using Function ensures runtime import().
                const mod = await (Function('return import("@tinyhumansai/neocortex")')() as Promise<any>);
                const ClientCtor = mod.AlphahumanMemoryClient as unknown as typeof AlphahumanMemoryClient;

                if (SHOULD_LOG_TINYHUMANS) {
                    console.log('[TinyHumans][MemoryStore] Creating client', {
                        token: maskToken(memoryApiToken),
                        baseUrl: memoryBaseUrl ?? '[default]',
                    });
                }

                this.client = new ClientCtor({
                    token: memoryApiToken,
                    baseUrl: memoryBaseUrl,
                });
                this.clientToken = memoryApiToken;
                this.clientBaseUrl = memoryBaseUrl;
                return this.client;
            })();
        }

        return this.clientPromise;
    }

    private formatQueryLikeResponse(resp: any): string {
        const data = resp?.data;
        if (!data) return '';

        if (typeof data.llmContextMessage === 'string' && data.llmContextMessage.trim()) {
            return data.llmContextMessage.trim();
        }

        if (data.context?.chunks && Array.isArray(data.context.chunks) && data.context.chunks.length > 0) {
            return data.context.chunks
                .slice(0, 12)
                .map((c: Record<string, unknown>) => chunkToText(c))
                .filter(Boolean)
                .join('\n');
        }

        if (typeof data.response === 'string' && data.response.trim()) {
            return data.response.trim();
        }

        return '';
    }

    async insertMemory(params: Omit<InsertMemoryParams, 'createdAt' | 'updatedAt'>): Promise<void> {
        const client = await this.buildClientIfNeeded();
        if (!client) return;

        try {
            const payload = {
                ...params,
                title: truncate(params.title, 160),
                content: truncate(params.content, 6000),
            } satisfies InsertMemoryParams;

            if (SHOULD_LOG_TINYHUMANS) {
                console.log('[TinyHumans][MemoryStore] insertMemory input', {
                    namespace: payload.namespace,
                    sourceType: payload.sourceType ?? 'doc',
                    priority: payload.priority ?? undefined,
                    titlePreview: truncate(payload.title, 120),
                    contentChars: payload.content.length,
                    contentPreview: truncate(payload.content, 800),
                    metadata: payload.metadata,
                });
            }

            const resp = await client.insertMemory(payload);

            if (SHOULD_LOG_TINYHUMANS) {
                console.log('[TinyHumans][MemoryStore] insertMemory output', safeStringify(resp));
            }
        } catch (err) {
            console.error('[MemoryStore] insertMemory failed:', err);
        }
    }

    async queryMemoryToText(params: QueryMemoryParams): Promise<string> {
        const client = await this.buildClientIfNeeded();
        if (!client) return '';

        try {
            if (SHOULD_LOG_TINYHUMANS) {
                console.log('[TinyHumans][MemoryStore] queryMemory input', {
                    namespace: params.namespace ?? '[default]',
                    maxChunks: params.maxChunks,
                    includeReferences: params.includeReferences ?? false,
                    queryChars: params.query.length,
                    queryPreview: truncate(params.query, 500),
                    documentIds: params.documentIds,
                    llmQuery: params.llmQuery ? truncate(params.llmQuery, 500) : undefined,
                });
            }

            const resp = await client.queryMemory(params);
            if (SHOULD_LOG_TINYHUMANS) {
                console.log('[TinyHumans][MemoryStore] queryMemory output', safeStringify(resp));
            }
            return this.formatQueryLikeResponse(resp);
        } catch (err) {
            console.error('[MemoryStore] queryMemory failed:', err);
            return '';
        }
    }

    async recallMemoryToText(params: RecallMemoryParams): Promise<string> {
        const client = await this.buildClientIfNeeded();
        if (!client) return '';

        try {
            if (SHOULD_LOG_TINYHUMANS) {
                console.log('[TinyHumans][MemoryStore] recallMemory input', {
                    namespace: params.namespace ?? '[default]',
                    maxChunks: params.maxChunks,
                });
            }

            const resp = await client.recallMemory(params);
            if (SHOULD_LOG_TINYHUMANS) {
                console.log('[TinyHumans][MemoryStore] recallMemory output', safeStringify(resp));
            }
            return this.formatQueryLikeResponse(resp);
        } catch (err) {
            console.error('[MemoryStore] recallMemory failed:', err);
            return '';
        }
    }

    async recallMemoriesToText(params: RecallMemoriesParams): Promise<string> {
        const client = await this.buildClientIfNeeded();
        if (!client) return '';

        try {
            if (SHOULD_LOG_TINYHUMANS) {
                console.log('[TinyHumans][MemoryStore] recallMemories input', {
                    namespace: params.namespace ?? '[default]',
                    topK: params.topK,
                    minRetention: params.minRetention,
                    asOf: params.asOf,
                });
            }

            const resp = await client.recallMemories(params);
            if (SHOULD_LOG_TINYHUMANS) {
                console.log('[TinyHumans][MemoryStore] recallMemories output', safeStringify(resp));
            }
            const memories = resp?.data?.memories;
            if (!Array.isArray(memories) || memories.length === 0) return '';
            return memories
                .slice(0, 8)
                .map((m: any) => {
                    const type = m?.type ?? 'memory';
                    const content = typeof m?.content === 'string' ? m.content : '';
                    const score = typeof m?.score === 'number' ? m.score.toFixed(3) : String(m?.score ?? '');
                    return `- ${type}: ${truncate(content, 500)} (score: ${score})`;
                })
                .join('\n');
        } catch (err) {
            console.error('[MemoryStore] recallMemories failed:', err);
            return '';
        }
    }

    async deleteNamespace(params: DeleteMemoryParams): Promise<void> {
        const client = await this.buildClientIfNeeded();
        if (!client) return;
        try {
            if (SHOULD_LOG_TINYHUMANS) {
                console.log('[TinyHumans][MemoryStore] deleteMemory input', {
                    namespace: params.namespace ?? '[default]',
                });
            }
            await client.deleteMemory(params);
            if (SHOULD_LOG_TINYHUMANS) {
                console.log('[TinyHumans][MemoryStore] deleteMemory output', 'success');
            }
        } catch (err) {
            console.error('[MemoryStore] deleteMemory failed:', err);
        }
    }
}

export const memoryStore = new MemoryStore();

