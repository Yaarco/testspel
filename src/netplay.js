/**
 * Peer-to-peer connection for 1v1 with a friend. The host gets a link with
 * a room id; whoever opens it connects straight to the host's browser over
 * WebRTC. A public PeerJS broker only introduces the two browsers; game
 * traffic never passes through it.
 *
 * Public STUN servers let most home networks find a direct route. Some
 * networks (mobile data, many offices and dorms) allow no direct route;
 * then traffic must go through a relay (TURN) server, which either player
 * sets up under Settings. Without one such a connection fails, and says so.
 *
 * Messages arrive reliably but not necessarily in order (ordered delivery
 * would hold every state update behind a lost packet); see versus.js. A
 * connection that goes silent counts as lost, since WebRTC can take a long
 * time to notice a vanished peer.
 */
const PEERJS = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
const JOIN_PARAM = 'join';
const CONNECT_TIMEOUT = 20000;   // ms to wait for a route before giving up
const SILENCE_LIMIT = 5000;      // ms without a message before the connection counts as lost
const STUN_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const NO_ROUTE = 'No direct route to your friend: one of your networks blocks it. '
  + 'Add a relay (TURN) server under Settings → Connection (either of you), then try again.';

let library = null;

/** Loads PeerJS the first time it is needed. */
function loadPeerJs() {
  library ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = PEERJS;
    script.onload = () => resolve(window.Peer);
    script.onerror = () => reject(new Error('Could not load the connection library.'));
    document.head.append(script);
  });
  return library;
}

/** The room id in the page link, when the page was opened from an invite. */
export function invitedRoom() {
  return new URLSearchParams(location.search).get(JOIN_PARAM);
}

export function inviteLink(room) {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set(JOIN_PARAM, room);
  return url.toString();
}

/**
 * One side of a 1v1. `onMessage(message)` gets every message from the other
 * side; `onStatus(text, connected)` reports the connection's state;
 * `relay()` gives the relay server setting ({ urls, username, credential }) or null.
 */
export class Netplay {
  constructor({ onMessage, onStatus, relay = () => null }) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.relay = relay;
    this.peer = null;
    this.connection = null;
    this.isHost = false;
    this.lastHeard = 0;
    this.watchdog = null;
  }

  get connected() {
    return Boolean(this.connection?.open);
  }

  /** A peer using the public STUN servers and the relay, if one is set. */
  async createPeer() {
    const Peer = await loadPeerJs();
    const iceServers = [...STUN_SERVERS];
    const relay = this.relay();
    const urls = relay?.urls?.split(/[\s,]+/).filter(Boolean);
    if (urls?.length) iceServers.push({ urls, username: relay.username, credential: relay.credential });
    return new Peer({ config: { iceServers } });
  }

  /** Opens a room; resolves to its invite link. */
  async host() {
    this.close();
    this.isHost = true;
    this.peer = await this.createPeer();
    const room = await new Promise((resolve, reject) => {
      this.peer.on('open', resolve);
      this.peer.on('error', (error) => reject(new Error(`Could not open a room: ${error.type ?? error.message}`)));
    });
    this.peer.on('connection', (connection) => {
      if (this.connected) connection.close();   // the room is for two
      else this.attach(connection);
    });
    this.onStatus('Waiting for your friend to open the link…', false);
    return inviteLink(room);
  }

  /** Joins a room from an invite link. */
  async join(room) {
    this.close();
    this.isHost = false;
    this.peer = await this.createPeer();
    this.onStatus('Connecting…', false);
    this.peer.on('open', () => this.attach(this.peer.connect(room, { serialization: 'json' })));
    this.peer.on('error', (error) => this.onStatus(`Could not connect: ${error.type ?? error.message}`, false));
  }

  /** Follows a connection; reports when no route is found in time or the route fails. */
  attach(connection) {
    this.connection = connection;
    const current = () => this.connection === connection;
    const failed = () => {
      if (current() && !connection.open) this.onStatus(NO_ROUTE, false);
    };
    const timer = setTimeout(failed, CONNECT_TIMEOUT);
    connection.peerConnection?.addEventListener('iceconnectionstatechange', () => {
      if (connection.peerConnection.iceConnectionState === 'failed') failed();
    });
    connection.on('open', () => {
      clearTimeout(timer);
      this.lastHeard = performance.now();
      this.watch();
      this.onStatus('Connected', true);
    });
    connection.on('data', (message) => {
      this.lastHeard = performance.now();
      this.onMessage(message);
    });
    connection.on('close', () => { if (current()) this.lost('Your friend left'); });
    connection.on('error', () => { if (current()) this.lost('Connection lost'); });
  }

  /** Checks every second that the other side is still talking. */
  watch() {
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.connected && performance.now() - this.lastHeard > SILENCE_LIMIT) this.lost('Connection lost');
    }, 1000);
  }

  /** Drops the connection (keeping a hosted room open for a new one) and reports why. */
  lost(reason) {
    clearInterval(this.watchdog);
    const connection = this.connection;
    this.connection = null;
    connection?.close();
    this.onStatus(reason, false);
  }

  send(message) {
    if (this.connected) this.connection.send(message);
  }

  close() {
    clearInterval(this.watchdog);
    this.connection?.close();
    this.peer?.destroy();
    this.peer = null;
    this.connection = null;
  }
}
