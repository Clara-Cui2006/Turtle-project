import { z } from 'zod';

export const idSchema = z.string().min(1).max(100);
export const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(30).default([]);

export const courseInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  teacher: z.string().max(100).default(''),
  tags: tagsSchema
});

export const sessionInputSchema = z.object({
  id: z.string().uuid().optional(),
  courseId: idSchema,
  name: z.string().trim().min(1).max(160),
  date: z.string().min(8).max(30),
  teacher: z.string().max(100).default(''),
  tags: tagsSchema,
  remarks: z.string().max(4000).default(''),
  legalTerms: z.string().max(4000).default('')
});

export const transcriptInputSchema = z.object({
  startedAt: z.string(),
  endedAt: z.string(),
  text: z.string().trim().min(1).max(20000),
  clientResultId: z.string().max(200).optional()
});

export const settingsInputSchema = z.object({
  baseUrl: z.string().url().refine((value) => value.startsWith('https://'), '必须使用 HTTPS'),
  apiKey: z.string().max(500).optional(),
  noteModel: z.string().min(1).max(100),
  autoQaModel: z.string().min(1).max(100),
  manualQaModel: z.string().min(1).max(100),
  deepModel: z.string().min(1).max(100),
  stream: z.boolean(),
  thinking: z.boolean(),
  autoNotes: z.boolean(),
  noteIntervalSeconds: z.number().int().min(10).max(600),
  noteTriggerChars: z.number().int().min(100).max(5000),
  autoDetectQuestions: z.boolean(),
  autoAnswer: z.boolean(),
  autoQaPaused: z.boolean(),
  useHistory: z.boolean(),
  allowGeneralKnowledge: z.boolean(),
  keepOriginalFiles: z.boolean(),
  filterSmallTalk: z.boolean(),
  includeCourseContextInNotes: z.boolean(),
  deferUncertainContent: z.boolean(),
  showRelevanceLabels: z.boolean(),
  realtimeMicroUpdates: z.boolean(),
  backgroundReorganization: z.boolean(),
  organizationSensitivity: z.enum(['low', 'standard', 'high']),
  allowAiReorganization: z.boolean(),
  showRevisionNotices: z.boolean(),
  legalQuestionsOnly: z.boolean(),
  showUncertainQuestions: z.boolean(),
  unreadQuestionBadges: z.boolean(),
  transcriptionAutoRecovery: z.boolean(),
  preventScreenSleep: z.boolean(),
  showTranscriptionDiagnostics: z.boolean(),
  backgroundStatusAlerts: z.boolean(),
  recordAudioLocally: z.boolean()
});

export const noteUpdateSchema = z.object({ force: z.boolean().default(false) });
export const questionInputSchema = z.object({
  question: z.string().trim().min(2).max(4000),
  source: z.enum(['auto', 'manual']).default('manual')
});
export const relevanceCategorySchema = z.enum(['substantive_legal', 'course_context', 'small_talk', 'uncertain']);
export type RelevanceCategory = z.infer<typeof relevanceCategorySchema>;

export const transcriptRelevancePatchSchema = z.object({ category: relevanceCategorySchema });
export const noteNodeTypeSchema = z.enum(['heading', 'paragraph', 'bulletList', 'orderedList', 'blockquote', 'horizontalRule', 'table', 'image', 'qa', 'suggestion']);
export const notePatchOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('insertNode'), node: z.object({ id: z.string().uuid().optional(), parentId: z.string().uuid().nullable().default(null), type: noteNodeTypeSchema, position: z.number().int().min(0).optional(), headingLevel: z.number().int().min(1).max(4).nullable().optional(), content: z.unknown(), sourceTranscriptIds: z.array(z.string()).default([]) }) }),
  z.object({ op: z.literal('updateNode'), nodeId: z.string().uuid(), content: z.unknown().optional(), headingLevel: z.number().int().min(1).max(4).nullable().optional() }),
  z.object({ op: z.enum(['insertAfter', 'insertBefore']), targetNodeId: z.string().uuid(), node: z.object({ id: z.string().uuid().optional(), type: noteNodeTypeSchema, headingLevel: z.number().int().min(1).max(4).nullable().optional(), content: z.unknown(), sourceTranscriptIds: z.array(z.string()).default([]) }) }),
  z.object({ op: z.literal('moveNode'), nodeId: z.string().uuid(), parentId: z.string().uuid().nullable(), position: z.number().int().min(0) }),
  z.object({ op: z.literal('mergeNodes'), nodeIds: z.array(z.string().uuid()).min(2), content: z.unknown() }),
  z.object({ op: z.literal('splitNode'), nodeId: z.string().uuid(), parts: z.array(z.unknown()).min(2) }),
  z.object({ op: z.enum(['convertToTable', 'updateTable']), nodeIds: z.array(z.string().uuid()).min(1), table: z.unknown() }),
  z.object({ op: z.enum(['addExample', 'addRelation', 'addAuthority', 'markForVerification']), targetNodeId: z.string().uuid(), content: z.unknown(), sourceTranscriptIds: z.array(z.string()).default([]) }),
  z.object({ op: z.literal('createSection'), title: z.string().min(1).max(200), headingLevel: z.number().int().min(1).max(4), parentId: z.string().uuid().nullable().default(null), afterNodeId: z.string().uuid().optional(), content: z.unknown().optional(), sourceTranscriptIds: z.array(z.string()).default([]) })
]);
export const notePatchSchema = z.object({ baseVersion: z.number().int().min(0), reason: z.string().min(1).max(500), operations: z.array(notePatchOperationSchema).min(1).max(50) });
export const noteDocumentUpdateSchema = z.object({ baseVersion: z.number().int().min(0), content: z.unknown(), activeNodeId: z.string().uuid().nullable().optional() });
export const addToNoteSchema = z.object({ target: z.enum(['full', 'outline', 'both']), targetNodeId: z.string().uuid().nullable().optional(), preview: z.boolean().default(false) });
export const exportInputSchema = z.object({
  format: z.enum(['docx', 'md', 'txt']),
  scope: z.enum(['full', 'outline', 'notes', 'transcript', 'qa', 'package']).default('package')
});

