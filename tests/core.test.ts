import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, HeadingLevel, Packer, Paragraph } from 'docx';
import mammoth from 'mammoth';
import request from 'supertest';
import { DEFAULT_SETTINGS, maskApiKey, normalizeQuestion, questionCandidate } from '@turtle/shared';
import { createApp } from '../apps/server/src/app.js';
import { TurtleDatabase } from '../apps/server/src/database.js';
import { exportSession, parseImport } from '../apps/server/src/files.js';
import { ClassroomServices } from '../apps/server/src/services.js';
import { SettingsStore } from '../apps/server/src/settings.js';
import type { CompletionOptions, LlmProvider } from '../apps/server/src/ai.js';
import { BrowserTranscriptionProvider, type RecognitionLike, type SpeechStatus } from '../apps/web/src/speech.js';
import { classifyLocally } from '../apps/server/src/relevance.js';

class MockLlm implements LlmProvider {
  calls: CompletionOptions[] = [];
  async complete(options: CompletionOptions): Promise<string> {
    this.calls.push(options);
    if(options.system.includes('相关性分类器'))return JSON.stringify({category:'substantive_legal',confidence:.9,rationale:'测试法律内容'});
    if(options.system.includes('文档补丁 Schema')){const version=Number(/文档版本：(\d+)/.exec(options.prompt)?.[1]??0),outline=options.system.includes('复习提纲');return JSON.stringify({baseVersion:version,reason:'测试微更新',operations:[{op:'createSection',title:outline?'行政行为要点':'行政行为的合法性',headingLevel:1,parentId:null,content:{type:'paragraph',content:[{type:'text',text:outline?'核心：合法性审查':'老师说明了行政行为合法性的判断方法。'}]},sourceTranscriptIds:[]}]});}
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
    expect(db.search('行政行为',session.id,course.id).some((result)=>result.sourceType==='transcript')).toBe(true);
    expect(db.search('2026-09-18',session.id,course.id).some((result)=>result.sourceType==='session')).toBe(true);
    expect(db.listTranscripts(session.id)).toHaveLength(1);
  });

  it('双版本笔记独立增量更新、锁定用户编辑、保留修订并可撤销', async () => {
    const { session } = seed();
    settings.save({ ...DEFAULT_SETTINGS, apiKey:'unit-key', noteTriggerChars:100 });
    db.addTranscript(session.id,{ startedAt:'2026-09-18T10:00:00',endedAt:'2026-09-18T10:00:03',text:'行政行为为什么必须符合法律规定？'.repeat(5) });
    const service = new ClassroomServices(db,settings,llm);
    await service.updateNotes(session.id,true);const documents=db.getNoteDocuments(session.id);
    expect(documents.find((n)=>n.type==='full')?.nodes.some((node)=>node.textContent==='行政行为的合法性')).toBe(true);
    expect(documents.find((n)=>n.type==='outline')?.nodes.some((node)=>node.textContent==='行政行为要点')).toBe(true);
    const document=documents[0]!,node=document.nodes[0]!;const userContent={type:'doc',content:[{type:'heading',attrs:{level:1,nodeId:node.id},content:[{type:'text',text:'用户自己的笔记'}]}]};const saved=db.saveNoteDocument(document.id,document.version,userContent,node.id);
    const protectedNode=saved.nodes[0]!;db.applyNotePatch(saved.id,saved.version,'AI 尝试修改',[{op:'updateNode',nodeId:protectedNode.id,content:{type:'heading',attrs:{level:1,nodeId:protectedNode.id},content:[{type:'text',text:'AI 覆盖'}]}}]);
    expect(db.getNoteDocument(saved.id)?.nodes[0]?.textContent).toBe('用户自己的笔记');expect(db.getNoteDocument(saved.id)?.pendingSuggestions).toBe(1);expect(db.undoNoteDocument(saved.id)?.nodes[0]?.textContent).toBe('用户自己的笔记');
  });

  it('字数与时间触发会防抖，并发调用不重复处理同一转写', async () => {
    vi.useFakeTimers(); const {session}=seed(); settings.save({...DEFAULT_SETTINGS,apiKey:'unit-key',noteTriggerChars:100,noteIntervalSeconds:10});
    const service=new ClassroomServices(db,settings,llm);
    db.addTranscript(session.id,{startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),text:'法律课堂内容'.repeat(25)});
    service.scheduleNotes(session.id);service.scheduleNotes(session.id);
    await vi.advanceTimersByTimeAsync(799);expect(llm.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);expect(llm.calls).toHaveLength(2);
    vi.advanceTimersByTime(1);db.addTranscript(session.id,{startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),text:'新的行政法最终转写'.repeat(20)});
    await Promise.all([service.updateNotes(session.id,true),service.updateNotes(session.id,true)]);
    expect(llm.calls).toHaveLength(4);
    vi.advanceTimersByTime(1);db.addTranscript(session.id,{startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),text:'行政法短内容'});
    service.scheduleNotes(session.id);await vi.advanceTimersByTimeAsync(9_999);expect(llm.calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);expect(llm.calls).toHaveLength(6);
  });

  it('AI 失败保留待处理内容并标记失败，稍后可重试', async () => {
    const {session}=seed();settings.save({...DEFAULT_SETTINGS,apiKey:'unit-key'});db.addTranscript(session.id,{startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),text:'行政法上应当保留的待处理法律课堂内容'});
    const failing: LlmProvider={complete:async()=>{throw new Error('模拟网络故障');}};
    await expect(new ClassroomServices(db,settings,failing).updateNotes(session.id,true)).rejects.toThrow('模拟网络故障');
    expect(db.getNoteDocuments(session.id).every((note)=>note.status==='failed')).toBe(true);
    await new ClassroomServices(db,settings,llm).updateNotes(session.id,true);
    expect(db.getNoteDocuments(session.id).every((note)=>note.nodes.length>=2&&note.status==='complete')).toBe(true);
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

  it('富文本 Word 导出保留多级标题、表格、图片和前文顺序',async()=>{
    const {session}=seed(),document=db.getNoteDocuments(session.id).find((item)=>item.type==='full')!,assetPath=join(directory,'test.png');writeFileSync(assetPath,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=','base64'));const asset=db.addEditorAsset({sessionId:session.id,filename:'证据图.png',mimeType:'image/png',size:68,path:assetPath,altText:'证据结构图'});
    const content={type:'doc',content:[{type:'heading',attrs:{level:1,nodeId:crypto.randomUUID()},content:[{type:'text',text:'行政行为效力'}]},{type:'heading',attrs:{level:2,nodeId:crypto.randomUUID()},content:[{type:'text',text:'无效行政行为'}]},{type:'table',attrs:{nodeId:crypto.randomUUID()},content:[{type:'tableRow',content:[{type:'tableHeader',content:[{type:'paragraph',content:[{type:'text',text:'比较项'}]}]},{type:'tableCell',content:[{type:'paragraph',content:[{type:'text',text:'法律效果'}]}]}]}]},{type:'image',attrs:{nodeId:crypto.randomUUID(),src:`/api/editor-assets/${asset.id}/content`,alt:'证据结构图'}}]};db.saveNoteDocument(document.id,document.version,content,null);
    const exported=await exportSession(db,session.id,'docx','full'),html=(await mammoth.convertToHtml({buffer:exported.buffer},{convertImage:mammoth.images.imgElement(async()=>({src:'embedded'}))})).value;expect(html).toContain('<strong>一、</strong>行政行为效力');expect(html).toContain('<strong>（一）</strong>无效行政行为');expect(html).toContain('<table>');expect(html).toContain('<img');expect(exported.buffer.toString()).not.toContain(directory);
  });
});

