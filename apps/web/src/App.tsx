import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import type { ClassSession, Course, NoteDocumentV2, QaItem, RelevanceCategory, SettingsInput, TranscriptSegment } from '@turtle/shared';
import { DEFAULT_SETTINGS } from '@turtle/shared';
import { api, download } from './api';
import type { SpeechStatus } from './speech';
import { transcriptionController } from './transcriptionController';
import { durableJson, flushOutbox, loadSnapshot, pendingOutboxCount, saveSnapshot } from './outbox';
import { RichNoteEditor } from './RichNoteEditor';
import turtleNormal from './assets/turtle-normal.png';
import turtleAngryImage from './assets/turtle-angry.png';

type PublicSettings = SettingsInput & { apiKeyConfigured: boolean; maskedApiKey: string };
type SessionDetail = ClassSession & { transcripts: TranscriptSegment[]; noteDocuments: NoteDocumentV2[]; qa: QaItem[] };
type DocumentInfo = { id: string; course_id: string | null; name: string; file_type: string; size: number; created_at: string };
type SearchResult = { sourceType: string; sourceId: string; title: string; snippet: string; relevance: number };
type RecordingInfo = { id:string;sessionId:string;mimeType:string;durationMs:number|null;size:number;createdAt:string };
type BootstrapSnapshot = { courses:Course[];sessions:ClassSession[];settings:PublicSettings;documents:DocumentInfo[];detail:SessionDetail|null;courseId:string;savedAt:string };
type RightTab = 'full'|'outline'|'qa'|'ask';

