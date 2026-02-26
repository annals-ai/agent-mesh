/**
 * WebRTC P2P file transfer via node-datachannel.
 *
 * FileSender: Agent B (producer) — waits for receiver's offer, sends ZIP chunks.
 * FileReceiver: Agent A (caller) — initiates offer, collects ZIP chunks.
 *
 * node-datachannel is dynamically imported — if native binary unavailable,
 * functions return null and file transfer is silently skipped.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { log } from './logger.js';

const ICE_SERVERS = ['stun:stun.l.google.com:19302'];
const CHUNK_SIZE = 64 * 1024; // 64KB per DataChannel message
const CONNECT_TIMEOUT_MS = 10_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NodeDataChannel = any;

let ndcModule: NodeDataChannel | null | undefined;

/**
 * Ensure the correct platform-specific prebuilt binary is in place
 * before importing node-datachannel.
 *
 * Our npm package ships prebuilds for all platforms under
 * <pkg-root>/prebuilds/{platform}-{arch}/node_datachannel.node
 * but node-datachannel loads from build/Release/node_datachannel.node.
 * So we copy the correct one to node-datachannel's expected location.
 */
function ensurePrebuilt(): boolean {
  try {
    const require = createRequire(import.meta.url);

    // Find node-datachannel's expected binary path
    const ndcMain = require.resolve('node-datachannel');
    // Walk up to find the package root (contains package.json)
    let ndcRoot = dirname(ndcMain);
    for (let i = 0; i < 5; i++) {
      if (existsSync(join(ndcRoot, 'package.json'))) break;
      ndcRoot = dirname(ndcRoot);
    }

    const target = join(ndcRoot, 'build', 'Release', 'node_datachannel.node');
    if (existsSync(target)) return true;

    // Our prebuilds are shipped alongside our dist/ directory
    const platform = process.platform;
    const arch = process.arch;

    // Try: <our-package>/prebuilds/{platform}-{arch}/node_datachannel.node
    // Our dist/ is at <pkg>/dist/index.js, so prebuilds/ is at <pkg>/prebuilds/
    const ourPkgRoot = join(dirname(import.meta.url.replace('file://', '')), '..', '..');
    const prebuiltSrc = join(ourPkgRoot, 'prebuilds', `${platform}-${arch}`, 'node_datachannel.node');

    if (!existsSync(prebuiltSrc)) {
      log.warn(`No prebuilt binary for ${platform}-${arch}`);
      return false;
    }

    mkdirSync(join(ndcRoot, 'build', 'Release'), { recursive: true });
    copyFileSync(prebuiltSrc, target);
    log.info(`Installed node-datachannel prebuilt for ${platform}-${arch}`);
    return true;
  } catch {
    return false;
  }
}

async function loadNdc(): Promise<NodeDataChannel | null> {
  if (ndcModule !== undefined) return ndcModule;
  try {
    ensurePrebuilt();
    ndcModule = await import('node-datachannel');
    return ndcModule;
  } catch {
    log.warn('node-datachannel not available — WebRTC file transfer disabled');
    ndcModule = null;
    return null;
  }
}

export interface SignalMessage {
  signal_type: 'offer' | 'answer' | 'candidate';
  payload: string;
}

// ============================================================
// FileSender — Agent B (has files, waits for receiver's offer)
// ============================================================

export class FileSender {
  private peer: InstanceType<NodeDataChannel['PeerConnection']> | null = null;
  private transferId: string;
  private zipBuffer: Buffer;
  private pendingCandidates: Array<{ candidate: string; mid: string }> = [];
  private signalCallback: ((signal: SignalMessage) => void) | null = null;
  private closed = false;

  constructor(transferId: string, zipBuffer: Buffer) {
    this.transferId = transferId;
    this.zipBuffer = zipBuffer;
  }

  onSignal(cb: (signal: SignalMessage) => void): void {
    this.signalCallback = cb;
  }

