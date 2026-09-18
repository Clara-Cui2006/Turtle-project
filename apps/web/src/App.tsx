import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import type { ClassSession, Course, NoteBlock, NoteDocument, QaItem, SettingsInput, TranscriptSegment } from '@turtle/shared';
import { DEFAULT_SETTINGS } from '@turtle/shared';
import { api, download } from './api';
import { BrowserTranscriptionProvider, createBrowserRecognition, type SpeechStatus } from './speech';

type PublicSettings = SettingsInput & { apiKeyConfigured: boolean; maskedApiKey: string };
type SessionDetail = ClassSession & { transcripts: TranscriptSegment[]; notes: NoteDocument[]; qa: QaItem[] };
type DocumentInfo = { id: string; course_id: string | null; name: string; file_type: string; size: number; created_at: string };
type SearchResult = { sourceType: string; sourceId: string; title: string; snippet: string; relevance: number };
type RightTab = 'full'|'outline'|'qa'|'ask';

const speechLabels: Record<SpeechStatus,string> = { idle:'尚未开始', requesting:'正在申请麦克风权限', listening:'正在监听', paused:'已暂停', recovering:'正在恢复', unsupported:'浏览器不支持', denied:'麦克风权限被拒绝', error:'语音识别异常' };
const qaStatus: Record<string,string> = { none:'未加入笔记', full:'已加入完整版', outline:'已加入提纲版', both:'已加入两个版本' };
const shortcuts = ['总结最近5分钟','总结最近10分钟','老师刚才的核心观点是什么','找出刚才提到的法条','找出刚才提到的案例','这一部分有哪些易错点','当前内容与以前课程有什么联系','当前笔记可能遗漏了什么','生成复习问题'];
const localDate = () => new Date().toLocaleDateString('sv-SE');
const time = (value: string | null) => value ? new Date(value).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '';

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose(): void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section className="modal" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button onClick={onClose}>关闭</button></header>{children}</section></div>;
}