const speechLabels: Record<SpeechStatus,string> = { idle:'尚未开始', requesting:'正在申请麦克风权限', listening:'正在监听', paused:'已暂停', recovering:'正在恢复', 'recovery-failed':'恢复失败，仍在重试', unsupported:'浏览器不支持', denied:'麦克风权限被拒绝', error:'语音识别异常' };
const relevanceLabels:Record<RelevanceCategory,string>={substantive_legal:'法律课程内容',course_context:'课程提醒',small_talk:'闲聊',uncertain:'待判断'};
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
  const [loadState,setLoadState]=useState<'loading'|'ready'|'error'>('loading');
  const detailRef = useRef<SessionDetail|null>(null);
  const askController = useRef<AbortController|null>(null);
  const transcriptBox = useRef<HTMLDivElement|null>(null);
  const recoveryHandled = useRef(false);
  const [diagnostics,setDiagnostics]=useState<import('./speech').DiagnosticEvent[]>([]);
  const [recordings,setRecordings]=useState<RecordingInfo[]>([]);
  const [outboxCount,setOutboxCount]=useState(0);
  const [turtleAngry,setTurtleAngry]=useState(false);const turtleTimer=useRef<number|null>(null);
  const mediaRecorder=useRef<MediaRecorder|null>(null),recordingStream=useRef<MediaStream|null>(null),recordingStarted=useRef(0);

  const showError = useCallback((error: unknown) => { const text = error instanceof Error ? error.message : '操作失败'; setMessage(`保存失败：${text}`); },[]);
  const restoreSnapshot=useCallback(async()=>{try{const cached=await loadSnapshot<BootstrapSnapshot>('bootstrap');if(!cached)return false;setCourses(cached.courses);setSessions(cached.sessions);setSettings(cached.settings);setDocuments(cached.documents);setDetail(cached.detail);detailRef.current=cached.detail;setCourseId(cached.courseId);setMessage(`本地服务未连接，正在显示 ${new Date(cached.savedAt).toLocaleString('zh-CN')} 的本机缓存`);return true;}catch{return false;}},[]);
  const refreshLists = useCallback(async () => {
    setLoadState('loading');
    const [nextCourses,nextSessions,nextSettings,nextDocuments,state] = await Promise.all([
      api<Course[]>('/api/courses'),api<ClassSession[]>('/api/sessions'),api<PublicSettings>('/api/settings'),api<DocumentInfo[]>('/api/documents'),api<{currentSessionId:string|null;activeSessions:ClassSession[]}>('/api/state')
    ]);
    setCourses(nextCourses); setSessions(nextSessions); setSettings(nextSettings); setDocuments(nextDocuments);
    const selected = state.currentSessionId ?? nextSessions[0]?.id;
    let selectedDetail:SessionDetail|null=null;
    if (selected) {
      let value = await api<SessionDetail>(`/api/sessions/${selected}`);
      if(!recoveryHandled.current){recoveryHandled.current=true;const unfinished=state.activeSessions.some((item)=>item.id===selected);if(unfinished&&!confirm(`发现未正常结束的课堂“${value.name}”。\n\n确定：继续课堂\n取消：结束并保存`)){const ended=await api<ClassSession>(`/api/sessions/${selected}`,{method:'PATCH',body:JSON.stringify({status:'ended',endedAt:new Date().toISOString()})});value={...value,...ended};}}
      selectedDetail=value;setDetail(value);detailRef.current=value;setRecordings(await api<RecordingInfo[]>(`/api/sessions/${selected}/recordings`));setCourseId(value.courseId);
    }
    else {setDetail(null);detailRef.current=null;setCourseId(nextCourses[0]?.id ?? '');}
    void saveSnapshot<BootstrapSnapshot>('bootstrap',{courses:nextCourses,sessions:nextSessions,settings:nextSettings,documents:nextDocuments,detail:selectedDetail,courseId:selectedDetail?.courseId??nextCourses[0]?.id??'',savedAt:new Date().toISOString()}).catch(()=>undefined);setLoadState('ready');
  },[]);
  const reloadDetail = useCallback(async () => { if (detail) {setDetail(await api<SessionDetail>(`/api/sessions/${detail.id}`));setRecordings(await api<RecordingInfo[]>(`/api/sessions/${detail.id}/recordings`));} },[detail]);

  useEffect(() => { refreshLists().catch(async()=>{setLoadState('error');if(!await restoreSnapshot())setMessage('本地服务暂时无法连接，且尚无可恢复的页面缓存');}); },[refreshLists,restoreSnapshot]);
  useEffect(()=>transcriptionController.subscribe((state)=>{setStatus(state.status);setStatusDetail(state.detail);setInterim(state.interim);setDiagnostics(state.events);}),[]);
  useEffect(()=>{detailRef.current=detail;transcriptionController.setSession(detail?.id??null,(text)=>{const current=detailRef.current;if(!current)return;const stamp=new Date().toISOString(),id=crypto.randomUUID(),optimistic:TranscriptSegment={id,sessionId:current.id,startedAt:stamp,endedAt:stamp,originalText:text,text,isFinal:true,userEdited:false,important:false,createdAt:stamp,updatedAt:stamp};setMessage('正在保存');void durableJson<TranscriptSegment>(`/api/sessions/${current.id}/transcripts`,{method:'POST',body:JSON.stringify({startedAt:stamp,endedAt:stamp,text,clientResultId:id})},optimistic).then(({value,queued})=>{setDetail((state)=>state?{...state,transcripts:[...state.transcripts.filter((item)=>item.id!==value.id),value]}:state);setMessage(queued?'网络中断，已进入本地待同步队列':'已保存');if(!queued)window.setTimeout(()=>reloadDetail().catch(showError),1200);}).catch(showError);});},[detail?.id,reloadDetail,showError]);
  useEffect(()=>{void flushOutbox();},[]);
  useEffect(()=>{const update=()=>void pendingOutboxCount().then(setOutboxCount);update();window.addEventListener('turtle-outbox-change',update);return()=>window.removeEventListener('turtle-outbox-change',update);},[]);
  useEffect(()=>{const timer=window.setInterval(()=>{void api<{ok:boolean}>('/api/health').then(async(result)=>{if(result.ok&&loadState==='error')await refreshLists();if(result.ok)await flushOutbox();}).catch(()=>{if(loadState==='ready'){setLoadState('error');setMessage('与本地服务连接中断，未保存操作会进入待同步队列');}});},5000);return()=>window.clearInterval(timer);},[loadState,refreshLists]);
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
  const note = (type: 'full'|'outline') => detail?.noteDocuments.find((n) => n.type === type);
  const aiLabel = loadState==='error' ? '本地服务未连接' : settings.apiKeyConfigured ? 'DeepSeek 可用' : 'DeepSeek 未配置';

  async function openSession(id:string) { const [value,audio] = await Promise.all([api<SessionDetail>(`/api/sessions/${id}`),api<RecordingInfo[]>(`/api/sessions/${id}/recordings`)]); setDetail(value);setRecordings(audio);detailRef.current=value;setCourseId(value.courseId); }
  async function newCourse() { const name = prompt('课程名称'); if (!name?.trim()) return; const teacher = prompt('授课教师（可留空）') ?? ''; const description=prompt('课程描述（可留空）')??'';const tags=(prompt('标签（用逗号分隔，可留空）')??'').split(/[,，]/).map((item)=>item.trim()).filter(Boolean),stamp=new Date().toISOString(),id=crypto.randomUUID(),optimistic:Course={id,name,teacher,description,tags,createdAt:stamp,updatedAt:stamp};const result=await durableJson<Course>('/api/courses',{method:'POST',body:JSON.stringify({id,name,teacher,description,tags})},optimistic);setCourses((items)=>[result.value,...items]);setCourseId(result.value.id);if(result.queued)setMessage('课程已存入本地待同步队列'); }
  async function editCourse(course: Course) { const name = prompt('新的课程名称',course.name); if (!name?.trim()) return; const value = await api<Course>(`/api/courses/${course.id}`,{method:'PATCH',body:JSON.stringify({name})}); setCourses((items) => items.map((item) => item.id === value.id ? value : item)); }
  async function deleteCourse(course: Course) { if (!confirm(`删除课程“${course.name}”及其全部课堂、转写、笔记和问答？此操作不可撤销。`)) return; await api(`/api/courses/${course.id}`,{method:'DELETE'}); if (detail?.courseId === course.id) setDetail(null); await refreshLists(); }
  async function newSession() { if (!courseId) { alert('请先新建课程'); return; } const name = prompt('课堂名称',`${localDate()} 课堂`); if (!name?.trim()) return; const course = courses.find((c) => c.id === courseId);const teacher=prompt('授课教师',course?.teacher??'')??'';const tags=(prompt('标签（用逗号分隔，可留空）')??'').split(/[,，]/).map((item)=>item.trim()).filter(Boolean);const remarks=prompt('备注（可留空）')??'';const legalTerms=prompt('法律术语提示词（可留空）')??'',stamp=new Date().toISOString(),id=crypto.randomUUID(),input={id,courseId,name,date:localDate(),teacher,tags,remarks,legalTerms},optimistic:ClassSession={...input,status:'active',startedAt:stamp,endedAt:null,createdAt:stamp,updatedAt:stamp};const result=await durableJson<ClassSession>('/api/sessions',{method:'POST',body:JSON.stringify(input)},optimistic);setSessions((items)=>[result.value,...items]);if(result.queued){setMessage('课堂已存入本地待同步队列，联网后自动创建');return;}await openSession(result.value.id); }
  async function editSession(session: ClassSession) { const name = prompt('新的课堂名称',session.name); if (!name?.trim()) return; await api(`/api/sessions/${session.id}`,{method:'PATCH',body:JSON.stringify({name})}); await refreshLists(); }
  async function deleteSession(session: ClassSession) { if (!confirm(`删除课堂“${session.name}”及其转写、笔记和问答？此操作不可撤销。`)) return; await api(`/api/sessions/${session.id}`,{method:'DELETE'}); if (detail?.id === session.id) setDetail(null); await refreshLists(); }
  async function changeSessionStatus(next: 'active'|'paused'|'ended') { if (!detail) return; const payload: Record<string,unknown> = {status:next}; if (next === 'ended') payload.endedAt = new Date().toISOString(); if (next === 'active' && detail.status === 'ended') payload.endedAt = null; const value = await api<ClassSession>(`/api/sessions/${detail.id}`,{method:'PATCH',body:JSON.stringify(payload)}); setDetail({...detail,...value}); }
  async function startLocalRecording(){if(!detail||mediaRecorder.current)return;try{const sessionId=detail.id,stream=await navigator.mediaDevices.getUserMedia({audio:true});recordingStream.current=stream;const recorder=new MediaRecorder(stream);mediaRecorder.current=recorder;recordingStarted.current=Date.now();recorder.ondataavailable=(event)=>{if(!event.data.size)return;const durationMs=Date.now()-recordingStarted.current;recordingStarted.current=Date.now();const form=new FormData();form.append('file',event.data,'课堂录音.webm');form.append('durationMs',String(durationMs));void api<RecordingInfo>(`/api/sessions/${sessionId}/recordings`,{method:'POST',body:form}).then((item)=>setRecordings((items)=>[...items,item])).catch(showError);};recorder.onstop=()=>{recordingStream.current?.getTracks().forEach((track)=>track.stop());recordingStream.current=null;mediaRecorder.current=null;};recorder.start(30_000);setMessage('正在转写 · 录音每30秒仅保存到本机');}catch(error){showError(error);}}
  function stopLocalRecording(){if(mediaRecorder.current?.state!=='inactive')mediaRecorder.current?.stop();}
  async function startSpeech() { if (!detail) return alert('请先新建课堂'); if (detail.status === 'ended' && !confirm('这是一节已结束课堂。要明确继续本节课堂并追加转写吗？')) return; if (detail.status !== 'active') await changeSessionStatus('active'); transcriptionController.start();if(settings.recordAudioLocally)void startLocalRecording(); }
  async function pauseSpeech() { transcriptionController.pause(); await changeSessionStatus('paused'); }
  async function endClass() { if (!detail || !confirm('确定结束本节课堂？全部内容会保存在本机。')) return; transcriptionController.stop();stopLocalRecording();await changeSessionStatus('ended'); }
  async function updateTranscript(segment:TranscriptSegment) { const text = prompt('编辑转写（编辑后将锁定，不会被识别结果覆盖）',segment.text); if (!text?.trim() || text === segment.text) return; const value = await api<TranscriptSegment>(`/api/transcripts/${segment.id}`,{method:'PATCH',body:JSON.stringify({text})}); setDetail((d) => d ? {...d,transcripts:d.transcripts.map((t) => t.id === value.id ? value : t)} : d); }
  async function toggleImportant(segment:TranscriptSegment) { const value = await api<TranscriptSegment>(`/api/transcripts/${segment.id}`,{method:'PATCH',body:JSON.stringify({important:!segment.important})}); setDetail((d) => d ? {...d,transcripts:d.transcripts.map((t) => t.id === value.id ? value : t)} : d); }
  async function forceNotes() { if (!detail) return; setMessage('正在整理笔记'); try { await api(`/api/sessions/${detail.id}/notes/update`,{method:'POST',body:JSON.stringify({force:true})}); await reloadDetail(); setMessage('更新完成'); } catch (error) { showError(error); } }
  async function undoNote(type:'full'|'outline') { const doc = note(type); if (!doc) return; await api(`/api/note-documents/${doc.id}/undo`,{method:'POST'}); await reloadDetail(); }
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
  async function addQa(id:string,target:'full'|'outline'|'both') {const nodes=detail?.noteDocuments.find((doc)=>target==='both'||doc.type===target)?.nodes??[];const suggested=nodes.filter((node)=>node.type==='heading').at(-1);const label=suggested?`${suggested.textContent}（推荐）`:'文档末尾';const chosen=confirm(`建议插入位置：${label}\n\n确定后插入；取消可保留问答且不修改笔记。`);if(!chosen)return;await api(`/api/questions/${id}/insert`,{method:'POST',body:JSON.stringify({target,targetNodeId:suggested?.id??null})});await reloadDetail(); }
  async function removeQa(id:string) { await api(`/api/questions/${id}/note-link`,{method:'DELETE'}); await reloadDetail(); }
  async function updateQa(item:QaItem,field:'question'|'answer') { const value = prompt(field === 'question' ? '编辑问题' : '编辑答案',item[field]); if (value === null) return; await api(`/api/questions/${item.id}`,{method:'PATCH',body:JSON.stringify({[field]:value})}); await reloadDetail(); }
  async function runSearch(event:FormEvent) { event.preventDefault(); if (!search.trim()) return setResults([]); setResults(await api<SearchResult[]>(`/api/search?q=${encodeURIComponent(search)}${detail ? `&sessionId=${detail.id}&courseId=${detail.courseId}` : ''}`)); }
  async function setRelevance(segment:TranscriptSegment,category:RelevanceCategory){const value=await api<TranscriptSegment>(`/api/transcripts/${segment.id}/relevance`,{method:'PATCH',body:JSON.stringify({category})});setDetail((current)=>current?{...current,transcripts:current.transcripts.map((item)=>item.id===value.id?value:item)}:current);}
  function animateTurtle(){if(turtleTimer.current)return;setTurtleAngry(true);turtleTimer.current=window.setTimeout(()=>{setTurtleAngry(false);turtleTimer.current=null;},800);}
  function onTranscriptScroll() { const box=transcriptBox.current; if (box && box.scrollHeight-box.scrollTop-box.clientHeight>80) setAutoScroll(false); }

  return <div className="app-shell">
    <header className="toolbar">
      <div className="brand"><button className={`turtle-button ${turtleAngry?'angry':''}`} aria-label="点击乌龟" onClick={animateTurtle}><img src={turtleAngry?turtleAngryImage:turtleNormal} alt="课堂实时助手乌龟" onError={(event)=>{event.currentTarget.hidden=true;event.currentTarget.parentElement?.classList.add('image-error');}}/></button><div><strong>课堂实时助手</strong><small>{currentCourse?.name ?? '未选择课程'} · {detail?.name ?? '未选择课堂'}</small></div></div>
      <div className="status-strip"><span>{new Date().toLocaleDateString('zh-CN')}</span><span className={`status ${status}`}>{speechLabels[status]}</span><span className={`status ${settings.apiKeyConfigured?'ok':'muted'}`}>{aiLabel}</span>{outboxCount>0&&<span className="status muted">待同步 {outboxCount}</span>}<span className="timer">{duration}</span></div>
      <div className="toolbar-actions">
        {status !== 'listening' ? <button className="primary" onClick={startSpeech}>{status === 'paused' ? '继续转写' : '开始转写'}</button> : <button onClick={pauseSpeech}>暂停转写</button>}
        <button onClick={endClass} disabled={!detail || detail.status === 'ended'}>结束课堂</button>
        <button onClick={() => setImportOpen(true)}>导入</button><ExportButton session={detail} onError={showError}/><button onClick={() => setSettingsOpen(true)}>设置</button>
      </div>
    </header>
    {statusDetail && <div className="banner" role="alert">{statusDetail}</div>}
    {loadState==='error'&&<div className="banner" role="alert">本地数据加载失败，未将失败误判为空课堂。请确认后端正在运行后重试。<button onClick={()=>refreshLists().catch(showError)}>重新连接</button></div>}
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
        {(detail?.transcripts.some((item)=>item.relevance==='course_context'))&&<details className="course-reminders"><summary>课程提醒（{detail.transcripts.filter((item)=>item.relevance==='course_context').length}）</summary>{detail.transcripts.filter((item)=>item.relevance==='course_context').map((item)=><p key={item.id}>{item.text}</p>)}</details>}
        {recordings.length>0&&<details className="course-reminders"><summary>本地录音（{recordings.length} 段）</summary>{recordings.map((item)=><div className="recording-row" key={item.id}><audio controls preload="none" src={`/api/recordings/${item.id}/content`}/><span>{(item.size/1024).toFixed(1)} KB</span><a href={`/api/recordings/${item.id}/content?download=1`}>导出</a><button onClick={async()=>{if(!confirm('确定删除这一段本地录音？此操作不可撤销。'))return;await api(`/api/recordings/${item.id}`,{method:'DELETE'});setRecordings((items)=>items.filter((value)=>value.id!==item.id));}}>删除</button></div>)}</details>}
        <div className="transcript-list" ref={transcriptBox} onScroll={onTranscriptScroll}>
          {!detail?.transcripts.length && !interim && <div className="empty"><span>声音会变成可编辑的课堂记录</span><p>仅最终识别结果会保存；原始音频不会保存或发送给 DeepSeek。</p></div>}
          {detail?.transcripts.map((segment)=><article className={segment.important?'important':''} key={segment.id}><time>{time(segment.startedAt)}</time><p>{segment.text}</p><div>{(settings.showRelevanceLabels||segment.relevanceManual)&&segment.relevance&&<span className={`relevance ${segment.relevance}`}>{relevanceLabels[segment.relevance]}</span>}<button onClick={()=>updateTranscript(segment)}>编辑</button><button onClick={()=>toggleImportant(segment)}>{segment.important?'取消重点':'标记重点'}</button><button onClick={()=>navigator.clipboard.writeText(segment.text)}>复制</button><select aria-label="内容分类" value={segment.relevance??'uncertain'} onChange={(event)=>setRelevance(segment,event.target.value as RelevanceCategory)}><option value="substantive_legal">加入笔记/法律内容</option><option value="small_talk">排除出笔记/闲聊</option><option value="course_context">课程提醒</option><option value="uncertain">待判断</option></select>{segment.userEdited&&<span>用户已编辑并锁定</span>}</div></article>)}
          {interim && <article className="interim"><time>识别中</time><p>{interim}</p></article>}
        </div>
        {!autoScroll && <button className="to-latest" onClick={()=>{setAutoScroll(true);if(transcriptBox.current)transcriptBox.current.scrollTop=transcriptBox.current.scrollHeight;}}>回到最新内容</button>}
      </section>

      <aside className="right-panel">
        <div className="tabs" role="tablist">
          {([['full','完整版笔记'],['outline','提纲版笔记'],['qa','课堂问答'],['ask','手动提问']] as const).map(([id,label])=>{
            const unread=id==='qa'?(detail?.qa.filter((item)=>item.source==='auto'&&!item.readAt).length??0):0;
            return <button role="tab" aria-selected={rightTab===id} className={rightTab===id?'active':''} onClick={async()=>{setRightTab(id);if(id==='qa'&&unread){await Promise.all((detail?.qa??[]).filter((item)=>!item.readAt).map((item)=>api(`/api/questions/${item.id}/read`,{method:'PATCH'})));await reloadDetail();}}} key={id}>{label}{unread>0&&settings.unreadQuestionBadges?<span className="badge">{unread>9?'9+':unread}</span>:null}</button>;
          })}
        </div>
        {(rightTab==='full'||rightTab==='outline') && <NoteView document={note(rightTab)} sessionId={detail?.id??''} configured={loadState==='error'?null:settings.apiKeyConfigured} onSettings={()=>setSettingsOpen(true)} onUpdate={forceNotes} onUndo={()=>undoNote(rightTab)} onSaved={(value)=>setDetail((current)=>current?{...current,noteDocuments:current.noteDocuments.map((item)=>item.id===value.id?value:item)}:current)} onError={showError}/>}
        {rightTab==='qa' && <QaView items={detail?.qa??[]} onAdd={addQa} onRemove={removeQa} onEdit={updateQa} onReload={reloadDetail}/>}
        {rightTab==='ask' && <div className="ask-panel"><h2>向课堂提问</h2><div className="shortcuts">{shortcuts.map((item)=><button key={item} onClick={()=>submitQuestion(item)}>{item}</button>)}</div><label htmlFor="question">问题</label><textarea id="question" rows={6} value={question} onChange={(e)=>setQuestion(e.target.value)} onKeyDown={(e:KeyboardEvent<HTMLTextAreaElement>)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submitQuestion();}}} placeholder="结合当前课堂、历史课堂和导入资料提问…"/>{streamText&&<div className="stream-answer" aria-live="polite">{streamText}</div>}<button className="primary wide" onClick={()=>submitQuestion()} disabled={asking||!question.trim()}>{asking?'正在生成，可继续转写…':'发送（Enter）'}</button>{asking&&<button className="wide" onClick={()=>askController.current?.abort()}>停止生成</button>}{!settings.apiKeyConfigured&&<button className="link" onClick={()=>setSettingsOpen(true)}>尚未配置 DeepSeek，前往设置</button>}</div>}
      </aside>
    </main>
    {settings.showTranscriptionDiagnostics&&<details className="diagnostics"><summary>转写诊断（最近 {diagnostics.length} 条）</summary><div>{diagnostics.map((event,index)=><p key={`${event.occurredAt}-${index}`}><time>{time(event.occurredAt)}</time> <strong>{event.type}</strong> {event.detail}</p>)}</div></details>}
    {settingsOpen && <SettingsModal value={settings} onClose={()=>setSettingsOpen(false)} onSaved={(value)=>{setSettings(value);setSettingsOpen(false);}} onError={showError}/>}
    {importOpen && <ImportModal courses={courses} selectedCourse={courseId} onClose={()=>setImportOpen(false)} onDone={async()=>{setImportOpen(false);await refreshLists();}} onError={showError}/>}
  </div>;
}

