export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const init: RequestInit = { ...options };
  if (!(options?.body instanceof FormData)) {
    const headers = new Headers(options?.headers); headers.set('Content-Type', 'application/json'); init.headers = headers;
  }
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: { message: '请求失败' } })) as { error?: { message?: string } };
    throw new Error(body.error?.message || `请求失败（${response.status}）`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function download(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) { const value = await response.json() as { error: { message: string } }; throw new Error(value.error.message); }
  const blob = await response.blob(); const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename\*=UTF-8''([^;]+)/.exec(disposition); const name = match ? decodeURIComponent(match[1]!) : '课堂导出';
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
}