export function App() {
  const [courses,setCourses] = useState<Course[]>([]);
  const [sessions,setSessions] = useState<ClassSession[]>([]);
  const [documents,setDocuments] = useState<DocumentInfo[]>([]);
  const [courseId,setCourseId] = useState('');
  const [detail,setDetail] = useState<SessionDetail|null>(null);
  const [settings,setSettings] = useState<PublicSettings>({ ...DEFAULT_SETTINGS, apiKeyConfigured:false, maskedApiKey:'' });
  const [status,setStatus] = useState<SpeechStatus>('idle');
  const [statusDetail,setStatusDetail] = useState('');
  const [interim,setInterim] = useState('');
  const [message,setMessage] = useState('已保存');
  const [rightTab,setRightTab] = useState<RightTab>('full');
  const [settingsOpen,setSettingsOpen] = useState(false);
  const [importOpen,setImportOpen] = useState(false);
  const [question,setQuestion] = useState('');
  const [asking,setAsking] = useState(false);
  const [streamText,setStreamText] = useState('');
  const [search,setSearch] = useState('');
  const [results,setResults] = useState<SearchResult[]>([]);
  const [autoScroll,setAutoScroll] = useState(true);
  const [duration,setDuration] = useState('00:00:00');
  const provider = useRef<BrowserTranscriptionProvider|null>(null);
  const askController = useRef<AbortController|null>(null);
  const transcriptBox = useRef<HTMLDivElement|null>(null);

  const showError = useCallback((error: unknown) => { const text = error instanceof Error ? error.message : '操作失败'; setMessage(`保存失败：${text}`); },[]);
  const refreshLists = useCallback(async () => {
    const [nextCourses,nextSessions,nextSettings,nextDocuments,state] = await Promise.all([
      api<Course[]>('/api/courses'),api<ClassSession[]>('/api/sessions'),api<PublicSettings>('/api/settings'),api<DocumentInfo[]>('/api/documents'),api<{currentSessionId:string|null;activeSessions:ClassSession[]}>('/api/state')
    ]);
    setCourses(nextCourses); setSessions(nextSessions); setSettings(nextSettings); setDocuments(nextDocuments);
    const selected = state.currentSessionId ?? nextSessions[0]?.id;
    if (selected) { const value = await api<SessionDetail>(`/api/sessions/${selected}`); setDetail(value); setCourseId(value.courseId); }
    else setCourseId(nextCourses[0]?.id ?? '');
  },[]);
  const reloadDetail = useCallback(async () => { if (detail) setDetail(await api<SessionDetail>(`/api/sessions/${detail.id}`)); },[detail]);

  useEffect(() => { refreshLists().catch(showError); },[refreshLists,showError]);
  useEffect(() => {
    provider.current?.stop();
    provider.current = new BrowserTranscriptionProvider(createBrowserRecognition(), {
      onInterim:setInterim,
      onStatus:(next,info) => { setStatus(next); setStatusDetail(info ?? ''); },
      onFinal:(text) => {
        if (!detail) return;
        const stamp = new Date().toISOString(); setMessage('正在保存');
        api<TranscriptSegment>(`/api/sessions/${detail.id}/transcripts`,{method:'POST',body:JSON.stringify({startedAt:stamp,endedAt:stamp,text,clientResultId:crypto.randomUUID()})})
          .then((segment) => { setDetail((current) => current ? {...current,transcripts:[...current.transcripts.filter((item) => item.id !== segment.id),segment]} : current); setMessage('已保存'); window.setTimeout(() => reloadDetail().catch(showError),800); })
          .catch(showError);
      }
    });
    return () => provider.current?.stop();
  },[detail?.id]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!detail?.startedAt) return;
      const end = detail.endedAt ? Date.parse(detail.endedAt) : Date.now(); const seconds = Math.max(0,Math.floor((end-Date.parse(detail.startedAt))/1000));
      setDuration([Math.floor(seconds/3600),Math.floor(seconds%3600/60),seconds%60].map((v) => String(v).padStart(2,'0')).join(':'));
    },1000); return () => window.clearInterval(timer);
  },[detail?.startedAt,detail?.endedAt]);
  useEffect(() => { if (autoScroll && transcriptBox.current) transcriptBox.current.scrollTop = transcriptBox.current.scrollHeight; },[detail?.transcripts,interim,autoScroll]);

  const currentCourse = courses.find((c) => c.id === (detail?.courseId || courseId));
  const courseSessions = sessions.filter((s) => !courseId || s.courseId === courseId);
  const note = (type: 'full'|'outline') => detail?.notes.find((n) => n.type === type);
  const aiLabel = settings.apiKeyConfigured ? 'DeepSeek 可用' : 'DeepSeek 未配置';

  async function openSession(id:string) { provider.current?.stop(); const value = await api<SessionDetail>(`/api/sessions/${id}`); setDetail(value); setCourseId(value.courseId); setStatus('idle'); }
  async function newCourse() { const name = prompt('课程名称'); if (!name?.trim()) return; const teacher = prompt('授课教师（可留空）') ?? ''; const value = await api<Course>('/api/courses',{method:'POST',body:JSON.stringify({name,teacher,description:'',tags:[]})}); setCourses((items) => [value,...items]); setCourseId(value.id); }
  async function editCourse(course: Course) { const name = prompt('新的课程名称',course.name); if (!name?.trim()) return; const value = await api<Course>(`/api/courses/${course.id}`,{method:'PATCH',body:JSON.stringify({name})}); setCourses((items) => items.map((item) => item.id === value.id ? value : item)); }
  async function deleteCourse(course: Course) { if (!confirm(`删除课程“${course.name}”及其全部课堂、转写、笔记和问答？此操作不可撤销。`)) return; await api(`/api/courses/${course.id}`,{method:'DELETE'}); if (detail?.courseId === course.id) setDetail(null); await refreshLists(); }
  async function newSession() { if (!courseId) { alert('请先新建课程'); return; } const name = prompt('课堂名称',`${localDate()} 课堂`); if (!name?.trim()) return; const course = courses.find((c) => c.id === courseId); const value = await api<ClassSession>('/api/sessions',{method:'POST',body:JSON.stringify({courseId,name,date:localDate(),teacher:course?.teacher ?? '',tags:[],remarks:'',legalTerms:''})}); setSessions((items) => [value,...items]); await openSession(value.id); }
  async function editSession(session: ClassSession) { const name = prompt('新的课堂名称',session.name); if (!name?.trim()) return; await api(`/api/sessions/${session.id}`,{method:'PATCH',body:JSON.stringify({name})}); await refreshLists(); }
  async function deleteSession(session: ClassSession) { if (!confirm(`删除课堂“${session.name}”及其转写、笔记和问答？此操作不可撤销。`)) return; await api(`/api/sessions/${session.id}`,{method:'DELETE'}); if (detail?.id === session.id) setDetail(null); await refreshLists(); }
  async function changeSessionStatus(next: 'active'|'paused'|'ended') { if (!detail) return; const payload: Record<string,unknown> = {status:next}; if (next === 'ended') payload.endedAt = new Date().toISOString(); if (next === 'active' && detail.status === 'ended') payload.endedAt = null; const value = await api<ClassSession>(`/api/sessions/${detail.id}`,{method:'PATCH',body:JSON.stringify(payload)}); setDetail({...detail,...value}); }
  async function startSpeech() { if (!detail) return alert('请先新建课堂'); if (detail.status === 'ended' && !confirm('这是一节已结束课堂。要明确继续本节课堂并追加转写吗？')) return; if (detail.status !== 'active') await changeSessionStatus('active'); provider.current?.start(); }
  async function pauseSpeech() { provider.current?.pause(); await changeSessionStatus('paused'); }
  async function endClass() { if (!detail || !confirm('确定结束本节课堂？全部内容会保存在本机。')) return; provider.current?.stop(); await changeSessionStatus('ended'); }
  async function updateTranscript(segment:TranscriptSegment) { const text = prompt('编辑转写（编辑后将锁定，不会被识别结果覆盖）',segment.text); if (!text?.trim() || text === segment.text) return; const value = await api<TranscriptSegment>(`/api/transcripts/${segment.id}`,{method:'PATCH',body:JSON.stringify({text})}); setDetail((d) => d ? {...d,transcripts:d.transcripts.map((t) => t.id === value.id ? value : t)} : d); }
  async function toggleImportant(segment:TranscriptSegment) { const value = await api<TranscriptSegment>(`/api/transcripts/${segment.id}`,{method:'PATCH',body:JSON.stringify({important:!segment.important})}); setDetail((d) => d ? {...d,transcripts:d.transcripts.map((t) => t.id === value.id ? value : t)} : d); }
  async function saveBlock(block:NoteBlock,content:string) { if (content === block.content) return; await api(`/api/note-blocks/${block.id}`,{method:'PATCH',body:JSON.stringify({content})}); await reloadDetail(); }
  async function forceNotes() { if (!detail) return; setMessage('正在整理笔记'); try { await api(`/api/sessions/${detail.id}/notes/update`,{method:'POST',body:JSON.stringify({force:true})}); await reloadDetail(); setMessage('更新完成'); } catch (error) { showError(error); } }
  async function undoNote(type:'full'|'outline') { const doc = note(type); if (!doc) return; await api(`/api/notes/${doc.id}/undo`,{method:'POST'}); await reloadDetail(); }
  async function submitQuestion(value=question) {
    if (!detail || !value.trim()) return; if (!settings.apiKeyConfigured) { setSettingsOpen(true); return; }
    setQuestion(''); setAsking(true); setStreamText('');
    try {
      if(settings.stream){
        const controller=new AbortController();askController.current=controller;
        const response=await fetch(`/api/sessions/${detail.id}/questions/stream`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:value,source:'manual'}),signal:controller.signal});
        if(!response.ok)throw new Error(((await response.json()) as {error?:{message?:string}}).error?.message||'生成失败');
        const reader=response.body?.getReader(),decoder=new TextDecoder();let buffer='';
        while(reader){const {done,value:valueChunk}=await reader.read();if(done)break;buffer+=decoder.decode(valueChunk,{stream:true});const events=buffer.split('\n\n');buffer=events.pop()??'';for(const event of events){const data=event.replace(/^data:\s*/,'').trim();if(!data||data==='[DONE]')continue;const payload=JSON.parse(data) as {chunk?:string;error?:string};if(payload.error)throw new Error(payload.error);if(payload.chunk)setStreamText((current)=>current+payload.chunk);}}
      }else await api(`/api/sessions/${detail.id}/questions`,{method:'POST',body:JSON.stringify({question:value,source:'manual'})});
      await reloadDetail(); setRightTab('qa');
    } catch(error) { if((error as Error).name!=='AbortError')showError(error); }
    finally { setAsking(false);askController.current=null; }
  }
  async function addQa(id:string,target:'full'|'outline'|'both') { await api(`/api/questions/${id}/add-to-note`,{method:'POST',body:JSON.stringify({target})}); await reloadDetail(); }
  async function removeQa(id:string) { await api(`/api/questions/${id}/from-note`,{method:'DELETE'}); await reloadDetail(); }
  async function updateQa(item:QaItem,field:'question'|'answer') { const value = prompt(field === 'question' ? '编辑问题' : '编辑答案',item[field]); if (value === null) return; await api(`/api/questions/${item.id}`,{method:'PATCH',body:JSON.stringify({[field]:value})}); await reloadDetail(); }
  async function runSearch(event:FormEvent) { event.preventDefault(); if (!search.trim()) return setResults([]); setResults(await api<SearchResult[]>(`/api/search?q=${encodeURIComponent(search)}${detail ? `&sessionId=${detail.id}&courseId=${detail.courseId}` : ''}`)); }
  async function addManualBlock(type:'full'|'outline'){const doc=note(type);if(!doc)return;const section=prompt('章节标题',type==='full'?'用户补充':'补充要点');if(!section?.trim())return;const content=prompt('笔记内容');if(!content?.trim())return;await api(`/api/notes/${doc.id}/blocks`,{method:'POST',body:JSON.stringify({section,content})});await reloadDetail();}
  function onTranscriptScroll() { const box=transcriptBox.current; if (box && box.scrollHeight-box.scrollTop-box.clientHeight>80) setAutoScroll(false); }

  return <div className="app-shell">
    <header className="toolbar">
      <div className="brand"><span className="turtle">龟</span><div><strong>课堂实时助手</strong><small>{currentCourse?.name ?? '未选择课程'} · {detail?.name ?? '未选择课堂'}</small></div></div>
      <div className="status-strip"><span>{new Date().toLocaleDateString('zh-CN')}</span><span className={`status ${status}`}>{speechLabels[status]}</span><span className={`status ${settings.apiKeyConfigured?'ok':'muted'}`}>{aiLabel}</span><span className="timer">{duration}</span></div>
      <div className="toolbar-actions">
        {status !== 'listening' ? <button className="primary" onClick={startSpeech}>{status === 'paused' ? '继续转写' : '开始转写'}</button> : <button onClick={pauseSpeech}>暂停转写</button>}
        <button onClick={endClass} disabled={!detail || detail.status === 'ended'}>结束课堂</button>
        <button onClick={() => setImportOpen(true)}>导入</button><ExportButton session={detail} onError={showError}/><button onClick={() => setSettingsOpen(true)}>设置</button>
      </div>
    </header>
    {statusDetail && <div className="banner" role="alert">{statusDetail}</div>}
    <main className="workspace">
      <aside className="left-panel">
        <form className="search" onSubmit={runSearch}><label htmlFor="search">全局搜索</label><div><input id="search" value={search} onChange={(e)=>setSearch(e.target.value)} placeholder="课程、法条、案例…"/><button>搜索</button></div></form>
        {results.length>0 && <div className="search-results">{results.map((r)=><article key={`${r.sourceType}-${r.sourceId}`}><strong>{r.title}</strong><p dangerouslySetInnerHTML={{__html:r.snippet}}/></article>)}</div>}
        <div className="section-title"><h2>课程</h2><button onClick={newCourse}>新建课程</button></div>
        <nav className="course-list" aria-label="课程列表">{courses.map((course)=><div className={`nav-row ${course.id===courseId?'selected':''}`} key={course.id}><button className="nav-main" onClick={()=>setCourseId(course.id)}>{course.name}<small>{course.teacher || '未填写教师'}</small></button><button title="重命名课程" onClick={()=>editCourse(course)}>改</button><button className="danger-text" title="删除课程" onClick={()=>deleteCourse(course)}>删</button></div>)}</nav>
        <div className="section-title"><h2>课堂</h2><button onClick={newSession} disabled={!courseId}>新建课堂</button></div>
        <nav className="session-list" aria-label="历史课堂">{courseSessions.map((session)=><div className={`nav-row ${session.id===detail?.id?'selected':''}`} key={session.id}><button className="nav-main" onClick={()=>openSession(session.id)}>{session.name}<small>{session.date} · {session.status==='ended'?'已结束':'进行中'}</small></button><button title="重命名课堂" onClick={()=>editSession(session)}>改</button><button className="danger-text" title="删除课堂" onClick={()=>deleteSession(session)}>删</button></div>)}</nav>
        <div className="section-title"><h2>导入资料</h2><span>{documents.length}</span></div>
        <div className="documents">{documents.map((doc)=><div key={doc.id}><span>{doc.name}<small>{doc.file_type.toUpperCase()} · {(doc.size/1024).toFixed(1)}KB</small></span><button className="danger-text" onClick={async()=>{if(confirm('删除该资料的解析内容和全文索引？默认未保存原文件。')){await api(`/api/documents/${doc.id}`,{method:'DELETE'});await refreshLists();}}}>删</button></div>)}</div>
      </aside>

      <section className="transcript-panel">
        <header><div><h1>实时转写</h1><p>{detail ? `${detail.date} · ${detail.teacher || '未填写教师'}` : '新建课程和课堂后即可开始'}</p></div><div><span className="save-state">{message}</span><button onClick={()=>setAutoScroll(!autoScroll)}>自动滚动：{autoScroll?'开':'关'}</button></div></header>
        <div className="transcript-list" ref={transcriptBox} onScroll={onTranscriptScroll}>
          {!detail?.transcripts.length && !interim && <div className="empty"><span>声音会变成可编辑的课堂记录</span><p>仅最终识别结果会保存；原始音频不会保存或发送给 DeepSeek。</p></div>}
          {detail?.transcripts.map((segment)=><article className={segment.important?'important':''} key={segment.id}><time>{time(segment.startedAt)}</time><p>{segment.text}</p><div><button onClick={()=>updateTranscript(segment)}>编辑</button><button onClick={()=>toggleImportant(segment)}>{segment.important?'取消重点':'标记重点'}</button><button onClick={()=>navigator.clipboard.writeText(segment.text)}>复制</button>{segment.userEdited&&<span>用户已编辑并锁定</span>}</div></article>)}
          {interim && <article className="interim"><time>识别中</time><p>{interim}</p></article>}
        </div>
        {!autoScroll && <button className="to-latest" onClick={()=>{setAutoScroll(true);if(transcriptBox.current)transcriptBox.current.scrollTop=transcriptBox.current.scrollHeight;}}>回到最新内容</button>}
      </section>

      <aside className="right-panel">
        <div className="tabs" role="tablist">{([['full','完整版笔记'],['outline','提纲版笔记'],['qa','课堂问答'],['ask','手动提问']] as const).map(([id,label])=><button role="tab" aria-selected={rightTab===id} className={rightTab===id?'active':''} onClick={()=>setRightTab(id)} key={id}>{label}</button>)}</div>
        {(rightTab==='full'||rightTab==='outline') && <NoteView document={note(rightTab)} configured={settings.apiKeyConfigured} onSettings={()=>setSettingsOpen(true)} onUpdate={forceNotes} onUndo={()=>undoNote(rightTab)} onAdd={()=>addManualBlock(rightTab)} onSave={saveBlock}/>}
        {rightTab==='qa' && <QaView items={detail?.qa??[]} onAdd={addQa} onRemove={removeQa} onEdit={updateQa} onReload={reloadDetail}/>}
        {rightTab==='ask' && <div className="ask-panel"><h2>向课堂提问</h2><div className="shortcuts">{shortcuts.map((item)=><button key={item} onClick={()=>submitQuestion(item)}>{item}</button>)}</div><label htmlFor="question">问题</label><textarea id="question" rows={6} value={question} onChange={(e)=>setQuestion(e.target.value)} onKeyDown={(e:KeyboardEvent<HTMLTextAreaElement>)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submitQuestion();}}} placeholder="结合当前课堂、历史课堂和导入资料提问…"/>{streamText&&<div className="stream-answer" aria-live="polite">{streamText}</div>}<button className="primary wide" onClick={()=>submitQuestion()} disabled={asking||!question.trim()}>{asking?'正在生成，可继续转写…':'发送（Enter）'}</button>{asking&&<button className="wide" onClick={()=>askController.current?.abort()}>停止生成</button>}{!settings.apiKeyConfigured&&<button className="link" onClick={()=>setSettingsOpen(true)}>尚未配置 DeepSeek，前往设置</button>}</div>}
      </aside>
    </main>
    {settingsOpen && <SettingsModal value={settings} onClose={()=>setSettingsOpen(false)} onSaved={(value)=>{setSettings(value);setSettingsOpen(false);}} onError={showError}/>}
    {importOpen && <ImportModal courses={courses} selectedCourse={courseId} onClose={()=>setImportOpen(false)} onDone={async()=>{setImportOpen(false);await refreshLists();}} onError={showError}/>}
  </div>;
}

