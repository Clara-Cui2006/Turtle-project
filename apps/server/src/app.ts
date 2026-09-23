import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { accessSync, constants, copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { z, ZodError } from 'zod';
import { addToNoteSchema, courseInputSchema, exportInputSchema, noteDocumentUpdateSchema, notePatchSchema, noteUpdateSchema, questionInputSchema, sessionInputSchema, transcriptInputSchema, transcriptRelevancePatchSchema } from '@turtle/shared';
import { AiError, DeepSeekProvider, type LlmProvider } from './ai.js';
import { TurtleDatabase } from './database.js';
import { exportSession, MAX_IMPORT_SIZE, parseImport } from './files.js';
import { getPaths } from './paths.js';
import { ClassroomServices } from './services.js';
import { SettingsStore } from './settings.js';

function applyPendingRestore(paths:ReturnType<typeof getPaths>):void{
  const marker=join(paths.root,'restore-request.json');if(!existsSync(marker))return;
  const request=JSON.parse(readFileSync(marker,'utf8')) as {name:string};if(!/^turtle-[a-z0-9-]+\.db$/i.test(request.name))throw new Error('备份恢复请求名称无效');
  const source=join(paths.backups,request.name);if(!existsSync(source))throw new Error('待恢复的备份不存在');const check=new DatabaseSync(source,{readOnly:true});const integrity=(check.prepare('PRAGMA integrity_check').get() as any).integrity_check;check.close();if(integrity!=='ok')throw new Error('备份完整性检查失败，未替换当前数据库');
  if(existsSync(paths.database))copyFileSync(paths.database,join(paths.backups,`turtle-pre-restore-${new Date().toISOString().replace(/[:.]/g,'-')}.db`));const temp=`${paths.database}.restore.tmp`;copyFileSync(source,temp);renameSync(temp,paths.database);for(const suffix of ['-wal','-shm'])if(existsSync(`${paths.database}${suffix}`))unlinkSync(`${paths.database}${suffix}`);unlinkSync(marker);
}

function pruneDailyBackups(directory:string):void{
  const daily=readdirSync(directory).filter((name)=>/^turtle-daily-\d{4}-\d{2}-\d{2}\.db$/.test(name)).sort().reverse();
  for(const name of daily.slice(7))unlinkSync(join(directory,name));
}

const patchCourseSchema = courseInputSchema.partial().refine((value) => Object.keys(value).length > 0);
const patchSessionSchema = sessionInputSchema.omit({ courseId: true }).partial().extend({ status: z.enum(['active','paused','ended']).optional(), startedAt: z.string().nullable().optional(), endedAt: z.string().nullable().optional() }).refine((value) => Object.keys(value).length > 0);
const patchTranscriptSchema = z.object({ text: z.string().trim().min(1).max(20000).optional(), important: z.boolean().optional() }).refine((value) => Object.keys(value).length > 0);
const patchQuestionSchema = z.object({ question: z.string().trim().min(2).max(4000).optional(), answer: z.string().max(30000).optional(), archived: z.boolean().optional() }).refine((value) => Object.keys(value).length > 0);

export interface AppDependencies { db?: TurtleDatabase; settings?: SettingsStore; llm?: LlmProvider }

export function createApp(deps: AppDependencies = {}) {
  const paths = getPaths(),dataDir=paths.root,startedAt=new Date().toISOString();
  if(!deps.db)applyPendingRestore(paths);
  const db = deps.db ?? new TurtleDatabase(dataDir);
  const settings = deps.settings ?? new SettingsStore(dataDir);
  const llm = deps.llm ?? new DeepSeekProvider(settings);
  const services = new ClassroomServices(db, settings, llm);
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMPORT_SIZE } });
  const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024 } });
  const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 250*1024*1024 } });
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  const backupDay=new Date().toISOString().slice(0,10),dailyName=`turtle-daily-${backupDay}.db`;if(!deps.db&&!existsSync(join(paths.backups,dailyName)))void backup(db.db,join(paths.backups,dailyName)).then(()=>pruneDailyBackups(paths.backups)).catch(()=>undefined);

  app.get('/api/health', (_req, res) => {let writable=true;try{accessSync(dataDir,constants.R_OK|constants.W_OK);db.db.prepare('SELECT 1').get();}catch{writable=false;}const databaseExists=existsSync(paths.database),databaseSize=databaseExists?statSync(paths.database).size:0;const schemaVersion=Number((db.db.prepare('PRAGMA user_version').get() as any).user_version??0);const lastSuccessfulWrite=(db.db.prepare('SELECT MAX(updated_at) value FROM (SELECT updated_at FROM courses UNION ALL SELECT updated_at FROM class_sessions UNION ALL SELECT updated_at FROM transcript_segments)').get() as any)?.value??null;const activeSessionCount=db.listSessions().filter((item)=>item.status!=='ended').length,settingsConfigured=settings.getPublic().apiKeyConfigured;res.json({ok:writable,status:writable?'ok':'error',service:'课堂实时助手',serverStartedAt:startedAt,dataDir,dataDirectory:dataDir,databasePath:paths.database,databaseExists,databaseSize,schemaVersion,writable,lastSuccessfulWrite,settings:settings.getDiagnostic(),aiConfigured:settingsConfigured,settingsConfigured,activeSessionCount,counts:{courses:db.listCourses().length,sessions:db.listSessions().length}}); });
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
  app.post('/api/courses', (req, res) => {const key=req.get('Idempotency-Key');if(key){const existing=db.getPersistenceOperation(key);if(existing)return res.status(200).json(existing);}const value=db.createCourse(courseInputSchema.parse(req.body));if(key)db.savePersistenceOperation(key,'POST',req.path,value);res.status(201).json(value);});
  app.patch('/api/courses/:id', (req, res) => { const value = db.updateCourse(req.params.id!, patchCourseSchema.parse(req.body)); if(value)res.json(value);else res.status(404).json({ error: { code: 'NOT_FOUND', message: '课程不存在' } }); });
  app.delete('/api/courses/:id', (req, res) => db.deleteCourse(req.params.id!) ? res.status(204).end() : res.status(404).json({ error: { code: 'NOT_FOUND', message: '课程不存在' } }));

  app.get('/api/sessions', (req, res) => res.json(db.listSessions(typeof req.query.courseId === 'string' ? req.query.courseId : undefined)));
  app.post('/api/sessions', (req, res) => {const key=req.get('Idempotency-Key');if(key){const existing=db.getPersistenceOperation(key);if(existing)return res.status(200).json(existing);}const value=db.createSession(sessionInputSchema.parse(req.body));if(key)db.savePersistenceOperation(key,'POST',req.path,value);res.status(201).json(value);});
  app.get('/api/sessions/:id', (req, res) => { const session = db.getSession(req.params.id!); if(session)res.json({ ...session, transcripts: db.listTranscripts(session.id), notes: db.getNotes(session.id), noteDocuments:db.getNoteDocuments(session.id), qa: db.listQa(session.id) });else res.status(404).json({ error: { code: 'NOT_FOUND', message: '课堂不存在' } }); });
  app.patch('/api/sessions/:id', (req, res) => { const value = db.updateSession(req.params.id!, patchSessionSchema.parse(req.body)); if(value)res.json(value);else res.status(404).json({ error: { code: 'NOT_FOUND', message: '课堂不存在' } }); });
  app.delete('/api/sessions/:id', (req, res) => db.deleteSession(req.params.id!) ? res.status(204).end() : res.status(404).json({ error: { code: 'NOT_FOUND', message: '课堂不存在' } }));

  app.get('/api/sessions/:id/transcripts', (req, res) => res.json(db.listTranscripts(req.params.id!)));
  app.post('/api/sessions/:id/transcripts', (req, res) => {
    const key=req.get('Idempotency-Key');if(key){const existing=db.getPersistenceOperation(key);if(existing)return res.status(200).json(existing);}const input = transcriptInputSchema.parse(req.body); const segment = db.addTranscript(req.params.id!, input);if(key)db.savePersistenceOperation(key,'POST',req.path,segment);res.status(201).json(segment);void services.handleFinalTranscript(segment).catch(()=>undefined);
  });
  app.patch('/api/transcripts/:id', (req, res) => { const value = db.updateTranscript(req.params.id!, patchTranscriptSchema.parse(req.body)); if(value)res.json(value);else res.status(404).json({ error: { code: 'NOT_FOUND', message: '转写不存在' } }); });
  app.post('/api/transcripts/classify', async(req,res,next)=>{try{const {id}=z.object({id:z.string().uuid()}).parse(req.body);const segment=(db.db.prepare('SELECT session_id FROM transcript_segments WHERE id=?').get(id) as any);if(!segment)return res.status(404).json({error:{code:'NOT_FOUND',message:'转写不存在'}});const item=db.listTranscripts(segment.session_id).find((value)=>value.id===id)!;res.json(await services.classifyTranscript(item));}catch(error){next(error);}});
  app.patch('/api/transcripts/:id/relevance',(req,res)=>{const {category}=transcriptRelevancePatchSchema.parse(req.body);const value=db.setTranscriptRelevance(req.params.id!,category,1,true,'用户手动分类');if(value){res.json(value);if(category==='substantive_legal')void services.handleFinalTranscript(value).catch(()=>undefined);}else res.status(404).json({error:{code:'NOT_FOUND',message:'转写不存在'}});});

  app.get('/api/sessions/:id/notes', (req, res) => res.json(db.getNotes(req.params.id!)));
  app.post('/api/sessions/:id/notes/update', async (req, res, next) => { try { const { force } = noteUpdateSchema.parse(req.body); res.json(await services.updateNotes(req.params.id!, force)); } catch (error) { next(error); } });
  app.patch('/api/note-blocks/:id', (req, res) => { const { content } = z.object({ content: z.string().min(1).max(50000) }).parse(req.body); const value = db.updateNoteBlock(req.params.id!, content); if(value)res.json(value);else res.status(404).json({ error: { code: 'NOT_FOUND', message: '笔记块不存在' } }); });
  app.post('/api/notes/:id/blocks', (req,res) => { const input=z.object({section:z.string().min(1).max(120),content:z.string().min(1).max(50000)}).parse(req.body); res.status(201).json(db.addUserNoteBlock(req.params.id!,input.section,input.content)); });
  app.post('/api/notes/:id/undo', (req, res) => db.undoNote(req.params.id!) ? res.json({ ok: true }) : res.status(409).json({ error: { code: 'NO_REVISION', message: '没有可撤销的自动更新' } }));
  app.get('/api/sessions/:id/note-documents',(req,res)=>res.json(db.getNoteDocuments(req.params.id!)));
  app.patch('/api/note-documents/:id',(req,res)=>{const input=noteDocumentUpdateSchema.parse(req.body);res.json(db.saveNoteDocument(req.params.id!,input.baseVersion,input.content,input.activeNodeId));});
  app.post('/api/note-documents/:id/patch',(req,res)=>{const input=notePatchSchema.parse(req.body);res.json(db.applyNotePatch(req.params.id!,input.baseVersion,input.reason,input.operations));});
  app.post('/api/note-documents/:id/reorganize',async(req,res,next)=>{try{const document=db.getNoteDocument(req.params.id!);if(!document)throw new Error('笔记文档不存在');await services.updateNotes(document.sessionId,true);res.json(db.getNoteDocument(document.id));}catch(error){next(error);}});
  app.post('/api/note-documents/:id/undo',(req,res)=>{const value=db.undoNoteDocument(req.params.id!);if(value)res.json(value);else res.status(409).json({error:{code:'NO_REVISION',message:'没有可撤销修订'}});});

  app.get('/api/sessions/:id/questions', (req, res) => res.json(db.listQa(req.params.id!)));
  app.post('/api/sessions/:id/questions/detect', async (req, res, next) => { try { const { text } = z.object({ text: z.string().min(1) }).parse(req.body); await services.detectAndAnswer(req.params.id!, text); res.json(db.listQa(req.params.id!)); } catch (error) { next(error); } });
  app.post('/api/sessions/:id/questions', async (req, res, next) => { try { const input = questionInputSchema.parse(req.body); res.status(201).json(await services.ask(req.params.id!, input.question, input.source)); } catch (error) { next(error); } });
  app.post('/api/sessions/:id/questions/stream', async (req,res,next) => { try { const input=questionInputSchema.parse(req.body);res.setHeader('Content-Type','text/event-stream; charset=utf-8');res.setHeader('Cache-Control','no-cache');res.flushHeaders();for await(const chunk of services.streamAsk(req.params.id!,input.question)){res.write(`data: ${JSON.stringify({chunk})}\n\n`);}res.write('data: [DONE]\n\n');res.end();}catch(error){if(res.headersSent){res.write(`data: ${JSON.stringify({error:error instanceof Error?error.message:'生成失败'})}\n\n`);res.end();}else next(error);} });
  app.post('/api/questions/:id/regenerate', async (req, res, next) => { try { res.json(await services.answer(req.params.id!)); } catch (error) { next(error); } });
  app.post('/api/questions/:id/cancel', (req, res) => { services.cancel(`qa:${req.params.id!}`); res.status(204).end(); });
  app.patch('/api/questions/:id', (req, res) => { const value = db.updateQa(req.params.id!, patchQuestionSchema.parse(req.body)); if(value)res.json(value);else res.status(404).json({ error: { code: 'NOT_FOUND', message: '问答不存在' } }); });
  app.delete('/api/questions/:id', (req, res) => db.deleteQa(req.params.id!) ? res.status(204).end() : res.status(404).json({ error: { code: 'NOT_FOUND', message: '问答不存在' } }));
  app.patch('/api/questions/:id/read',(req,res)=>{const value=db.markQaRead(req.params.id!);if(value)res.json(value);else res.status(404).json({error:{code:'NOT_FOUND',message:'问答不存在'}});});
  app.post('/api/questions/:id/insert',(req,res)=>{const input=addToNoteSchema.parse(req.body);if(input.preview){const qa=db.getQa(req.params.id!);return res.json({question:qa?.question,target:input.target,targetNodeId:input.targetNodeId??null,preview:qa?.answer});}res.json(db.insertQaIntoDocuments(req.params.id!,input.target,input.targetNodeId));});
  app.delete('/api/questions/:id/note-link',(req,res)=>res.json(db.removeQaFromNotes(req.params.id!)));
  app.post('/api/questions/:id/add-to-note', (req, res, next) => { try { res.json(db.addQaToNotes(req.params.id!, addToNoteSchema.parse(req.body).target)); } catch (error) { next(error); } });
  app.delete('/api/questions/:id/from-note', (req, res, next) => { try { res.json(db.removeQaFromNotes(req.params.id!)); } catch (error) { next(error); } });

  app.post('/api/editor-assets',imageUpload.single('file'),(req,res)=>{if(!req.file)throw new Error('请选择图片');const sessionId=z.string().uuid().parse(req.body.sessionId);const allowed=new Set(['image/png','image/jpeg','image/webp','image/gif']);if(!allowed.has(req.file.mimetype))throw new Error('仅支持 PNG、JPEG、WebP 或 GIF 图片');const id=randomUUID(),extension=req.file.mimetype==='image/png'?'png':req.file.mimetype==='image/jpeg'?'jpg':req.file.mimetype==='image/webp'?'webp':'gif',path=join(paths.assets,`${id}.${extension}`);writeFileSync(path,req.file.buffer,{mode:0o600});const asset=db.addEditorAsset({id,sessionId,filename:req.file.originalname,mimeType:req.file.mimetype,size:req.file.size,path,altText:typeof req.body.altText==='string'?req.body.altText.slice(0,500):''});res.status(201).json({id:asset.id,url:`/api/editor-assets/${asset.id}/content`,altText:asset.alt_text});});
  app.get('/api/editor-assets/:id/content',(req,res)=>{const asset=db.getEditorAsset(req.params.id!);if(!asset)return res.status(404).end();res.type(asset.mime_type);createReadStream(asset.path).pipe(res);});
  app.delete('/api/editor-assets/:id',(req,res)=>{const asset=db.deleteEditorAsset(req.params.id!);if(!asset)return res.status(404).end();if(existsSync(asset.path))unlinkSync(asset.path);res.status(204).end();});
  app.post('/api/sessions/:id/recordings',audioUpload.single('file'),(req,res)=>{if(!req.file)throw new Error('没有录音数据');if(!req.file.mimetype.startsWith('audio/'))throw new Error('文件不是音频');const sessionId=z.string().uuid().parse(req.params.id),extension=req.file.mimetype.includes('ogg')?'ogg':'webm',path=join(paths.recordings,`${randomUUID()}.${extension}`);writeFileSync(path,req.file.buffer,{mode:0o600});res.status(201).json(db.addAudioRecording(sessionId,path,req.file.mimetype,req.file.size,Number(req.body.durationMs)||undefined));});
  app.get('/api/sessions/:id/recordings',(req,res)=>res.json(db.listAudioRecordings(req.params.id!)));
  app.get('/api/recordings/:id/content',(req,res)=>{const item=db.getAudioRecording(req.params.id!);if(!item||!existsSync(item.path))return res.status(404).end();res.type(item.mime_type);res.setHeader('Content-Disposition',req.query.download==='1'?`attachment; filename="recording-${item.id}.${item.mime_type.includes('ogg')?'ogg':'webm'}"`:'inline');createReadStream(item.path).pipe(res);});
  app.delete('/api/recordings/:id',(req,res)=>{const item=db.deleteAudioRecording(req.params.id!);if(!item)return res.status(404).end();if(existsSync(item.path))unlinkSync(item.path);res.status(204).end();});

  app.post('/api/transcription/events',(req,res)=>{const input=z.object({sessionId:z.string().uuid().nullable(),eventType:z.string().min(1).max(60),detail:z.string().max(1000).default(''),occurredAt:z.string().optional()}).parse(req.body);db.addTranscriptionEvent(input.sessionId,input.eventType,input.detail,input.occurredAt);res.status(201).json({ok:true});});
  app.get('/api/transcription/diagnostics',(req,res)=>res.json(db.listTranscriptionEvents(typeof req.query.sessionId==='string'?req.query.sessionId:undefined,100)));
  app.get('/api/backups',(_req,res)=>res.json(readdirSync(paths.backups).filter((name)=>name.endsWith('.db')).map((name)=>{const info=statSync(join(paths.backups,name));return{name,size:info.size,createdAt:info.mtime.toISOString()};}).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))));
  app.post('/api/backups',async(_req,res,next)=>{try{const name=`turtle-manual-${new Date().toISOString().replace(/[:.]/g,'-')}.db`,path=join(paths.backups,name);await backup(db.db,path);res.status(201).json({name,size:statSync(path).size});}catch(error){next(error);}});
  app.post('/api/backups/restore',(req,res)=>{const input=z.object({name:z.string().regex(/^turtle-[a-z0-9-]+\.db$/i),confirmation:z.literal('RESTORE')}).parse(req.body);const source=join(paths.backups,input.name);if(!existsSync(source))throw new Error('备份不存在');const check=new DatabaseSync(source,{readOnly:true});const integrity=(check.prepare('PRAGMA integrity_check').get() as any).integrity_check;check.close();if(integrity!=='ok')throw new Error('备份完整性检查失败');writeFileSync(join(paths.root,'restore-request.json'),JSON.stringify({name:input.name,requestedAt:new Date().toISOString()}),{mode:0o600});res.json({ok:true,restartRequired:true,message:'恢复请求已保存。关闭并重新启动应用后生效；当前数据库会先自动备份。'});});
  app.get('/api/backups/personal-data',(_req,res)=>{const rows=(table:string)=>db.db.prepare(`SELECT * FROM ${table}`).all();const assets=(rows('editor_assets') as any[]).map(({path,...item})=>({...item,data:existsSync(path)?readFileSync(path).toString('base64'):null}));const imported=(rows('imported_documents') as any[]).map(({original_path:_,...item})=>item);const payload={format:'turtle-personal-data-v1',exportedAt:new Date().toISOString(),courses:rows('courses'),sessions:rows('class_sessions'),transcripts:rows('transcript_segments'),transcriptRelevance:rows('transcript_relevance'),noteDocuments:rows('note_documents_v2'),noteNodes:rows('note_nodes'),noteSources:rows('note_node_sources'),questions:rows('qa_items'),questionNoteLinks:rows('qa_note_links'),importedDocuments:imported,documentChunks:rows('document_chunks'),editorAssets:assets};res.attachment(`turtle-personal-data-${new Date().toISOString().slice(0,10)}.json`).type('application/json').send(JSON.stringify(payload));});

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
