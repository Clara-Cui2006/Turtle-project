import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import UniqueID from '@tiptap/extension-unique-id';
import type { NoteDocumentV2 } from '@turtle/shared';
import { api } from './api';
import { durableJson } from './outbox';

interface Props{document:NoteDocumentV2;sessionId:string;onSaved(document:NoteDocumentV2):void;onError(error:unknown):void}
const extensions=[StarterKit.configure({heading:{levels:[1,2,3,4]}}),Underline,Highlight.configure({multicolor:false}),Link.configure({openOnClick:false,autolink:true}),Image.configure({allowBase64:false,inline:false}),TableKit.configure({table:{resizable:true}}),UniqueID.configure({attributeName:'nodeId',types:['heading','paragraph','bulletList','orderedList','blockquote','horizontalRule','table','image']})];

export function RichNoteEditor({document,sessionId,onSaved,onError}:Props){
  const [saveState,setSaveState]=useState('已保存'),[find,setFind]=useState('');const version=useRef(document.version),timer=useRef<number|null>(null),file=useRef<HTMLInputElement|null>(null),pending=useRef(false);
  const editor=useEditor({extensions,content:document.content as JSONContent,editorProps:{attributes:{class:'rich-document',spellcheck:'true'},handlePaste:(_view,event)=>{const image=Array.from(event.clipboardData?.files??[]).find((item)=>item.type.startsWith('image/'));if(image){void upload(image);return true;}return false;},handleDrop:(_view,event)=>{const image=Array.from(event.dataTransfer?.files??[]).find((item)=>item.type.startsWith('image/'));if(image){event.preventDefault();void upload(image);return true;}return false;}},onUpdate:({editor})=>{pending.current=true;setSaveState('等待保存');if(timer.current)window.clearTimeout(timer.current);timer.current=window.setTimeout(()=>void save(editor.getJSON()),700);}});
  useEffect(()=>{version.current=document.version;if(editor&&!editor.isFocused)editor.commands.setContent(document.content as JSONContent,{emitUpdate:false});},[document.id,document.version]);
  useEffect(()=>{const flush=()=>{if(globalThis.document.visibilityState==='hidden'&&pending.current&&editor)void save(editor.getJSON());};globalThis.document.addEventListener('visibilitychange',flush);return()=>{globalThis.document.removeEventListener('visibilitychange',flush);if(timer.current)window.clearTimeout(timer.current);if(pending.current&&editor)void save(editor.getJSON());};},[editor,document.id]);
  async function save(content:JSONContent){if(timer.current)window.clearTimeout(timer.current);timer.current=null;setSaveState('正在保存');try{const optimistic={...document,content,version:version.current+1,updatedAt:new Date().toISOString()};const result=await durableJson<NoteDocumentV2>(`/api/note-documents/${document.id}`,{method:'PATCH',body:JSON.stringify({baseVersion:version.current,content})},optimistic);version.current=result.value.version;pending.current=false;setSaveState(result.queued?'已存入本地待同步队列':'已保存');onSaved(result.value);}catch(error){setSaveState('保存冲突，原文未覆盖');onError(error);}}
  async function upload(image:File){const form=new FormData();form.append('file',image);form.append('sessionId',sessionId);form.append('altText',image.name);try{const asset=await api<{url:string;altText:string}>('/api/editor-assets',{method:'POST',body:form});editor?.chain().focus().setImage({src:asset.url,alt:asset.altText}).run();}catch(error){onError(error);}}
  function setLink(){const href=prompt('链接地址（仅在当前文档中显示）',editor?.getAttributes('link').href??'https://');if(href===null)return;if(!href)editor?.chain().focus().unsetLink().run();else editor?.chain().focus().extendMarkRange('link').setLink({href}).run();}
  function runFind(){if(!editor||!find)return;const text=editor.state.doc.textBetween(0,editor.state.doc.content.size,'\n');const index=text.indexOf(find);if(index>=0)editor.chain().focus().setTextSelection({from:index+1,to:index+1+find.length}).run();}
  if(!editor)return <div className="empty">正在加载编辑器…</div>;
  const button=(label:string,action:()=>void,active=false)=><button type="button" className={active?'active':''} onMouseDown={(event)=>{event.preventDefault();action();}}>{label}</button>;
  return <div className="rich-editor-shell"><div className="editor-toolbar" role="toolbar" aria-label="笔记格式工具栏">
    {button('撤销',()=>editor.chain().focus().undo().run())}{button('重做',()=>editor.chain().focus().redo().run())}{[1,2,3,4].map((level)=>button(`H${level}`,()=>editor.chain().focus().toggleHeading({level:level as 1|2|3|4}).run(),editor.isActive('heading',{level})))}
    {button('正文',()=>editor.chain().focus().setParagraph().run(),editor.isActive('paragraph'))}{button('粗体',()=>editor.chain().focus().toggleBold().run(),editor.isActive('bold'))}{button('斜体',()=>editor.chain().focus().toggleItalic().run(),editor.isActive('italic'))}{button('下划线',()=>editor.chain().focus().toggleUnderline().run(),editor.isActive('underline'))}{button('高亮',()=>editor.chain().focus().toggleHighlight().run(),editor.isActive('highlight'))}
    {button('项目符号',()=>editor.chain().focus().toggleBulletList().run(),editor.isActive('bulletList'))}{button('编号',()=>editor.chain().focus().toggleOrderedList().run(),editor.isActive('orderedList'))}{button('引用',()=>editor.chain().focus().toggleBlockquote().run(),editor.isActive('blockquote'))}{button('分隔线',()=>editor.chain().focus().setHorizontalRule().run())}{button('链接',setLink,editor.isActive('link'))}
    {button('插入表格',()=>editor.chain().focus().insertTable({rows:3,cols:3,withHeaderRow:true}).run())}{button('加行',()=>editor.chain().focus().addRowAfter().run())}{button('删行',()=>editor.chain().focus().deleteRow().run())}{button('加列',()=>editor.chain().focus().addColumnAfter().run())}{button('删列',()=>editor.chain().focus().deleteColumn().run())}{button('合并',()=>editor.chain().focus().mergeCells().run())}{button('拆分',()=>editor.chain().focus().splitCell().run())}
    {button('图片',()=>file.current?.click())}<input ref={file} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event)=>{const selected=event.target.files?.[0];if(selected)void upload(selected);event.currentTarget.value='';}}/><span className="editor-save-state">{saveState}</span>
  </div><div className="editor-find"><input value={find} onChange={(event)=>setFind(event.target.value)} onKeyDown={(event)=>{if(event.key==='Enter')runFind();}} placeholder="查找文档"/><button onClick={runFind}>查找</button></div><EditorContent editor={editor}/></div>;
}