function NoteView({document,sessionId,configured,onSettings,onUpdate,onUndo,onSaved,onError}:{document:NoteDocumentV2|undefined;sessionId:string;configured:boolean|null;onSettings():void;onUpdate():void;onUndo():void;onSaved(document:NoteDocumentV2):void;onError(error:unknown):void}) {
  return <div className="note-view"><div className="note-tools"><span>{document?.status==='generating'?'正在修订':document?.status==='complete'?'已更新':document?.status==='failed'?'修订失败，待重试':'等待整理'}{document?.pendingSuggestions?` · ${document.pendingSuggestions} 条建议待处理`:''}</span><button onClick={onUpdate}>整理当前笔记</button><button onClick={onUndo}>撤销修订</button></div>{configured===null?<div className="notice">本地服务未连接，无法确认 DeepSeek 配置；不会将其显示为“未配置”。</div>:!configured&&<div className="notice">尚未配置 DeepSeek。富文本编辑和本地自动保存仍可使用。<button onClick={onSettings}>前往设置</button></div>}{document?<RichNoteEditor document={document} sessionId={sessionId} onSaved={onSaved} onError={onError}/>:<div className="empty"><span>正在准备笔记文档</span></div>}</div>;
}

function QaView({items,onAdd,onRemove,onEdit,onReload}:{items:QaItem[];onAdd(id:string,target:'full'|'outline'|'both'):void;onRemove(id:string):void;onEdit(item:QaItem,field:'question'|'answer'):void;onReload():void}) {
  return <div className="qa-list">{!items.length&&<div className="empty"><span>尚未发现法律问题</span><p>闲聊和课堂管理问题不会触发自动问答；不确定项会明确标记待判断。</p></div>}{items.map((item)=><details key={item.id}><summary><span>{item.source==='auto'?'自动发现':'手动提问'} · {time(item.createdAt)}{item.isLegal===null?' · 待判断':''}{!item.readAt&&item.source==='auto'?' · 未读':''}</span><strong>{item.question}</strong></summary><div className="qa-body"><h4>回答</h4><p>{item.answer||'正在生成…'}</p><h4>课堂依据</h4><p>{item.evidence||'课堂记录中未找到直接依据'}</p><small>{qaStatus[item.status]??item.status}</small><div className="qa-actions"><button onClick={()=>onEdit(item,'question')}>编辑问题</button><button onClick={()=>onEdit(item,'answer')}>编辑回答</button><button onClick={()=>navigator.clipboard.writeText(`${item.question}\n${item.answer}`)}>复制</button><button onClick={()=>onAdd(item.id,'full')}>加入完整版</button><button onClick={()=>onAdd(item.id,'outline')}>加入提纲版</button><button onClick={()=>onAdd(item.id,'both')}>加入两版</button>{item.status!=='none'&&<button onClick={()=>onRemove(item.id)}>从笔记移除</button>}<button onClick={async()=>{await api(`/api/questions/${item.id}/regenerate`,{method:'POST'});await onReload();}}>重新回答</button><button className="danger-text" onClick={async()=>{const withNote=item.status!=='none';const removeLinked=withNote?confirm('该问答已经写入笔记。\n确定：同时从笔记移除\n取消：下一步可只删除问答卡'):false;if(withNote&&removeLinked)await onRemove(item.id);if(!confirm(withNote&&!removeLinked?'只删除问答卡、保留已插入笔记的内容？':'确定删除该问答？'))return;await api(`/api/questions/${item.id}`,{method:'DELETE'});await onReload();}}>删除</button></div></div></details>)}</div>;
}