function NoteView({document,configured,onSettings,onUpdate,onUndo,onAdd,onSave}:{document:NoteDocument|undefined;configured:boolean;onSettings():void;onUpdate():void;onUndo():void;onAdd():void;onSave(block:NoteBlock,content:string):void}) {
  return <div className="note-view"><div className="note-tools"><span>{document?.status==='generating'?'正在生成':document?.status==='complete'?'更新完成':document?.status==='failed'?'更新失败，待重试':'等待新内容'}</span><button onClick={onAdd}>新增笔记块</button><button onClick={onUpdate}>立即整理</button><button onClick={onUndo}>撤销更新</button></div>{!configured&&<div className="notice">尚未配置 DeepSeek。仍可手动编辑本地内容。<button onClick={onSettings}>前往设置</button></div>}{document?.blocks.length ? document.blocks.map((block)=><article className="note-block" key={block.id}><label>{block.section}{block.locked&&<span> · 已锁定</span>}</label><textarea defaultValue={block.content} onBlur={(e)=>onSave(block,e.target.value)} rows={Math.max(3,Math.min(12,block.content.split('\n').length+2))}/><small>{block.source==='ai'?'AI 整理':block.source==='qa'?'来自问答':'用户内容'} · 离开输入框自动保存</small></article>) : <div className="empty"><span>笔记尚未生成</span><p>可新增手写笔记；配置 DeepSeek 后，最终转写达到时间或字数阈值会自动增量整理。</p></div>}</div>;
}

