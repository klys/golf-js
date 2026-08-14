(function (NG) {
  'use strict';

  class WebRTCHostClient {
    constructor(relay) {
      this.relay = relay;
      this.iceServers = relay.iceServers || [];
      this.role = 'idle';
      this.lobbyId = null;
      this.hostClientId = null;
      this.peers = new Map();
      this.listeners = new Map();
      this.unsubs = [
        relay.on('signal', (payload) => this.handleSignal(payload)),
        relay.on('peer:join', (payload) => this.handlePeerJoin(payload)),
        relay.on('peer:resume', (payload) => this.handlePeerJoin(payload)),
        relay.on('peer:leave', (payload) => { if (payload?.clientId) this.closePeer(payload.clientId, 'peer-left'); }),
      ];
      this.pingAccumulator = 0;
    }

    on(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(handler);
      return () => this.listeners.get(type)?.delete(handler);
    }

    emit(type, payload) {
      for (const fn of this.listeners.get(type) || []) {
        try { fn(payload); } catch (error) { console.error('[WebRTCHostClient listener]', error); }
      }
    }

    becomeHost(lobbyId) {
      this.role = 'host';
      this.lobbyId = lobbyId;
      this.hostClientId = this.relay.clientId;
    }

    becomeClient(lobbyId, hostClientId) {
      this.role = 'client';
      this.lobbyId = lobbyId;
      this.hostClientId = hostClientId;
    }

    createPeer(peerId, initiator) {
      if (!window.RTCPeerConnection) throw new Error('Este navegador no dispone de WebRTC RTCPeerConnection.');
      if (this.peers.has(peerId)) return this.peers.get(peerId);
      const pc = new RTCPeerConnection({
        iceServers: this.iceServers,
        bundlePolicy: 'max-bundle',
      });
      const peer = {
        id: peerId,
        pc,
        reliable: null,
        state: null,
        pendingIce: [],
        open: false,
        rtt: null,
        pings: new Map(),
        lastStateAt: 0,
      };
      this.peers.set(peerId, peer);

      pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        this.relay.send('signal', {
          lobbyId: this.lobbyId,
          targetClientId: peerId,
          data: { kind: 'ice', candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate },
        });
      };
      pc.onicecandidateerror = (event) => this.emit('iceerror', {
        peerId,
        errorCode: event.errorCode,
        errorText: event.errorText,
        url: event.url,
      });
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        this.emit('connectionstate', { peerId, state });
        if (state === 'failed' || state === 'closed') this.handlePeerClosed(peerId, state);
      };
      pc.oniceconnectionstatechange = () => this.emit('icestate', { peerId, state: pc.iceConnectionState });
      pc.ondatachannel = (event) => this.attachChannel(peer, event.channel);

      if (initiator) {
        this.attachChannel(peer, pc.createDataChannel('reliable', { ordered: true }));
        try {
          this.attachChannel(peer, pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 }));
        } catch (_) {
          // Algunos navegadores antiguos no aceptan maxRetransmits; el canal fiable sigue siendo suficiente.
        }
      }
      return peer;
    }

    attachChannel(peer, channel) {
      if (!channel) return;
      if (channel.label === 'state') peer.state = channel;
      else peer.reliable = channel;
      channel.onopen = () => {
        if (channel.label !== 'state' && !peer.open) {
          peer.open = true;
          this.emit('peeropen', { peerId: peer.id });
        }
      };
      channel.onclose = () => {
        if (channel.label !== 'state' && peer.open) {
          peer.open = false;
          this.emit('peerclose', { peerId: peer.id, reason: 'datachannel-closed' });
        }
      };
      channel.onerror = (event) => this.emit('channelerror', { peerId: peer.id, label: channel.label, event });
      channel.onmessage = (event) => this.handleDataMessage(peer, channel.label, event.data);
    }

    async handlePeerJoin(payload) {
      if (this.role !== 'host' || payload.lobbyId !== this.lobbyId || !payload.clientId) return;
      try {
        this.closePeer(payload.clientId, 'replace-before-offer');
        const peer = this.createPeer(payload.clientId, true);
        peer.joinMeta = payload;
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        this.relay.send('signal', {
          lobbyId: this.lobbyId,
          targetClientId: payload.clientId,
          data: { kind: 'description', description: peer.pc.localDescription },
        });
        this.emit('peerpending', payload);
      } catch (error) {
        console.error('[WebRTC host offer]', error);
        this.emit('peererror', { peerId: payload.clientId, error });
      }
    }

    async handleSignal(payload) {
      if (!payload || payload.lobbyId !== this.lobbyId || !payload.fromClientId || !payload.data) return;
      const from = payload.fromClientId;
      try {
        const peer = this.peers.get(from) || this.createPeer(from, false);
        const data = payload.data;
        if (data.kind === 'description' && data.description) {
          const description = data.description;
          await peer.pc.setRemoteDescription(description);
          while (peer.pendingIce.length) {
            const candidate = peer.pendingIce.shift();
            try { await peer.pc.addIceCandidate(candidate); } catch (error) { console.warn('[WebRTC queued ICE]', error); }
          }
          if (description.type === 'offer') {
            const answer = await peer.pc.createAnswer();
            await peer.pc.setLocalDescription(answer);
            this.relay.send('signal', {
              lobbyId: this.lobbyId,
              targetClientId: from,
              data: { kind: 'description', description: peer.pc.localDescription },
            });
          }
        } else if (data.kind === 'ice' && data.candidate) {
          if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate);
          else peer.pendingIce.push(data.candidate);
        }
      } catch (error) {
        console.error('[WebRTC signal]', error);
        this.emit('peererror', { peerId: from, error });
      }
    }

    handleDataMessage(peer, channelLabel, raw) {
      let message;
      try { message = JSON.parse(String(raw)); } catch (_) { return; }
      if (!message || typeof message.type !== 'string') return;
      if (message.type === '_net:ping') {
        this.sendReliable(peer.id, { type: '_net:pong', nonce: message.nonce, at: message.at });
        return;
      }
      if (message.type === '_net:pong') {
        const started = peer.pings.get(message.nonce);
        if (started !== undefined) {
          peer.pings.delete(message.nonce);
          peer.rtt = Math.round(performance.now() - started);
          this.emit('rtt', { peerId: peer.id, rtt: peer.rtt });
        }
        return;
      }
      if (channelLabel === 'state') peer.lastStateAt = performance.now();
      this.emit('message', { peerId: peer.id, channel: channelLabel, message });
    }

    update(dt) {
      this.pingAccumulator += dt;
      if (this.pingAccumulator < NG.NET_CONFIG.reliablePingSeconds) return;
      this.pingAccumulator = 0;
      for (const peer of this.peers.values()) {
        if (!peer.open) continue;
        const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        peer.pings.set(nonce, performance.now());
        if (peer.pings.size > 4) peer.pings.delete(peer.pings.keys().next().value);
        this.sendReliable(peer.id, { type: '_net:ping', nonce, at: Date.now() });
      }
    }

    sendChannel(peer, channel, message) {
      if (!channel || channel.readyState !== 'open') return false;
      try {
        if (channel.bufferedAmount > 512 * 1024 && channel.label === 'state') return false;
        channel.send(JSON.stringify(message));
        return true;
      } catch (_) { return false; }
    }

    sendReliable(peerId, message) {
      const peer = this.peers.get(peerId);
      return !!peer && this.sendChannel(peer, peer.reliable, message);
    }

    sendState(peerId, message) {
      const peer = this.peers.get(peerId);
      if (!peer) return false;
      if (peer.state && peer.state.readyState === 'open') return this.sendChannel(peer, peer.state, message);
      return this.sendChannel(peer, peer.reliable, message);
    }

    broadcastReliable(message) {
      for (const peer of this.peers.values()) if (peer.open) this.sendChannel(peer, peer.reliable, message);
    }

    broadcastState(message) {
      for (const peer of this.peers.values()) if (peer.open) this.sendState(peer.id, message);
    }

    getRtt(peerId) { return this.peers.get(peerId)?.rtt ?? null; }

    handlePeerClosed(peerId, reason) {
      const peer = this.peers.get(peerId);
      if (!peer) return;
      if (peer.open) this.emit('peerclose', { peerId, reason });
      peer.open = false;
    }

    closePeer(peerId, reason = 'closed') {
      const peer = this.peers.get(peerId);
      if (!peer) return;
      const wasOpen = !!peer.open;
      peer.open = false;
      this.peers.delete(peerId);
      try { peer.reliable?.close(); } catch (_) { /* noop */ }
      try { peer.state?.close(); } catch (_) { /* noop */ }
      try { peer.pc?.close(); } catch (_) { /* noop */ }
      if (wasOpen) this.emit('peerclose', { peerId, reason });
    }

    close() {
      for (const peerId of [...this.peers.keys()]) this.closePeer(peerId, 'transport-close');
      for (const unsub of this.unsubs) try { unsub(); } catch (_) { /* noop */ }
      this.unsubs.length = 0;
      this.role = 'idle';
    }
  }

  NG.WebRTCHostClient = WebRTCHostClient;
}(window.NoiseGolf = window.NoiseGolf || {}));
