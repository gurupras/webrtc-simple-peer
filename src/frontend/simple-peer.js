const deepmerge = require('deepmerge')
const { nanoid } = require('nanoid')
const SimpleSignalClient = require('@gurupras/simple-signal-client')
const AbstractWebRTC = require('@gurupras/abstract-webrtc')
const AsyncLock = require('async-lock')
const { VolumeMeter } = require('./volume-meter')

class SimplePeer extends AbstractWebRTC {
  constructor (options, socket, userIdentifier) {
    const defaultOpts = {
      peerOpts: {
        config: {
          iceTransportPolicy: 'all'
        },
        offerOptions: {
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        },
        answerOptions: {
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        },
        trickle: true
      },
      requestTimeoutMS: 2000,
      volumesEventInterval: 3000
    }
    options = deepmerge(defaultOpts, options)
    super(options, socket, userIdentifier)

    this.peers = {}
    this.discoveryIDToPeer = {}
    this.streams = []
    this.streamInfo = {}
    this.remoteStreamInfo = {}
    this.lock = new AsyncLock()
  }

  async updateSocket (socket) {
    this.socket = socket
    // Save all the streams that are currently being sent out
    const streams = this.streams
    const streamInfo = {}
    streams.forEach(stream => {
      streamInfo[stream.id] = this.streamInfo[stream.id]
    })
    // Restore streams currently being sent out so that new connections
    // automatically get these streams
    this.streams = streams
    this.streamInfo = streamInfo
    await this.setup()
  }

  async setup () {
    const { socket } = this

    // We cannot pass in this socket as-is because SimpleSignalClient does not give us an easy way to cleanly destroy without closing socket
    // As a result, we're going to pass in a socket-like item
    const signalSocket = wrapSocketForSignalClient(socket)
    const signalClient = new SimpleSignalClient(signalSocket)
    const { userIdentifier } = this
    signalClient.on('discover', async (peerIDs = []) => {
      const { options: { peerOpts } } = this
      // console.log(`Found peers: ${JSON.stringify(peerIDs)}`)
      for (const peerID of peerIDs) {
        signalClient.connect(peerID, {
          userIdentifier
        }, {
          ...peerOpts
        }).then(async ({ peer, metadata }) => {
          const { userIdentifier: remoteUserIdentifier } = metadata
          // console.log(`[simple-peer]: Connected to peer: ${peer._id}`)
          await this.setupPeer(peer, metadata, remoteUserIdentifier)
        })
      }
    })
    this.signalClient = signalClient

    signalClient.on('request', async (request) => {
      // console.log(`[simple-peer]: Calling accept with stream`)
      const { options: { peerOpts } } = this
      const { metadata: { userIdentifier: remoteUserIdentifier } } = request
      const oldPeer = this.discoveryIDToPeer[remoteUserIdentifier]
      if (this.discoveryIDToPeer[remoteUserIdentifier]) {
        try {
          oldPeer.destroy()
        } catch (e) {
        }
      }
      const { peer, metadata } = await request.accept({
        userIdentifier
      }, {
        ...peerOpts
      })
      // console.log(`[simple-peer]: Accepted request: ${peer._id}`)
      await this.setupPeer(peer, metadata, remoteUserIdentifier)
    })
  }

  setupVolumesEvent () {
    this.volumesEventInterval = setInterval(() => {
      const volumes = {}
      for (const entry of Object.values(this.remoteStreamInfo)) {
        const { peer: { metadata: { userIdentifier } }, volume } = entry
        volumes[userIdentifier] = { volume }
      }
      this.emit('volumes', volumes)
    }, this.options.volumesEventInterval)
  }

  discover () {
    return this.signalClient.discover()
  }

