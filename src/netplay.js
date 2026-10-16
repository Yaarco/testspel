/**
 * Peer-to-peer connection for 1v1 with a friend. The host gets a link with
 * a room id; whoever opens it connects straight to the host's browser over
 * WebRTC. A public PeerJS broker only introduces the two browsers; game
 * traffic never passes through it.
 */
const PEERJS = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
const JOIN_PARAM = 'join';

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
 * side; `onStatus(text, connected)` reports the connection's state.
 */
export class Netplay {
  constructor({ onMessage, onStatus }) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.peer = null;
    this.connection = null;
    this.isHost = false;
  }

  get connected() {
    return Boolean(this.connection?.open);
  }

  /** Opens a room; resolves to its invite link. */
  async host() {
    this.close();
    this.isHost = true;
    const Peer = await loadPeerJs();
    this.peer = new Peer();
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
    const Peer = await loadPeerJs();
    this.peer = new Peer();
    this.onStatus('Connecting…', false);
    this.peer.on('open', () => this.attach(this.peer.connect(room, { serialization: 'json' })));
    this.peer.on('error', (error) => this.onStatus(`Could not connect: ${error.type ?? error.message}`, false));
  }

  attach(connection) {
    this.connection = connection;
    connection.on('open', () => this.onStatus('Connected', true));
    connection.on('data', (message) => this.onMessage(message));
    connection.on('close', () => this.onStatus('Your friend left', false));
    connection.on('error', () => this.onStatus('Connection lost', false));
  }

  send(message) {
    if (this.connected) this.connection.send(message);
  }

  close() {
    this.connection?.close();
    this.peer?.destroy();
    this.peer = null;
    this.connection = null;
  }
}
