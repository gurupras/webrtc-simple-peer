const deepmerge = require('deepmerge')
const { nanoid } = require('nanoid')
const SimpleSignalClient = require('simple-signal-client')
const AbstractWebRTC = require('@gurupras/abstract-webrtc')
const AsyncLock = require('async-lock')

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
      requestTimeoutMS: 2000
    }
    options = deepmerge(defaultOpts, options)
    super(options, socket, userIdentifier)

    Object.assign(this, {
      peers: {},
      discoveryIDToPeer: {},
      gainMap: {},
      streams: [],
      streamInfo: {},
      remoteStreamInfo: {},
      lock: new AsyncLock()
    })
  }

  async setup () {
    const { socket } = this

    const signalClient = new SimpleSignalClient(socket)
    const { userIdentifier } = this
    signalClient.on('discover', async (peerIDs = []) => {
      const { options: { peerOpts } } = this
      // console.log(`Found peers: ${JSON.stringify(peerIDs)}`)
      for (const peerID of peerIDs) {
        const { peer, metadata } = await signalClient.connect(peerID, {
          userIdentifier
        }, {
          ...peerOpts
        })
        const { userIdentifier: remoteUserIdentifier } = metadata
        // console.log(`[simple-peer]: Connected to peer: ${peer._id}`)
        this.setupPeer(peer, metadata, remoteUserIdentifier)
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
      this.setupPeer(peer, metadata, remoteUserIdentifier)
    })
  }

  discover () {
    return this.signalClient.discover()
  }

  setupPeer (peer, metadata, discoveryID) {
    peer.peerID = discoveryID // Expose a standard UID
    this.gainMap[peer.peerID] = []
    this.discoveryIDToPeer[discoveryID] = peer
    peer.metadata = metadata
    peer.on('data', async data => {
      let json
      try {
        json = JSON.parse(data)
      } catch (e) {
        return this.emit('error', new BadDataError('', peer.peerID, data))
      }
      switch (json.action) {
        case 'volume-control': {
          const { volume, type } = json
          // console.log(`Changing volume...peer=${peer.peerID} userIdentifier=${metadata.userIdentifier} volume=${volume}`)
          const peerGainMap = this.gainMap[peer.peerID]
          if (!peerGainMap) {
            return this.emit('error', new BadDataError(json.action, peer.peerID))
          }
          const clonedStreamWithGain = this.gainMap[peer.peerID].find(entry => entry.type === type)
          if (clonedStreamWithGain && clonedStreamWithGain.gainNode) {
            clonedStreamWithGain.gainNode.gain.value = volume
          }
          break
        }
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
          const { type = null, originalStream } = streamInfo
          let videoTrack
          let audioTrack
          // We get audio and video enabled state from the original stream since the clonedStream will always have enabled = true
          // and since we clone the video track
          if (originalStream) {
            videoTrack = originalStream.getVideoTracks()[0]
            audioTrack = originalStream.getAudioTracks()[0]
          }
          peer.send(JSON.stringify({
            action: 'stream-info',
            nonce,
            type,
            videoPaused: videoTrack ? !videoTrack.enabled : undefined,
            audioPaused: audioTrack ? !audioTrack.enabled : undefined
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
      }
    })
    var events = ['connect', 'close', 'signal', 'destroy', 'error', 'data']
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

    const clonedStreams = this.cloneAllStreams()
    this.registerClonedStreams(clonedStreams, peer.peerID)
    for (const entry of clonedStreams) {
      peer.addStream(entry.stream)
    }

    const closePeer = () => {
      // console.log(`Closing peer: ${peer.peerID}`)
      delete this.peers[peer.peerID]
      delete this.gainMap[peer.peerID]
      delete this.discoveryIDToPeer[discoveryID]
    }
    peer.on('destroy', closePeer)
    // console.log(`peer: ${peer.peerID} has been set up`)
    this.peers[peer.peerID] = peer
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
      this.remoteStreamInfo[stream.id] = { peer, type, stream, videoPaused, audioPaused }
      return json
    })
    return info
  }

  async sendStream (newStream, oldStream, type) {
    if (this.signalClient) {
      await this.lock.acquire('sendStream', async () => {
        for (const peer of Object.values(this.signalClient.peers())) {
          const peerStreams = this.gainMap[peer.peerID]
          if (!peerStreams) {
            console.warn(`Failed to find peer streams for peerID: ${peer.peerID}`)
            continue
          }
          const oldClonedStream = peerStreams.find(e => e.type === type)
          if (oldClonedStream) {
            peerStreams.splice(peerStreams.indexOf(oldClonedStream), 1)
            delete this.streamInfo[oldClonedStream.stream.id]
            peer.removeStream(oldClonedStream.stream)
          }

          const clonedStreamWithGain = this.cloneStreamWithGain(newStream, type)
          if (clonedStreamWithGain.stream) {
            peerStreams.push(clonedStreamWithGain)
            // We need to add data to streamInfo before we call addStream
            // This is so that we have the necessary information to respond to the get-stream-info request
            // that we will receive shortly
            const stream = clonedStreamWithGain.stream
            const videoTrack = stream.getVideoTracks()[0]
            const audioTrack = newStream.getAudioTracks()[0]
            this.streamInfo[clonedStreamWithGain.stream.id] = {
              peer,
              type,
              stream: clonedStreamWithGain.stream,
              videoPaused: videoTrack && !videoTrack.enabled,
              audioPaused: audioTrack && !audioTrack.enabled,
              consumerVideoPaused: true,
              consumerAudioPaused: true,
              originalStream: clonedStreamWithGain.originalStream
            }
            await peer.addStream(clonedStreamWithGain.stream)
          }
          if (!newStream || newStream.getTracks().length === 0) {
            peer.send(JSON.stringify({
              action: 'no-stream',
              type
            }))
          }
        }
      })
    }
    if (newStream) {
      this.streams.push(newStream)
      this.streamInfo[newStream.id] = { type, stream: newStream }
    }
    if (oldStream) {
      const oldStreamIndex = this.streams.indexOf(oldStream)
      if (oldStreamIndex >= 0) {
        this.streams.splice(oldStreamIndex, 1)
      }
      delete this.streamInfo[oldStream.id]
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

  cloneStreamWithGain (stream, type) {
    if (!stream) {
      return {}
    }
    const originalVideoTracks = [...stream.getVideoTracks()]
    const clonedVideoTracks = originalVideoTracks.map(t => {
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
    if (stream.getAudioTracks().length === 0) {
      return { stream: new MediaStream(clonedVideoTracks), type }
    }
    const audioTrack = stream.getAudioTracks()[0]
    var ctx = new AudioContext()
    var src = ctx.createMediaStreamSource(new MediaStream([audioTrack]))
    var dst = ctx.createMediaStreamDestination()
    var gainNode = ctx.createGain()
    gainNode.gain.value = 0.5
    ;[src, gainNode, dst].reduce((a, b) => a && a.connect(b))
    clonedVideoTracks.forEach(t => dst.stream.addTrack(t))
    return { gainNode, stream: dst.stream, type, originalStream: stream }
  }

  cloneAllStreams () {
    const result = []
    const { streamInfo } = this
    for (const stream of this.streams) {
      const { id } = stream
      const { [id]: { type } } = streamInfo
      const clonedStream = this.cloneStreamWithGain(stream, type)
      result.push(clonedStream)
    }
    return result
  }

  registerClonedStreams (clonedStreams, peerID) {
    this.gainMap[peerID].push(...clonedStreams)
    for (const entry of clonedStreams) {
      const { stream } = entry
      const { id } = stream
      this.streamInfo[id] = entry
    }
  }

  updateVolume (volume, peerID, type) {
    const peer = this.peers[peerID]
    if (!peer) {
      throw new Error(`No peer found with id=${peerID}`)
    }
    if (!type) {
      throw new Error('Must specify a stream type')
    }
    peer.send(JSON.stringify({ action: 'volume-control', volume, type }))
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
    this.streams.forEach(stream => {
      stream.getTracks().forEach(t => t.stop())
      delete this.streamInfo[stream.id]
    }, this)
    this.streams = []
    this.streamInfo = {}
    // Disconnect from all peers
    if (this.signalClient) {
      const peers = this.signalClient.peers()
      Object.keys(peers).forEach(key => peers[key].destroy())
      this.signalClient = undefined
    }
  }
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
  BadDataError,
  RequestTimedOutError
}