  async setupPeer (peer, metadata, discoveryID) {
    await this.lock.acquire('peers', async () => {
      peer.peerID = discoveryID // Expose a standard UID
      this.discoveryIDToPeer[discoveryID] = peer
      peer.streamMap = new Map()
      peer.metadata = metadata
      peer.on('data', async data => {
        let json
        try {
          json = JSON.parse(data)
        } catch (e) {
          return this.emit('error', new BadDataError('', peer.peerID, data))
        }
        switch (json.action) {
          case 'no-stream': {
            const { type } = json
            const remoteStreamIDs = peer._remoteStreams.map(x => x.id)
            peer._remoteStreams.splice(0, peer._remoteStreams.length)
            for (const remoteStreamID of remoteStreamIDs) {
              const entry = this.remoteStreamInfo[remoteStreamID]
              if (!entry || entry.type !== type) {
                continue
              }
              delete this.remoteStreamInfo[remoteStreamID]
            }
            this.emit('no-stream', {
              peer,
              metadata,
              data: undefined
            })
            break
          }
          case 'get-stream-info': {
            const { nonce, streamID } = json
            const streamInfo = this.streamInfo[streamID] || {}
            const { type = null, videoPaused, audioPaused } = streamInfo
            peer.send(JSON.stringify({
              action: 'stream-info',
              nonce,
              type,
              videoPaused,
              audioPaused
            }))
            break
          }
          case 'pauseProducer': {
            const { type, kind } = json
            const info = this._getStreamInfo({ type, peer }, this.remoteStreamInfo)[0]
            if (!info) {
              console.warn('No stream found', { action: json.action, type, kind, peerID: peer.peerID })
              return
            }
            switch (kind) {
              case 'video':
                info.videoPaused = true
                break
              case 'audio':
                info.audioPaused = true
                break
            }
            this.emit('stream-update', { peer, metadata, data: info })
            break
          }
          case 'resumeProducer': {
            const { type, kind } = json
            const info = this._getStreamInfo({ type, peer }, this.remoteStreamInfo)[0]
            if (!info) {
              console.warn('No stream found', { action: json.action, type, kind, peerID: peer.peerID })
              return
            }
            switch (kind) {
              case 'video':
                info.videoPaused = false
                break
              case 'audio':
                info.audioPaused = false
                break
            }
            this.emit('stream-update', { peer, metadata, data: info })
            break
          }
          case 'pauseConsumer': {
            await this.lock.acquire([peer.peerID], async () => {
              const { type, kind } = json
              const info = this._getStreamInfo({ type, peer }, this.streamInfo)[0]
              if (!info) {
                console.warn('No stream found', { action: json.action, type, kind, peerID: peer.peerID })
                return
              }
              const track = this._getTrack(type, kind, info)
              if (!track) {
                return
              }
              track.enabled = false
              switch (kind) {
                case 'audio':
                  info.consumerAudioPaused = true
                  break
                case 'video':
                  info.consumerVideoPaused = true
                  break
              }
              this.emit('stream-update', { peer, metadata, data: info })
            })
            break
          }
          case 'resumeConsumer': {
            await this.lock.acquire([peer.peerID], async () => {
              const { type, kind } = json
              const info = this._getStreamInfo({ type, peer }, this.streamInfo)[0]
              if (!info) {
                console.warn('No stream found', { action: json.action, type, kind, peerID: peer.peerID })
                return
              }
              const track = this._getTrack(type, kind, info)
              if (!track) {
                return
              }
              switch (kind) {
                case 'audio':
                  info.consumerAudioPaused = false
                  track.enabled = !info.audioPaused
                  break
                case 'video':
                  info.consumerVideoPaused = false
                  track.enabled = !info.videoPaused
                  break
              }
              this.emit('stream-update', { peer, metadata, data: info })
            })
            break
          }
          case 'volume': {
            const { data: { streamID, volume } } = json
            if (this.remoteStreamInfo[streamID]) {
              this.remoteStreamInfo[streamID].volume = volume
            }
            break
          }
        }
      })
      const events = ['connect', 'close', 'signal', 'destroy', 'error', 'data']
      events.forEach(evt => {
        peer.on(evt, data => {
          // console.log(`[simple-peer]: ${peer.peerID}: ${evt}`)
          this.emit(evt, { peer, metadata, data })
        })
      }, this)
      // Track is special because it has a second argument
      peer.on('track', async (track, stream) => {
        try {
          const info = await this._getRemoteStreamInfo(peer, stream)
          const { type, videoPaused, audioPaused } = info
          await this.onRemoteTrack(track, stream, info)
          await this.emit('track', { peer, track, stream, metadata: { ...metadata, type, videoPaused, audioPaused } })
        } catch (e) {
          this.emit('error', e)
        }
      })

      peer.on('stream', async stream => {
        try {
          const info = await this._getRemoteStreamInfo(peer, stream)
          const { type, videoPaused, audioPaused } = info
          await this.emit('stream', { peer, stream, metadata: { ...metadata, type, videoPaused, audioPaused } })
        } catch (e) {
          this.emit('error', e)
        }
      })

      const closePeer = () => {
        // console.log(`Closing peer: ${peer.peerID}`)
        delete this.peers[peer.peerID]
        delete this.discoveryIDToPeer[discoveryID]
        // Delete all streamInfos that we have for this peer
        const infos = this._getStreamInfo({ peer })
        infos.forEach(info => {
          const { stream: { id: streamID } } = info
          delete this.streamInfo[streamID]
        })
        // We don't need to wipe out the peer.streamMap because
        // that object will get garbage collected when peer
        // goes out of scope.
      }
      peer.on('destroy', closePeer)
      peer.on('close', closePeer)

      // console.log(`peer: ${peer.peerID} has been set up`)
      this.peers[peer.peerID] = peer

      await Promise.all(this.streams.map(stream => this._sendStreamToPeer(peer, stream, null, this.streamInfo[stream.id].type)))
    })
  }

