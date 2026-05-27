export interface WebSocketTransportOptions {
  url: string;
  tokenProvider: () => string;
  reconnect?: boolean;
  maxReconnectDelay?: number;
  onData?: (data: Uint8Array | string) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (event: Event) => void;
}

export class WebSocketTransport {
  url: string;
  tokenProvider: () => string;
  reconnect: boolean;
  maxReconnectDelay: number;
  onData: ((data: Uint8Array | string) => void) | null;
  onOpen: (() => void) | null;
  onClose: (() => void) | null;
  onError: ((event: Event) => void) | null;

  private _ws: WebSocket | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectDelay = 1000;
  private _closed = false;
  private _buffer: (string | ArrayBufferLike | Blob | ArrayBufferView)[] = [];

  constructor(options: WebSocketTransportOptions) {
    this.url = options.url;
    this.tokenProvider = options.tokenProvider
    this.reconnect = options.reconnect !== false;
    this.maxReconnectDelay = options.maxReconnectDelay ?? 30000;
    this.onData = options.onData ?? null;
    this.onOpen = options.onOpen ?? null;
    this.onClose = options.onClose ?? null;
    this.onError = options.onError ?? null;
  }

  connect(): void {
    let token = this.tokenProvider()
    this._closed = false;
    this._ws = new WebSocket(this.url, ["pty.v0", `bearer.${token}`]);
    this._ws.binaryType = "arraybuffer";

    this._ws.onopen = () => {
      this._reconnectDelay = 1000;
      this._flushBuffer();
      if (this.onOpen) this.onOpen();
    };

    this._ws.onmessage = (event: MessageEvent) => {
      if (this.onData) {
        if (event.data instanceof ArrayBuffer) {
          this.onData(new Uint8Array(event.data));
        } else {
          this.onData(event.data as string);
        }
      }
    };

    this._ws.onclose = () => {
      if (this.onClose) this.onClose();
      if (this.reconnect && !this._closed) this._scheduleReconnect();
    };

    this._ws.onerror = (event) => {
      if (this.onError) this.onError(event);
      this._ws?.close();
    };
  }

  write(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(data);
    } else {
      this._buffer.push(data);
    }
  }

  close(): void {
    this._closed = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._ws) this._ws.close();
  }

  resize(rows: number, cols: number) {

  }

  get connected(): boolean {
    return this._ws !== null && this._ws.readyState === WebSocket.OPEN;
  }

  private _flushBuffer(): void {
    const items = this._buffer.splice(0);
    for (const item of items) {
      this.write(item);
    }
  }

  private _scheduleReconnect(): void {
    this._reconnectTimer = setTimeout(() => {
      this.connect();
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(
      this._reconnectDelay * 2,
      this.maxReconnectDelay,
    );
  }
}