export type SettingsInput = z.infer<typeof settingsInputSchema>;
export type CourseInput = z.infer<typeof courseInputSchema>;
export type SessionInput = z.infer<typeof sessionInputSchema>;

export interface Course extends CourseInput { id: string; createdAt: string; updatedAt: string }
export interface ClassSession extends SessionInput {
  id: string; status: 'active' | 'paused' | 'ended'; startedAt: string | null; endedAt: string | null; createdAt: string; updatedAt: string;
}
export interface TranscriptSegment {
  id: string; sessionId: string; startedAt: string; endedAt: string; originalText: string; text: string; isFinal: boolean; userEdited: boolean; important: boolean; relevance?: RelevanceCategory; relevanceConfidence?: number; relevanceManual?: boolean; createdAt: string; updatedAt: string;
}
export interface NoteBlock {
  id: string; noteId: string; section: string; content: string; source: 'ai' | 'user' | 'qa'; userEdited: boolean; locked: boolean; qaId: string | null; position: number; createdAt: string; updatedAt: string;
}
export interface NoteDocument { id: string; sessionId: string; type: 'full' | 'outline'; status: string; lastProcessedAt: string | null; blocks: NoteBlock[] }
export interface QaItem {
  id: string; sessionId: string; source: 'auto' | 'manual'; question: string; completedQuestion?: string; questionType?: string; isLegal?: boolean | null; confidence?: number; answer: string; evidence: string; references: string; status: string; possibleRhetorical: boolean; archived: boolean; readAt?: string | null; deletedAt?: string | null; createdAt: string; updatedAt: string;
}
export interface NoteNode { id: string; documentId: string; parentId: string | null; type: z.infer<typeof noteNodeTypeSchema>; position: number; headingLevel: number | null; content: unknown; textContent: string; source: 'ai'|'user'|'qa'|'migration'; userEdited: boolean; aiManaged: boolean; version: number; createdAt: string; updatedAt: string; sourceTranscriptIds: string[] }
export interface NoteDocumentV2 { id: string; sessionId: string; type: 'full'|'outline'; status: string; version: number; content: unknown; nodes: NoteNode[]; pendingSuggestions: number; updatedAt: string }
export interface ApiError { error: { code: string; message: string; details?: unknown } }

export const DEFAULT_SETTINGS: SettingsInput = {
  baseUrl: 'https://api.deepseek.com', noteModel: 'deepseek-flash', autoQaModel: 'deepseek-flash', manualQaModel: 'deepseek-flash', deepModel: 'deepseek-v4-pro',
  stream: true, thinking: false, autoNotes: true, noteIntervalSeconds: 25, noteTriggerChars: 500,
  autoDetectQuestions: true, autoAnswer: true, autoQaPaused: false, useHistory: true, allowGeneralKnowledge: true, keepOriginalFiles: false,
  filterSmallTalk: true, includeCourseContextInNotes: false, deferUncertainContent: true, showRelevanceLabels: false,
  realtimeMicroUpdates: true, backgroundReorganization: true, organizationSensitivity: 'standard', allowAiReorganization: true, showRevisionNotices: true,
  legalQuestionsOnly: true, showUncertainQuestions: true, unreadQuestionBadges: true,
  transcriptionAutoRecovery: true, preventScreenSleep: true, showTranscriptionDiagnostics: false, backgroundStatusAlerts: true, recordAudioLocally: false
};

export const questionCandidate = (text: string): boolean => {
  const value = text.trim();
  if (value.length < 6 || /^(是不是|对不对|好不好|明白吗)[？?]?$/.test(value)) return false;
  return /[？?]$/.test(value) || /(为什么|如何|什么是|有哪些|是否|能否|区别|关系|依据是什么)/.test(value);
};

export const normalizeQuestion = (text: string): string => text.trim().replace(/[？?]+$/, '').replace(/\s+/g, '').toLowerCase();
export const maskApiKey = (key: string): string => key ? `${key.slice(0, 3)}-****${key.slice(-4)}` : '';
