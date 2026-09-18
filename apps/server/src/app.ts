import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { addToNoteSchema, courseInputSchema, exportInputSchema, noteUpdateSchema, questionInputSchema, sessionInputSchema, transcriptInputSchema } from '@turtle/shared';
import { AiError, DeepSeekProvider, type LlmProvider } from './ai.js';
import { TurtleDatabase } from './database.js';
import { exportSession, MAX_IMPORT_SIZE, parseImport } from './files.js';
import { getDataDir } from './paths.js';
import { ClassroomServices } from './services.js';
import { SettingsStore } from './settings.js';

const patchCourseSchema = courseInputSchema.partial().refine((value) => Object.keys(value).length > 0);
const patchSessionSchema = sessionInputSchema.omit({ courseId: true }).partial().extend({ status: z.enum(['active','paused','ended']).optional(), startedAt: z.string().nullable().optional(), endedAt: z.string().nullable().optional() }).refine((value) => Object.keys(value).length > 0);
const patchTranscriptSchema = z.object({ text: z.string().trim().min(1).max(20000).optional(), important: z.boolean().optional() }).refine((value) => Object.keys(value).length > 0);
const patchQuestionSchema = z.object({ question: z.string().trim().min(2).max(4000).optional(), answer: z.string().max(30000).optional(), archived: z.boolean().optional() }).refine((value) => Object.keys(value).length > 0);

export interface AppDependencies { db?: TurtleDatabase; settings?: SettingsStore; llm?: LlmProvider }

