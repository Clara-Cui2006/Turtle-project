import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import type { ClassSession, Course, NoteBlock, NoteDocument, QaItem, SessionInput, TranscriptSegment } from '@turtle/shared';

const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value);
const parseJson = <T>(value: string): T => JSON.parse(value) as T;

export class TurtleDatabase {
  readonly db: DatabaseSync;
  private transactionDepth = 0;

  constructor(dataDir: string, memory = false) {
    this.db = new DatabaseSync(memory ? ':memory:' : join(dataDir, 'turtle.db'));
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.migrate();
  }

  close(): void { this.db.close(); }

  private transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try { const value = operation(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.transactionDepth--; }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS courses(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', teacher TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS class_sessions(
        id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, name TEXT NOT NULL, date TEXT NOT NULL, started_at TEXT, ended_at TEXT,
        teacher TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', remarks TEXT NOT NULL DEFAULT '', legal_terms TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_segments(
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE, started_at TEXT NOT NULL, ended_at TEXT NOT NULL, original_text TEXT NOT NULL,
        text TEXT NOT NULL, is_final INTEGER NOT NULL DEFAULT 1, user_edited INTEGER NOT NULL DEFAULT 0, important INTEGER NOT NULL DEFAULT 0, client_result_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(session_id, client_result_id)
      );
      CREATE TABLE IF NOT EXISTS note_documents(
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE, type TEXT NOT NULL CHECK(type IN ('full','outline')), status TEXT NOT NULL DEFAULT 'waiting', last_processed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(session_id,type)
      );
      CREATE TABLE IF NOT EXISTS note_blocks(
        id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES note_documents(id) ON DELETE CASCADE, section TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'ai', user_edited INTEGER NOT NULL DEFAULT 0,
        locked INTEGER NOT NULL DEFAULT 0, qa_id TEXT, position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS note_revisions(
        id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES note_documents(id) ON DELETE CASCADE, snapshot TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS qa_items(
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE, source TEXT NOT NULL, normalized_question TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '', references_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'none', possible_rhetorical INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(session_id, normalized_question)
      );
      CREATE TABLE IF NOT EXISTS imported_documents(
        id TEXT PRIMARY KEY, course_id TEXT REFERENCES courses(id) ON DELETE SET NULL, name TEXT NOT NULL, file_type TEXT NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL, original_path TEXT, created_at TEXT NOT NULL, UNIQUE(course_id,hash)
      );
      CREATE TABLE IF NOT EXISTS document_chunks(
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES imported_documents(id) ON DELETE CASCADE, heading TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, position INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tags(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_preferences(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS processing_jobs(id TEXT PRIMARY KEY, session_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(source_type UNINDEXED, source_id UNINDEXED, course_id UNINDEXED, session_id UNINDEXED, title, content, tokenize='trigram');
      INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,datetime('now'));
    `);
    const columns=this.db.prepare('PRAGMA table_info(imported_documents)').all() as unknown as {name:string}[];
    if(!columns.some((column)=>column.name==='original_path'))this.db.exec('ALTER TABLE imported_documents ADD COLUMN original_path TEXT');
  }

  private course(row: any): Course { return { id: row.id, name: row.name, description: row.description, teacher: row.teacher, tags: parseJson(row.tags), createdAt: row.created_at, updatedAt: row.updated_at }; }
  private session(row: any): ClassSession { return { id: row.id, courseId: row.course_id, name: row.name, date: row.date, startedAt: row.started_at, endedAt: row.ended_at, teacher: row.teacher, tags: parseJson(row.tags), remarks: row.remarks, legalTerms: row.legal_terms, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }; }
  private transcript(row: any): TranscriptSegment { return { id: row.id, sessionId: row.session_id, startedAt: row.started_at, endedAt: row.ended_at, originalText: row.original_text, text: row.text, isFinal: Boolean(row.is_final), userEdited: Boolean(row.user_edited), important: Boolean(row.important), createdAt: row.created_at, updatedAt: row.updated_at }; }
  private block(row: any): NoteBlock { return { id: row.id, noteId: row.note_id, section: row.section, content: row.content, source: row.source, userEdited: Boolean(row.user_edited), locked: Boolean(row.locked), qaId: row.qa_id, position: row.position, createdAt: row.created_at, updatedAt: row.updated_at }; }
  private qa(row: any): QaItem { return { id: row.id, sessionId: row.session_id, source: row.source, question: row.question, answer: row.answer, evidence: row.evidence, references: row.references_json, status: row.status, possibleRhetorical: Boolean(row.possible_rhetorical), archived: Boolean(row.archived), createdAt: row.created_at, updatedAt: row.updated_at }; }

  listCourses(): Course[] { return this.db.prepare('SELECT * FROM courses ORDER BY updated_at DESC').all().map((r) => this.course(r)); }
  createCourse(input: { name: string; description: string; teacher: string; tags: string[] }): Course {
    const id = randomUUID(), stamp = now();
    this.db.prepare('INSERT INTO courses VALUES(?,?,?,?,?,?,?)').run(id, input.name, input.description, input.teacher, json(input.tags), stamp, stamp);
    return this.course(this.db.prepare('SELECT * FROM courses WHERE id=?').get(id));
  }
  updateCourse(id: string, patch: Record<string, unknown>): Course | undefined {
    const current = this.db.prepare('SELECT * FROM courses WHERE id=?').get(id) as any;
    if (!current) return undefined;
    const value = { name: patch.name ?? current.name, description: patch.description ?? current.description, teacher: patch.teacher ?? current.teacher, tags: patch.tags ? json(patch.tags) : current.tags };
    this.db.prepare('UPDATE courses SET name=?,description=?,teacher=?,tags=?,updated_at=? WHERE id=?').run(value.name, value.description, value.teacher, value.tags, now(), id);
    return this.course(this.db.prepare('SELECT * FROM courses WHERE id=?').get(id));
  }
  deleteCourse(id: string): boolean { return this.db.prepare('DELETE FROM courses WHERE id=?').run(id).changes > 0; }

  listSessions(courseId?: string): ClassSession[] {
    const rows = courseId ? this.db.prepare('SELECT * FROM class_sessions WHERE course_id=? ORDER BY date DESC,created_at DESC').all(courseId) : this.db.prepare('SELECT * FROM class_sessions ORDER BY date DESC,created_at DESC').all();
    return rows.map((r) => this.session(r));
  }
  createSession(input: SessionInput): ClassSession {
    const id = randomUUID(), stamp = now();
    this.transaction(() => {
      this.db.prepare(`INSERT INTO class_sessions(id,course_id,name,date,started_at,teacher,tags,remarks,legal_terms,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?)`).run(id, input.courseId, input.name, input.date, stamp, input.teacher, json(input.tags), input.remarks, input.legalTerms, stamp, stamp);
      for (const type of ['full', 'outline']) this.db.prepare('INSERT INTO note_documents VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, type, 'waiting', null, stamp, stamp);
      this.db.prepare(`INSERT INTO app_preferences(key,value,updated_at) VALUES('currentSessionId',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(id, stamp);
    });
    return this.getSession(id)!;
  }
  getSession(id: string): ClassSession | undefined { const row = this.db.prepare('SELECT * FROM class_sessions WHERE id=?').get(id); return row ? this.session(row) : undefined; }
  updateSession(id: string, patch: Record<string, unknown>): ClassSession | undefined {
    const current = this.db.prepare('SELECT * FROM class_sessions WHERE id=?').get(id) as any;
    if (!current) return undefined;
    const fields = ['name','date','teacher','remarks','legal_terms','status','started_at','ended_at'] as const;
    const next: any = { ...current };
    for (const field of fields) { const camel = field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()); if (patch[camel] !== undefined) next[field] = patch[camel]; }
    if (patch.tags) next.tags = json(patch.tags);
    this.db.prepare('UPDATE class_sessions SET name=?,date=?,teacher=?,tags=?,remarks=?,legal_terms=?,status=?,started_at=?,ended_at=?,updated_at=? WHERE id=?').run(next.name,next.date,next.teacher,next.tags,next.remarks,next.legal_terms,next.status,next.started_at,next.ended_at,now(),id);
    return this.getSession(id);
  }
  deleteSession(id: string): boolean { return this.db.prepare('DELETE FROM class_sessions WHERE id=?').run(id).changes > 0; }
  currentSessionId(): string | null { return (this.db.prepare(`SELECT value FROM app_preferences WHERE key='currentSessionId'`).get() as any)?.value ?? null; }

  listTranscripts(sessionId: string): TranscriptSegment[] { return this.db.prepare('SELECT * FROM transcript_segments WHERE session_id=? ORDER BY started_at,created_at').all(sessionId).map((r) => this.transcript(r)); }
  addTranscript(sessionId: string, input: { startedAt: string; endedAt: string; text: string; clientResultId?: string | undefined }): TranscriptSegment {
    const duplicate = input.clientResultId && this.db.prepare('SELECT * FROM transcript_segments WHERE session_id=? AND client_result_id=?').get(sessionId, input.clientResultId);
    if (duplicate) return this.transcript(duplicate);
    const id = randomUUID(), stamp = now();
    this.transaction(() => {
      this.db.prepare('INSERT INTO transcript_segments VALUES(?,?,?,?,?,?,1,0,0,?,?,?)').run(id, sessionId, input.startedAt, input.endedAt, input.text, input.text, input.clientResultId ?? null, stamp, stamp);
      this.index('transcript', id, this.getSession(sessionId)?.courseId ?? '', sessionId, `转写 ${input.startedAt}`, input.text);
    });
    return this.transcript(this.db.prepare('SELECT * FROM transcript_segments WHERE id=?').get(id));
  }
  updateTranscript(id: string, patch: { text?: string | undefined; important?: boolean | undefined }): TranscriptSegment | undefined {
    const row = this.db.prepare('SELECT * FROM transcript_segments WHERE id=?').get(id) as any;
    if (!row) return undefined;
    const text = patch.text ?? row.text, edited = patch.text !== undefined ? 1 : row.user_edited, important = patch.important === undefined ? row.important : Number(patch.important);
    this.transaction(() => { this.db.prepare('UPDATE transcript_segments SET text=?,user_edited=?,important=?,updated_at=? WHERE id=?').run(text,edited,important,now(),id); this.reindex('transcript', id, row.session_id, text); });
    return this.transcript(this.db.prepare('SELECT * FROM transcript_segments WHERE id=?').get(id));
  }

  getNotes(sessionId: string): NoteDocument[] {
    return (this.db.prepare('SELECT * FROM note_documents WHERE session_id=? ORDER BY type').all(sessionId) as any[]).map((n) => ({ id: n.id, sessionId: n.session_id, type: n.type, status: n.status, lastProcessedAt: n.last_processed_at, blocks: this.db.prepare('SELECT * FROM note_blocks WHERE note_id=? ORDER BY position').all(n.id).map((b) => this.block(b)) }));
  }
  snapshotNote(noteId: string, reason: string): void {
    const blocks = this.db.prepare('SELECT * FROM note_blocks WHERE note_id=? ORDER BY position').all(noteId);
    this.db.prepare('INSERT INTO note_revisions VALUES(?,?,?,?,?)').run(randomUUID(), noteId, json(blocks), reason, now());
    const stale = this.db.prepare('SELECT id FROM note_revisions WHERE note_id=? ORDER BY rowid DESC LIMIT -1 OFFSET 20').all(noteId) as unknown as { id: string }[];
    for (const row of stale) this.db.prepare('DELETE FROM note_revisions WHERE id=?').run(row.id);
  }
  appendNoteBlocks(noteId: string, blocks: { section: string; content: string; source?: string; qaId?: string }[], processedAt?: string): void {
    this.transaction(() => {
      this.snapshotNote(noteId, '自动更新前');
      const position = ((this.db.prepare('SELECT MAX(position) max FROM note_blocks WHERE note_id=?').get(noteId) as any)?.max ?? -1) + 1;
      blocks.forEach((block, offset) => { const stamp = now(); this.db.prepare('INSERT INTO note_blocks VALUES(?,?,?,?,?,0,0,?,?,?,?)').run(randomUUID(),noteId,block.section,block.content,block.source ?? 'ai',block.qaId ?? null,position + offset,stamp,stamp); });
      this.db.prepare(`UPDATE note_documents SET status='complete',last_processed_at=?,updated_at=? WHERE id=?`).run(processedAt ?? now(), now(), noteId);
      const note = this.db.prepare('SELECT * FROM note_documents WHERE id=?').get(noteId) as any;
      const content = (this.db.prepare('SELECT section,content FROM note_blocks WHERE note_id=? ORDER BY position').all(noteId) as any[]).map((b) => `${b.section}\n${b.content}`).join('\n');
      this.reindex(note.type === 'full' ? 'note_full' : 'note_outline', noteId, note.session_id, content);
    });
  }
  addUserNoteBlock(noteId: string, section: string, content: string): NoteBlock {
    const id=randomUUID(),stamp=now(),position=((this.db.prepare('SELECT MAX(position) max FROM note_blocks WHERE note_id=?').get(noteId) as any)?.max??-1)+1;
    this.transaction(()=>{this.snapshotNote(noteId,'用户新增内容前');this.db.prepare(`INSERT INTO note_blocks VALUES(?,?,?,?,?,1,1,NULL,?,?,?)`).run(id,noteId,section,content,'user',position,stamp,stamp);});
    return this.block(this.db.prepare('SELECT * FROM note_blocks WHERE id=?').get(id));
  }
  updateNoteBlock(id: string, content: string): NoteBlock | undefined {
    const row = this.db.prepare('SELECT * FROM note_blocks WHERE id=?').get(id) as any; if (!row) return undefined;
    this.snapshotNote(row.note_id, '用户编辑前');
    this.db.prepare('UPDATE note_blocks SET content=?,user_edited=1,locked=1,updated_at=? WHERE id=?').run(content,now(),id);
    return this.block(this.db.prepare('SELECT * FROM note_blocks WHERE id=?').get(id));
  }
  undoNote(noteId: string): boolean {
    const revision = this.db.prepare('SELECT * FROM note_revisions WHERE note_id=? ORDER BY rowid DESC LIMIT 1').get(noteId) as any; if (!revision) return false;
    const blocks = parseJson<any[]>(revision.snapshot);
    this.transaction(() => { this.db.prepare('DELETE FROM note_blocks WHERE note_id=?').run(noteId); for (const b of blocks) this.db.prepare('INSERT INTO note_blocks VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(b.id,b.note_id,b.section,b.content,b.source,b.user_edited,b.locked,b.qa_id,b.position,b.created_at,b.updated_at); this.db.prepare('DELETE FROM note_revisions WHERE id=?').run(revision.id); });
    return true;
  }

  listQa(sessionId: string): QaItem[] { return this.db.prepare('SELECT * FROM qa_items WHERE session_id=? ORDER BY created_at DESC').all(sessionId).map((r) => this.qa(r)); }
  getQa(id: string): QaItem | undefined { const row = this.db.prepare('SELECT * FROM qa_items WHERE id=?').get(id); return row ? this.qa(row) : undefined; }
  createQa(sessionId: string, source: string, question: string, normalized: string, possible = false): QaItem | undefined {
    const id = randomUUID(), stamp = now();
    try { this.db.prepare('INSERT INTO qa_items VALUES(?,?,?,?,?,?,?,?,\'none\',?,0,?,?)').run(id,sessionId,source,normalized,question,'','',json([]),Number(possible),stamp,stamp); return this.getQa(id); } catch { return undefined; }
  }
  updateQa(id: string, patch: Partial<{ question: string | undefined; answer: string | undefined; evidence: string | undefined; references: unknown[] | undefined; archived: boolean | undefined; status: string | undefined }>): QaItem | undefined {
    const row = this.db.prepare('SELECT * FROM qa_items WHERE id=?').get(id) as any; if (!row) return undefined;
    this.db.prepare('UPDATE qa_items SET question=?,answer=?,evidence=?,references_json=?,archived=?,status=?,updated_at=? WHERE id=?').run(patch.question ?? row.question,patch.answer ?? row.answer,patch.evidence ?? row.evidence,patch.references ? json(patch.references) : row.references_json,patch.archived === undefined ? row.archived : Number(patch.archived),patch.status ?? row.status,now(),id);
    const value = this.getQa(id)!; this.reindex('qa', id, value.sessionId, `${value.question}\n${value.answer}`); return value;
  }
  deleteQa(id: string): boolean { return this.db.prepare('DELETE FROM qa_items WHERE id=?').run(id).changes > 0; }

  addQaToNotes(qaId: string, target: 'full' | 'outline' | 'both'): QaItem {
    const qa = this.getQa(qaId); if (!qa) throw new Error('问答不存在');
    const notes = this.getNotes(qa.sessionId).filter((n) => target === 'both' || n.type === target);
    this.transaction(() => {
      for (const note of notes) {
        const exists = this.db.prepare('SELECT 1 FROM note_blocks WHERE note_id=? AND qa_id=?').get(note.id, qaId); if (exists) continue;
        const content = note.type === 'full' ? `问题：${qa.question}\n回答：${qa.answer}\n课堂依据：${qa.evidence || '课堂记录中未找到直接依据'}\nAI补充及待核实内容已在回答中标注。` : `- ${qa.question}\n  - ${qa.answer.split(/。|\n/)[0] || qa.answer}`;
        this.appendNoteBlocks(note.id, [{ section: note.type === 'full' ? '课堂问题和答案' : '复习问题', content, source: 'qa', qaId }]);
      }
      const status = target === 'both' ? 'both' : target;
      this.db.prepare('UPDATE qa_items SET status=?,updated_at=? WHERE id=?').run(status,now(),qaId);
    });
    return this.getQa(qaId)!;
  }
  removeQaFromNotes(qaId: string): QaItem {
    this.transaction(() => { this.db.prepare('DELETE FROM note_blocks WHERE qa_id=?').run(qaId); this.db.prepare(`UPDATE qa_items SET status='none',updated_at=? WHERE id=?`).run(now(),qaId); });
    return this.getQa(qaId)!;
  }

  addDocument(courseId: string | null, name: string, fileType: string, size: number, hash: string, chunks: { heading: string; content: string }[], originalPath: string | null = null) {
    if (this.db.prepare('SELECT 1 FROM imported_documents WHERE course_id IS ? AND hash=?').get(courseId,hash)) throw new Error('同一文件已导入，请勿重复导入');
    const id = randomUUID(), stamp = now();
    this.transaction(() => { this.db.prepare('INSERT INTO imported_documents(id,course_id,name,file_type,size,hash,original_path,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,courseId,name,fileType,size,hash,originalPath,stamp); chunks.forEach((chunk,i) => { const chunkId = randomUUID(); this.db.prepare('INSERT INTO document_chunks VALUES(?,?,?,?,?)').run(chunkId,id,chunk.heading,chunk.content,i); this.index('document',chunkId,courseId ?? '','',name,`${chunk.heading}\n${chunk.content}`); }); });
    return this.db.prepare('SELECT * FROM imported_documents WHERE id=?').get(id);
  }
  listDocuments() { return this.db.prepare('SELECT * FROM imported_documents ORDER BY created_at DESC').all(); }
  deleteDocument(id: string): boolean { const chunks = this.db.prepare('SELECT id FROM document_chunks WHERE document_id=?').all(id) as unknown as {id:string}[]; const document=this.db.prepare('SELECT original_path FROM imported_documents WHERE id=?').get(id) as {original_path:string|null}|undefined; this.transaction(() => { chunks.forEach((c) => this.db.prepare('DELETE FROM search_index WHERE source_id=?').run(c.id)); this.db.prepare('DELETE FROM imported_documents WHERE id=?').run(id); }); if(document?.original_path&&existsSync(document.original_path))unlinkSync(document.original_path); return Boolean(document); }

  search(query: string, sessionId?: string, courseId?: string) {
    const clean = query.trim().replace(/["']/g, ' '); if (!clean) return [];
    const rows = this.db.prepare('SELECT source_type,source_id,course_id,session_id,title,snippet(search_index,5,\'<mark>\',\'</mark>\',\'…\',24) snippet,bm25(search_index) rank FROM search_index WHERE search_index MATCH ? ORDER BY CASE WHEN session_id=? THEN 0 WHEN course_id=? THEN 1 ELSE 2 END,rank LIMIT 30').all(clean,sessionId ?? '',courseId ?? '') as any[];
    return rows.map((r) => ({ sourceType:r.source_type,sourceId:r.source_id,courseId:r.course_id,sessionId:r.session_id,title:r.title,snippet:r.snippet,relevance:-r.rank }));
  }
  context(sessionId: string, query: string, limit = 12000): { text: string; refs: string[] } {
    const session = this.getSession(sessionId); const results = this.search(query, sessionId, session?.courseId).slice(0, 12);
    let text = '', refs: string[] = [];
    for (const r of results) { const piece = `[${r.sourceType}｜${r.title}] ${r.snippet.replace(/<\/?mark>/g,'')}`; if (text.length + piece.length > limit) break; text += `${piece}\n`; refs.push(`${r.sourceType}:${r.sourceId}`); }
    if (!text) { const recent = this.listTranscripts(sessionId).slice(-20); text = recent.map((t) => `[${t.startedAt}] ${t.text}`).join('\n').slice(-limit); refs = recent.map((t) => `transcript:${t.id}`); }
    return { text, refs };
  }

  private index(type: string, id: string, courseId: string, sessionId: string, title: string, content: string) { this.db.prepare('INSERT INTO search_index VALUES(?,?,?,?,?,?)').run(type,id,courseId,sessionId,title,content); }
  private reindex(type: string, id: string, sessionId: string, content: string) { const session = this.getSession(sessionId); this.db.prepare('DELETE FROM search_index WHERE source_type=? AND source_id=?').run(type,id); this.index(type,id,session?.courseId ?? '',sessionId,type,content); }
}
