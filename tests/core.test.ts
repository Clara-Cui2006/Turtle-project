import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, HeadingLevel, Packer, Paragraph } from 'docx';
import request from 'supertest';
import { DEFAULT_SETTINGS, maskApiKey, normalizeQuestion, questionCandidate } from '@turtle/shared';
import { createApp } from '../apps/server/src/app.js';
import { TurtleDatabase } from '../apps/server/src/database.js';
import { exportSession, parseImport } from '../apps/server/src/files.js';
import { ClassroomServices } from '../apps/server/src/services.js';
import { SettingsStore } from '../apps/server/src/settings.js';
import type { CompletionOptions, LlmProvider } from '../apps/server/src/ai.js';
import { BrowserTranscriptionProvider, type RecognitionLike, type SpeechStatus } from '../apps/web/src/speech.js';

class MockLlm implements LlmProvider {
  calls: CompletionOptions[] = [];
  async complete(options: CompletionOptions): Promise<string> {
    this.calls.push(options);
    if (options.system.includes('blocks')) return JSON.stringify({ blocks: [{ section: options.system.includes('考试复习提纲') ? '一级知识点' : '老师讲授内容', content: options.system.includes('考试复习提纲') ? '- 行政行为的合法性' : '老师说明了行政行为合法性的判断方法。' }] });
    return JSON.stringify({ answer: '当前课堂依据：应审查行政行为的合法性。\nAI一般知识补充：无。', evidence: '课堂转写 10:00', references: ['课堂转写'] });
  }
}

let directory = '';
let db: TurtleDatabase;
let settings: SettingsStore;
let llm: MockLlm;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'turtle-test-'));
  process.env.TURTLE_DATA_DIR = directory;
  db = new TurtleDatabase(directory, true);
  settings = new SettingsStore(directory);
  llm = new MockLlm();
});

