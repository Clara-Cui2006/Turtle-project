import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import type { TurtleDatabase } from './database.js';

export const MAX_IMPORT_SIZE = 10 * 1024 * 1024;

export async function parseImport(filename: string, buffer: Buffer): Promise<{ type: string; chunks: { heading: string; content: string }[]; hash: string }> {
  if (buffer.length > MAX_IMPORT_SIZE) throw new Error('文件超过 10MB 限制');
  const extension = filename.toLowerCase().split('.').pop();
  if (extension === 'doc') throw new Error('当前版本支持 `.docx`，请使用 Word 将文件另存为 `.docx` 后重新导入。');
  if (!['txt','md','docx'].includes(extension ?? '')) throw new Error('仅支持 TXT、Markdown 和 DOCX 文件');
  let text: string;
  if (extension === 'docx') {
    const html = (await mammoth.convertToHtml({ buffer })).value;
    text = html
      .replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gis, (_all, level: string, value: string) => `${'#'.repeat(Number(level))} ${value}\n\n`)
      .replace(/<li[^>]*>(.*?)<\/li>/gis, '- $1\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }
  else text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('文件中没有可导入的文字');
  const chunks: { heading: string; content: string }[] = [];
  let heading = '';
  for (const part of text.split(/\n{2,}/)) {
    const clean = part.trim(); if (!clean) continue;
    const match = /^(#{1,6})\s+(.+)/.exec(clean);
    if (match) { heading = match[2] ?? ''; continue; }
    chunks.push({ heading, content: clean });
  }
  if (!chunks.length) chunks.push({ heading, content: text.trim() });
  return { type: extension!, chunks, hash: createHash('sha256').update(buffer).digest('hex') };
}

const safeName = (value: string) => [...value].map((character) => character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(character) ? '_' : character).join('').slice(0, 80);

export async function exportSession(db: TurtleDatabase, sessionId: string, format: 'docx'|'md'|'txt', scope: string) {
  const session = db.getSession(sessionId); if (!session) throw new Error('课堂不存在');
  const course = db.listCourses().find((item) => item.id === session.courseId);
  const notes = db.getNotes(sessionId), transcripts = db.listTranscripts(sessionId), qa = db.listQa(sessionId);
  const include = (part: string) => scope === 'package' || scope === part || (scope === 'notes' && ['full','outline'].includes(part));
  const sections: { title: string; lines: string[] }[] = [{ title: session.name, lines: [`课程：${course?.name ?? ''}`, `日期：${session.date}`, `教师：${session.teacher || course?.teacher || ''}`] }];
  for (const note of notes) if (include(note.type)) sections.push({ title: note.type === 'full' ? '完整版笔记' : '提纲版笔记', lines: note.blocks.flatMap((b) => [b.section, b.content]) });
  if (include('transcript')) sections.push({ title: '完整转写', lines: transcripts.map((t) => `[${t.startedAt}]${t.important ? ' [重点]' : ''} ${t.text}`) });
  if (include('qa')) {
    for (const source of ['auto','manual']) { const items = qa.filter((q) => q.source === source); if (items.length) sections.push({ title: source === 'auto' ? '自动问答' : '手动问答', lines: items.flatMap((q) => [`问题：${q.question}`, `回答：${q.answer}`, `课堂依据：${q.evidence}`, `加入笔记：${q.status}`]) }); }
  }
  const nonempty = sections.filter((s) => s.lines.some(Boolean));
  const base = `${safeName(course?.name ?? '课程')}-${safeName(session.name)}-${session.date}`;
  if (format === 'docx') {
    const children = nonempty.flatMap((section, index) => [new Paragraph({ text: section.title, heading: index === 0 ? HeadingLevel.TITLE : HeadingLevel.HEADING_1 }), ...section.lines.filter(Boolean).map((line) => new Paragraph(/^[-•]/.test(line) ? { children: [new TextRun(line.replace(/^[-•]\s*/,''))], bullet: { level: 0 } } : { children: [new TextRun(line)] }))]);
    return { buffer: await Packer.toBuffer(new Document({ sections: [{ children }] })), filename: `${base}.docx`, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  const marker = format === 'md' ? '# ' : '';
  const text = nonempty.map((s) => `${marker}${s.title}\n\n${s.lines.join('\n\n')}`).join('\n\n');
  return { buffer: Buffer.from(text, 'utf8'), filename: `${base}.${format}`, contentType: format === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8' };
}