function QaView({items,onAdd,onRemove,onEdit,onReload}:{items:QaItem[];onAdd(id:string,target:'full'|'outline'|'both'):void;onRemove(id:string):void;onEdit(item:QaItem,field:'question'|'answer'):void;onReload():void}) {
  return <div className="qa-list">{!items.length&&<div className="empty"><span>尚未发现问题</span><p>系统仅根据最终转写识别完整问题，自动回答默认不会写入正式笔记。</p></div>}{items.map((item)=><details key={item.id} open={!item.archived}><summary><span>{item.source==='auto'?'自动发现':'手动提问'} · {time(item.createdAt)}{item.possibleRhetorical?' · 可能是课堂设问':''}</span><strong>{item.question}</strong></summary><div className="qa-body"><h4>回答</h4><p>{item.answer||'正在生成…'}</p><h4>课堂依据</h4><p>{item.evidence||'课堂记录中未找到直接依据'}</p><small>{qaStatus[item.status]??item.status}</small><div className="qa-actions"><button onClick={()=>onEdit(item,'question')}>编辑问题</button><button onClick={()=>onEdit(item,'answer')}>编辑答案</button><button onClick={()=>navigator.clipboard.writeText(item.answer)}>复制</button><button onClick={()=>onAdd(item.id,'full')}>加入完整版</button><button onClick={()=>onAdd(item.id,'outline')}>加入提纲版</button><button onClick={()=>onAdd(item.id,'both')}>同时加入</button>{item.status!=='none'&&<button onClick={()=>onRemove(item.id)}>从笔记移除</button>}<button onClick={async()=>{await api(`/api/questions/${item.id}`,{method:'PATCH',body:JSON.stringify({archived:!item.archived})});await onReload();}}>{item.archived?'取消归档':'归档'}</button><button onClick={async()=>{await api(`/api/questions/${item.id}/regenerate`,{method:'POST'});await onReload();}}>重新生成</button></div></div></details>)}</div>;
}