  async handleSignal(signal: SignalMessage): Promise<void> {
    const ndc = await loadNdc();
    if (!ndc || this.closed) return;

    if (!this.peer) {
      this.peer = new ndc.PeerConnection(`sender-${this.transferId}`, {
        iceServers: ICE_SERVERS,
      });

      this.peer.onLocalDescription((sdp: string, type: string) => {
        this.signalCallback?.({ signal_type: type as 'offer' | 'answer', payload: sdp });
      });

      this.peer.onLocalCandidate((candidate: string, mid: string) => {
        this.signalCallback?.({
          signal_type: 'candidate',
          payload: JSON.stringify({ candidate, mid }),
        });
      });

      this.peer.onDataChannel((dc: InstanceType<NodeDataChannel['DataChannel']>) => {
        dc.onOpen(() => {
          void this.sendZip(dc);
        });
      });
    }

    try {
      if (signal.signal_type === 'offer' || signal.signal_type === 'answer') {
        this.peer.setRemoteDescription(signal.payload, signal.signal_type);
        for (const c of this.pendingCandidates) {
          this.peer.addRemoteCandidate(c.candidate, c.mid);
        }
        this.pendingCandidates = [];
      } else if (signal.signal_type === 'candidate') {
        const { candidate, mid } = JSON.parse(signal.payload);
        if (this.peer.remoteDescription()) {
          this.peer.addRemoteCandidate(candidate, mid);
        } else {
          this.pendingCandidates.push({ candidate, mid });
        }
      }
    } catch {
      // Ignore invalid signals (malformed SDP, bad candidates)
    }
  }

  private async sendZip(dc: InstanceType<NodeDataChannel['DataChannel']>): Promise<void> {
    try {
      // Send header
      dc.sendMessage(JSON.stringify({
        type: 'header',
        transfer_id: this.transferId,
        zip_size: this.zipBuffer.length,
      }));

      // Send binary chunks
      let offset = 0;
      while (offset < this.zipBuffer.length) {
        const end = Math.min(offset + CHUNK_SIZE, this.zipBuffer.length);
        const chunk = this.zipBuffer.subarray(offset, end);
        dc.sendMessageBinary(chunk);
        offset = end;
      }

      // Send completion marker
      dc.sendMessage(JSON.stringify({ type: 'complete' }));

      log.info(`[WebRTC] Sent ${this.zipBuffer.length} bytes in ${Math.ceil(this.zipBuffer.length / CHUNK_SIZE)} chunks`);
    } catch (err) {
      log.error(`[WebRTC] Send failed: ${err}`);
    }
  }

  close(): void {
    this.closed = true;
    try { this.peer?.close(); } catch {}
    this.peer = null;
  }
}

// ============================================================
// FileReceiver — Agent A (caller, initiates WebRTC offer)
// ============================================================

export class FileReceiver {
  private peer: InstanceType<NodeDataChannel['PeerConnection']> | null = null;
  private dc: InstanceType<NodeDataChannel['DataChannel']> | null = null;
  private expectedSize: number;
  private expectedSha256: string;
  private chunks: Buffer[] = [];
  private receivedBytes = 0;
  private resolveComplete: ((buf: Buffer) => void) | null = null;
  private rejectComplete: ((err: Error) => void) | null = null;
  private signalCallback: ((signal: SignalMessage) => void | Promise<void>) | null = null;
  private pendingCandidates: Array<{ candidate: string; mid: string }> = [];
  private closed = false;

  constructor(expectedSize: number, expectedSha256: string) {
    this.expectedSize = expectedSize;
    this.expectedSha256 = expectedSha256;
  }

  onSignal(cb: (signal: SignalMessage) => void | Promise<void>): void {
    this.signalCallback = cb;
  }

