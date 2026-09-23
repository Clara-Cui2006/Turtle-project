import { z } from 'zod';
import { normalizeQuestion, notePatchSchema, questionCandidate, type TranscriptSegment } from '@turtle/shared';
import type { TurtleDatabase } from './database.js';
import type { SettingsStore } from './settings.js';
import { LEGAL_GUARDRAILS, parseJson, withRetry, type LlmProvider } from './ai.js';
import { classifyLocally, classifyWithContext, type RelevanceResult } from './relevance.js';

const answerResponseSchema = z.object({ answer: z.string().min(1), evidence: z.string(), references: z.array(z.string()).default([]) });
const legacyNoteResponseSchema = z.object({ blocks: z.array(z.object({ section: z.string().min(1), content: z.string().min(1) })).min(1).max(12) });
const plainText=(value:any):string=>typeof value?.text==='string'?value.text:Array.isArray(value?.content)?value.content.map(plainText).join(''):'';
const questionType=(text:string)=>/(案例|甲|乙|事实|争点)/.test(text)?'case':/(第.{0,8}条|法条|条文)/.test(text)?'statute':/(学说|争议|观点)/.test(text)?'theory':/(区别|比较|关系)/.test(text)?'comparison':'concept';

class SerialQueue {
  private pending = Promise.resolve();
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.pending.then(task, task);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class ClassroomServices {
  private queues = new Map<string, SerialQueue>();
  private controllers = new Map<string, AbortController>();
  private cooldown = new Map<string, number>();
  private noteTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private db: TurtleDatabase, private settings: SettingsStore, private llm: LlmProvider) {}

  private queue(key: string): SerialQueue { let queue = this.queues.get(key); if (!queue) { queue = new SerialQueue(); this.queues.set(key, queue); } return queue; }
  cancel(key: string): void { this.controllers.get(key)?.abort(); this.controllers.delete(key); }

  async classifyTranscript(segment:TranscriptSegment):Promise<TranscriptSegment>{
    const context=this.db.listTranscripts(segment.sessionId).filter((item)=>item.id!==segment.id).slice(-6).map((item)=>item.text);
    let result:RelevanceResult=classifyLocally(segment.text,context);const settings=this.settings.getPrivate();
    if(settings.apiKey&&result.category==='uncertain')try{result=await classifyWithContext(this.llm,settings.noteModel,segment.text,context);}catch{/* Local uncertain classification is safer than blocking persistence. */}
    return this.db.setTranscriptRelevance(segment.id,result.category,result.confidence,false,result.rationale)??segment;
  }

  async handleFinalTranscript(segment:TranscriptSegment):Promise<void>{
    const classified=await this.classifyTranscript(segment),settings=this.settings.getPrivate();
    if(classified.relevance==='substantive_legal'){if(settings.realtimeMicroUpdates)this.scheduleNotes(segment.sessionId);await this.detectAndAnswer(segment.sessionId,segment.text);}
  }

  scheduleNotes(sessionId: string): void {
    const settings=this.settings.getPrivate(); if(!settings.apiKey||!settings.autoNotes)return;
    const existing=this.noteTimers.get(sessionId); if(existing)clearTimeout(existing);
    const notes=this.db.getNotes(sessionId),transcripts=this.db.listTranscripts(sessionId);
    const pendingChars=Math.max(0,...notes.map((note)=>transcripts.filter((t)=>!note.lastProcessedAt||t.createdAt>note.lastProcessedAt).reduce((sum,t)=>sum+t.text.length,0)));
    const delay=pendingChars>=settings.noteTriggerChars?800:settings.noteIntervalSeconds*1000;
    this.noteTimers.set(sessionId,setTimeout(()=>{this.noteTimers.delete(sessionId);void this.updateNotes(sessionId,true).catch(()=>undefined);},delay));
  }