  async _getRemoteStreamInfo (peer, stream) {
    const info = await this.lock.acquire('stream-event', async () => {
      // We need to find out what type of stream this is
      const { options: { requestTimeoutMS } } = this
      const nonce = nanoid()
      const promise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new RequestTimedOutError('get-stream-info', peer.peerID)), requestTimeoutMS)
        const self = this
        peer.on('data', function once (data) {
          try {
            const json = JSON.parse(data)
            if (json.action === 'stream-info' && json.nonce === nonce) {
              clearTimeout(timeout)
              peer.off('data', once)
              resolve(json)
            }
          } catch (e) {
            self.emit('error', new BadDataError('', peer.peerID, data))
          }
        })
      })
      peer.send(JSON.stringify({
        action: 'get-stream-info',
        nonce,
        streamID: stream.id
      }))
      const json = await promise
      const { type, videoPaused, audioPaused } = json
      // If there is existing data in remoteStreams for this peer and this type, remove it
      const existingInfo = this._getStreamInfo({ peer, type }, this.remoteStreamInfo)
      if (existingInfo) {
        existingInfo.forEach(entry => {
          const { stream: { id: streamID } } = entry
          if (streamID !== stream.id) {
            delete this.remoteStreamInfo[streamID]
          }
        })
      }
      this.remoteStreamInfo[stream.id] = { peer, type, stream, videoPaused, audioPaused }
      return json
    })
    return info
  }

  async sendStream (newStream, oldStream, type) {
    if (this.signalClient) {
      await this.lock.acquire(['peers', 'sendStream'], async () => {
        for (const peer of Object.values(this.peers)) {
          await this._sendStreamToPeer(peer, newStream, oldStream, type)
        }
      })
    }
    if (newStream) {
      this.streams.push(newStream)
      // Set up volume event if necessary
      const audioTrack = newStream.getAudioTracks()[0]
      const newStreamData = {
        type,
        stream: newStream
      }
      if (audioTrack) {
        const volumeMeter = new VolumeMeter(newStream, this.options.volumeMeter)
        const volumeInterval = setInterval(async () => {
          const volume = await volumeMeter.getVolume()
          for (const peer of Object.values(this.peers)) {
            // Get the cloned stream ID and use that
            const clonedStream = peer.streamMap.get(newStream)
            if (!clonedStream) {
              // Nothing to do
              continue
            }
            peer.send(JSON.stringify({
              action: 'volume',
              data: {
                streamID: clonedStream.id,
                volume
              }
            }))
          }
        }, 1000)
        await volumeMeter.start()
        Object.assign(newStreamData, {
          volumeMeter,
          interval: volumeInterval,
          destroy: async () => {
            clearInterval(volumeInterval)
            await volumeMeter.stop()
          }
        })
      }
      this.streamInfo[newStream.id] = newStreamData
    }
    if (oldStream) {
      const oldStreamIndex = this.streams.indexOf(oldStream)
      if (oldStreamIndex >= 0) {
        this.streams.splice(oldStreamIndex, 1)
      }
      const info = this.streamInfo[oldStream.id]
      if (info && info.destroy) {
        info.destroy() // We don't need to wait for this to complete
      }
      delete this.streamInfo[oldStream.id]
    }
  }

  async _sendStreamToPeer (peer, newStream, oldStream, type) {
    if (oldStream) {
      const clonedStream = peer.streamMap.get(oldStream)
      if (clonedStream) {
        delete this.streamInfo[clonedStream.id]
        peer.removeStream(clonedStream)
      }
    }
    // We need to add data to streamInfo before we call addStream
    // This is so that we have the necessary information to respond to the get-stream-info request
    // that we will receive shortly
    if (newStream) {
      const tracks = newStream.getTracks()
      const clonedTracks = [...tracks].map(t => {
        const clone = t.clone()
        clone.enabled = t.enabled
        const stop = t.stop.bind(t)
        t.stop = () => {
          stop()
          clone.stop()
        }
        t.addEventListener('ended', () => { clone.stop() })
        return clone
      })
      const clonedStream = new MediaStream(clonedTracks)
      const videoTrack = clonedStream.getVideoTracks()[0]
      const audioTrack = clonedStream.getAudioTracks()[0]
      this.streamInfo[clonedStream.id] = {
        peer,
        type,
        stream: clonedStream,
        videoPaused: videoTrack && !videoTrack.enabled,
        audioPaused: audioTrack && !audioTrack.enabled,
        consumerVideoPaused: true,
        consumerAudioPaused: true
      }
      peer.streamMap.set(newStream, clonedStream)
      await peer.addStream(clonedStream)
    }

    if (!newStream || newStream.getTracks().length === 0) {
      peer.send(JSON.stringify({
        action: 'no-stream',
        type
      }))
    }
  }

  async sendScreen (newStream, oldStream) {
    return this.sendStream(newStream, oldStream, 'screen')
  }

  async sendWebcam (newStream, oldStream) {
    return this.sendStream(newStream, oldStream, 'webcam')
  }

  async stopScreen () {
    // Do nothing. This is expected to be handled by the application
  }

  updateVolume (volume, userIdentifier, type) {
    if (!type) {
      throw new Error('Must specify type')
    }
    const peer = this.discoveryIDToPeer[userIdentifier]
    if (!peer) {
      return
    }
    const streamInfo = this._getStreamInfo({ peer, type }, this.remoteStreamInfo)[0]
    if (!streamInfo) {
      return
    }
    const { stream } = streamInfo
    if (!stream || !stream.volume) {
      return
    }
    return stream.volume(volume)
  }

  _getStreamInfo (filters, streamInfo = this.streamInfo) {
    return Object.values(streamInfo).filter(entry => {
      for (const [k, v] of Object.entries(filters)) {
        if (entry[k] !== v) {
          return false
        }
      }
      return true
    })
  }

  _getTrack (type, kind, info) {
    info = info || this._getStreamInfo({ type })
    if (!info) {
      throw new Error(`Did not find producer of type=${type}`)
    }
    const { stream } = info
    if (!stream) {
      throw new Error(`Did not find stream of type=${type}`)
    }
    let track
    switch (kind) {
      case 'video':
        track = stream.getVideoTracks()[0]
        break
      case 'audio':
        track = stream.getAudioTracks()[0]
        break
    }
    return track
  }

  _producerRequest (type, kind, action, pausedState) {
    const infos = this._getStreamInfo({ type })
    if (infos.length === 0) {
      throw new Error(`Did not find producer of type=${type}`)
    }
    infos.forEach(info => {
      const track = this._getTrack(type, kind, info)
      if (!track) {
        return
      }
      switch (kind) {
        case 'audio':
          info.audioPaused = pausedState
          track.enabled = !info.audioPaused && !info.consumerAudioPaused
          break
        case 'video':
          info.videoPaused = pausedState
          track.enabled = !info.videoPaused && !info.consumerVideoPaused
          break
      }
    })
    Object.values(this.peers).forEach(async peer => {
      try {
        await peer.send(JSON.stringify({ action, kind, type }))
      } catch (e) {
      }
    })
  }

  pauseProducer (type, kind) {
    return this._producerRequest(type, kind, 'pauseProducer', true)
  }

  resumeProducer (type, kind) {
    return this._producerRequest(type, kind, 'resumeProducer', false)
  }

  async _consumerRequest (remotePeerID, type, kind, action) {
    await this.lock.acquire([remotePeerID], async () => {
      const infos = this._getStreamInfo({ type }, this.remoteStreamInfo)
      if (infos.length === 0) {
        throw new Error(`Did not find consumer of type=${type}`)
      }
      const { peers: { [remotePeerID]: peer } } = this
      if (!peer) {
        throw new Error(`Did not find peer with peerID '${remotePeerID}'`)
      }
      try {
        await peer.send(JSON.stringify({ action, kind, type }))
      } catch (e) {
      }
    })
  }

  pauseConsumer (type, kind, remotePeerID) {
    return this._consumerRequest(remotePeerID, type, kind, 'pauseConsumer')
  }

  resumeConsumer (type, kind, remotePeerID) {
    return this._consumerRequest(remotePeerID, type, kind, 'resumeConsumer')
  }

  destroy () {
    if (this.volumesEventInterval) {
      clearInterval(this.volumesEventInterval)
    }
    this.streams.forEach(stream => {
      delete this.streamInfo[stream.id]
    }, this)
    this.streams = []
    for (const entry of Object.values(this.streamInfo)) {
      if (entry.destroy) {
        entry.destroy()
      }
    }
    this.streamInfo = {}
    // Disconnect from all peers
    if (this.signalClient) {
      this.signalClient.destroy()
      this.signalClient = undefined
    }
  }
}