  async createOffer(): Promise<string | null> {
    const ndc = await loadNdc();
    if (!ndc) return null;

    this.peer = new ndc.PeerConnection('receiver', {
      iceServers: ICE_SERVERS,
    });

    return new Promise<string>((resolve) => {
      this.peer.onLocalDescription((sdp: string, type: string) => {
        if (type === 'offer') {
          resolve(sdp);
        }
        this.signalCallback?.({ signal_type: type as 'offer' | 'answer', payload: sdp });
      });

      this.peer.onLocalCandidate((candidate: string, mid: string) => {
        this.signalCallback?.({
          signal_type: 'candidate',
          payload: JSON.stringify({ candidate, mid }),
        });
      });

      this.dc = this.peer.createDataChannel('file-transfer');

      this.dc.onMessage((msg: Buffer | string) => {
        if (typeof msg === 'string') {
          // JSON control message
          try {
            const ctrl = JSON.parse(msg);
            if (ctrl.type === 'complete') {
              this.finalizeReceive();
            }
          } catch {}
          return;
        }
        // Binary chunk
        const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
        this.chunks.push(buf);
        this.receivedBytes += buf.length;
      });
    });
  }

  async handleSignal(signal: SignalMessage): Promise<void> {
    if (!this.peer || this.closed) return;

    try {
      if (signal.signal_type === 'answer' || signal.signal_type === 'offer') {
        this.peer.setRemoteDescription(signal.payload, signal.signal_type);
        for (const c of this.pendingCandidates) {
          this.peer.addRemoteCandidate(c.candidate, c.mid);
        }
        this.pendingCandidates = [];
      } else if (signal.signal_type === 'candidate') {
        const { candidate, mid } = JSON.parse(signal.payload);
        if (this.peer.remoteDescription()) {
          this.peer.addRemoteCandidate(candidate, mid);
        } else {
          this.pendingCandidates.push({ candidate, mid });
        }
      }
    } catch {
      // Ignore invalid signals (malformed SDP, bad candidates)
    }
  }

  waitForCompletion(timeoutMs = CONNECT_TIMEOUT_MS): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      this.resolveComplete = resolve;
      this.rejectComplete = reject;

      setTimeout(() => {
        if (!this.closed) {
          reject(new Error(`WebRTC file transfer timed out after ${timeoutMs}ms`));
          this.close();
        }
      }, timeoutMs);
    });
  }

  private finalizeReceive(): void {
    const zipBuffer = Buffer.concat(this.chunks);
    const actualSha256 = createHash('sha256').update(zipBuffer).digest('hex');

    if (zipBuffer.length !== this.expectedSize) {
      this.rejectComplete?.(
        new Error(`Size mismatch: expected ${this.expectedSize}, got ${zipBuffer.length}`)
      );
      this.close();
      return;
    }

    if (actualSha256 !== this.expectedSha256) {
      this.rejectComplete?.(
        new Error(`SHA-256 mismatch: expected ${this.expectedSha256}, got ${actualSha256}`)
      );
      this.close();
      return;
    }

    log.info(`[WebRTC] Received ${zipBuffer.length} bytes, SHA-256 verified`);
    this.resolveComplete?.(zipBuffer);
    this.close();
  }

  close(): void {
    this.closed = true;
    try { this.dc?.close(); } catch {}
    try { this.peer?.close(); } catch {}
    this.peer = null;
    this.dc = null;
  }
}

// ============================================================
// FileUploadReceiver — Agent (passive peer, receives upload from caller)
// ============================================================

export class FileUploadReceiver {
  private peer: InstanceType<NodeDataChannel['PeerConnection']> | null = null;
  private expectedSize: number;
  private expectedSha256: string;
  private chunks: Buffer[] = [];
  private receivedBytes = 0;
  private resolveComplete: ((buf: Buffer) => void) | null = null;
  private rejectComplete: ((err: Error) => void) | null = null;
  private signalCallback: ((signal: SignalMessage) => void) | null = null;
  private pendingCandidates: Array<{ candidate: string; mid: string }> = [];
  private closed = false;

  constructor(expectedSize: number, expectedSha256: string) {
    this.expectedSize = expectedSize;
    this.expectedSha256 = expectedSha256;
  }

