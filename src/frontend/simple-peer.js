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
    this.gainMap[peer._id] = []
    this.discoveryIDToPeer[discoveryID] = peer
    peer.peerID = peer._id // Expose a standard UID
    peer.metadata = metadata
    peer.on('data', data => {
      let json
      try {
        json = JSON.parse(data)
      } catch (e) {
        return this.emit('error', new BadDataError('', peer._id, data))
      }
      switch (json.action) {
        case 'volume-control': {
          const { volume, type } = json
          // console.log(`Changing volume...peer=${peer._id} userIdentifier=${metadata.userIdentifier} volume=${volume}`)
          const peerGainMap = this.gainMap[peer._id]
          if (!peerGainMap) {
            return this.emit('error', new BadDataError(json.action, peer._id))
          }
          const clonedStreamWithGain = this.gainMap[peer._id].find(entry => entry.type === type)
          if (clonedStreamWithGain && clonedStreamWithGain.gainNode) {
            clonedStreamWithGain.gainNode.gain.value = volume
          }
          break
        }
        case 'no-stream':
          peer._remoteStreams.splice(0, peer._remoteStreams.length)
          this.emit('no-stream', {
            peer,
            metadata,
            data: undefined
          })
          break
        case 'get-stream-info': {
          const { nonce, streamID } = json
          const streamInfo = this.streamInfo[streamID] || {}
          const { type = null, stream } = streamInfo
          let videoTrack
          let audioTrack
          if (stream) {
            videoTrack = stream.getVideoTracks()[0]
            audioTrack = stream.getAudioTracks()[0]
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
      }
    })
    var events = ['connect', 'close', 'signal', 'destroy', 'error', 'data', 'track']
    events.forEach(evt => {
      peer.on(evt, data => {
        // console.log(`[simple-peer]: ${peer._id}: ${evt}`)
        this.emit(evt, { peer, metadata, data })
      })
    }, this)

    peer.on('stream', async stream => {
      await this.lock.acquire('stream-event', async () => {
        // We need to find out what type of stream this is
        const { options: { requestTimeoutMS } } = this
        const nonce = nanoid()
        const promise = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new RequestTimedOutError('get-stream-info', peer._id)), requestTimeoutMS)
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
              self.emit('error', new BadDataError('', peer._id, data))
            }
          })
        })
        peer.send(JSON.stringify({
          action: 'get-stream-info',
          nonce,
          streamID: stream.id
        }))
        try {
          const json = await promise
          const { type, videoPaused, audioPaused } = json
          this.remoteStreamInfo[stream.id] = { peer, type, stream, videoPaused, audioPaused }
          await this.emit('stream', { peer, stream, metadata: { ...metadata, type, videoPaused, audioPaused } })
        } catch (e) {
          this.emit('error', e)
        }
      })
    })

    const clonedStreams = this.cloneAllStreams()
    this.registerClonedStreams(clonedStreams, peer._id)
    for (const entry of clonedStreams) {
      peer.addStream(entry.stream)
    }

    const closePeer = () => {
      // console.log(`Closing peer: ${peer._id}`)
      delete this.peers[peer._id]
      delete this.gainMap[peer._id]
      delete this.discoveryIDToPeer[discoveryID]
    }
    peer.on('destroy', closePeer)
    // console.log(`peer: ${peer._id} has been set up`)
    this.peers[peer._id] = peer
  }

  async sendStream (newStream, oldStream, type) {
    if (this.signalClient) {
      await this.lock.acquire('sendStream', async () => {
        for (const peer of Object.values(this.signalClient.peers())) {
          const peerStreams = this.gainMap[peer._id]
          if (!peerStreams) {
            console.warn(`Failed to find peer streams for peerID: ${peer._id}`)
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
            const audioTrack = stream.getAudioTracks()[0]
            this.streamInfo[clonedStreamWithGain.stream.id] = {
              peer,
              type,
              stream: clonedStreamWithGain.stream,
              videoPaused: videoTrack && !videoTrack.enabled,
              audioPaused: audioTrack && !audioTrack.enabled
            }
            await peer.addStream(clonedStreamWithGain.stream)
          }
          if (!newStream || newStream.getTracks().length === 0) {
            peer.send(JSON.stringify({
              action: 'no-stream'
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
    if (stream.getAudioTracks().length === 0) {
      return { stream: new MediaStream(stream), type }
    }
    const audioTrack = stream.getAudioTracks()[0]
    var ctx = new AudioContext()
    var src = ctx.createMediaStreamSource(new MediaStream([audioTrack]))
    var dst = ctx.createMediaStreamDestination()
    var gainNode = ctx.createGain()
    gainNode.gain.value = 0.5
    ;[src, gainNode, dst].reduce((a, b) => a && a.connect(b))
    stream.getVideoTracks().forEach(t => dst.stream.addTrack(t))
    return { gainNode, stream: dst.stream, type }
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
      const { stream, type } = entry
      const { id } = stream
      this.streamInfo[id] = { type, stream }
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

  pauseProducer (type, kind) {
    const infos = this._getStreamInfo({ type })
    if (infos.length === 0) {
      throw new Error(`Did not find producer of type=${type}`)
    }
    infos.forEach(info => {
      const track = this._getTrack(type, kind, info)
      if (!track) {
        return
      }
      track.enabled = false
      switch (kind) {
        case 'audio':
          info.audioPaused = true
          break
        case 'video':
          info.videoPaused = true
          break
      }
    })
    Object.values(this.peers).forEach(async peer => {
      try {
        await peer.send(JSON.stringify({ action: 'pauseProducer', kind, type }))
      } catch (e) {
      }
    })
  }

  resumeProducer (type, kind) {
    const infos = this._getStreamInfo({ type })
    if (infos.length === 0) {
      throw new Error(`Did not find producer of type=${type}`)
    }
    infos.forEach(info => {
      const track = this._getTrack(type, kind, info)
      if (!track) {
        return
      }
      track.enabled = true
      switch (kind) {
        case 'audio':
          info.audioPaused = false
          break
        case 'video':
          info.videoPaused = false
          break
      }
    })
    Object.values(this.peers).forEach(async peer => {
      try {
        await peer.send(JSON.stringify({ action: 'resumeProducer', kind, type }))
      } catch (e) {
      }
    })
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
