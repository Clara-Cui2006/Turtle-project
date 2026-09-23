import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mammoth from 'mammoth';
import { BorderStyle, Document, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, UnderlineType } from 'docx';
import type { TurtleDatabase } from './database.js';

export const MAX_IMPORT_SIZE = 10 * 1024 * 1024;

export async function parseImport(filename:string,buffer:Buffer):Promise<{type:string;chunks:{heading:string;content:string}[];hash:string}>{
  if(buffer.length>MAX_IMPORT_SIZE)throw new Error('文件超过 10MB 限制');
  const extension=filename.toLowerCase().split('.').pop();
  if(extension==='doc')throw new Error('当前版本支持 `.docx`，请使用 Word 将文件另存为 `.docx` 后重新导入。');
  if(!['txt','md','docx'].includes(extension??''))throw new Error('仅支持 TXT、Markdown 和 DOCX 文件');
  let text:string;
  if(extension==='docx'){
    const html=(await mammoth.convertToHtml({buffer})).value;
    text=html.replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gis,(_all,level:string,value:string)=>`${'#'.repeat(Number(level))} ${value}\n\n`).replace(/<li[^>]*>(.*?)<\/li>/gis,'- $1\n').replace(/<\/p>/gi,'\n\n').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
  }else text=buffer.toString('utf8').replace(/^\uFEFF/,'');
  if(!text.trim())throw new Error('文件中没有可导入的文字');
  const chunks:{heading:string;content:string}[]=[];let heading='';
  for(const part of text.split(/\n{2,}/)){const clean=part.trim();if(!clean)continue;const match=/^(#{1,6})\s+(.+)/.exec(clean);if(match){heading=match[2]??'';continue;}chunks.push({heading,content:clean});}
  if(!chunks.length)chunks.push({heading,content:text.trim()});
  return{type:extension!,chunks,hash:createHash('sha256').update(buffer).digest('hex')};
}

const safeName=(value:string)=>[...value].map((character)=>character.charCodeAt(0)<32||/[<>:"/\\|?*]/.test(character)?'_':character).join('').slice(0,80);
const textFrom=(node:any):string=>typeof node?.text==='string'?node.text:Array.isArray(node?.content)?node.content.map(textFrom).join(node.type==='doc'?'\n':''):'';

function richDocxChildren(db:TurtleDatabase,content:any):Array<Paragraph|Table>{
  const counters=[0,0,0,0];
  const chinese=['〇','一','二','三','四','五','六','七','八','九','十'];
  const numeral=(value:number)=>value<=10?(chinese[value]??String(value)):String(value);
  const headingPrefix=(level:number)=>{counters[level-1]=(counters[level-1]??0)+1;for(let index=level;index<4;index++)counters[index]=0;return level===1?`${numeral(counters[0]??0)}、`:level===2?`（${numeral(counters[1]??0)}）`:level===3?`${counters[2]??0}. `:`（${counters[3]??0}）`;};
  const run=(child:any)=>new TextRun({text:child.text??'',bold:Boolean(child.marks?.some((mark:any)=>mark.type==='bold')),italics:Boolean(child.marks?.some((mark:any)=>mark.type==='italic')),...(child.marks?.some((mark:any)=>mark.type==='underline')?{underline:{type:UnderlineType.SINGLE}}:{}),...(child.marks?.some((mark:any)=>mark.type==='highlight')?{highlight:'yellow' as const}:{})});
  const paragraphRuns=(node:any):TextRun[]=>Array.isArray(node?.content)?node.content.flatMap((child:any)=>child.type==='text'?[run(child)]:[]):[];
  const render=(node:any):Array<Paragraph|Table>=>{
    if(!node)return[];
    if(node.type==='heading'){const level=Math.max(1,Math.min(4,Number(node.attrs?.level??2)));const heading=[HeadingLevel.HEADING_1,HeadingLevel.HEADING_2,HeadingLevel.HEADING_3,HeadingLevel.HEADING_4][level-1]!;return[new Paragraph({heading,children:[new TextRun({text:headingPrefix(level),bold:true}),...paragraphRuns(node)]})];}
    if(node.type==='paragraph')return[new Paragraph({children:paragraphRuns(node)})];
    if(node.type==='blockquote')return[new Paragraph({indent:{left:420},border:{left:{style:BorderStyle.SINGLE,size:10,color:'769685'}},children:(node.content??[]).flatMap(paragraphRuns)})];
    if(node.type==='horizontalRule')return[new Paragraph({border:{bottom:{style:BorderStyle.SINGLE,size:6,color:'AEBBB5'}}})];
    if(node.type==='bulletList'||node.type==='orderedList')return(node.content??[]).map((item:any,index:number)=>new Paragraph(node.type==='bulletList'?{bullet:{level:0},children:[new TextRun(textFrom(item))]}:{children:[new TextRun(`${index+1}. ${textFrom(item)}`)]}));
    if(node.type==='table')return[new Table({rows:(node.content??[]).map((row:any)=>new TableRow({children:(row.content??[]).map((cell:any)=>new TableCell({children:(cell.content??[]).flatMap((child:any)=>render(child))}))}))})];
    if(node.type==='image'){
      const match=/\/api\/editor-assets\/([^/]+)\/content/.exec(node.attrs?.src??''),asset=match?db.getEditorAsset(match[1]!):undefined;
      if(!asset||asset.mime_type==='image/webp')return[new Paragraph(`[图片无法嵌入 Word] ${node.attrs?.alt??asset?.filename??''}`)];
      const type=asset.mime_type==='image/jpeg'?'jpg':asset.mime_type==='image/gif'?'gif':'png';
      return[new Paragraph({children:[new ImageRun({data:readFileSync(asset.path),type,transformation:{width:480,height:320},altText:{title:node.attrs?.alt??asset.filename,description:node.attrs?.alt??'',name:asset.filename}})]})];
    }
    return[new Paragraph({children:[new TextRun(textFrom(node))]})];
  };
  return(content?.content??[]).flatMap(render);
}

export async function exportSession(db:TurtleDatabase,sessionId:string,format:'docx'|'md'|'txt',scope:string){
  const session=db.getSession(sessionId);if(!session)throw new Error('课堂不存在');
  const course=db.listCourses().find((item)=>item.id===session.courseId),notes=db.getNoteDocuments(sessionId),transcripts=db.listTranscripts(sessionId),qa=db.listQa(sessionId);
  const include=(part:string)=>scope==='package'||scope===part||(scope==='notes'&&['full','outline'].includes(part));
  const sections:{title:string;lines:string[];content?:any}[]=[{title:session.name,lines:[`课程：${course?.name??''}`,`日期：${session.date}`,`教师：${session.teacher||course?.teacher||''}`]}];
  for(const note of notes)if(include(note.type))sections.push({title:note.type==='full'?'完整版笔记':'提纲版笔记',lines:(note.content as any)?.content?.map(textFrom).filter(Boolean)??[],content:note.content});
  if(include('transcript'))sections.push({title:'完整转写',lines:transcripts.map((item)=>`[${item.startedAt}]${item.important?' [重点]':''} ${item.text}`)});
  if(include('qa'))for(const source of ['auto','manual']){const items=qa.filter((item)=>item.source===source);if(items.length)sections.push({title:source==='auto'?'自动问答':'手动问答',lines:items.flatMap((item)=>[`问题：${item.question}`,`回答：${item.answer}`,`课堂依据：${item.evidence}`,`加入笔记：${item.status}`])});}
  const nonempty=sections.filter((section)=>section.lines.some(Boolean)||section.content),base=`${safeName(course?.name??'课程')}-${safeName(session.name)}-${session.date}`;
  if(format==='docx'){
    const children:Array<Paragraph|Table>=[];
    nonempty.forEach((section,index)=>{children.push(new Paragraph({text:section.title,heading:index===0?HeadingLevel.TITLE:HeadingLevel.HEADING_1}));if(section.content)children.push(...richDocxChildren(db,section.content));else for(const line of section.lines.filter(Boolean))children.push(new Paragraph({children:[new TextRun(line)]}));});
    return{buffer:await Packer.toBuffer(new Document({sections:[{children}]})),filename:`${base}.docx`,contentType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
  }
  const marker=format==='md'?'# ':'',text=nonempty.map((section)=>`${marker}${section.title}\n\n${section.lines.join('\n\n')}`).join('\n\n');
  return{buffer:Buffer.from(text,'utf8'),filename:`${base}.${format}`,contentType:format==='md'?'text/markdown; charset=utf-8':'text/plain; charset=utf-8'};
}