  onSignal(cb: (signal: SignalMessage) => void): void {
    this.signalCallback = cb;
  }

  async handleSignal(signal: SignalMessage): Promise<void> {
    const ndc = await loadNdc();
    if (!ndc || this.closed) return;

    if (!this.peer) {
      this.peer = new ndc.PeerConnection(`upload-receiver-${Date.now()}`, {
        iceServers: ICE_SERVERS,
      });

      this.peer.onLocalDescription((sdp: string, type: string) => {
        this.signalCallback?.({ signal_type: type as 'offer' | 'answer', payload: sdp });
      });

      this.peer.onLocalCandidate((candidate: string, mid: string) => {
        this.signalCallback?.({
          signal_type: 'candidate',
          payload: JSON.stringify({ candidate, mid }),
        });
      });

      // Passive peer — receive DataChannel created by caller
      this.peer.onDataChannel((dc: InstanceType<NodeDataChannel['DataChannel']>) => {
        dc.onMessage((msg: Buffer | string) => {
          if (typeof msg === 'string') {
            try {
              const ctrl = JSON.parse(msg);
              if (ctrl.type === 'complete') {
                this.finalizeReceive();
              }
            } catch {}
            return;
          }
          const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
          this.chunks.push(buf);
          this.receivedBytes += buf.length;
        });
      });
    }

    try {
      if (signal.signal_type === 'offer' || signal.signal_type === 'answer') {
        this.peer.setRemoteDescription(signal.payload, signal.signal_type);
        for (const c of this.pendingCandidates) {
          this.peer.addRemoteCandidate(c.candidate, c.mid);
        }
        this.pendingCandidates = [];
      } else if (signal.signal_type === 'candidate') {
        const { candidate, mid } = JSON.parse(signal.payload);
        if (this.peer.remoteDescription()) {
          this.peer.addRemoteCandidate(candidate, mid);
        } else {
          this.pendingCandidates.push({ candidate, mid });
        }
      }
    } catch {
      // Ignore invalid signals (malformed SDP, bad candidates)
    }
  }

  waitForCompletion(timeoutMs = 30_000): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      this.resolveComplete = resolve;
      this.rejectComplete = reject;

      setTimeout(() => {
        if (!this.closed) {
          reject(new Error(`Upload receive timed out after ${timeoutMs}ms`));
          this.close();
        }
      }, timeoutMs);
    });
  }

  private finalizeReceive(): void {
    const zipBuffer = Buffer.concat(this.chunks);
    const actualSha256 = createHash('sha256').update(zipBuffer).digest('hex');

    if (zipBuffer.length !== this.expectedSize) {
      this.rejectComplete?.(
        new Error(`Size mismatch: expected ${this.expectedSize}, got ${zipBuffer.length}`)
      );
      this.close();
      return;
    }

    if (actualSha256 !== this.expectedSha256) {
      this.rejectComplete?.(
        new Error(`SHA-256 mismatch: expected ${this.expectedSha256}, got ${actualSha256}`)
      );
      this.close();
      return;
    }

    log.info(`[WebRTC] Upload received ${zipBuffer.length} bytes, SHA-256 verified`);
    this.resolveComplete?.(zipBuffer);
    this.close();
  }

  close(): void {
    this.closed = true;
    try { this.peer?.close(); } catch {}
    this.peer = null;
  }
}

// ============================================================
// FileUploadSender — Caller (active peer, sends files to agent)
// ============================================================

export class FileUploadSender {
  private peer: InstanceType<NodeDataChannel['PeerConnection']> | null = null;
  private dc: InstanceType<NodeDataChannel['DataChannel']> | null = null;
  private transferId: string;
  private zipBuffer: Buffer;
  private signalCallback: ((signal: SignalMessage) => void | Promise<void>) | null = null;
  private pendingCandidates: Array<{ candidate: string; mid: string }> = [];
  private resolveComplete: (() => void) | null = null;
  private rejectComplete: ((err: Error) => void) | null = null;
  private closed = false;