export function createApp(deps: AppDependencies = {}) {
  const dataDir = getDataDir();
  const db = deps.db ?? new TurtleDatabase(dataDir);
  const settings = deps.settings ?? new SettingsStore(dataDir);
  const llm = deps.llm ?? new DeepSeekProvider(settings);
  const services = new ClassroomServices(db, settings, llm);
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMPORT_SIZE } });
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: '课堂实时助手', dataDir, aiConfigured: settings.getPublic().apiKeyConfigured }));
  app.get('/api/state', (_req, res) => res.json({ currentSessionId: db.currentSessionId(), activeSessions: db.listSessions().filter((s) => s.status !== 'ended') }));

  app.get('/api/settings', (_req, res) => res.json(settings.getPublic()));
  app.put('/api/settings', (req, res) => res.json(settings.save(req.body)));
  app.delete('/api/settings/api-key', (_req, res) => { settings.clearKey(); res.status(204).end(); });
  app.post('/api/settings/test', async (req, res, next) => {
    try {
      const current = settings.getPrivate(); const model = z.object({ apiKey: z.string().optional(), baseUrl: z.string().url().optional(), model: z.string().optional() }).parse(req.body);
      const temporary = model.apiKey || model.baseUrl ? { getPrivate: () => ({ ...current, apiKey: model.apiKey || current.apiKey, baseUrl: model.baseUrl || current.baseUrl }) } as SettingsStore : settings;
      await new DeepSeekProvider(temporary).complete({ model: model.model || current.noteModel, system: '只回答“连接成功”。', prompt: '测试连接', json: false });
      res.json({ ok: true, message: 'DeepSeek 连接成功' });
    } catch (error) { next(error); }
  });

  app.get('/api/courses', (_req, res) => res.json(db.listCourses()));
  app.post('/api/courses', (req, res) => res.status(201).json(db.createCourse(courseInputSchema.parse(req.body))));
  app.patch('/api/courses/:id', (req, res) => { const value = db.updateCourse(req.params.id!, patchCourseSchema.parse(req.body)); if(value)res.json(value);else res.status(404).json({ error: { code: 'NOT_FOUND', message: '课程不存在' } }); });
  app.delete('/api/courses/:id', (req, res) => db.deleteCourse(req.params.id!) ? res.status(204).end() : res.status(404).json({ error: { code: 'NOT_FOUND', message: '课程不存在' } }));

  app.get('/api/sessions', (req, res) => res.json(db.listSessions(typeof req.query.courseId === 'string' ? req.query.courseId : undefined)));
  app.post('/api/sessions', (req, res) => res.status(201).json(db.createSession(sessionInputSchema.parse(req.body))));
  app.get('/api/sessions/:id', (req, res) => { const session = db.getSession(req.params.id!); if(session)res.json({ ...session, transcripts: db.listTranscripts(session.id), notes: db.getNotes(session.id), qa: db.listQa(session.id) });else res.status(404).json({ error: { code: 'NOT_FOUND', message: '课堂不存在' } }); });
  app.patch('/api/sessions/:id', (req, res) => { const value = db.updateSession(req.params.id!, patchSessionSchema.parse(req.body)); if(value)res.json(value);else res.status(404).json({ error: { code: 'NOT_FOUND', message: '课堂不存在' } }); });
  app.delete('/api/sessions/:id', (req, res) => db.deleteSession(req.params.id!) ? res.status(204).end() : res.status(404).json({ error: { code: 'NOT_FOUND', message: '课堂不存在' } }));

  app.get('/api/sessions/:id/transcripts', (req, res) => res.json(db.listTranscripts(req.params.id!)));
  app.post('/api/sessions/:id/transcripts', (req, res) => {
    const input = transcriptInputSchema.parse(req.body); const segment = db.addTranscript(req.params.id!, input); res.status(201).json(segment);
    const privateSettings = settings.getPrivate();
    if (privateSettings.apiKey) { services.scheduleNotes(req.params.id!); void services.detectAndAnswer(req.params.id!, segment.text); }
  });
  app.patch('/api/transcripts/:id', (req, res) => { const value = db.updateTranscript(req.params.id!, patchTranscriptSchema.parse(req.body)); if(value)res.json(value);else res.status(404).json({ error: { code: 'NOT_FOUND', message: '转写不存在' } }); });

  app.get('/api/sessions/:id/notes', (req, res) => res.json(db.getNotes(req.params.id!)));
  app.post('/api/sessions/:id/notes/update', async (req, res, next) => { try { const { force } = noteUpdateSchema.parse(req.body); res.json(await services.updateNotes(req.params.id!, force)); } catch (error) { next(error); } });
  app.patch('/api/note-blocks/:id', (req, res) => { const { content } = z.object({ content: z.string().min(1).max(50000) }).parse(req.body); const value = db.updateNoteBlock(req.params.id!, content); if(value)res.json(value);else res.status(404).json({ error: { code: 'NOT_FOUND', message: '笔记块不存在' } }); });
  app.post('/api/notes/:id/blocks', (req,res) => { const input=z.object({section:z.string().min(1).max(120),content:z.string().min(1).max(50000)}).parse(req.body); res.status(201).json(db.addUserNoteBlock(req.params.id!,input.section,input.content)); });
  app.post('/api/notes/:id/undo', (req, res) => db.undoNote(req.params.id!) ? res.json({ ok: true }) : res.status(409).json({ error: { code: 'NO_REVISION', message: '没有可撤销的自动更新' } }));

  app.get('/api/sessions/:id/questions', (req, res) => res.json(db.listQa(req.params.id!)));
  app.post('/api/sessions/:id/questions/detect', async (req, res, next) => { try { const { text } = z.object({ text: z.string().min(1) }).parse(req.body); await services.detectAndAnswer(req.params.id!, text); res.json(db.listQa(req.params.id!)); } catch (error) { next(error); } });
  app.post('/api/sessions/:id/questions', async (req, res, next) => { try { const input = questionInputSchema.parse(req.body); res.status(201).json(await services.ask(req.params.id!, input.question, input.source)); } catch (error) { next(error); } });
  app.post('/api/sessions/:id/questions/stream', async (req,res,next) => { try { const input=questionInputSchema.parse(req.body);res.setHeader('Content-Type','text/event-stream; charset=utf-8');res.setHeader('Cache-Control','no-cache');res.flushHeaders();for await(const chunk of services.streamAsk(req.params.id!,input.question)){res.write(`data: ${JSON.stringify({chunk})}\n\n`);}res.write('data: [DONE]\n\n');res.end();}catch(error){if(res.headersSent){res.write(`data: ${JSON.stringify({error:error instanceof Error?error.message:'生成失败'})}\n\n`);res.end();}else next(error);} });
  app.post('/api/questions/:id/regenerate', async (req, res, next) => { try { res.json(await services.answer(req.params.id!)); } catch (error) { next(error); } });
  app.post('/api/questions/:id/cancel', (req, res) => { services.cancel(`qa:${req.params.id!}`); res.status(204).end(); });
  app.patch('/api/questions/:id', (req, res) => { const value = db.updateQa(req.params.id!, patchQuestionSchema.parse(req.body)); if(value)res.json(value);else res.status(404).json({ error: { code: 'NOT_FOUND', message: '问答不存在' } }); });
  app.delete('/api/questions/:id', (req, res) => db.deleteQa(req.params.id!) ? res.status(204).end() : res.status(404).json({ error: { code: 'NOT_FOUND', message: '问答不存在' } }));
  app.post('/api/questions/:id/add-to-note', (req, res, next) => { try { res.json(db.addQaToNotes(req.params.id!, addToNoteSchema.parse(req.body).target)); } catch (error) { next(error); } });
  app.delete('/api/questions/:id/from-note', (req, res, next) => { try { res.json(db.removeQaFromNotes(req.params.id!)); } catch (error) { next(error); } });

  app.post('/api/documents/import', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) throw new Error('请选择文件');
      const parsed = await parseImport(req.file.originalname, req.file.buffer);
      const name = (typeof req.body.name === 'string' && req.body.name.trim()) || req.file.originalname;
      const courseId = typeof req.body.courseId === 'string' && req.body.courseId ? req.body.courseId : null;
      let originalPath:string|null=null;
      if(settings.getPrivate().keepOriginalFiles){const folder=join(dataDir,'imports');mkdirSync(folder,{recursive:true});originalPath=join(folder,`${randomUUID()}.${parsed.type}`);writeFileSync(originalPath,req.file.buffer,{mode:0o600});}
      try{res.status(201).json(db.addDocument(courseId,name,parsed.type,req.file.size,parsed.hash,parsed.chunks,originalPath));}
      catch(error){if(originalPath){try{const {unlinkSync}=await import('node:fs');unlinkSync(originalPath);}catch{/* no orphan cleanup needed */}}throw error;}
    } catch (error) { next(error); }
  });
  app.get('/api/documents', (_req, res) => res.json(db.listDocuments()));
  app.delete('/api/documents/:id', (req, res) => db.deleteDocument(req.params.id!) ? res.status(204).end() : res.status(404).json({ error: { code: 'NOT_FOUND', message: '资料不存在' } }));
  app.post('/api/sessions/:id/export', async (req, res, next) => { try { const input = exportInputSchema.parse(req.body); const file = await exportSession(db,req.params.id!,input.format,input.scope); res.setHeader('Content-Type',file.contentType); res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`); res.send(file.buffer); } catch (error) { next(error); } });
  app.get('/api/search', (req, res) => { const query = z.string().min(1).parse(req.query.q); res.json(db.search(query,typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined,typeof req.query.courseId === 'string' ? req.query.courseId : undefined)); });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '输入内容不符合要求', details: error.issues } });
    if (error instanceof AiError) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    if (error instanceof multer.MulterError) return res.status(400).json({ error: { code: 'FILE_ERROR', message: error.code === 'LIMIT_FILE_SIZE' ? '文件超过 10MB 限制' : '文件上传失败' } });
    const message = error instanceof Error ? error.message : '未知错误';
    const safe = /UNIQUE constraint failed: imported_documents/.test(message) ? '同一文件已导入，请勿重复导入' : message;
    res.status(400).json({ error: { code: 'REQUEST_ERROR', message: safe } });
  });

  return { app, db, settings, services };
}
