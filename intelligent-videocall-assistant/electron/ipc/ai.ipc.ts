import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/types';
import { analyzeConversation, askQuestion } from '../services/ai-engine';
import { extractTextFromScreen, captureScreen } from '../services/screen-capture';
import { memoryStore } from '../services/memory-store';
import type { TranscriptSegment } from '../../shared/types';

// In-memory transcript buffer per session
let sessionTranscript: TranscriptSegment[] = [];
let currentSessionId = `session-${Date.now()}`;
let currentMode: 'meeting' | 'interview' | 'sales' = 'meeting';
let latestScreenContext: string = '';

export function getSessionTranscript(): TranscriptSegment[] {
    return sessionTranscript;
}

export function getCurrentSessionId(): string {
    return currentSessionId;
}

export function getCurrentMode(): 'meeting' | 'interview' | 'sales' {
    return currentMode;
}

export function setSessionMode(mode: 'meeting' | 'interview' | 'sales'): void {
    currentMode = mode;
}

export function resetSession(): void {
    const oldSessionId = currentSessionId;
    currentSessionId = `session-${Date.now()}`;
    sessionTranscript = [];
    // Delete per-session memories (admin delete) so we don't keep ephemeral transcript context forever.
    void memoryStore.deleteNamespace({ namespace: memoryStore.sessionNamespace(oldSessionId) });
}

export function startNewSession(sessionId: string, mode: 'meeting' | 'interview' | 'sales'): void {
    const oldSessionId = currentSessionId;
    currentSessionId = sessionId;
    currentMode = mode;
    sessionTranscript = [];
    // Delete per-session memories so this session starts from a clean slate.
    void memoryStore.deleteNamespace({ namespace: memoryStore.sessionNamespace(oldSessionId) });
}

// Append to session buffer directly
export function appendTranscript(segment: TranscriptSegment): void {
    sessionTranscript.push(segment);
    // Keep only last 200 segments to avoid memory growth
    if (sessionTranscript.length > 200) sessionTranscript = sessionTranscript.slice(-200);
}

export function setLatestScreenContext(text: string): void {
    latestScreenContext = text;
}

export async function generateMeetingSummary(): Promise<void> {
    if (sessionTranscript.length === 0) return;
    console.log('[IPC:AI] Generating automatic meeting summary...');
    BrowserWindow.getAllWindows().forEach((win) => {
        // Trigger the frontend to open the question stream UI
        win.webContents.send(IPC_CHANNELS.QUESTION_STREAM, { token: '\n\n**MEETING SUMMARY:**\n', isDone: false });
    });
    const summary = await askQuestion(
        'The meeting has just ended. Please generate a concise, structured summary highlighting key takeaways, decisions made, and action items. Factor in the screen context if relevant.',
        sessionTranscript,
        currentSessionId,
        'meeting',
        (token) => {
            BrowserWindow.getAllWindows().forEach((win) => {
                win.webContents.send(IPC_CHANNELS.QUESTION_STREAM, token);
            });
        }
    );

    // Store meeting summary for later recall (long-term namespace).
    if (summary) {
        void memoryStore.insertMemory({
            title: `Meeting summary (${currentSessionId})`,
            content: summary,
            namespace: memoryStore.meetingsNamespace(),
            sourceType: 'doc',
            metadata: { mode: currentMode, sessionId: currentSessionId },
            priority: 'medium',
        });
    }
}

export function registerAIIPC(): void {
    // Trigger analysis manually
    ipcMain.on(IPC_CHANNELS.ANALYZE_NOW, async () => {
        console.log('[IPC:AI] Analyzing...');

        // If we have cached background OCR, use it instead of blocking
        let screenText = latestScreenContext;
        if (!screenText) {
            screenText = await extractTextFromScreen().catch(() => '');
        }

        const sender = BrowserWindow.getAllWindows()[0];

        const result = await analyzeConversation({
            transcript: sessionTranscript,
            screenText,
            mode: currentMode,
            sessionId: currentSessionId,
            onStream: (token) => {
                BrowserWindow.getAllWindows().forEach((win) => {
                    win.webContents.send(IPC_CHANNELS.ANALYSIS_STREAM, token);
                });
            },
        });

        BrowserWindow.getAllWindows().forEach((win) => {
            win.webContents.send(IPC_CHANNELS.ANALYSIS_RESULT, result);
        });
    });

    // Ask a freeform question
    ipcMain.on(IPC_CHANNELS.ASK_QUESTION, async (_event, question: string) => {
        console.log('[IPC:AI] Question:', question);
        await askQuestion(question, sessionTranscript, currentSessionId, currentMode, (token) => {
            BrowserWindow.getAllWindows().forEach((win) => {
                win.webContents.send(IPC_CHANNELS.QUESTION_STREAM, token);
            });
        });
    });

    // Take a screenshot and return base64
    ipcMain.handle(IPC_CHANNELS.TAKE_SCREENSHOT, async () => {
        return captureScreen();
    });
}