function ExportButton({session,onError}:{session:SessionDetail|null;onError(error:unknown):void}) {
  const [open,setOpen]=useState(false); const [format,setFormat]=useState<'docx'|'md'|'txt'>('docx'); const [scope,setScope]=useState('package');
  return <div className="export-menu"><button onClick={()=>setOpen(!open)}>导出</button>{open&&<div><label>格式<select value={format} onChange={(e)=>setFormat(e.target.value as typeof format)}><option value="docx">Word .docx</option><option value="md">Markdown .md</option><option value="txt">纯文本 .txt</option></select></label><label>内容<select value={scope} onChange={(e)=>setScope(e.target.value)}><option value="package">完整课堂包</option><option value="full">只导出完整版</option><option value="outline">只导出提纲版</option><option value="notes">同时导出两版笔记</option><option value="transcript">完整转写</option><option value="qa">课堂问答</option></select></label><button className="primary" disabled={!session} onClick={()=>{if(session)download(`/api/sessions/${session.id}/export`,{format,scope}).then(()=>setOpen(false)).catch(onError);}}>开始导出</button></div>}</div>;
}

function SettingsModal({value,onClose,onSaved,onError}:{value:PublicSettings;onClose():void;onSaved(value:PublicSettings):void;onError(error:unknown):void}) {
  const [form,setForm]=useState<SettingsInput>({...value,apiKey:undefined}); const [key,setKey]=useState(''); const [show,setShow]=useState(false); const [testing,setTesting]=useState('');
  const [health,setHealth]=useState<any>(null),[backups,setBackups]=useState<{name:string;size:number;createdAt:string}[]>([]);useEffect(()=>{void Promise.all([api<any>('/api/health'),api<{name:string;size:number;createdAt:string}[]>('/api/backups')]).then(([nextHealth,nextBackups])=>{setHealth(nextHealth);setBackups(nextBackups);}).catch(onError);},[]);
  const field=(name:keyof SettingsInput,value:unknown)=>setForm((current)=>({...current,[name]:value}));
  async function save(event:FormEvent){event.preventDefault();try{onSaved(await api<PublicSettings>('/api/settings',{method:'PUT',body:JSON.stringify({...form,...(key?{apiKey:key}:{})})}));}catch(error){onError(error);}}
  async function test(){setTesting('正在连接…');try{const result=await api<{message:string}>('/api/settings/test',{method:'POST',body:JSON.stringify({apiKey:key||undefined,baseUrl:form.baseUrl,model:form.noteModel})});setTesting(result.message);}catch(error){setTesting(error instanceof Error?error.message:'连接失败');}}
  const checks=(values:readonly (readonly [keyof SettingsInput,string])[]) => <div className="checks">{values.map(([name,label])=><label key={name}><input type="checkbox" checked={form[name] as boolean} onChange={(e)=>field(name,e.target.checked)}/>{label}</label>)}</div>;
  return <Modal title="设置" onClose={onClose}><form className="settings-form" onSubmit={save}><fieldset><legend>DeepSeek</legend><label>AI 服务商<input value="DeepSeek" disabled/></label><label>API Base URL<input value={form.baseUrl} onChange={(e)=>field('baseUrl',e.target.value)}/></label><label>API Key<div className="key-row"><input type={show?'text':'password'} value={key} onChange={(e)=>setKey(e.target.value)} placeholder={value.apiKeyConfigured?`已保存：${value.maskedApiKey}`:'请输入 sk-…'}/><button type="button" onClick={()=>setShow(!show)}>{show?'隐藏':'显示'}</button></div></label><div className="model-grid"><label>普通笔记模型<input value={form.noteModel} onChange={(e)=>field('noteModel',e.target.value)}/></label><label>自动问答模型<input value={form.autoQaModel} onChange={(e)=>field('autoQaModel',e.target.value)}/></label><label>手动问答模型<input value={form.manualQaModel} onChange={(e)=>field('manualQaModel',e.target.value)}/></label><label>深度回答模型<input value={form.deepModel} onChange={(e)=>field('deepModel',e.target.value)}/></label></div><div className="inline-actions"><button type="button" onClick={test}>测试连接</button><span>{testing}</span><button type="button" className="danger-text" onClick={async()=>{await api('/api/settings/api-key',{method:'DELETE'});setKey('');onSaved({...value,apiKeyConfigured:false,maskedApiKey:''});}}>清除 API Key</button></div></fieldset>
  <fieldset><legend>内容筛选</legend>{checks([['filterSmallTalk','过滤课堂闲聊'],['includeCourseContextInNotes','课程管理信息进入笔记'],['deferUncertainContent','不确定内容暂缓进入笔记'],['showRelevanceLabels','显示内容相关性标签']])}</fieldset>
  <fieldset><legend>笔记整理</legend>{checks([['realtimeMicroUpdates','实时微更新'],['backgroundReorganization','后台结构整理'],['allowAiReorganization','允许 AI 重组 AI 内容'],['showRevisionNotices','AI 修改前文时显示提示']])}<label>整理灵敏度<select value={form.organizationSensitivity} onChange={(e)=>field('organizationSensitivity',e.target.value)}><option value="low">较低</option><option value="standard">标准</option><option value="high">较高</option></select></label></fieldset>
  <fieldset><legend>自动问答</legend>{checks([['legalQuestionsOnly','只识别法律问题'],['showUncertainQuestions','不确定问题仍显示'],['unreadQuestionBadges','新问题红点提醒'],['autoAnswer','自动生成回答'],['autoQaPaused','暂停自动问答'],['useHistory','使用历史资料'],['allowGeneralKnowledge','允许一般知识（会标注）']])}</fieldset>
  <fieldset><legend>转写稳定性</legend>{checks([['transcriptionAutoRecovery','自动恢复'],['preventScreenSleep','防止屏幕休眠'],['showTranscriptionDiagnostics','显示转写诊断'],['backgroundStatusAlerts','后台状态提醒'],['recordAudioLocally','在本机保存录音（默认关闭）']])}<p className="privacy">Wake Lock 只能尽量防止屏幕休眠，不能保证浏览器厂商的语音服务永久运行。录音选项不会把音频发送给 DeepSeek。</p></fieldset>
  <fieldset><legend>兼容设置</legend>{checks([['stream','流式输出'],['thinking','思考模式'],['autoNotes','自动笔记'],['autoDetectQuestions','自动识别问题'],['keepOriginalFiles','保留导入原文件']])}<div className="model-grid"><label>整理间隔（秒）<input type="number" min="10" max="600" value={form.noteIntervalSeconds} onChange={(e)=>field('noteIntervalSeconds',Number(e.target.value))}/></label><label>合并片段参考字数<input type="number" min="100" max="5000" value={form.noteTriggerChars} onChange={(e)=>field('noteTriggerChars',Number(e.target.value))}/></label></div></fieldset>
  <fieldset><legend>本地数据与备份</legend>{health?<div className="privacy"><p>数据目录：{health.dataDir}</p><p>数据库：{health.databaseExists?'存在':'不存在'} · {(health.databaseSize/1024).toFixed(1)} KB · Schema v{health.schemaVersion}</p><p>读写状态：{health.writable?'正常':'异常'} · 最近写入：{health.lastSuccessfulWrite?new Date(health.lastSuccessfulWrite).toLocaleString('zh-CN'):'尚无'}</p><p>课程/课堂：{health.counts?.courses??0}/{health.counts?.sessions??0} · API：{health.settingsConfigured?'已配置':'未配置'}</p>{health.settings&&!health.settings.ok&&<p className="danger-text">{health.settings.warning}</p>}</div>:<p>正在检查本地数据…</p>}<div className="inline-actions">{health&&<button type="button" onClick={()=>navigator.clipboard.writeText(health.dataDir)}>复制数据目录</button>}<button type="button" onClick={async()=>{await api('/api/backups',{method:'POST'});setBackups(await api('/api/backups'));}}>立即备份</button><a className="button-link" href="/api/backups/personal-data" download>导出个人数据</a><span>最近备份：{backups[0]?.name??'无'}</span></div>{backups.length>0&&<label>选择备份恢复<select defaultValue="" onChange={async(event)=>{const name=event.target.value;if(!name)return;if(prompt(`恢复 ${name} 将在下次启动替换当前数据库；当前数据库会先备份。\n输入 RESTORE 确认：`)!=='RESTORE'){event.target.value='';return;}const result=await api<{message:string}>('/api/backups/restore',{method:'POST',body:JSON.stringify({name,confirmation:'RESTORE'})});alert(result.message);}}><option value="">不恢复</option>{backups.map((item)=><option key={item.name} value={item.name}>{item.name} · {(item.size/1024).toFixed(1)} KB</option>)}</select></label>}</fieldset>
  <div className="privacy"><strong>隐私说明</strong><p>调用 AI 时，必要的课堂文字、问题和相关笔记会发送给 DeepSeek。语音识别可能使用浏览器厂商在线服务。API Key 不写入浏览器 IndexedDB；离线待同步队列只保存非敏感业务操作。</p></div><footer><button type="button" onClick={()=>setForm({...DEFAULT_SETTINGS})}>恢复默认值</button><button className="primary">保存设置</button></footer></form></Modal>;
}