afterEach(() => {
  db.close(); delete process.env.TURTLE_DATA_DIR;
  if (directory.startsWith(tmpdir())) rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

function seed() {
  const course = db.createCourse({ name: '行政诉讼法', description: '测试课程', teacher: '张老师', tags: ['法学'] });
  const session = db.createSession({ courseId: course.id, name: '第三讲', date: '2026-09-18', teacher: '张老师', tags: ['行政行为'], remarks: '', legalTerms: '行政行为' });
  return { course, session };
}

describe('本地规则与设置安全', () => {
  it('识别完整问题、过滤口头禅并规范化去重键', () => {
    expect(questionCandidate('行政行为为什么必须符合法律规定？')).toBe(true);
    expect(questionCandidate('对不对？')).toBe(false);
    expect(normalizeQuestion(' 什么是 行政行为？？ ')).toBe('什么是行政行为');
  });

  it('保存 Key 但读取接口只返回脱敏结果，清除后本地设置仍存在', () => {
    settings.save({ ...DEFAULT_SETTINGS, apiKey: 'unit-test-secret-value' });
    const visible = settings.getPublic();
    expect(visible.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(visible)).not.toContain('unit-test-secret-value');
    expect(maskApiKey('unit-test-secret-value')).toMatch(/\*{4}/);
    expect(readFileSync(settings.file,'utf8')).toContain('unit-test-secret-value');
    settings.clearKey();
    expect(settings.getPublic().apiKeyConfigured).toBe(false);
    expect(settings.getPrivate().noteModel).toBe(DEFAULT_SETTINGS.noteModel);
  });
});

describe('SQLite 持久化、笔记与问答', () => {
  it('完成课程、课堂、转写 CRUD 和 FTS5 检索', () => {
    const { course, session } = seed();
    expect(db.updateCourse(course.id,{ name:'行政法专题' })?.name).toBe('行政法专题');
    expect(db.updateSession(session.id,{ remarks:'重点课' })?.remarks).toBe('重点课');
    const transcript = db.addTranscript(session.id,{ startedAt:'2026-09-18T10:00:00',endedAt:'2026-09-18T10:00:03',text:'行政行为合法性审查',clientResultId:'result-1' });
    expect(db.addTranscript(session.id,{ startedAt:'2026-09-18T10:00:00',endedAt:'2026-09-18T10:00:03',text:'重复文本',clientResultId:'result-1' }).id).toBe(transcript.id);
    expect(db.updateTranscript(transcript.id,{ text:'行政行为的合法性审查',important:true })?.userEdited).toBe(true);
    expect(db.search('行政行为',session.id,course.id)[0]?.sourceType).toBe('transcript');
    expect(db.listTranscripts(session.id)).toHaveLength(1);
  });

  it('双版本笔记独立增量更新、锁定用户编辑、保留修订并可撤销', async () => {
    const { session } = seed();
    settings.save({ ...DEFAULT_SETTINGS, apiKey:'unit-key', noteTriggerChars:100 });
    db.addTranscript(session.id,{ startedAt:'2026-09-18T10:00:00',endedAt:'2026-09-18T10:00:03',text:'行政行为为什么必须符合法律规定？'.repeat(5) });
    const service = new ClassroomServices(db,settings,llm);
    const notes = await service.updateNotes(session.id,true);
    expect(notes.find((n)=>n.type==='full')?.blocks[0]?.section).toBe('老师讲授内容');
    expect(notes.find((n)=>n.type==='outline')?.blocks[0]?.section).toBe('一级知识点');
    const block = notes[0]!.blocks[0]!; db.updateNoteBlock(block.id,'用户自己的笔记');
    db.appendNoteBlocks(notes[0]!.id,[{section:'建议补充',content:'新内容'}]);
    expect(db.getNotes(session.id)[0]?.blocks.find((b)=>b.id===block.id)?.locked).toBe(true);
    expect(db.undoNote(notes[0]!.id)).toBe(true);
    expect(db.getNotes(session.id)[0]?.blocks.some((b)=>b.content==='用户自己的笔记')).toBe(true);
  });

  it('字数与时间触发会防抖，并发调用不重复处理同一转写', async () => {
    vi.useFakeTimers(); const {session}=seed(); settings.save({...DEFAULT_SETTINGS,apiKey:'unit-key',noteTriggerChars:100,noteIntervalSeconds:10});
    const service=new ClassroomServices(db,settings,llm);
    db.addTranscript(session.id,{startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),text:'法学课堂内容'.repeat(25)});
    service.scheduleNotes(session.id);service.scheduleNotes(session.id);
    await vi.advanceTimersByTimeAsync(799);expect(llm.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);expect(llm.calls).toHaveLength(2);
    vi.advanceTimersByTime(1);db.addTranscript(session.id,{startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),text:'新的最终转写'.repeat(20)});
    await Promise.all([service.updateNotes(session.id,true),service.updateNotes(session.id,true)]);
    expect(llm.calls).toHaveLength(4);
    vi.advanceTimersByTime(1);db.addTranscript(session.id,{startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),text:'短内容'});
    service.scheduleNotes(session.id);await vi.advanceTimersByTimeAsync(9_999);expect(llm.calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);expect(llm.calls).toHaveLength(6);
  });

  it('AI 失败保留待处理内容并标记失败，稍后可重试', async () => {
    const {session}=seed();settings.save({...DEFAULT_SETTINGS,apiKey:'unit-key'});db.addTranscript(session.id,{startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),text:'应当保留的待处理课堂内容'});
    const failing: LlmProvider={complete:async()=>{throw new Error('模拟网络故障');}};
    await expect(new ClassroomServices(db,settings,failing).updateNotes(session.id,true)).rejects.toThrow('模拟网络故障');
    expect(db.getNotes(session.id).every((note)=>note.lastProcessedAt===null&&note.status==='failed')).toBe(true);
    await new ClassroomServices(db,settings,llm).updateNotes(session.id,true);
    expect(db.getNotes(session.id).every((note)=>note.blocks.length===1&&note.lastProcessedAt!==null)).toBe(true);
  });

  it('自动问题去重，答案默认不入笔记，可分别加入和移除', async () => {
    const { session } = seed(); settings.save({ ...DEFAULT_SETTINGS, apiKey:'unit-key' });
    db.addTranscript(session.id,{startedAt:'2026-09-18T10:00:00',endedAt:'2026-09-18T10:00:03',text:'行政行为为什么必须合法？'});
    const service = new ClassroomServices(db,settings,llm);
    await service.detectAndAnswer(session.id,'行政行为为什么必须合法？');
    await service.detectAndAnswer(session.id,'行政行为为什么必须合法？');
    const item = db.listQa(session.id)[0]!;
    expect(db.listQa(session.id)).toHaveLength(1); expect(item.status).toBe('none');
    db.addQaToNotes(item.id,'both');
    expect(db.getQa(item.id)?.status).toBe('both');
    expect(db.getNotes(session.id).every((n)=>n.blocks.some((b)=>b.qaId===item.id))).toBe(true);
    db.addQaToNotes(item.id,'both');
    expect(db.getNotes(session.id).flatMap((n)=>n.blocks).filter((b)=>b.qaId===item.id)).toHaveLength(2);
    db.removeQaFromNotes(item.id);
    expect(db.getQa(item.id)?.answer).toContain('合法性'); expect(db.getQa(item.id)?.status).toBe('none');
  });
});