function ExportButton({session,onError}:{session:SessionDetail|null;onError(error:unknown):void}) {
  const [open,setOpen]=useState(false); const [format,setFormat]=useState<'docx'|'md'|'txt'>('docx'); const [scope,setScope]=useState('package');
  return <div className="export-menu"><button onClick={()=>setOpen(!open)}>导出</button>{open&&<div><label>格式<select value={format} onChange={(e)=>setFormat(e.target.value as typeof format)}><option value="docx">Word .docx</option><option value="md">Markdown .md</option><option value="txt">纯文本 .txt</option></select></label><label>内容<select value={scope} onChange={(e)=>setScope(e.target.value)}><option value="package">完整课堂包</option><option value="full">只导出完整版</option><option value="outline">只导出提纲版</option><option value="notes">同时导出两版笔记</option><option value="transcript">完整转写</option><option value="qa">课堂问答</option></select></label><button className="primary" disabled={!session} onClick={()=>{if(session)download(`/api/sessions/${session.id}/export`,{format,scope}).then(()=>setOpen(false)).catch(onError);}}>开始导出</button></div>}</div>;
}

function SettingsModal({value,onClose,onSaved,onError}:{value:PublicSettings;onClose():void;onSaved(value:PublicSettings):void;onError(error:unknown):void}) {
  const [form,setForm]=useState<SettingsInput>({...value,apiKey:undefined}); const [key,setKey]=useState(''); const [show,setShow]=useState(false); const [testing,setTesting]=useState('');
  const field=(name:keyof SettingsInput,value:unknown)=>setForm((current)=>({...current,[name]:value}));
  async function save(event:FormEvent){event.preventDefault();try{onSaved(await api<PublicSettings>('/api/settings',{method:'PUT',body:JSON.stringify({...form,...(key?{apiKey:key}:{})})}));}catch(error){onError(error);}}
  async function test(){setTesting('正在连接…');try{const result=await api<{message:string}>('/api/settings/test',{method:'POST',body:JSON.stringify({apiKey:key||undefined,baseUrl:form.baseUrl,model:form.noteModel})});setTesting(result.message);}catch(error){setTesting(error instanceof Error?error.message:'连接失败');}}
  return <Modal title="设置" onClose={onClose}><form className="settings-form" onSubmit={save}><fieldset><legend>DeepSeek</legend><label>AI 服务商<input value="DeepSeek" disabled/></label><label>API Base URL<input value={form.baseUrl} onChange={(e)=>field('baseUrl',e.target.value)}/></label><label>API Key<div className="key-row"><input type={show?'text':'password'} value={key} onChange={(e)=>setKey(e.target.value)} placeholder={value.apiKeyConfigured?`已保存：${value.maskedApiKey}`:'请输入 sk-…'}/><button type="button" onClick={()=>setShow(!show)}>{show?'隐藏':'显示'}</button></div></label><div className="model-grid"><label>普通笔记模型<input value={form.noteModel} onChange={(e)=>field('noteModel',e.target.value)}/></label><label>自动问答模型<input value={form.autoQaModel} onChange={(e)=>field('autoQaModel',e.target.value)}/></label><label>手动问答模型<input value={form.manualQaModel} onChange={(e)=>field('manualQaModel',e.target.value)}/></label><label>深度回答模型<input value={form.deepModel} onChange={(e)=>field('deepModel',e.target.value)}/></label></div><div className="inline-actions"><button type="button" onClick={test}>测试连接</button><span>{testing}</span><button type="button" className="danger-text" onClick={async()=>{await api('/api/settings/api-key',{method:'DELETE'});setKey('');onSaved({...value,apiKeyConfigured:false,maskedApiKey:''});}}>清除 API Key</button></div></fieldset><fieldset><legend>自动处理</legend><div className="checks">{([['stream','流式输出'],['thinking','思考模式'],['autoNotes','自动笔记'],['autoDetectQuestions','自动识别问题'],['autoAnswer','自动生成答案'],['useHistory','自动问答使用历史资料'],['allowGeneralKnowledge','允许模型一般知识（会标注）'],['keepOriginalFiles','保留导入原文件']] as const).map(([name,label])=><label key={name}><input type="checkbox" checked={form[name] as boolean} onChange={(e)=>field(name,e.target.checked)}/>{label}</label>)}</div><div className="model-grid"><label>笔记更新间隔（秒）<input type="number" min="10" max="600" value={form.noteIntervalSeconds} onChange={(e)=>field('noteIntervalSeconds',Number(e.target.value))}/></label><label>笔记触发字数<input type="number" min="100" max="5000" value={form.noteTriggerChars} onChange={(e)=>field('noteTriggerChars',Number(e.target.value))}/></label></div></fieldset><div className="privacy"><strong>隐私说明</strong><p>调用 AI 时，必要的课堂文字、问题和相关笔记会发送给 DeepSeek。原始音频默认不保存，也不发送给 DeepSeek；浏览器语音识别可能使用浏览器厂商的在线服务。本版本不是完全离线软件，数据库和历史课堂主要保存在本机，请勿将本地数据目录提交到 GitHub。</p></div><footer><button type="button" onClick={()=>setForm({...DEFAULT_SETTINGS})}>恢复默认值</button><button className="primary">保存设置</button></footer></form></Modal>;
}