  async updateNotes(sessionId: string, force = false): Promise<ReturnType<TurtleDatabase['getNotes']>> {
    const settings = this.settings.getPrivate();
    if (!settings.autoNotes && !force) return this.db.getNotes(sessionId);
    const notes = this.db.getNotes(sessionId),documents=this.db.getNoteDocuments(sessionId);
    const results=await Promise.allSettled(documents.map((document) => this.queue(`note-v2:${document.id}`).enqueue(async () => {
      const legacy=notes.find((item)=>item.type===document.type); const row=this.db.db.prepare('SELECT last_processed_at FROM note_documents_v2 WHERE id=?').get(document.id) as {last_processed_at:string|null};
      const transcripts=this.db.listTranscripts(sessionId);
      const pending = transcripts.filter((t) => (!row.last_processed_at || t.createdAt > row.last_processed_at)&&(t.relevance==='substantive_legal'||(!t.relevance&&classifyLocally(t.text,transcripts.slice(Math.max(0,transcripts.indexOf(t)-4),transcripts.indexOf(t)).map((item)=>item.text)).category==='substantive_legal')));
      const chars = pending.reduce((sum, item) => sum + item.text.length, 0);
      const age = row.last_processed_at ? Date.now() - Date.parse(row.last_processed_at) : pending[0] ? Date.now()-Date.parse(pending[0].createdAt) : 0;
      if (!force && chars < settings.noteTriggerChars && age < settings.noteIntervalSeconds * 1000) return;
      if (!pending.length) return;
      const controller = new AbortController(); this.controllers.set(`note-v2:${document.id}`, controller);
      this.db.db.prepare(`UPDATE note_documents_v2 SET status='generating',updated_at=? WHERE id=?`).run(new Date().toISOString(),document.id);
      const transcript = pending.map((t) => `[${t.startedAt}] ${t.text}`).join('\n').slice(-18000);
      const relevantNodes=document.nodes.slice(-40).map((node)=>({id:node.id,parentId:node.parentId,type:node.type,headingLevel:node.headingLevel,text:node.textContent,userEdited:node.userEdited,aiManaged:node.aiManaged}));
      const format = document.type === 'full' ? '维护详细连续的法律课堂讲义' : '维护简洁、层级清晰且不重复完整版的复习提纲';
      try {
        const raw = await withRetry(() => this.llm.complete({ model: settings.noteModel, system: `${LEGAL_GUARDRAILS}\n${format}。根据真实授课逻辑回到已有节点补充、建立关系或转换表格，不要机械追加，不要创建空模板。用户编辑节点绝不能覆盖。只输出符合文档补丁 Schema 的 JSON：{"baseVersion":数字,"reason":"原因","operations":[...]}`, prompt: `文档版本：${document.version}\n现有相关节点：\n${JSON.stringify(relevantNodes)}\n\n新增法律课程语义单元：\n${transcript}`, signal: controller.signal, json: true }));
        let parsed;try{parsed=parseJson(raw,notePatchSchema);}catch{const fallback=parseJson(raw,legacyNoteResponseSchema);parsed={baseVersion:document.version,reason:'兼容旧模型输出',operations:fallback.blocks.flatMap((block)=>[{op:'createSection' as const,title:block.section,headingLevel:2,parentId:null,content:{type:'paragraph',content:[{type:'text',text:block.content}]},sourceTranscriptIds:pending.map((item)=>item.id)}])};}
        this.db.applyNotePatch(document.id,document.version,parsed.reason,parsed.operations);
        this.db.db.prepare('UPDATE note_documents_v2 SET last_processed_at=?,status=\'complete\',updated_at=? WHERE id=?').run(pending.at(-1)!.createdAt,new Date().toISOString(),document.id);
        if(legacy){const legacyBlocks=parsed.operations.filter((operation:any)=>operation.op==='createSection').map((operation:any)=>({section:operation.title,content:plainText(operation.content)}));if(legacyBlocks.length)this.db.appendNoteBlocks(legacy.id,legacyBlocks,pending.at(-1)!.createdAt);}
      } catch(error) { this.db.db.prepare(`UPDATE note_documents_v2 SET status='failed',updated_at=? WHERE id=?`).run(new Date().toISOString(),document.id); throw error; }
      finally { this.controllers.delete(`note-v2:${document.id}`); }
    })));
    const failure=results.find((result):result is PromiseRejectedResult=>result.status==='rejected');
    if(failure)throw failure.reason;
    return this.db.getNotes(sessionId);
  }

