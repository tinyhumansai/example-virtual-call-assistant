import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { settingsStore } from './settings-store';
import { kbService } from './kb-service';
import { memoryStore } from './memory-store';
import type { AnalysisResult, TranscriptSegment, StreamToken } from '../../shared/types';

export type StreamCallback = (token: StreamToken) => void;

interface AnalyzeOptions {
    transcript: TranscriptSegment[];
    screenText?: string;
    mode: 'meeting' | 'interview' | 'sales';
    sessionId: string;
    onStream?: StreamCallback;
}

// ────────────────────────────────────────────────────────────────
// Build system prompt
// ────────────────────────────────────────────────────────────────

async function buildSystemPrompt(
    transcript: TranscriptSegment[],
    screenText: string,
    mode: string,
    sessionId: string,
    responseFormat: 'json' | 'text'
): Promise<{ systemPrompt: string; kbContext: string }> {
    // Get transcript text for KB retrieval
    const recentText = transcript
        .slice(-20)
        .map((s) => s.text)
        .join(' ');

    // RAG: retrieve relevant KB chunks
    let kbContext = '';
    try {
        const chunks = await kbService.retrieve(recentText, 5);
        if (chunks.length > 0) {
            kbContext = '### Company Knowledge Base\n' + chunks.map((c) => `- ${c.text}`).join('\n');
        }
    } catch { }

    // Memory SDK: query + recall for richer context
    let memorySessionText = '';
    let memoryLongtermText = '';
    let recalledMemoriesText = '';
    let memoryCompanyKbText = '';
    try {
        const [sessionText, longtermText, recalledMemories, companyKbText] = await Promise.all([
            memoryStore.queryMemoryToText({
                query: recentText,
                namespace: memoryStore.sessionNamespace(sessionId),
                includeReferences: false,
                maxChunks: 5,
            }),
            memoryStore.recallMemoryToText({
                namespace: memoryStore.meetingsNamespace(),
                maxChunks: 4,
            }),
            memoryStore.recallMemoriesToText({
                namespace: memoryStore.meetingsNamespace(),
                topK: 5,
            }),
            memoryStore.queryMemoryToText({
                query: recentText,
                namespace: memoryStore.companyKbNamespace(),
                includeReferences: false,
                maxChunks: 3,
            }),
        ]);

        memorySessionText = sessionText;
        memoryLongtermText = longtermText;
        recalledMemoriesText = recalledMemories;
        memoryCompanyKbText = companyKbText;
    } catch { }

    // Build transcript context
    const transcriptCtx = transcript
        .slice(-30)
        .map((s) => `[${s.speaker}]: ${s.text}`)
        .join('\n');

    const screenCtx = screenText
        ? `### Visible Screen Content\n${screenText.slice(0, 2000)}`
        : '';

    const modeInstructions = {
        meeting: 'You are a real-time meeting assistant. Help identify key topics, action items, sentiment, and provide concise suggestions.',
        interview: 'You are an interview assistant. Analyze candidate responses, suggest follow-up questions, and flag potential bias in interviewer questions.',
        sales: 'You are a sales call assistant. Help with objection handling, product info retrieval, and engagement tips.',
    }[mode] || '';

    const memoryCtxParts = [
        memorySessionText ? `### Memory (Session)\n${memorySessionText.slice(0, 2500)}` : '',
        memoryLongtermText ? `### Memory (Long-term)\n${memoryLongtermText.slice(0, 2500)}` : '',
        recalledMemoriesText ? `### Recalled Memories\n${recalledMemoriesText.slice(0, 2000)}` : '',
        memoryCompanyKbText ? `### Memory (Company KB)\n${memoryCompanyKbText.slice(0, 2000)}` : '',
    ].filter(Boolean);

    const memoryCtx = memoryCtxParts.join('\n\n');

    const baseSystemPrompt = `You are VideoAgent, an invisible AI co-pilot for live meetings.
${modeInstructions}

${memoryCtx}

${kbContext}

${screenCtx}

### Recent Conversation Transcript
${transcriptCtx}
`;

    const systemPrompt =
        responseFormat === 'json'
            ? `${baseSystemPrompt}

Respond with a JSON object in this exact format:
{
  "insights": "<1-3 sentence real-time insight or suggestion>",
  "topics": ["<topic1>", "<topic2>"],
  "sentiment": "positive|neutral|negative",
  "sentimentScore": <number between -1 and 1>,
  "actionItems": ["<action1>", "<action2>"],
  "suggestedResponses": ["<response1>", "<response2>"]
}`
            : `${baseSystemPrompt}

Use the provided context to answer the user request.
Answer with plain text (no JSON).
If the app is in interview mode, provide a detailed, interview-ready response:
- direct guidance
- concrete examples from the transcript/context when available
- suggested follow-up questions or interviewer prompts where helpful`;

    return { systemPrompt, kbContext };
}

// ────────────────────────────────────────────────────────────────
// OpenAI analysis
// ────────────────────────────────────────────────────────────────

