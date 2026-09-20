import { z } from 'zod';
import { normalizeQuestion, questionCandidate } from '@turtle/shared';
import type { TurtleDatabase } from './database.js';
import type { SettingsStore } from './settings.js';
import { LEGAL_GUARDRAILS, parseJson, withRetry, type LlmProvider } from './ai.js';

const noteResponseSchema = z.object({ blocks: z.array(z.object({ section: z.string().min(1), content: z.string().min(1) })).min(1).max(12) });
const answerResponseSchema = z.object({ answer: z.string().min(1), evidence: z.string(), references: z.array(z.string()).default([]) });

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
    const notes = this.db.getNotes(sessionId);
    const results=await Promise.allSettled(notes.map((note) => this.queue(`note:${note.id}`).enqueue(async () => {
      const current=this.db.getNotes(sessionId).find((item)=>item.id===note.id)??note;
      const transcripts=this.db.listTranscripts(sessionId);
      const pending = transcripts.filter((t) => !current.lastProcessedAt || t.createdAt > current.lastProcessedAt);
      const chars = pending.reduce((sum, item) => sum + item.text.length, 0);
      const age = current.lastProcessedAt ? Date.now() - Date.parse(current.lastProcessedAt) : pending[0] ? Date.now()-Date.parse(pending[0].createdAt) : 0;
      if (!force && chars < settings.noteTriggerChars && age < settings.noteIntervalSeconds * 1000) return;
      if (!pending.length) return;
      const controller = new AbortController(); this.controllers.set(`note:${note.id}`, controller);
      this.db.db.prepare(`UPDATE note_documents SET status='generating',updated_at=? WHERE id=?`).run(new Date().toISOString(),note.id);
      const transcript = pending.map((t) => `[${t.startedAt}] ${t.text}`).join('\n').slice(-18000);
      const locked = current.blocks.filter((b) => b.locked).map((b) => `${b.section}: ${b.content}`).join('\n');
      const format = current.type === 'full'
        ? '生成接近可直接复习的完整讲义增量：完整句子、分层标题、保留课堂逻辑和时间依据；可用章节包括主题、课程结构、讲授内容、核心观点、概念、法条、案例、观点比较、老师强调、易混淆点、前序联系、AI补充、待核实、本节总结。'
        : '生成明显更短的考试复习提纲增量：项目符号、一级/二级知识点、关键词、核心法条、案例、易错点、老师强调、复习问题、一句话总结。不要复制完整版。';
      try {
        const raw = await withRetry(() => this.llm.complete({ model: settings.noteModel, system: `${LEGAL_GUARDRAILS}\n${format}\n只输出 JSON：{"blocks":[{"section":"章节","content":"内容"}]}`, prompt: `新增最终转写：\n${transcript}\n\n用户已锁定内容（不得改写；相关内容应作为“建议补充”新块）：\n${locked || '无'}`, signal: controller.signal, json: true }));
        const parsed = parseJson(raw, noteResponseSchema);
        this.db.appendNoteBlocks(note.id, parsed.blocks, pending.at(-1)!.createdAt);
      } catch(error) { this.db.db.prepare(`UPDATE note_documents SET status='failed',updated_at=? WHERE id=?`).run(new Date().toISOString(),note.id); throw error; }
      finally { this.controllers.delete(`note:${note.id}`); }
    })));
    const failure=results.find((result):result is PromiseRejectedResult=>result.status==='rejected');
    if(failure)throw failure.reason;
    return this.db.getNotes(sessionId);
  }

  async detectAndAnswer(sessionId: string, text: string): Promise<void> {
    const settings = this.settings.getPrivate();
    if (!settings.autoDetectQuestions || settings.autoQaPaused || !questionCandidate(text)) return;
    const key = normalizeQuestion(text); const stamp = Date.now();
    if ((this.cooldown.get(key) ?? 0) + 30_000 > stamp) return;
    this.cooldown.set(key, stamp);
    const qa = this.db.createQa(sessionId, 'auto', text.trim(), key, !/[？?]$/.test(text));
    if (qa && settings.autoAnswer) await this.answer(qa.id);
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
      const raw = await withRetry(() => this.llm.complete({ model: qa.source === 'auto' ? settings.autoQaModel : settings.manualQaModel, system: `${LEGAL_GUARDRAILS}\n按“当前课堂依据、历史课堂依据、导入资料依据、AI一般知识补充、待核实内容”区分作答。课堂记录没有答案时必须明确说明。只输出 JSON：{"answer":"...","evidence":"...","references":["..."]}`, prompt: `问题：${qa.question}\n\n按相关度检索到的有限上下文：\n${context.text || '未找到课堂记录'}\n\n${settings.allowGeneralKnowledge ? '允许一般知识补充，但必须标注。' : '不得使用一般知识补充。'}`, signal: controller.signal, json: true }));
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