describe('导入与导出', () => {
  it('导入 TXT、Markdown 和 DOCX，拒绝 DOC、超大文件和重复文件', async () => {
    expect((await parseImport('资料.txt',Buffer.from('第一段\n\n第二段'))).chunks).toHaveLength(2);
    expect((await parseImport('资料.md',Buffer.from('# 标题\n\n正文'))).chunks[0]?.heading).toBe('标题');
    const word = await Packer.toBuffer(new Document({sections:[{children:[new Paragraph({text:'行政诉讼',heading:HeadingLevel.HEADING_1}),new Paragraph('正文内容')]}]}));
    const parsed = await parseImport('资料.docx',word); expect(parsed.chunks[0]?.heading).toBe('行政诉讼');
    await expect(parseImport('旧文档.doc',Buffer.from('x'))).rejects.toThrow('当前版本支持 `.docx`');
    await expect(parseImport('太大.txt',Buffer.alloc(10*1024*1024+1))).rejects.toThrow('10MB');
    const { course }=seed(); db.addDocument(course.id,'资料','txt',2,'hash',[{heading:'',content:'内容'}]);
    expect(()=>db.addDocument(course.id,'重复','txt',2,'hash',[{heading:'',content:'内容'}])).toThrow('重复');
  });

  it('导出中文 DOCX/Markdown/TXT，正文完整且不包含 Key', async () => {
    const {session}=seed(); db.addTranscript(session.id,{startedAt:'2026-09-18T10:00:00',endedAt:'2026-09-18T10:00:03',text:'课堂正文'});
    const note=db.getNotes(session.id)[0]!; db.appendNoteBlocks(note.id,[{section:'本节主题',content:'行政行为'}]);
    for (const format of ['docx','md','txt'] as const) {
      const file=await exportSession(db,session.id,format,'package'); expect(file.filename).toContain('行政诉讼法'); expect(file.buffer.length).toBeGreaterThan(30); expect(file.buffer.toString()).not.toContain('unit-test-secret-value');
      if(format==='docx') expect(file.buffer.subarray(0,2).toString()).toBe('PK'); else expect(file.buffer.toString('utf8')).toContain('课堂正文');
    }
  });
});

