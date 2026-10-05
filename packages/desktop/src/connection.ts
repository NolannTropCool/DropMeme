import { appVersion, protocolVersion, serverEventSchema, type ServerEvent, type Profile } from '@dropmeme/shared';

export class Connection {
  private socket: WebSocket | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private stopped = true;
  private negotiated = 0;

  constructor(private readonly origin: string, private readonly token: string, private readonly onEvent: (event: ServerEvent) => void, private readonly onState: (state: 'connecting' | 'offline' | 'expired' | 'duplicate') => void, private profile: Profile = { name: 'Utilisateur', acceptDirect: false }) {}

  start(): void { this.stopped = false; this.open(); }
  stop(): void { this.stopped = true; clearTimeout(this.retry); this.socket?.close(); this.socket = undefined; }
  setProfile(profile: Profile): void {
    this.profile = profile;
    if (this.socket?.readyState === WebSocket.OPEN && this.negotiated >= 2) this.socket.send(JSON.stringify({ type: 'profile', profile }));
  }

  private open(): void {
    if (this.stopped) return;
    this.onState('connecting');
    const url = new URL('/v1/events', this.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    this.socket = socket;
    this.negotiated = 0;
    socket.onopen = () => socket.send(JSON.stringify({ type: 'authenticate', token: this.token, protocol: protocolVersion, version: appVersion, profile: this.profile }));
    socket.onmessage = message => {
      if (this.stopped || socket !== this.socket) return;
      try {
        const parsed = serverEventSchema.safeParse(JSON.parse(String(message.data)));
        if (!parsed.success) return;
        if (parsed.data.type === 'ready') { this.attempts = 0; this.negotiated = parsed.data.protocol ?? 1; }
        if (parsed.data.type === 'media') {
          const mediaUrl = new URL(parsed.data.url);
          if (mediaUrl.origin !== this.origin || !mediaUrl.pathname.startsWith('/v1/media/')) return;
        }
        this.onEvent(parsed.data);
      } catch { /* Ignore unrecognized data, never evaluate it. */ }
    };
    socket.onerror = () => { /* onclose drives reconnection. */ };
    socket.onclose = event => {
      if (this.stopped || socket !== this.socket) return;
      if (event.code === 4001 || event.code === 4009) {
        this.stopped = true; this.onState(event.code === 4001 ? 'expired' : 'duplicate'); return;
      }
      this.onState('offline');
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5)) + Math.random() * 500;
      this.retry = setTimeout(() => this.open(), delay);
    };
  }
}