function ImportModal({courses,selectedCourse,onClose,onDone,onError}:{courses:Course[];selectedCourse:string;onClose():void;onDone():void;onError(error:unknown):void}) {
  const [file,setFile]=useState<File|null>(null); const [preview,setPreview]=useState(''); const [courseId,setCourseId]=useState(selectedCourse); const [name,setName]=useState('');
  async function select(next:File){setFile(next);setName(next.name.replace(/\.[^.]+$/,''));if(/\.(txt|md)$/i.test(next.name))setPreview((await next.text()).slice(0,3000));else setPreview('Word 文档将在本机后端安全解析标题、列表和普通段落；不会执行宏、脚本或嵌入对象。');}
  async function submit(){if(!file)return;const form=new FormData();form.append('file',file);form.append('courseId',courseId);form.append('name',name);try{await api('/api/documents/import',{method:'POST',body:form});await onDone();}catch(error){onError(error);}}
  return <Modal title="导入历史资料" onClose={onClose}><div className="import-form"><label className="drop-zone" onDragOver={(e:DragEvent)=>e.preventDefault()} onDrop={(e:DragEvent)=>{e.preventDefault();const next=e.dataTransfer.files[0];if(next)select(next);}}>拖拽 TXT、Markdown 或 DOCX 到这里，或点击选择<input type="file" accept=".txt,.md,.docx,.doc" onChange={(e:ChangeEvent<HTMLInputElement>)=>{const next=e.target.files?.[0];if(next)select(next);}}/></label>{file&&<><div className="file-meta"><strong>{file.name}</strong><span>{file.type||'未知类型'} · {(file.size/1024).toFixed(1)}KB</span></div><label>所属课程<select value={courseId} onChange={(e)=>setCourseId(e.target.value)}><option value="">全局资料</option>{courses.map((c)=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label><label>资料名称<input value={name} onChange={(e)=>setName(e.target.value)}/></label><label>导入预览<textarea readOnly rows={10} value={preview}/></label><button className="primary" onClick={submit}>确认导入</button></>}</div></Modal>;
}