describe('浏览器语音识别状态机', () => {
  class FakeRecognition implements RecognitionLike {
    continuous=false; interimResults=false; lang=''; onresult: any=null; onerror: any=null; onend:(()=>void)|null=null; starts=0; stops=0; aborts=0;
    start(){this.starts++;} stop(){this.stops++;this.onend?.();} abort(){this.aborts++;this.onend?.();}
  }
  it('临时结果被最终结果替换且相同最终片段不重复追加', () => {
    const fake=new FakeRecognition(), interim:string[]=[], finals:string[]=[], states:SpeechStatus[]=[];
    const provider=new BrowserTranscriptionProvider(()=>fake,{onInterim:(v)=>interim.push(v),onFinal:(v)=>finals.push(v),onStatus:(v)=>states.push(v)}); provider.start();
    fake.onresult?.({resultIndex:0,results:Object.assign([{0:{transcript:'临时内容'},isFinal:false,length:1}],{length:1})});
    fake.onresult?.({resultIndex:0,results:Object.assign([{0:{transcript:'最终内容'},isFinal:true,length:1}],{length:1})});
    fake.onresult?.({resultIndex:0,results:Object.assign([{0:{transcript:'最终内容'},isFinal:true,length:1}],{length:1})});
    expect(interim).toContain('临时内容'); expect(interim.at(-1)).toBe(''); expect(finals).toEqual(['最终内容']); expect(states).toContain('listening');
  });
  it('异常结束有限退避恢复，用户主动停止后不重启', () => {
    vi.useFakeTimers(); const instances:FakeRecognition[]=[]; const states:SpeechStatus[]=[];
    const provider=new BrowserTranscriptionProvider(()=>{const item=new FakeRecognition();instances.push(item);return item;},{onInterim:()=>{},onFinal:()=>{},onStatus:(v)=>states.push(v)},2);
    provider.start(); instances[0]!.onend?.(); vi.advanceTimersByTime(500); expect(instances).toHaveLength(2);
    instances[1]!.onend?.(); vi.advanceTimersByTime(1000); expect(instances).toHaveLength(3);
    instances[2]!.onend?.(); expect(states.at(-1)).toBe('error');
    provider.stop(); vi.runAllTimers(); expect(instances).toHaveLength(3);
  });
});

describe('API 集成核心流程', () => {
  it('无 Key 可用本地功能，Mock AI 完成转写→双笔记→问答→入笔记→重读→Word 导出', async () => {
    const {app}=createApp({db,settings,llm});
    expect((await request(app).get('/api/health')).body.aiConfigured).toBe(false);
    const course=(await request(app).post('/api/courses').send({name:'证据法',description:'',teacher:'李老师',tags:[]})).body;
    const session=(await request(app).post('/api/sessions').send({courseId:course.id,name:'第一讲',date:'2026-09-18',teacher:'李老师',tags:[],remarks:'',legalTerms:''})).body;
    await request(app).post(`/api/sessions/${session.id}/transcripts`).send({startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),text:'证据为什么必须具有合法性？'.repeat(5)}).expect(201);
    await request(app).put('/api/settings').send({...DEFAULT_SETTINGS,apiKey:'unit-key',noteTriggerChars:100}).expect(200);
    await request(app).post(`/api/sessions/${session.id}/notes/update`).send({force:true}).expect(200);
    const qa=(await request(app).post(`/api/sessions/${session.id}/questions`).send({question:'证据为什么必须合法？',source:'auto'}).expect(201)).body;
    await request(app).post(`/api/questions/${qa.id}/add-to-note`).send({target:'both'}).expect(200);
    const restored=(await request(app).get(`/api/sessions/${session.id}`).expect(200)).body;
    expect(restored.transcripts).toHaveLength(1); expect(restored.notes.every((n:any)=>n.blocks.length>0)).toBe(true); expect(restored.qa[0].status).toBe('both');
    const exported=await request(app).post(`/api/sessions/${session.id}/export`).send({format:'docx',scope:'package'}).buffer(true).parse((response,done)=>{const chunks:Buffer[]=[];response.on('data',(chunk:Buffer)=>chunks.push(chunk));response.on('end',()=>done(null,Buffer.concat(chunks)));}).expect(200);
    expect((exported.body as Buffer).subarray(0,2).toString()).toBe('PK'); expect(JSON.stringify((await request(app).get('/api/settings')).body)).not.toContain('unit-key');
  });
});
