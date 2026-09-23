export type SpeechStatus = 'idle'|'requesting'|'listening'|'paused'|'recovering'|'recovery-failed'|'unsupported'|'denied'|'error';
export type SpeechEventType = 'start'|'audiostart'|'soundstart'|'speechstart'|'result'|'speechend'|'soundend'|'audioend'|'end'|'error'|'visibilitychange'|'focus'|'blur'|'auto-restart'|'restart-failed';
interface SpeechAlternativeLike { transcript: string }
interface SpeechResultLike { isFinal: boolean; length: number; [index: number]: SpeechAlternativeLike }
interface SpeechEventLike { resultIndex: number; results: { length: number; [index: number]: SpeechResultLike } }
interface SpeechErrorLike { error: string }
export interface RecognitionLike { continuous:boolean;interimResults:boolean;lang:string;onresult:((event:SpeechEventLike)=>void)|null;onerror:((event:SpeechErrorLike)=>void)|null;onend:(()=>void)|null;onstart?:(()=>void)|null;onaudiostart?:(()=>void)|null;onsoundstart?:(()=>void)|null;onspeechstart?:(()=>void)|null;onspeechend?:(()=>void)|null;onsoundend?:(()=>void)|null;onaudioend?:(()=>void)|null;start():void;stop():void;abort():void }
export interface DiagnosticEvent { type:SpeechEventType;occurredAt:string;detail:string }
export interface SpeechCallbacks { onInterim(text:string):void;onFinal(text:string):void;onStatus(status:SpeechStatus,detail?:string):void;onEvent?(event:DiagnosticEvent):void }

export class BrowserTranscriptionProvider {
  private recognition:RecognitionLike|null=null;private desired:'idle'|'listening'|'paused'='idle';private retries=0;private timer:ReturnType<typeof setTimeout>|null=null;private lastFinal='';private lastFinalAt=0;private opening=false;private intentionalEnd=false;
  constructor(private factory:(()=>RecognitionLike)|undefined,private callbacks:SpeechCallbacks,private burstRetries=4){if(!factory)callbacks.onStatus('unsupported','当前浏览器不支持语音识别，请使用最新版 Edge 或 Chrome。');}
  setCallbacks(callbacks:SpeechCallbacks):void{this.callbacks=callbacks;}wantsListening():boolean{return this.desired==='listening';}
  start():void{if(!this.factory)return;this.desired='listening';this.intentionalEnd=false;this.retries=0;this.callbacks.onStatus('requesting');this.open();}
  pause():void{this.desired='paused';this.intentionalEnd=true;this.clearTimer();this.recognition?.stop();this.callbacks.onInterim('');this.callbacks.onStatus('paused');}
  stop():void{this.desired='idle';this.intentionalEnd=true;this.clearTimer();this.recognition?.abort();this.recognition=null;this.opening=false;this.callbacks.onInterim('');this.callbacks.onStatus('idle');}
  checkHealth():void{if(this.desired==='listening'&&!this.recognition&&!this.opening&&!this.timer)this.recover('前台状态检查发现识别器已结束');}
  private event(type:SpeechEventType,detail=''):void{this.callbacks.onEvent?.({type,detail,occurredAt:new Date().toISOString()});}
  private open():void{if(!this.factory||this.desired!=='listening'||this.opening||this.recognition)return;this.opening=true;this.intentionalEnd=false;const recognition=this.factory();this.recognition=recognition;recognition.continuous=true;recognition.interimResults=true;recognition.lang='zh-CN';
    recognition.onaudiostart=()=>this.event('audiostart');recognition.onsoundstart=()=>this.event('soundstart');recognition.onspeechstart=()=>this.event('speechstart');recognition.onspeechend=()=>this.event('speechend');recognition.onsoundend=()=>this.event('soundend');recognition.onaudioend=()=>this.event('audioend');
    recognition.onstart=()=>{this.opening=false;this.retries=0;this.event('start');this.callbacks.onStatus('listening');};
    recognition.onresult=(event)=>{this.event('result');let interim='';for(let i=event.resultIndex;i<event.results.length;i++){const result=event.results[i],text=result?.[0]?.transcript.trim()??'';if(!text)continue;if(result?.isFinal){const stamp=Date.now();if(text!==this.lastFinal||stamp-this.lastFinalAt>2500){this.lastFinal=text;this.lastFinalAt=stamp;this.callbacks.onFinal(text);}interim='';}else interim+=text;}this.callbacks.onInterim(interim);this.retries=0;this.callbacks.onStatus('listening');};
    recognition.onerror=(error)=>{this.event('error',error.error);if(error.error==='not-allowed'||error.error==='service-not-allowed'){this.desired='idle';this.callbacks.onStatus('denied','麦克风权限被拒绝。请在网站权限中允许麦克风后重试。');}else if(error.error==='audio-capture'){this.desired='idle';this.callbacks.onStatus('error','没有可用麦克风，或麦克风正被其他程序独占。');}else if(!['no-speech','aborted','network'].includes(error.error))this.callbacks.onStatus('error',`语音识别异常：${error.error}`);};
    recognition.onend=()=>{this.event('end',this.intentionalEnd?'用户操作':'浏览器自然结束');this.recognition=null;this.opening=false;if(this.desired==='listening'&&!this.intentionalEnd)this.recover('浏览器自然结束');};
    try{recognition.start();}catch(error){this.recognition=null;this.opening=false;this.recover(error instanceof Error?error.message:'启动失败');}}
  private recover(detail:string):void{if(this.desired!=='listening')return;this.clearTimer();this.callbacks.onStatus('recovering',detail);this.event('auto-restart',detail);const burstIndex=this.retries%this.burstRetries,completedBursts=Math.floor(this.retries/this.burstRetries),delay=completedBursts>0?Math.min(30_000,5000*completedBursts):Math.min(4000,500*2**burstIndex);this.retries++;if(completedBursts>0){this.callbacks.onStatus('recovery-failed','短时恢复未成功，将继续间隔重试；请检查麦克风和网络。');this.event('restart-failed',`连续 ${this.retries} 次未恢复`);}this.timer=setTimeout(()=>{this.timer=null;this.open();},delay);}
  private clearTimer():void{if(this.timer)clearTimeout(this.timer);this.timer=null;}
}
export function createBrowserRecognition():(()=>RecognitionLike)|undefined{if(typeof window==='undefined')return undefined;const scope=window as typeof window&{SpeechRecognition?:new()=>RecognitionLike;webkitSpeechRecognition?:new()=>RecognitionLike};const Constructor=scope.SpeechRecognition??scope.webkitSpeechRecognition;return Constructor?()=>new Constructor():undefined;}