async function analyzeWithOpenAI(
    options: AnalyzeOptions,
    systemPrompt: string
): Promise<Partial<AnalysisResult>> {
    const settings = settingsStore.get();
    const client = new OpenAI({ apiKey: settings.openaiApiKey });

    let rawResponse = '';

    if (options.onStream) {
        const stream = client.beta.chat.completions.stream({
            model: settings.openaiModel || 'gpt-4o',
            messages: [{ role: 'user', content: systemPrompt }],
            response_format: { type: 'json_object' },
        });

        for await (const chunk of stream) {
            const token = chunk.choices[0]?.delta?.content || '';
            if (token) {
                rawResponse += token;
                options.onStream({ token, isDone: false });
            }
        }
        options.onStream({ token: '', isDone: true });
    } else {
        const response = await client.chat.completions.create({
            model: settings.openaiModel || 'gpt-4o',
            messages: [{ role: 'user', content: systemPrompt }],
            response_format: { type: 'json_object' },
        });
        rawResponse = response.choices[0].message.content || '{}';
    }

    return JSON.parse(rawResponse);
}

// ────────────────────────────────────────────────────────────────
// Gemini analysis
// ────────────────────────────────────────────────────────────────

async function analyzeWithGemini(
    options: AnalyzeOptions,
    systemPrompt: string
): Promise<Partial<AnalysisResult>> {
    const settings = settingsStore.get();
    const genAI = new GoogleGenerativeAI(settings.geminiApiKey);
    const model = genAI.getGenerativeModel({ model: settings.geminiModel || 'gemini-1.5-flash' });

    const prompt = `${systemPrompt}\n\nRespond ONLY with valid JSON, no markdown.`;

    let rawResponse = '';

    if (options.onStream) {
        const result = await model.generateContentStream(prompt);
        for await (const chunk of result.stream) {
            const token = chunk.text();
            rawResponse += token;
            options.onStream({ token, isDone: false });
        }
        options.onStream({ token: '', isDone: true });
    } else {
        const result = await model.generateContent(prompt);
        rawResponse = result.response.text();
    }

    // Gemini may wrap in markdown code block
    rawResponse = rawResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(rawResponse);
}

// ────────────────────────────────────────────────────────────────
// Public analyze function
// ────────────────────────────────────────────────────────────────

export async function analyzeConversation(options: AnalyzeOptions): Promise<AnalysisResult> {
    const { systemPrompt } = await buildSystemPrompt(
        options.transcript,
        options.screenText || '',
        options.mode,
        options.sessionId,
        'json'
    );

    const settings = settingsStore.get();
    let parsed: Partial<AnalysisResult>;

    try {
        if (settings.aiProvider === 'gemini' && settings.geminiApiKey) {
            parsed = await analyzeWithGemini(options, systemPrompt);
        } else {
            parsed = await analyzeWithOpenAI(options, systemPrompt);
        }
    } catch (err) {
        console.error('[AI Engine] Analysis error:', err);
        parsed = {
            insights: 'Analysis failed. Please check your API key and connection.',
            topics: [],
            sentiment: 'neutral',
            sentimentScore: 0,
            actionItems: [],
            suggestedResponses: [],
        };
    }

    return {
        sessionId: options.sessionId,
        insights: parsed.insights || '',
        topics: parsed.topics || [],
        sentiment: parsed.sentiment || 'neutral',
        sentimentScore: parsed.sentimentScore || 0,
        actionItems: parsed.actionItems || [],
        suggestedResponses: parsed.suggestedResponses || [],
        kbReferences: [],
        timestamp: Date.now(),
    };
}

// ────────────────────────────────────────────────────────────────
// Ask a freeform question
// ────────────────────────────────────────────────────────────────

export async function askQuestion(
    question: string,
    transcript: TranscriptSegment[],
    sessionId: string,
    mode: 'meeting' | 'interview' | 'sales',
    onStream: StreamCallback
): Promise<string> {
    const settings = settingsStore.get();
    const { systemPrompt } = await buildSystemPrompt(transcript, '', mode, sessionId, 'text');

    const modeAnswerStyle =
        mode === 'interview'
            ? 'Provide a detailed interview-grade answer. Include reasoning grounded in the transcript/context, and end with 2-4 follow-up interviewer questions when relevant.'
            : mode === 'sales'
              ? 'Provide a helpful sales-ready answer with concrete next steps.'
              : 'Provide a helpful answer with enough detail for real-time meetings.';

    const fullPrompt = `${systemPrompt}\n\nUser question: "${question}"\n\n${modeAnswerStyle}`;
    let fullAnswer = '';

    try {
        if (settings.aiProvider === 'gemini' && settings.geminiApiKey) {
            const genAI = new GoogleGenerativeAI(settings.geminiApiKey);
            const model = genAI.getGenerativeModel({ model: settings.geminiModel || 'gemini-1.5-flash' });
            const result = await model.generateContentStream(fullPrompt);
            for await (const chunk of result.stream) {
                const token = chunk.text();
                if (token) fullAnswer += token;
                onStream({ token, isDone: false });
            }
        } else {
            const client = new OpenAI({ apiKey: settings.openaiApiKey });
            const stream = client.beta.chat.completions.stream({
                model: settings.openaiModel || 'gpt-4o',
                messages: [{ role: 'user', content: fullPrompt }],
            });
            for await (const chunk of stream) {
                const token = chunk.choices[0]?.delta?.content || '';
                if (token) {
                    fullAnswer += token;
                    onStream({ token, isDone: false });
                }
            }
        }
    } catch (err) {
        onStream({ token: 'Error: ' + String(err), isDone: false });
        onStream({ token: '', isDone: true });
        return '';
    }

    onStream({ token: '', isDone: true });
    return fullAnswer.trim();
}
