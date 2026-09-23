import { z } from 'zod';
import type { RelevanceCategory } from '@turtle/shared';
import { parseJson, type LlmProvider } from './ai.js';

export interface RelevanceResult { category: RelevanceCategory; confidence: number; rationale: string }

const legalTerms = /(法律|法条|规范|权利|义务|责任|构成要件|法律效果|行政|民法|刑法|诉讼|合同|侵权|物权|代理|许可|裁判|法院|学说|请求权|举证|证据|违法|无效|撤销)/;
const courseContext = /(作业|考试|期中|期末|点名|签到|下次课|课程安排|交作业|截止|上课时间|课程进度)/;
const smallTalk = /(天气|吃饭|周末|堵车|早上好|下午好|大家好|开个玩笑|闲聊|生日|旅游|电影|电视剧)/;
const incomplete = /(?:这个|那个|然后|所以|就是|我们看|比如说|也就是说|至于|关于)$/;

export function classifyLocally(text:string,context:string[]=[]):RelevanceResult {
  const value=text.trim(),nearby=context.slice(-4).join(' '),legalContext=legalTerms.test(nearby);
  if(value.length<6||incomplete.test(value))return{category:'uncertain',confidence:.72,rationale:'片段过短或语义尚未结束，等待后文'};
  if(courseContext.test(value)&&!legalTerms.test(value))return{category:'course_context',confidence:.92,rationale:'课程安排或课堂管理信息'};
  if(legalTerms.test(value)||legalContext&&/(例如|比如|假设|案例|情形|甲|乙|公司|买卖|授权|表示)/.test(value))return{category:'substantive_legal',confidence:legalTerms.test(value)?.94:.78,rationale:legalTerms.test(value)?'包含实质法律概念或推理':'生活事实位于法律教学上下文中，作为法律例子保留'};
  if(smallTalk.test(value))return{category:'small_talk',confidence:.9,rationale:'与法律教学无关的寒暄或生活话题'};
  return{category:'uncertain',confidence:.55,rationale:'仅凭当前上下文无法可靠判断'};
}

const aiSchema=z.object({category:z.enum(['substantive_legal','course_context','small_talk','uncertain']),confidence:z.number().min(0).max(1),rationale:z.string().max(300)});
export async function classifyWithContext(llm:LlmProvider,model:string,text:string,context:string[]):Promise<RelevanceResult>{
  const raw=await llm.complete({model,json:true,system:'你是法律课堂内容相关性分类器。结合前后文判断。生活事实若用于解释法律概念必须归 substantive_legal。课程管理归 course_context，闲聊归 small_talk，残句归 uncertain。只输出 JSON。',prompt:`前文：\n${context.slice(-6).join('\n')}\n\n当前最终转写：\n${text}\n\n输出 {"category":"...","confidence":0-1,"rationale":"..."}`});
  return parseJson(raw,aiSchema);
}