  constructor(transferId: string, zipBuffer: Buffer) {
    this.transferId = transferId;
    this.zipBuffer = zipBuffer;
  }

  onSignal(cb: (signal: SignalMessage) => void | Promise<void>): void {
    this.signalCallback = cb;
  }

  async createOffer(): Promise<string | null> {
    const ndc = await loadNdc();
    if (!ndc) return null;

    this.peer = new ndc.PeerConnection('upload-sender', {
      iceServers: ICE_SERVERS,
    });

    return new Promise<string>((resolve) => {
      this.peer.onLocalDescription((sdp: string, type: string) => {
        if (type === 'offer') {
          resolve(sdp);
        }
        this.signalCallback?.({ signal_type: type as 'offer' | 'answer', payload: sdp });
      });

      this.peer.onLocalCandidate((candidate: string, mid: string) => {
        this.signalCallback?.({
          signal_type: 'candidate',
          payload: JSON.stringify({ candidate, mid }),
        });
      });

      this.dc = this.peer.createDataChannel('file-transfer');

      this.dc.onOpen(() => {
        void this.sendZip();
      });
    });
  }

  async handleSignal(signal: SignalMessage): Promise<void> {
    if (!this.peer || this.closed) return;

    try {
      if (signal.signal_type === 'answer' || signal.signal_type === 'offer') {
        this.peer.setRemoteDescription(signal.payload, signal.signal_type);
        for (const c of this.pendingCandidates) {
          this.peer.addRemoteCandidate(c.candidate, c.mid);
        }
        this.pendingCandidates = [];
      } else if (signal.signal_type === 'candidate') {
        const { candidate, mid } = JSON.parse(signal.payload);
        if (this.peer.remoteDescription()) {
          this.peer.addRemoteCandidate(candidate, mid);
        } else {
          this.pendingCandidates.push({ candidate, mid });
        }
      }
    } catch {
      // Ignore invalid signals (malformed SDP, bad candidates)
    }
  }

  waitForCompletion(timeoutMs = 30_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.resolveComplete = resolve;
      this.rejectComplete = reject;

      setTimeout(() => {
        if (!this.closed) {
          reject(new Error(`Upload send timed out after ${timeoutMs}ms`));
          this.close();
        }
      }, timeoutMs);
    });
  }

  private async sendZip(): Promise<void> {
    if (!this.dc) return;
    try {
      // Send header
      this.dc.sendMessage(JSON.stringify({
        type: 'header',
        transfer_id: this.transferId,
        zip_size: this.zipBuffer.length,
      }));

      // Send binary chunks
      let offset = 0;
      while (offset < this.zipBuffer.length) {
        const end = Math.min(offset + CHUNK_SIZE, this.zipBuffer.length);
        const chunk = this.zipBuffer.subarray(offset, end);
        this.dc.sendMessageBinary(chunk);
        offset = end;
      }

      // Send completion marker
      this.dc.sendMessage(JSON.stringify({ type: 'complete' }));

      log.info(`[WebRTC] Upload sent ${this.zipBuffer.length} bytes in ${Math.ceil(this.zipBuffer.length / CHUNK_SIZE)} chunks`);
      this.resolveComplete?.();
      this.close();
    } catch (err) {
      log.error(`[WebRTC] Upload send failed: ${err}`);
      this.rejectComplete?.(err instanceof Error ? err : new Error(String(err)));
      this.close();
    }
  }

  close(): void {
    this.closed = true;
    try { this.dc?.close(); } catch {}
    try { this.peer?.close(); } catch {}
    this.peer = null;
    this.dc = null;
  }
}

/**
 * Compute SHA-256 hex digest of a buffer.
 */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Check if node-datachannel is available (non-blocking).
 */
export async function isWebRtcAvailable(): Promise<boolean> {
  return !!(await loadNdc());
}
