export type SpeechStatus = 'idle'|'requesting'|'listening'|'paused'|'recovering'|'unsupported'|'denied'|'error';

interface SpeechAlternativeLike { transcript: string }
interface SpeechResultLike { isFinal: boolean; length: number; [index: number]: SpeechAlternativeLike }
interface SpeechEventLike { resultIndex: number; results: { length: number; [index: number]: SpeechResultLike } }
interface SpeechErrorLike { error: string }
export interface RecognitionLike {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((event: SpeechEventLike) => void) | null; onerror: ((event: SpeechErrorLike) => void) | null; onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}

export interface SpeechCallbacks { onInterim(text: string): void; onFinal(text: string): void; onStatus(status: SpeechStatus, detail?: string): void }

export class BrowserTranscriptionProvider {
  private recognition: RecognitionLike | null = null;
  private desired = false;
  private retries = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFinal = '';
  private lastFinalAt = 0;

  constructor(private factory: (() => RecognitionLike) | undefined, private callbacks: SpeechCallbacks, private maxRetries = 4) {
    if (!factory) callbacks.onStatus('unsupported', '当前浏览器不支持语音识别，请使用最新版 Edge 或 Chrome。');
  }

  start(): void {
    if (!this.factory) return;
    this.desired = true; this.retries = 0; this.callbacks.onStatus('requesting'); this.open();
  }
  pause(): void { this.desired = false; this.clearTimer(); this.recognition?.stop(); this.callbacks.onInterim(''); this.callbacks.onStatus('paused'); }
  stop(): void { this.desired = false; this.clearTimer(); this.recognition?.abort(); this.recognition = null; this.callbacks.onInterim(''); this.callbacks.onStatus('idle'); }

  private open(): void {
    if (!this.factory || !this.desired) return;
    const recognition = this.factory(); this.recognition = recognition;
    recognition.continuous = true; recognition.interimResults = true; recognition.lang = 'zh-CN';
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]; const text = result?.[0]?.transcript.trim() ?? ''; if (!text) continue;
        if (result?.isFinal) {
          const stamp = Date.now();
          if (text !== this.lastFinal || stamp - this.lastFinalAt > 2500) { this.lastFinal = text; this.lastFinalAt = stamp; this.callbacks.onFinal(text); }
          interim = '';
        } else interim += text;
      }
      this.callbacks.onInterim(interim); this.retries = 0; this.callbacks.onStatus('listening');
    };
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') { this.desired = false; this.callbacks.onStatus('denied', '麦克风权限被拒绝。请点击地址栏左侧图标，在网站设置中允许麦克风后重试。'); }
      else if (!['no-speech','aborted'].includes(event.error)) this.callbacks.onStatus('error', `语音识别异常：${event.error}`);
    };
    recognition.onend = () => { if (this.desired) this.recover(); };
    try { recognition.start(); this.callbacks.onStatus('listening'); } catch { this.recover(); }
  }
  private recover(): void {
    if (!this.desired) return;
    if (this.retries >= this.maxRetries) { this.desired = false; this.callbacks.onStatus('error', '语音识别自动恢复失败，请手动点击继续转写。'); return; }
    this.callbacks.onStatus('recovering'); const delay = 500 * 2 ** this.retries++; this.timer = setTimeout(() => this.open(), delay);
  }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}

export function createBrowserRecognition(): (() => RecognitionLike) | undefined {
  const scope = window as typeof window & { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike };
  const Constructor = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  return Constructor ? () => new Constructor() : undefined;
}
