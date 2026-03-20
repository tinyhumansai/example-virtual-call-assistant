import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types';
import type { InterviewReport, RubricItem } from '../../shared/types';
import type { TranscriptSegment } from '../../shared/types';
import { memoryStore } from '../services/memory-store';
import { getCurrentSessionId, getSessionTranscript, startNewSession } from './ai.ipc';
import { generateInterviewReport } from '../services/interview-engine';

// Keep interview metadata in memory for the current runtime.
interface InterviewSessionMeta {
    jobDescription: string;
    rubric: RubricItem[];
}

const sessions = new Map<string, InterviewSessionMeta>();

function createSessionId(): string {
    return `interview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function registerInterviewIPC(): void {
    ipcMain.handle(IPC_CHANNELS.INTERVIEW_START, async (_event, { jobDescription, rubric }: { jobDescription: string; rubric: RubricItem[] }) => {
        const sessionId = createSessionId();
        sessions.set(sessionId, { jobDescription, rubric: Array.isArray(rubric) ? rubric : [] });

        // Align the shared transcript buffer with the interview mode.
        startNewSession(sessionId, 'interview');
        return sessionId;
    });

    ipcMain.handle(IPC_CHANNELS.INTERVIEW_REPORT, async (_event, sessionId: string): Promise<InterviewReport> => {
        const meta = sessions.get(sessionId);
        const transcript: TranscriptSegment[] = getSessionTranscript();

        // If transcript buffer doesn't match, try to recall from TinyHumans (optional).
        let effectiveTranscript = transcript;
        if (sessionId !== getCurrentSessionId()) {
            const recalled = await memoryStore.recallMemoryToText({
                namespace: memoryStore.sessionNamespace(sessionId),
                maxChunks: 25,
            });
            if (recalled) {
                effectiveTranscript = [
                    {
                        id: `recalled-${sessionId}`,
                        speaker: 'unknown',
                        text: recalled,
                        timestamp: Date.now(),
                        isFinal: true,
                    },
                ];
            }
        }

        const jobDescription = meta?.jobDescription ?? '';
        const rubric = meta?.rubric ?? [];

        const report = await generateInterviewReport({
            sessionId,
            jobDescription,
            rubric,
            transcript: effectiveTranscript,
        });

        return report;
    });
}