describe('内容相关性、结构化文档与持久化恢复',()=>{
  it('区分闲聊、课程安排、不完整片段，并保留法律教学中的生活事实',()=>{
    expect(classifyLocally('周末天气真不错，大家吃饭了吗')).toMatchObject({category:'small_talk'});
    expect(classifyLocally('这个下周期中考试，记得交作业')).toMatchObject({category:'course_context'});
    expect(classifyLocally('那么关于这个')).toMatchObject({category:'uncertain'});
    expect(classifyLocally('甲把自己的房子交给乙管理，后来乙对外声称有代理权',['我们现在讨论表见代理的构成要件'])).toMatchObject({category:'substantive_legal'});
  });

  it('用户手动分类不会被后续 AI 分类覆盖，原始转写仍保留',()=>{
    const {session}=seed(),segment=db.addTranscript(session.id,{startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),text:'今天聊聊天气'});
    db.setTranscriptRelevance(segment.id,'substantive_legal',1,true,'用户决定');db.setTranscriptRelevance(segment.id,'small_talk',.9,false,'AI决定');
    const restored=db.listTranscripts(session.id)[0]!;expect(restored.text).toBe('今天聊聊天气');expect(restored.relevance).toBe('substantive_legal');expect(restored.relevanceManual).toBe(true);
  });

  it('支持前文插入、移动防循环、表格重组、版本冲突与撤销',()=>{
    const {session}=seed(),document=db.getNoteDocuments(session.id).find((item)=>item.type==='full')!;
    const first=db.applyNotePatch(document.id,document.version,'创建概念',[{op:'createSection',title:'行政行为的效力',headingLevel:1,parentId:null,content:{type:'paragraph',content:[{type:'text',text:'效力说明'}]},sourceTranscriptIds:[]}]);
    const heading=first.nodes.find((node)=>node.type==='heading')!,paragraph=first.nodes.find((node)=>node.type==='paragraph')!;
    const supplemented=db.applyNotePatch(first.id,first.version,'回填案例',[{op:'addExample',targetNodeId:heading.id,content:{type:'paragraph',content:[{type:'text',text:'典型案例'}]},sourceTranscriptIds:[]}]);
    expect(supplemented.nodes.some((node)=>node.parentId===heading.id&&node.textContent==='典型案例')).toBe(true);
    expect(()=>db.applyNotePatch(supplemented.id,first.version,'旧版本',[])).toThrow('版本冲突');
    expect(()=>db.applyNotePatch(supplemented.id,supplemented.version,'循环',[{op:'moveNode',nodeId:heading.id,parentId:heading.id,position:0}])).toThrow('自己的父节点');
    const table={type:'table',content:[{type:'tableRow',content:[{type:'tableHeader',content:[{type:'paragraph',content:[{type:'text',text:'比较项'}]}]}]}]};
    const converted=db.applyNotePatch(supplemented.id,supplemented.version,'转换表格',[{op:'convertToTable',nodeIds:[paragraph.id],table}]);expect(converted.nodes.some((node)=>node.type==='table')).toBe(true);expect(db.undoNoteDocument(converted.id)?.nodes.some((node)=>node.id===paragraph.id)).toBe(true);
  });

  it('数据库关闭重启后课程仍存在，健康接口区分真实数据并暴露稳定绝对路径',async()=>{
    const folder=mkdtempSync(join(tmpdir(),'turtle-restart-'));try{const first=new TurtleDatabase(folder);first.createCourse({name:'重启保留课',description:'',teacher:'',tags:[]});first.close();const reopened=new TurtleDatabase(folder);expect(reopened.listCourses()[0]?.name).toBe('重启保留课');reopened.close();}finally{rmSync(folder,{recursive:true,force:true});}
    const response=await request(createApp({db,settings,llm}).app).get('/api/health').expect(200);expect(response.body).toMatchObject({ok:true,schemaVersion:2,writable:true});expect(response.body.databasePath).toContain('turtle.db');
  });

  it('旧 note_blocks 非破坏迁移到 v2 文档并在迁移前生成备份',()=>{
    const folder=mkdtempSync(join(tmpdir(),'turtle-migration-'));try{const legacy=new TurtleDatabase(folder);const course=legacy.createCourse({name:'旧课程',description:'',teacher:'',tags:[]}),session=legacy.createSession({courseId:course.id,name:'旧课堂',date:'2026-09-22',teacher:'',tags:[],remarks:'',legalTerms:''}),note=legacy.getNotes(session.id)[0]!;legacy.addUserNoteBlock(note.id,'旧版笔记迁移内容','绝不能丢失的原文字');legacy.db.exec('PRAGMA foreign_keys=OFF; DROP TABLE qa_note_links; DROP TABLE note_node_sources; DROP TABLE note_suggestions; DROP TABLE note_patch_jobs; DROP TABLE note_revisions_v2; DROP TABLE note_nodes; DROP TABLE note_documents_v2; DROP TABLE transcript_relevance; DROP TABLE editor_assets; DROP TABLE transcription_events; DROP TABLE persistence_operations; DROP TABLE audio_recordings; DELETE FROM schema_migrations WHERE version=2; PRAGMA user_version=1;');legacy.close();const migrated=new TurtleDatabase(folder);const document=migrated.getNoteDocuments(session.id)[0]!;expect(document.nodes.some((node)=>node.textContent==='绝不能丢失的原文字')).toBe(true);expect(migrated.getNotes(session.id)[0]?.blocks.some((block)=>block.content==='绝不能丢失的原文字')).toBe(true);expect(readdirSync(join(folder,'backups')).some((name)=>name.startsWith('turtle-pre-migration-v2-'))).toBe(true);migrated.close();}finally{rmSync(folder,{recursive:true,force:true});}
  });

  it('损坏设置会保留副本并显示诊断，不静默伪装成正常空设置',()=>{
    writeFileSync(settings.file,'{broken','utf8');const recovered=new SettingsStore(directory);expect(recovered.getDiagnostic().ok).toBe(false);expect(readdirSync(directory).some((name)=>name.startsWith('local-settings.json.corrupt-'))).toBe(true);
  });

  it('自动问题未读状态持久化，阅读和软删除同步列表',()=>{
    const {session}=seed(),qa=db.createQa(session.id,'auto','行政许可的构成要件是什么？','行政许可的构成要件是什么',false,true,'concept',.95)!;expect(db.listQa(session.id).filter((item)=>!item.readAt)).toHaveLength(1);expect(db.markQaRead(qa.id)?.readAt).toBeTruthy();expect(db.deleteQa(qa.id)).toBe(true);expect(db.listQa(session.id)).toHaveLength(0);expect(db.getQa(qa.id)?.deletedAt).toBeTruthy();
  });

  it('问答按指定节点插入且同一文档不重复，并可同时移除链接',()=>{
    const {session}=seed(),document=db.getNoteDocuments(session.id)[0]!,created=db.applyNotePatch(document.id,document.version,'建立问题区',[{op:'createSection',title:'课堂问题',headingLevel:1,parentId:null,sourceTranscriptIds:[]}]),target=created.nodes[0]!,qa=db.createQa(session.id,'auto','行政许可与行政确认有什么区别？','行政许可与行政确认有什么区别',false,true,'comparison',.96)!;db.updateQa(qa.id,{answer:'二者在行为性质与法律效果上不同。'});db.insertQaIntoDocuments(qa.id,created.type,target.id);const count=()=>Number((db.db.prepare('SELECT COUNT(*) count FROM qa_note_links WHERE qa_id=? AND document_id=?').get(qa.id,created.id) as any).count);expect(count()).toBe(1);db.insertQaIntoDocuments(qa.id,created.type,target.id);expect(count()).toBe(1);db.removeQaFromNotes(qa.id);expect(count()).toBe(0);
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
    instances[2]!.onend?.(); expect(states.at(-1)).toBe('recovery-failed');
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
    expect(restored.transcripts).toHaveLength(1); expect(restored.noteDocuments.every((n:any)=>n.nodes.length>0)).toBe(true); expect(restored.qa[0].status).toBe('both');
    const exported=await request(app).post(`/api/sessions/${session.id}/export`).send({format:'docx',scope:'package'}).buffer(true).parse((response,done)=>{const chunks:Buffer[]=[];response.on('data',(chunk:Buffer)=>chunks.push(chunk));response.on('end',()=>done(null,Buffer.concat(chunks)));}).expect(200);
    expect((exported.body as Buffer).subarray(0,2).toString()).toBe('PK'); expect(JSON.stringify((await request(app).get('/api/settings')).body)).not.toContain('unit-key');
  });

  it('本地录音分段可列出、播放、导出和删除，个人数据备份排除秘密与内部路径',async()=>{
    const {app}=createApp({db,settings,llm});settings.save({...DEFAULT_SETTINGS,apiKey:'unit-private-key'});const {session}=seed();
    const created=(await request(app).post(`/api/sessions/${session.id}/recordings`).field('durationMs','30000').attach('file',Buffer.from('local-audio-chunk'),{filename:'chunk.webm',contentType:'audio/webm'}).expect(201)).body;
    expect((await request(app).get(`/api/sessions/${session.id}/recordings`).expect(200)).body).toHaveLength(1);
    expect((await request(app).get(`/api/recordings/${created.id}/content`).expect(200)).body.toString()).toContain('local-audio-chunk');
    const personal=await request(app).get('/api/backups/personal-data').expect(200);const text=JSON.stringify(personal.body);expect(personal.body.format).toBe('turtle-personal-data-v1');expect(text).not.toContain('unit-private-key');expect(text).not.toContain(directory);
    await request(app).delete(`/api/recordings/${created.id}`).expect(204);expect((await request(app).get(`/api/sessions/${session.id}/recordings`)).body).toHaveLength(0);
  });
});
