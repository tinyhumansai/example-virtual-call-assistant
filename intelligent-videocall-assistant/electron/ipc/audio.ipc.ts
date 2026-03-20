import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/types';
import {
    startTranscription,
    stopTranscription,
    appendAudioChunk,
    setTranscriptCallback,
} from '../services/transcription';
import { appendTranscript, getCurrentMode, getCurrentSessionId } from './ai.ipc';
import { memoryStore } from '../services/memory-store';

export function registerAudioIPC(): void {
    // Set up transcript callback to broadcast to all windows and save to AI memory
    setTranscriptCallback((segment) => {
        appendTranscript(segment);
        BrowserWindow.getAllWindows().forEach((win) => {
            win.webContents.send(IPC_CHANNELS.TRANSCRIPT_CHUNK, segment);
        });

        // Store each finalized transcript chunk in the session namespace
        // (used later for queryMemory-based context building).
        if (segment.isFinal) {
            const sessionId = getCurrentSessionId();
            void memoryStore.insertMemory({
                title: `Transcript segment (${segment.id})`,
                content: segment.text,
                namespace: memoryStore.sessionNamespace(sessionId),
                sourceType: 'chat',
                metadata: {
                    speaker: segment.speaker,
                    timestamp: segment.timestamp,
                    mode: getCurrentMode(),
                },
                priority: 'low',
            });
        }
    });

    ipcMain.on(IPC_CHANNELS.START_RECORDING, () => {
        console.log('[IPC:Audio] Start recording');
        startTranscription();
    });

    ipcMain.on(IPC_CHANNELS.STOP_RECORDING, () => {
        console.log('[IPC:Audio] Stop recording');
        stopTranscription();
    });

    // Receive raw audio chunks from renderer (MediaRecorder API)
    ipcMain.on(IPC_CHANNELS.AUDIO_CHUNK, (_event, chunk: Buffer) => {
        appendAudioChunk(chunk);
    });
}
