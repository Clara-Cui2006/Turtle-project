import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import type { ClassSession, Course, NoteBlock, NoteDocument, NoteDocumentV2, NoteNode, QaItem, RelevanceCategory, SessionInput, TranscriptSegment } from '@turtle/shared';

const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value);
const parseJson = <T>(value: string): T => JSON.parse(value) as T;

export class TurtleDatabase {
  readonly db: DatabaseSync;
  readonly databasePath: string;
  private transactionDepth = 0;

  constructor(dataDir: string, memory = false) {
    this.databasePath = memory ? ':memory:' : join(dataDir, 'turtle.db');
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.migrate(dataDir, memory);
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

  private migrate(dataDir: string, memory: boolean): void {
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
    const version = Number((this.db.prepare('SELECT MAX(version) version FROM schema_migrations').get() as {version:number|null}).version ?? 0);
    if (version < 2) {
      if (!memory && existsSync(this.databasePath)) {
        const backupDir = join(dataDir, 'backups'); mkdirSync(backupDir, { recursive: true });
        const target = join(backupDir, `turtle-pre-migration-v2-${new Date().toISOString().replace(/[:.]/g, '-')}.db`).replaceAll("'", "''");
        this.db.exec(`VACUUM INTO '${target}'`);
      }
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS transcript_relevance(
            segment_id TEXT PRIMARY KEY REFERENCES transcript_segments(id) ON DELETE CASCADE,
            category TEXT NOT NULL CHECK(category IN ('substantive_legal','course_context','small_talk','uncertain')),
            confidence REAL NOT NULL DEFAULT 0, rationale TEXT NOT NULL DEFAULT '', manual INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS note_documents_v2(
            id TEXT PRIMARY KEY, legacy_note_id TEXT UNIQUE REFERENCES note_documents(id) ON DELETE SET NULL,
            session_id TEXT NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE, type TEXT NOT NULL CHECK(type IN ('full','outline')),
            status TEXT NOT NULL DEFAULT 'waiting', version INTEGER NOT NULL DEFAULT 0, content_json TEXT NOT NULL DEFAULT '{"type":"doc","content":[]}', active_node_id TEXT,
            last_processed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(session_id,type)
          );
          CREATE TABLE IF NOT EXISTS note_nodes(
            id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES note_documents_v2(id) ON DELETE CASCADE, parent_id TEXT REFERENCES note_nodes(id) ON DELETE CASCADE,
            node_type TEXT NOT NULL, position INTEGER NOT NULL, heading_level INTEGER, content_json TEXT NOT NULL, text_content TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
            user_edited INTEGER NOT NULL DEFAULT 0, ai_managed INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS note_node_sources(node_id TEXT NOT NULL REFERENCES note_nodes(id) ON DELETE CASCADE, transcript_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE, PRIMARY KEY(node_id,transcript_id));
          CREATE TABLE IF NOT EXISTS note_revisions_v2(id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES note_documents_v2(id) ON DELETE CASCADE, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL, snapshot_json TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS note_patch_jobs(id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES note_documents_v2(id) ON DELETE CASCADE, kind TEXT NOT NULL, status TEXT NOT NULL, operations_json TEXT NOT NULL DEFAULT '[]', error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS note_suggestions(id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES note_documents_v2(id) ON DELETE CASCADE, target_node_id TEXT REFERENCES note_nodes(id) ON DELETE SET NULL, operation_json TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS qa_note_links(id TEXT PRIMARY KEY, qa_id TEXT NOT NULL REFERENCES qa_items(id) ON DELETE CASCADE, document_id TEXT NOT NULL REFERENCES note_documents_v2(id) ON DELETE CASCADE, node_id TEXT NOT NULL REFERENCES note_nodes(id) ON DELETE CASCADE, created_at TEXT NOT NULL, UNIQUE(qa_id,document_id));
          CREATE TABLE IF NOT EXISTS editor_assets(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE, filename TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL UNIQUE, alt_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS transcription_events(id TEXT PRIMARY KEY, session_id TEXT REFERENCES class_sessions(id) ON DELETE CASCADE, event_type TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', occurred_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS persistence_operations(id TEXT PRIMARY KEY, method TEXT NOT NULL, path TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS audio_recordings(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE, path TEXT NOT NULL, mime_type TEXT NOT NULL, duration_ms INTEGER, size INTEGER NOT NULL, created_at TEXT NOT NULL);
        `);
        const qaColumns=this.db.prepare('PRAGMA table_info(qa_items)').all() as unknown as {name:string}[];
        const addQa=(name:string,definition:string)=>{if(!qaColumns.some((column)=>column.name===name))this.db.exec(`ALTER TABLE qa_items ADD COLUMN ${name} ${definition}`);};
        addQa('completed_question',"TEXT NOT NULL DEFAULT ''"); addQa('question_type',"TEXT NOT NULL DEFAULT 'uncertain'"); addQa('is_legal','INTEGER'); addQa('confidence','REAL NOT NULL DEFAULT 0'); addQa('source_transcript_ids',"TEXT NOT NULL DEFAULT '[]'"); addQa('read_at','TEXT'); addQa('deleted_at','TEXT');
        this.migrateLegacyNotes();
        this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(2,?)').run(now());
        this.db.exec('PRAGMA user_version = 2');
      });
    }
  }

  private migrateLegacyNotes(): void {
    const legacy = this.db.prepare('SELECT * FROM note_documents ORDER BY created_at').all() as any[];
    for (const note of legacy) {
      let next = this.db.prepare('SELECT id FROM note_documents_v2 WHERE session_id=? AND type=?').get(note.session_id,note.type) as {id:string}|undefined;
      if (!next) {
        next={id:randomUUID()}; this.db.prepare('INSERT INTO note_documents_v2(id,legacy_note_id,session_id,type,status,version,content_json,last_processed_at,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?,?,?)').run(next.id,note.id,note.session_id,note.type,note.status,'{"type":"doc","content":[]}',note.last_processed_at,note.created_at,note.updated_at);
      }
      const hasNodes=this.db.prepare('SELECT 1 FROM note_nodes WHERE document_id=? LIMIT 1').get(next.id); if(hasNodes)continue;
      const blocks=this.db.prepare('SELECT * FROM note_blocks WHERE note_id=? ORDER BY position').all(note.id) as any[];
      const content:any[]=[];
      for(const [index,block] of blocks.entries()){
        const headingId=randomUUID(),paragraphId=block.id;
        this.db.prepare('INSERT INTO note_nodes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(headingId,next.id,null,'heading',index*2,2,json({type:'heading',attrs:{level:2,nodeId:headingId},content:[{type:'text',text:block.section}]}),block.section,'migration',block.user_edited,block.locked?0:1,1,block.created_at,block.updated_at);
        this.db.prepare('INSERT INTO note_nodes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(paragraphId,next.id,headingId,'paragraph',index*2+1,null,json({type:'paragraph',attrs:{nodeId:paragraphId},content:[{type:'text',text:block.content}]}),block.content,'migration',block.user_edited,block.locked?0:1,1,block.created_at,block.updated_at);
        content.push({type:'heading',attrs:{level:2,nodeId:headingId},content:[{type:'text',text:block.section}]},{type:'paragraph',attrs:{nodeId:paragraphId},content:[{type:'text',text:block.content}]});
      }
      this.db.prepare('UPDATE note_documents_v2 SET content_json=?,version=1 WHERE id=?').run(json({type:'doc',content}),next.id);
    }
  }

  private course(row: any): Course { return { id: row.id, name: row.name, description: row.description, teacher: row.teacher, tags: parseJson(row.tags), createdAt: row.created_at, updatedAt: row.updated_at }; }
  private session(row: any): ClassSession { return { id: row.id, courseId: row.course_id, name: row.name, date: row.date, startedAt: row.started_at, endedAt: row.ended_at, teacher: row.teacher, tags: parseJson(row.tags), remarks: row.remarks, legalTerms: row.legal_terms, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }; }
  private transcript(row: any): TranscriptSegment { return { id: row.id, sessionId: row.session_id, startedAt: row.started_at, endedAt: row.ended_at, originalText: row.original_text, text: row.text, isFinal: Boolean(row.is_final), userEdited: Boolean(row.user_edited), important: Boolean(row.important), ...(row.relevance_category?{relevance:row.relevance_category as RelevanceCategory,relevanceConfidence:Number(row.relevance_confidence),relevanceManual:Boolean(row.relevance_manual)}:{}), createdAt: row.created_at, updatedAt: row.updated_at }; }
  private block(row: any): NoteBlock { return { id: row.id, noteId: row.note_id, section: row.section, content: row.content, source: row.source, userEdited: Boolean(row.user_edited), locked: Boolean(row.locked), qaId: row.qa_id, position: row.position, createdAt: row.created_at, updatedAt: row.updated_at }; }
  private qa(row: any): QaItem { return { id: row.id, sessionId: row.session_id, source: row.source, question: row.question, completedQuestion: row.completed_question, questionType: row.question_type, isLegal: row.is_legal === null || row.is_legal === undefined ? null : Boolean(row.is_legal), confidence: row.confidence, answer: row.answer, evidence: row.evidence, references: row.references_json, status: row.status, possibleRhetorical: Boolean(row.possible_rhetorical), archived: Boolean(row.archived), readAt: row.read_at, deletedAt: row.deleted_at, createdAt: row.created_at, updatedAt: row.updated_at }; }

  listCourses(): Course[] { return this.db.prepare('SELECT * FROM courses ORDER BY updated_at DESC').all().map((r) => this.course(r)); }
  createCourse(input: { id?: string|undefined; name: string; description: string; teacher: string; tags: string[] }): Course {
    const id = input.id ?? randomUUID(), stamp = now();
    this.db.prepare('INSERT INTO courses VALUES(?,?,?,?,?,?,?)').run(id, input.name, input.description, input.teacher, json(input.tags), stamp, stamp);
    this.index('course',id,id,'',input.name,[input.description,input.teacher,...input.tags].join('\n'));
    return this.course(this.db.prepare('SELECT * FROM courses WHERE id=?').get(id));
  }
  updateCourse(id: string, patch: Record<string, unknown>): Course | undefined {
    const current = this.db.prepare('SELECT * FROM courses WHERE id=?').get(id) as any;
    if (!current) return undefined;
    const value = { name: patch.name ?? current.name, description: patch.description ?? current.description, teacher: patch.teacher ?? current.teacher, tags: patch.tags ? json(patch.tags) : current.tags };
    this.db.prepare('UPDATE courses SET name=?,description=?,teacher=?,tags=?,updated_at=? WHERE id=?').run(value.name, value.description, value.teacher, value.tags, now(), id);
    this.db.prepare(`DELETE FROM search_index WHERE source_type='course' AND source_id=?`).run(id);
    this.index('course',id,id,'',String(value.name),[value.description,value.teacher,value.tags].join('\n'));
    return this.course(this.db.prepare('SELECT * FROM courses WHERE id=?').get(id));
  }
  deleteCourse(id: string): boolean { this.db.prepare('DELETE FROM search_index WHERE course_id=?').run(id); return Number(this.db.prepare('DELETE FROM courses WHERE id=?').run(id).changes) > 0; }

  listSessions(courseId?: string): ClassSession[] {
    const rows = courseId ? this.db.prepare('SELECT * FROM class_sessions WHERE course_id=? ORDER BY date DESC,created_at DESC').all(courseId) : this.db.prepare('SELECT * FROM class_sessions ORDER BY date DESC,created_at DESC').all();
    return rows.map((r) => this.session(r));
  }
  createSession(input: SessionInput): ClassSession {
    const id = input.id ?? randomUUID(), stamp = now();
    this.transaction(() => {
      this.db.prepare(`INSERT INTO class_sessions(id,course_id,name,date,started_at,teacher,tags,remarks,legal_terms,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?)`).run(id, input.courseId, input.name, input.date, stamp, input.teacher, json(input.tags), input.remarks, input.legalTerms, stamp, stamp);
      for (const type of ['full', 'outline']) this.db.prepare('INSERT INTO note_documents VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, type, 'waiting', null, stamp, stamp);
      for (const type of ['full', 'outline']) this.db.prepare('INSERT INTO note_documents_v2(id,session_id,type,status,version,content_json,created_at,updated_at) VALUES(?,?,?,\'waiting\',0,\'{"type":"doc","content":[]}\',?,?)').run(randomUUID(),id,type,stamp,stamp);
      this.db.prepare(`INSERT INTO app_preferences(key,value,updated_at) VALUES('currentSessionId',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(id, stamp);
    });
    this.index('session',id,input.courseId,id,input.name,[input.date,input.teacher,...input.tags,input.remarks,input.legalTerms].join('\n'));
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
    this.db.prepare(`DELETE FROM search_index WHERE source_type='session' AND source_id=?`).run(id);
    this.index('session',id,current.course_id,id,String(next.name),[next.date,next.teacher,next.tags,next.remarks,next.legal_terms].join('\n'));
    return this.getSession(id);
  }
  deleteSession(id: string): boolean { this.db.prepare('DELETE FROM search_index WHERE session_id=?').run(id); return Number(this.db.prepare('DELETE FROM class_sessions WHERE id=?').run(id).changes) > 0; }
  currentSessionId(): string | null { return (this.db.prepare(`SELECT value FROM app_preferences WHERE key='currentSessionId'`).get() as any)?.value ?? null; }

  listTranscripts(sessionId: string): TranscriptSegment[] { return this.db.prepare('SELECT t.*,r.category relevance_category,r.confidence relevance_confidence,r.manual relevance_manual FROM transcript_segments t LEFT JOIN transcript_relevance r ON r.segment_id=t.id WHERE t.session_id=? ORDER BY t.started_at,t.created_at').all(sessionId).map((r) => this.transcript(r)); }
  addTranscript(sessionId: string, input: { startedAt: string; endedAt: string; text: string; clientResultId?: string | undefined }): TranscriptSegment {
    const duplicate = input.clientResultId && this.db.prepare('SELECT * FROM transcript_segments WHERE session_id=? AND client_result_id=?').get(sessionId, input.clientResultId);
    if (duplicate) return this.transcript(duplicate);
    const id = randomUUID(), stamp = now();
    this.transaction(() => {
      this.db.prepare('INSERT INTO transcript_segments VALUES(?,?,?,?,?,?,1,0,0,?,?,?)').run(id, sessionId, input.startedAt, input.endedAt, input.text, input.text, input.clientResultId ?? null, stamp, stamp);
      this.index('transcript', id, this.getSession(sessionId)?.courseId ?? '', sessionId, `转写 ${input.startedAt}`, input.text);
    });
    return this.transcript(this.db.prepare('SELECT t.*,r.category relevance_category,r.confidence relevance_confidence,r.manual relevance_manual FROM transcript_segments t LEFT JOIN transcript_relevance r ON r.segment_id=t.id WHERE t.id=?').get(id));
  }
  updateTranscript(id: string, patch: { text?: string | undefined; important?: boolean | undefined }): TranscriptSegment | undefined {
    const row = this.db.prepare('SELECT * FROM transcript_segments WHERE id=?').get(id) as any;
    if (!row) return undefined;
    const text = patch.text ?? row.text, edited = patch.text !== undefined ? 1 : row.user_edited, important = patch.important === undefined ? row.important : Number(patch.important);
    this.transaction(() => { this.db.prepare('UPDATE transcript_segments SET text=?,user_edited=?,important=?,updated_at=? WHERE id=?').run(text,edited,important,now(),id); this.reindex('transcript', id, row.session_id, text); });
    return this.transcript(this.db.prepare('SELECT t.*,r.category relevance_category,r.confidence relevance_confidence,r.manual relevance_manual FROM transcript_segments t LEFT JOIN transcript_relevance r ON r.segment_id=t.id WHERE t.id=?').get(id));
  }

  setTranscriptRelevance(id: string, category: RelevanceCategory, confidence: number, manual: boolean, rationale = ''): TranscriptSegment | undefined {
    const segment=this.db.prepare('SELECT * FROM transcript_segments WHERE id=?').get(id) as any; if(!segment)return undefined;
    const current=this.db.prepare('SELECT manual FROM transcript_relevance WHERE segment_id=?').get(id) as {manual:number}|undefined;
    if(current?.manual&&!manual)return this.listTranscripts(segment.session_id).find((item)=>item.id===id);
    this.db.prepare('INSERT INTO transcript_relevance(segment_id,category,confidence,rationale,manual,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(segment_id) DO UPDATE SET category=excluded.category,confidence=excluded.confidence,rationale=excluded.rationale,manual=excluded.manual,updated_at=excluded.updated_at').run(id,category,confidence,rationale,Number(manual),now());
    return this.listTranscripts(segment.session_id).find((item)=>item.id===id);
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

  private node(row: any): NoteNode { return { id:row.id,documentId:row.document_id,parentId:row.parent_id,type:row.node_type,position:row.position,headingLevel:row.heading_level,content:parseJson(row.content_json),textContent:row.text_content,source:row.source,userEdited:Boolean(row.user_edited),aiManaged:Boolean(row.ai_managed),version:row.version,createdAt:row.created_at,updatedAt:row.updated_at,sourceTranscriptIds:(this.db.prepare('SELECT transcript_id FROM note_node_sources WHERE node_id=?').all(row.id) as any[]).map((item)=>item.transcript_id) }; }
  private textFromContent(value: any): string { if(!value)return''; if(typeof value.text==='string')return value.text; return Array.isArray(value.content)?value.content.map((item:any)=>this.textFromContent(item)).join(value.type==='doc'?'\n':''):''; }
  private rebuildDocument(documentId:string): void { const content=(this.db.prepare('SELECT content_json FROM note_nodes WHERE document_id=? ORDER BY position,id').all(documentId) as any[]).map((row)=>parseJson(row.content_json)); this.db.prepare('UPDATE note_documents_v2 SET content_json=?,updated_at=? WHERE id=?').run(json({type:'doc',content}),now(),documentId); }
  private snapshotDocument(documentId:string,reason:string,nextVersion:number): void {
    const document=this.db.prepare('SELECT * FROM note_documents_v2 WHERE id=?').get(documentId); const nodes=this.db.prepare('SELECT * FROM note_nodes WHERE document_id=? ORDER BY position').all(documentId); const sources=this.db.prepare('SELECT s.* FROM note_node_sources s JOIN note_nodes n ON n.id=s.node_id WHERE n.document_id=?').all(documentId);
    this.db.prepare('INSERT INTO note_revisions_v2 VALUES(?,?,?,?,?,?,?)').run(randomUUID(),documentId,nextVersion-1,nextVersion,json({document,nodes,sources}),reason,now());
  }
  getNoteDocuments(sessionId:string): NoteDocumentV2[] { return (this.db.prepare('SELECT * FROM note_documents_v2 WHERE session_id=? ORDER BY type').all(sessionId) as any[]).map((document)=>this.getNoteDocument(document.id)!).filter(Boolean); }
  getNoteDocument(id:string): NoteDocumentV2|undefined { const row=this.db.prepare('SELECT * FROM note_documents_v2 WHERE id=?').get(id) as any;if(!row)return undefined;return{id:row.id,sessionId:row.session_id,type:row.type,status:row.status,version:row.version,content:parseJson(row.content_json),nodes:(this.db.prepare('SELECT * FROM note_nodes WHERE document_id=? ORDER BY position,id').all(id) as any[]).map((item)=>this.node(item)),pendingSuggestions:Number((this.db.prepare("SELECT COUNT(*) count FROM note_suggestions WHERE document_id=? AND status='pending'").get(id) as any).count),updatedAt:row.updated_at}; }
  saveNoteDocument(id:string,baseVersion:number,content:any,activeNodeId?:string|null):NoteDocumentV2 {
    const current=this.getNoteDocument(id);if(!current)throw new Error('笔记文档不存在');if(current.version!==baseVersion)throw new Error('笔记已在其他位置更新，请重新载入后合并');
    const blocks=Array.isArray(content?.content)?content.content:[]; const nextVersion=baseVersion+1;
    this.transaction(()=>{this.snapshotDocument(id,'用户编辑前',nextVersion);const previous=new Map(current.nodes.map((node)=>[node.id,node]));this.db.prepare('DELETE FROM note_nodes WHERE document_id=?').run(id);
      let parentId:string|null=null;
      blocks.forEach((block:any,position:number)=>{const nodeId=typeof block?.attrs?.nodeId==='string'?block.attrs.nodeId:randomUUID();if(block.type==='heading')parentId=null;const type=block.type==='heading'?'heading':block.type==='table'?'table':block.type==='image'?'image':block.type==='blockquote'?'blockquote':block.type==='bulletList'?'bulletList':block.type==='orderedList'?'orderedList':block.type==='horizontalRule'?'horizontalRule':'paragraph';const old=previous.get(nodeId);const stamp=now();this.db.prepare('INSERT INTO note_nodes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(nodeId,id,parentId,type,position,block.type==='heading'?Number(block.attrs?.level??2):null,json({...block,attrs:{...(block.attrs??{}),nodeId}}),this.textFromContent(block),old?.source??'user',1,0,(old?.version??0)+1,old?.createdAt??stamp,stamp);if(block.type==='heading')parentId=nodeId;});
      this.db.prepare('UPDATE note_documents_v2 SET content_json=?,active_node_id=?,version=?,status=\'complete\',updated_at=? WHERE id=?').run(json({type:'doc',content:blocks.map((block:any,index:number)=>({...block,attrs:{...(block.attrs??{}),nodeId:(this.db.prepare('SELECT id FROM note_nodes WHERE document_id=? AND position=?').get(id,index) as any).id}}))}),activeNodeId??null,nextVersion,now(),id);
    });return this.getNoteDocument(id)!;
  }
  applyNotePatch(id:string,baseVersion:number,reason:string,operations:any[]):NoteDocumentV2 {
    const current=this.getNoteDocument(id);if(!current)throw new Error('笔记文档不存在');if(current.version!==baseVersion)throw new Error('文档版本冲突，修订未应用');const nextVersion=baseVersion+1;
    this.transaction(()=>{this.snapshotDocument(id,reason,nextVersion);const find=(nodeId:string)=>this.db.prepare('SELECT * FROM note_nodes WHERE id=? AND document_id=?').get(nodeId,id) as any;const suggest=(target:any,operation:any)=>this.db.prepare('INSERT INTO note_suggestions VALUES(?,?,?,?,?,\'pending\',?,?)').run(randomUUID(),id,target?.id??null,json(operation),'目标包含用户编辑，未静默覆盖',now(),now());const insert=(node:any,parentId:string|null,position:number,source='ai')=>{const nodeId=node.id??randomUUID(),stamp=now(),content=node.content??{type:node.type==='heading'?'heading':'paragraph',attrs:{level:node.headingLevel??2},content:[]};this.db.prepare('INSERT INTO note_nodes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(nodeId,id,parentId,node.type,position,node.headingLevel??null,json({...content,attrs:{...(content.attrs??{}),nodeId}}),this.textFromContent(content),source,0,1,1,stamp,stamp);for(const transcriptId of node.sourceTranscriptIds??[])if(this.db.prepare('SELECT 1 FROM transcript_segments WHERE id=?').get(transcriptId))this.db.prepare('INSERT OR IGNORE INTO note_node_sources VALUES(?,?)').run(nodeId,transcriptId);return nodeId;};
      for(const operation of operations){
        if(operation.op==='insertNode')insert(operation.node,operation.node.parentId??null,operation.node.position??999999);
        else if(operation.op==='createSection'){let position=999999;if(operation.afterNodeId){const target=find(operation.afterNodeId);if(!target)throw new Error('目标节点不存在');position=target.position+1;}insert({type:'heading',headingLevel:operation.headingLevel,content:{type:'heading',attrs:{level:operation.headingLevel},content:[{type:'text',text:operation.title}]},sourceTranscriptIds:operation.sourceTranscriptIds},operation.parentId??null,position);if(operation.content)insert({type:'paragraph',content:operation.content,sourceTranscriptIds:operation.sourceTranscriptIds},null,position+1);}
        else {const target=find(operation.nodeId??operation.targetNodeId??operation.nodeIds?.[0]);if(!target)throw new Error('目标节点不存在');if(target.user_edited&&operation.op!=='insertAfter'&&operation.op!=='insertBefore'){suggest(target,operation);continue;}
          if(operation.op==='updateNode'){const content=operation.content??parseJson(target.content_json);this.db.prepare('UPDATE note_nodes SET content_json=?,text_content=?,heading_level=COALESCE(?,heading_level),version=version+1,updated_at=? WHERE id=?').run(json(content),this.textFromContent(content),operation.headingLevel??null,now(),target.id);}
          else if(operation.op==='insertAfter'||operation.op==='insertBefore')insert(operation.node,target.parent_id,target.position+(operation.op==='insertAfter'?0.5:-0.5));
          else if(operation.op==='moveNode'){if(operation.parentId===target.id)throw new Error('节点不能成为自己的父节点');let cursor=operation.parentId;while(cursor){if(cursor===target.id)throw new Error('节点移动会形成循环');cursor=(find(cursor) as any)?.parent_id??null;}this.db.prepare('UPDATE note_nodes SET parent_id=?,position=?,version=version+1,updated_at=? WHERE id=?').run(operation.parentId,operation.position,now(),target.id);}
          else if(operation.op==='mergeNodes'){const rows=operation.nodeIds.map(find);if(rows.some((row:any)=>!row))throw new Error('合并节点不存在');if(rows.some((row:any)=>row.user_edited)){suggest(rows.find((row:any)=>row.user_edited),operation);continue;}this.db.prepare('UPDATE note_nodes SET content_json=?,text_content=?,version=version+1,updated_at=? WHERE id=?').run(json(operation.content),this.textFromContent(operation.content),now(),rows[0].id);for(const row of rows.slice(1))this.db.prepare('DELETE FROM note_nodes WHERE id=?').run(row.id);}
          else if(operation.op==='splitNode'){this.db.prepare('DELETE FROM note_nodes WHERE id=?').run(target.id);operation.parts.forEach((part:any,index:number)=>insert({type:target.node_type,headingLevel:target.heading_level,content:part},target.parent_id,target.position+index/10));}
          else if(operation.op==='convertToTable'||operation.op==='updateTable'){const rows=operation.nodeIds.map(find);if(rows.some((row:any)=>row?.user_edited)){suggest(rows.find((row:any)=>row?.user_edited),operation);continue;}this.db.prepare('UPDATE note_nodes SET node_type=\'table\',content_json=?,text_content=?,version=version+1,updated_at=? WHERE id=?').run(json(operation.table),this.textFromContent(operation.table),now(),target.id);for(const row of rows.slice(1))if(row)this.db.prepare('DELETE FROM note_nodes WHERE id=?').run(row.id);}
          else insert({type:'paragraph',content:operation.content,sourceTranscriptIds:operation.sourceTranscriptIds},target.id,target.position+0.1);
        }
      }
      const ordered=this.db.prepare('SELECT id FROM note_nodes WHERE document_id=? ORDER BY position,id').all(id) as any[];ordered.forEach((row,index)=>this.db.prepare('UPDATE note_nodes SET position=? WHERE id=?').run(index,row.id));this.rebuildDocument(id);this.db.prepare('UPDATE note_documents_v2 SET version=?,status=\'complete\',updated_at=? WHERE id=?').run(nextVersion,now(),id);
    });return this.getNoteDocument(id)!;
  }
  undoNoteDocument(id:string):NoteDocumentV2|undefined { const revision=this.db.prepare('SELECT * FROM note_revisions_v2 WHERE document_id=? ORDER BY created_at DESC LIMIT 1').get(id) as any;if(!revision)return undefined;const snapshot=parseJson<any>(revision.snapshot_json);this.transaction(()=>{this.db.prepare('DELETE FROM note_nodes WHERE document_id=?').run(id);for(const row of snapshot.nodes)this.db.prepare('INSERT INTO note_nodes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.document_id,row.parent_id,row.node_type,row.position,row.heading_level,row.content_json,row.text_content,row.source,row.user_edited,row.ai_managed,row.version,row.created_at,row.updated_at);for(const source of snapshot.sources)this.db.prepare('INSERT INTO note_node_sources VALUES(?,?)').run(source.node_id,source.transcript_id);const document=snapshot.document;this.db.prepare('UPDATE note_documents_v2 SET status=?,version=?,content_json=?,active_node_id=?,last_processed_at=?,updated_at=? WHERE id=?').run(document.status,document.version,document.content_json,document.active_node_id,document.last_processed_at,now(),id);this.db.prepare('DELETE FROM note_revisions_v2 WHERE id=?').run(revision.id);});return this.getNoteDocument(id); }

  addTranscriptionEvent(sessionId:string|null,eventType:string,detail:string,occurredAt=now()):void { this.db.prepare('INSERT INTO transcription_events VALUES(?,?,?,?,?)').run(randomUUID(),sessionId,eventType,detail.slice(0,1000),occurredAt); }
  listTranscriptionEvents(sessionId?:string,limit=100){return sessionId?this.db.prepare('SELECT * FROM transcription_events WHERE session_id=? ORDER BY occurred_at DESC LIMIT ?').all(sessionId,limit):this.db.prepare('SELECT * FROM transcription_events ORDER BY occurred_at DESC LIMIT ?').all(limit);}
  getPersistenceOperation(id:string):unknown|undefined{const row=this.db.prepare('SELECT response_json FROM persistence_operations WHERE id=?').get(id) as {response_json:string}|undefined;return row?parseJson(row.response_json):undefined;}
  savePersistenceOperation(id:string,method:string,path:string,response:unknown):void{this.db.prepare('INSERT OR IGNORE INTO persistence_operations VALUES(?,?,?,?,?)').run(id,method,path,json(response),now());}

  listQa(sessionId: string): QaItem[] { return this.db.prepare('SELECT * FROM qa_items WHERE session_id=? AND deleted_at IS NULL ORDER BY created_at DESC').all(sessionId).map((r) => this.qa(r)); }
  getQa(id: string): QaItem | undefined { const row = this.db.prepare('SELECT * FROM qa_items WHERE id=?').get(id); return row ? this.qa(row) : undefined; }
  createQa(sessionId: string, source: string, question: string, normalized: string, possible = false, isLegal:boolean|null=null,questionType='uncertain',confidence=0): QaItem | undefined {
    const id = randomUUID(), stamp = now();
    try { this.db.prepare('INSERT INTO qa_items(id,session_id,source,normalized_question,question,answer,evidence,references_json,status,possible_rhetorical,archived,created_at,updated_at,completed_question,question_type,is_legal,confidence,source_transcript_ids) VALUES(?,?,?,?,?,?,?,?,\'none\',?,0,?,?,?,?,?,?,?)').run(id,sessionId,source,normalized,question,'','',json([]),Number(possible),stamp,stamp,question,questionType,isLegal===null?null:Number(isLegal),confidence,json([])); return this.getQa(id); } catch { return undefined; }
  }
  updateQa(id: string, patch: Partial<{ question: string | undefined; answer: string | undefined; evidence: string | undefined; references: unknown[] | undefined; archived: boolean | undefined; status: string | undefined }>): QaItem | undefined {
    const row = this.db.prepare('SELECT * FROM qa_items WHERE id=?').get(id) as any; if (!row) return undefined;
    this.db.prepare('UPDATE qa_items SET question=?,answer=?,evidence=?,references_json=?,archived=?,status=?,updated_at=? WHERE id=?').run(patch.question ?? row.question,patch.answer ?? row.answer,patch.evidence ?? row.evidence,patch.references ? json(patch.references) : row.references_json,patch.archived === undefined ? row.archived : Number(patch.archived),patch.status ?? row.status,now(),id);
    const value = this.getQa(id)!; this.reindex('qa', id, value.sessionId, `${value.question}\n${value.answer}`); return value;
  }
  markQaRead(id: string): QaItem | undefined { this.db.prepare('UPDATE qa_items SET read_at=COALESCE(read_at,?),updated_at=? WHERE id=? AND deleted_at IS NULL').run(now(),now(),id); return this.getQa(id); }
  deleteQa(id: string): boolean { return this.db.prepare('UPDATE qa_items SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL').run(now(),now(),id).changes > 0; }

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
    this.transaction(() => { this.db.prepare('DELETE FROM note_blocks WHERE qa_id=?').run(qaId);const links=this.db.prepare('SELECT * FROM qa_note_links WHERE qa_id=?').all(qaId) as any[];for(const link of links)this.db.prepare('DELETE FROM note_nodes WHERE id=?').run(link.node_id);this.db.prepare('DELETE FROM qa_note_links WHERE qa_id=?').run(qaId);for(const documentId of new Set(links.map((link)=>link.document_id)))this.rebuildDocument(String(documentId));this.db.prepare(`UPDATE qa_items SET status='none',updated_at=? WHERE id=?`).run(now(),qaId); });
    return this.getQa(qaId)!;
  }

  insertQaIntoDocuments(qaId:string,target:'full'|'outline'|'both',targetNodeId?:string|null):QaItem {
    const qa=this.getQa(qaId);if(!qa)throw new Error('问答不存在');const documents=this.getNoteDocuments(qa.sessionId).filter((document)=>target==='both'||document.type===target);
    for(const document of documents){if(this.db.prepare('SELECT 1 FROM qa_note_links WHERE qa_id=? AND document_id=?').get(qaId,document.id))continue;const anchor=targetNodeId?document.nodes.find((node)=>node.id===targetNodeId):document.nodes.at(-1);const content=document.type==='full'?`问题：${qa.question}\n回答：${qa.answer}\n课堂依据：${qa.evidence||'课堂记录中未找到直接依据'}`:`复习问题：${qa.question}\n核心答案：${qa.answer.split(/。|\n/)[0]??qa.answer}`;const nodeId=randomUUID();const operation=anchor?{op:'insertAfter',targetNodeId:anchor.id,node:{id:nodeId,type:'qa',content:{type:'blockquote',attrs:{nodeId},content:[{type:'paragraph',content:[{type:'text',text:content}]}]},sourceTranscriptIds:[]}}:{op:'insertNode',node:{id:nodeId,parentId:null,type:'qa',position:0,content:{type:'blockquote',attrs:{nodeId},content:[{type:'paragraph',content:[{type:'text',text:content}]}]},sourceTranscriptIds:[]}};this.applyNotePatch(document.id,document.version,'插入课堂问答',[operation]);this.db.prepare('INSERT INTO qa_note_links VALUES(?,?,?,?,?)').run(randomUUID(),qaId,document.id,nodeId,now());}
    this.db.prepare('UPDATE qa_items SET status=?,updated_at=? WHERE id=?').run(target,now(),qaId);return this.getQa(qaId)!;
  }

  addEditorAsset(input:{id?:string;sessionId:string;filename:string;mimeType:string;size:number;path:string;altText:string}){const id=input.id??randomUUID();this.db.prepare('INSERT INTO editor_assets VALUES(?,?,?,?,?,?,?,?)').run(id,input.sessionId,input.filename,input.mimeType,input.size,input.path,input.altText,now());return this.getEditorAsset(id);}
  getEditorAsset(id:string){return this.db.prepare('SELECT * FROM editor_assets WHERE id=?').get(id) as any;}
  deleteEditorAsset(id:string):any{const asset=this.getEditorAsset(id);if(asset)this.db.prepare('DELETE FROM editor_assets WHERE id=?').run(id);return asset;}
  addAudioRecording(sessionId:string,path:string,mimeType:string,size:number,durationMs?:number){const id=randomUUID();this.db.prepare('INSERT INTO audio_recordings VALUES(?,?,?,?,?,?,?)').run(id,sessionId,path,mimeType,durationMs??null,size,now());return{id,sessionId,path,mimeType,size,durationMs:durationMs??null};}
  listAudioRecordings(sessionId:string){return this.db.prepare('SELECT id,session_id,mime_type,duration_ms,size,created_at FROM audio_recordings WHERE session_id=? ORDER BY created_at').all(sessionId).map((row:any)=>({id:row.id,sessionId:row.session_id,mimeType:row.mime_type,durationMs:row.duration_ms,size:row.size,createdAt:row.created_at}));}
  getAudioRecording(id:string){return this.db.prepare('SELECT * FROM audio_recordings WHERE id=?').get(id) as any;}
  deleteAudioRecording(id:string){const row=this.getAudioRecording(id);if(!row)return undefined;this.db.prepare('DELETE FROM audio_recordings WHERE id=?').run(id);return row;}

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
    const match=`"${clean.replaceAll('"','""')}"`;
    const rows = this.db.prepare('SELECT source_type,source_id,course_id,session_id,title,snippet(search_index,5,\'<mark>\',\'</mark>\',\'…\',24) snippet,bm25(search_index) rank FROM search_index WHERE search_index MATCH ? ORDER BY CASE WHEN session_id=? THEN 0 WHEN course_id=? THEN 1 ELSE 2 END,rank LIMIT 30').all(match,sessionId ?? '',courseId ?? '') as any[];
    return rows.map((r) => ({ sourceType:r.source_type,sourceId:r.source_id,courseId:r.course_id,sessionId:r.session_id,title:r.title,snippet:r.snippet,relevance:-r.rank }));
  }
  context(sessionId: string, query: string, limit = 12000, includeHistory = true): { text: string; refs: string[] } {
    const session = this.getSession(sessionId); const results = this.search(query, sessionId, session?.courseId).filter((item)=>includeHistory||item.sessionId===sessionId).slice(0, 12);
    let text = '', refs: string[] = [];
    for (const r of results) { const piece = `[${r.sourceType}｜${r.title}] ${r.snippet.replace(/<\/?mark>/g,'')}`; if (text.length + piece.length > limit) break; text += `${piece}\n`; refs.push(`${r.sourceType}:${r.sourceId}`); }
    if (!text) { const recent = this.listTranscripts(sessionId).slice(-20); text = recent.map((t) => `[${t.startedAt}] ${t.text}`).join('\n').slice(-limit); refs = recent.map((t) => `transcript:${t.id}`); }
    return { text, refs };
  }

  private index(type: string, id: string, courseId: string, sessionId: string, title: string, content: string) { this.db.prepare('INSERT INTO search_index VALUES(?,?,?,?,?,?)').run(type,id,courseId,sessionId,title,content); }
  private reindex(type: string, id: string, sessionId: string, content: string) { const session = this.getSession(sessionId); this.db.prepare('DELETE FROM search_index WHERE source_type=? AND source_id=?').run(type,id); this.index(type,id,session?.courseId ?? '',sessionId,type,content); }
}