function ImportModal({courses,selectedCourse,onClose,onDone,onError}:{courses:Course[];selectedCourse:string;onClose():void;onDone():void;onError(error:unknown):void}) {
  const [file,setFile]=useState<File|null>(null); const [preview,setPreview]=useState(''); const [courseId,setCourseId]=useState(selectedCourse); const [name,setName]=useState('');
  async function select(next:File){setFile(next);setName(next.name.replace(/\.[^.]+$/,''));if(/\.(txt|md)$/i.test(next.name))setPreview((await next.text()).slice(0,3000));else setPreview('Word 文档将在本机后端安全解析标题、列表和普通段落；不会执行宏、脚本或嵌入对象。');}
  async function submit(){if(!file)return;const form=new FormData();form.append('file',file);form.append('courseId',courseId);form.append('name',name);try{await api('/api/documents/import',{method:'POST',body:form});await onDone();}catch(error){onError(error);}}
  return <Modal title="导入历史资料" onClose={onClose}><div className="import-form"><label className="drop-zone" onDragOver={(e:DragEvent)=>e.preventDefault()} onDrop={(e:DragEvent)=>{e.preventDefault();const next=e.dataTransfer.files[0];if(next)select(next);}}>拖拽 TXT、Markdown 或 DOCX 到这里，或点击选择<input type="file" accept=".txt,.md,.docx,.doc" onChange={(e:ChangeEvent<HTMLInputElement>)=>{const next=e.target.files?.[0];if(next)select(next);}}/></label>{file&&<><div className="file-meta"><strong>{file.name}</strong><span>{file.type||'未知类型'} · {(file.size/1024).toFixed(1)}KB</span></div><label>所属课程<select value={courseId} onChange={(e)=>setCourseId(e.target.value)}><option value="">全局资料</option>{courses.map((c)=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label><label>资料名称<input value={name} onChange={(e)=>setName(e.target.value)}/></label><label>导入预览<textarea readOnly rows={10} value={preview}/></label><button className="primary" onClick={submit}>确认导入</button></>}</div></Modal>;
}
