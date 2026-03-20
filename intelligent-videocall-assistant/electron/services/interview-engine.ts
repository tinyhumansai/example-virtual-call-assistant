import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { settingsStore } from './settings-store';
import type { BiasFlag, CompetencyScore, InterviewReport, RubricItem, TranscriptSegment } from '../../shared/types';

interface GenerateInterviewReportOptions {
    sessionId: string;
    jobDescription: string;
    rubric: RubricItem[];
    transcript: TranscriptSegment[];
}

function buildTranscriptText(transcript: TranscriptSegment[]): string {
    return transcript
        .map((s) => `[${s.speaker}] ${s.text}`)
        .slice(-80)
        .join('\n');
}

function buildRubricText(rubric: RubricItem[]): string {
    return rubric.map((r) => `- ${r.competency} (weight ${r.weight}): ${r.description}`).join('\n');
}

async function generateWithOpenAI(
    options: GenerateInterviewReportOptions,
    prompt: string
): Promise<InterviewReport> {
    const settings = settingsStore.get();
    const client = new OpenAI({ apiKey: settings.openaiApiKey });

    const response = await client.chat.completions.create({
        model: settings.openaiModel || 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content || '';
    return JSON.parse(content) as InterviewReport;
}

async function generateWithGemini(
    options: GenerateInterviewReportOptions,
    prompt: string
): Promise<InterviewReport> {
    const settings = settingsStore.get();
    const genAI = new GoogleGenerativeAI(settings.geminiApiKey);
    const model = genAI.getGenerativeModel({ model: settings.geminiModel || 'gemini-1.5-flash' });

    const raw = await model.generateContent(prompt);
    let text = raw.response.text();

    // Gemini may wrap JSON in code fences.
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(text) as InterviewReport;
}

export async function generateInterviewReport(
    options: GenerateInterviewReportOptions
): Promise<InterviewReport> {
    const settings = settingsStore.get();

    const transcriptText = buildTranscriptText(options.transcript);
    const rubricText = buildRubricText(options.rubric);

    const prompt = `
You are an interview evaluation engine.
Return ONLY valid JSON that matches the InterviewReport schema below.

Schema:
{
  "sessionId": string,
  "jobDescription": string,
  "rubric": Array<{ "competency": string, "description": string, "weight": number }>,
  "scores": Array<{
    "competency": string,
    "score": number,   // 0-10
    "evidence": string,
    "questionDiversity": number // 0-1
  }>,
  "biasFlags": Array<{
    "type": "gender"|"age"|"nationality"|"disability"|"appearance"|"other",
    "description": string,
    "utterance": string,
    "severity": "low"|"medium"|"high",
    "timestamp": number
  }>,
  "overallScore": number, // 0-100
  "recommendation": "strong_yes"|"yes"|"maybe"|"no"|"strong_no",
  "summary": string
}

Job Description:
${options.jobDescription}

Rubric:
${rubricText}

Interview Transcript:
${transcriptText}

Rules:
- Use the rubric competencies exactly as provided.
- evidence should cite specific transcript phrases when available.
- If no evidence exists for a competency, keep evidence short and truthful.
- If bias cannot be determined, return an empty biasFlags array.
`.trim();

    try {
        if (settings.aiProvider === 'gemini' && settings.geminiApiKey) {
            return await generateWithGemini(options, `${prompt}\n\nRespond ONLY with valid JSON.`);
        }
        return await generateWithOpenAI(options, prompt);
    } catch (err) {
        console.error('[InterviewEngine] Failed to generate report:', err);

        const emptyScores: CompetencyScore[] = options.rubric.map((r) => ({
            competency: r.competency,
            score: 0,
            evidence: '',
            questionDiversity: 0,
        }));

        const emptyBias: BiasFlag[] = [];

        return {
            sessionId: options.sessionId,
            jobDescription: options.jobDescription,
            rubric: options.rubric,
            scores: emptyScores,
            biasFlags: emptyBias,
            overallScore: 0,
            recommendation: 'maybe',
            summary: 'Interview report generation failed. Please verify API keys and try again.',
        };
    }
}

