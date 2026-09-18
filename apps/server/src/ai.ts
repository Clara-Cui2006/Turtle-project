import { z } from 'zod';
import type { SettingsStore } from './settings.js';

export class AiError extends Error {
  constructor(public code: string, message: string, public status = 500) { super(message); }
}

export interface CompletionOptions { model: string; system: string; prompt: string; signal?: AbortSignal; json?: boolean }
export interface LlmProvider { complete(options: CompletionOptions): Promise<string>; stream?(options: CompletionOptions): AsyncIterable<string> }

const friendlyError = (status: number): AiError => {
  if (status === 401 || status === 403) return new AiError('INVALID_API_KEY', 'DeepSeek API Key 无效或无权限', 401);
  if (status === 402) return new AiError('INSUFFICIENT_BALANCE', 'DeepSeek 余额或额度不足', 402);
  if (status === 404) return new AiError('MODEL_UNAVAILABLE', '所选模型不可用，请在设置中修改模型名称', 400);
  if (status === 429) return new AiError('RATE_LIMITED', 'DeepSeek 请求过于频繁，请稍后重试', 429);
  if (status >= 500) return new AiError('SERVICE_ERROR', 'DeepSeek 服务暂时不可用', 502);
  return new AiError('REQUEST_FAILED', 'DeepSeek 请求失败', 502);
};

export class DeepSeekProvider implements LlmProvider {
  constructor(private settings: SettingsStore) {}

  async complete(options: CompletionOptions): Promise<string> {
    const settings = this.settings.getPrivate();
    if (!settings.apiKey) throw new AiError('API_KEY_MISSING', '尚未配置 DeepSeek', 400);
    const timeout = AbortSignal.timeout(45_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
        body: JSON.stringify({ model: options.model, messages: [{ role: 'system', content: options.system }, { role: 'user', content: options.prompt }], stream: false, temperature: 0.2, ...(options.json ? { response_format: { type: 'json_object' } } : {}), ...(settings.thinking ? { thinking: { type: 'enabled' } } : {}) })
      });
    } catch {
      if (signal.aborted) throw new AiError('ABORTED', '请求已取消或超时', 408);
      throw new AiError('NETWORK_ERROR', '无法连接 DeepSeek，请检查网络', 502);
    }
    if (!response.ok) throw friendlyError(response.status);
    const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new AiError('INVALID_RESPONSE', 'DeepSeek 返回了无法解析的内容', 502);
    return content;
  }

  async *stream(options: CompletionOptions): AsyncIterable<string> {
    const settings = this.settings.getPrivate();
    if (!settings.apiKey) throw new AiError('API_KEY_MISSING', '尚未配置 DeepSeek', 400);
    const timeout = AbortSignal.timeout(90_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method:'POST',signal,headers:{'Content-Type':'application/json',Authorization:`Bearer ${settings.apiKey}`},
        body:JSON.stringify({model:options.model,messages:[{role:'system',content:options.system},{role:'user',content:options.prompt}],stream:true,temperature:0.2,...(settings.thinking?{thinking:{type:'enabled'}}:{})})
      });
    } catch { throw signal.aborted ? new AiError('ABORTED','请求已取消或超时',408) : new AiError('NETWORK_ERROR','无法连接 DeepSeek，请检查网络',502); }
    if (!response.ok) throw friendlyError(response.status);
    if (!response.body) throw new AiError('INVALID_RESPONSE','DeepSeek 未返回流式内容',502);
    const reader=response.body.getReader(),decoder=new TextDecoder(); let buffer='';
    while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split('\n');buffer=lines.pop()??'';for(const line of lines){const data=line.replace(/^data:\s*/, '').trim();if(!data||data==='[DONE]'||line.startsWith(':'))continue;try{const payload=JSON.parse(data) as {choices?:{delta?:{content?:string}}[]};const content=payload.choices?.[0]?.delta?.content;if(content)yield content;}catch{/* keep-alive or partial vendor event */}}}
  }
}

export async function withRetry<T>(operation: () => Promise<T>, retries = 2): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await operation(); } catch (error) {
      last = error;
      if (error instanceof AiError && !['NETWORK_ERROR', 'SERVICE_ERROR', 'RATE_LIMITED'].includes(error.code)) throw error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
    }
  }
  throw last;
}

export function parseJson<T>(text: string, schema: z.ZodType<T>): T {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return schema.parse(JSON.parse(cleaned)); } catch { throw new AiError('INVALID_RESPONSE', 'DeepSeek 返回格式不符合要求', 502); }
}

export const LEGAL_GUARDRAILS = `你是中国法学课堂笔记助手。不得伪造法条、案号、判决内容，不得把一般知识冒充老师原话。无法确认的法条、案号和案例必须标记“待核实”；模型自行补充的知识必须标记“AI补充”；区分课堂明确内容与模型推断；材料不足时明确说明。`;