function wrapSocketForSignalClient (socket) {
  const signalSocket = {
    listeners: new Map(),
    close () {
      for (const evt of this.listeners.keys()) {
        const cbSet = this.listeners.get(evt)
        cbSet.forEach(cb => socket.off(evt, cb))
      }
    },
    on (evt, cb) {
      let cbSet = this.listeners.get(evt)
      if (!cbSet) {
        cbSet = new Set()
        this.listeners.set(evt, cbSet)
      }
      cbSet.add(cb)
      socket.on(evt, cb)
    },
    off (evt, cb) {
      socket.off(evt, cb)
      const cbSet = this.listeners.get(evt)
      if (cbSet) {
        cbSet.delete(cb)
        if (cbSet.size === 0) {
          this.listeners.delete(evt)
        }
      }
    },
    emit (...args) {
      socket.emit(...args)
    }
  }
  return signalSocket
}

class BadDataError extends Error {
  constructor (action, peerID, data) {
    let msg = `Received bad data from peer-${peerID}: action=${action}`
    if (data) {
      msg += ` data=${data}`
    }
    super(msg)
  }
}

class RequestTimedOutError extends Error {
  constructor (action, peerID) {
    super(`Request timed out when attempting to contact peer-${peerID}: action=${action}`)
  }
}

module.exports = {
  SimplePeer,
  wrapSocketForSignalClient,
  BadDataError,
  RequestTimedOutError
}