  async detectAndAnswer(sessionId: string, text: string): Promise<void> {
    const settings = this.settings.getPrivate();
    if (!settings.autoDetectQuestions || settings.autoQaPaused || !questionCandidate(text)) return;
    const relevance=classifyLocally(text,this.db.listTranscripts(sessionId).slice(-5).map((item)=>item.text));if(settings.legalQuestionsOnly&&relevance.category!=='substantive_legal')return;
    const key = normalizeQuestion(text); const stamp = Date.now();
    if ((this.cooldown.get(key) ?? 0) + 30_000 > stamp) return;
    this.cooldown.set(key, stamp);
    const qa = this.db.createQa(sessionId, 'auto', text.trim(), key, !/[？?]$/.test(text),true,questionType(text),relevance.confidence);
    if (qa && settings.autoAnswer && settings.apiKey) await this.answer(qa.id);
  }

  async ask(sessionId: string, question: string, source: 'auto' | 'manual' = 'manual'): Promise<ReturnType<TurtleDatabase['getQa']>> {
    const normalized = normalizeQuestion(question);
    const existing = this.db.listQa(sessionId).find((q) => normalizeQuestion(q.question) === normalized);
    const qa = existing ?? this.db.createQa(sessionId, source, question, normalized);
    if (!qa) return existing;
    return this.answer(qa.id);
  }

  async answer(qaId: string): Promise<ReturnType<TurtleDatabase['getQa']>> {
    const qa = this.db.getQa(qaId); if (!qa) throw new Error('问答不存在');
    return this.queue(`${qa.source}-qa`).enqueue(async () => {
      const settings = this.settings.getPrivate(); const context = this.db.context(qa.sessionId, qa.question,12000,settings.useHistory);
      const controller = new AbortController(); this.controllers.set(`qa:${qa.id}`, controller);
      const raw = await withRetry(() => this.llm.complete({ model: qa.source === 'auto' ? settings.autoQaModel : settings.manualQaModel, system: `${LEGAL_GUARDRAILS}\n先判断问题类型，再具体分析：概念题强调定义、判断标准和相近概念；案例题强调争点、规范、涵摄、不同观点和有条件结论；法条题说明适用范围、要件、效果和条文关系；学理题说明学说理由与制度后果；比较题按比较维度组织，必要时用简洁表格。不要套用固定标题模板。必须区分课堂内容、导入资料、一般知识、模型推断和待核实内容；不确定现行条文时写“建议核验法条原文”。只输出 JSON：{"answer":"...","evidence":"...","references":["..."]}`, prompt: `问题：${qa.question}\n\n按相关度检索到的有限上下文：\n${context.text || '未找到课堂记录'}\n\n${settings.allowGeneralKnowledge ? '允许一般知识补充，但必须标注。' : '不得使用一般知识补充。'}`, signal: controller.signal, json: true }));
      const parsed = parseJson(raw, answerResponseSchema);
      this.controllers.delete(`qa:${qa.id}`);
      return this.db.updateQa(qa.id, { answer: parsed.answer, evidence: parsed.evidence, references: [...context.refs, ...parsed.references] });
    });
  }

  async *streamAsk(sessionId:string,question:string):AsyncIterable<string>{
    const settings=this.settings.getPrivate(),normalized=normalizeQuestion(question);
    const qa=this.db.createQa(sessionId,'manual',question,normalized)??this.db.listQa(sessionId).find((item)=>normalizeQuestion(item.question)===normalized);
    if(!qa)throw new Error('无法创建问答');
    const context=this.db.context(sessionId,question,12000,settings.useHistory),controller=new AbortController();this.controllers.set(`qa:${qa.id}`,controller);
    const options={model:settings.manualQaModel,system:`${LEGAL_GUARDRAILS}\n按“当前课堂依据、历史课堂依据、导入资料依据、AI一般知识补充、待核实内容”清晰分区作答。课堂记录没有答案时必须明确说明。`,prompt:`问题：${question}\n\n有限相关上下文：\n${context.text||'未找到课堂记录'}`,signal:controller.signal};
    let answer='';
    try{if(this.llm.stream){for await(const chunk of this.llm.stream(options)){answer+=chunk;yield chunk;}}else{answer=await this.llm.complete(options);yield answer;}this.db.updateQa(qa.id,{answer,evidence:context.text?'已引用检索到的课堂或资料片段':'课堂记录中未找到直接依据',references:context.refs});}
    finally{this.controllers.delete(`qa:${qa.id}`);}
  }
}
