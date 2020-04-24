const deepmerge = require('deepmerge')
const { nanoid } = require('nanoid')
const SimpleSignalClient = require('simple-signal-client')
const AbstractWebRTC = require('@gurupras/abstract-webrtc')

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
      gainMap: {},
      streams: [],
      streamInfo: {}
    })
  }

  async setup () {
    const { socket } = this

    const signalClient = new SimpleSignalClient(socket)
    const { userIdentifier } = this
    signalClient.on('discover', async function (peerIDs = []) {
      for (const peerID of peerIDs) {
        const { peer, metadata } = await signalClient.connect(peerID, {
          userIdentifier
        }, {
          ...this.peerOpts
        })
        this.setupPeer(peer, metadata)
      }
    }.bind(this))
    this.signalClient = signalClient

    signalClient.on('request', async (request) => {
      // console.log(`[simple-peer]: Calling accept with stream`)
      const { peer, metadata } = await request.accept({
        userIdentifier
      }, {
        ...this.peerOpts
      })
      this.setupPeer(peer, metadata)
    })
    signalClient.discover()
  }

  setupPeer (peer, metadata) {
    this.gainMap[peer._id] = []
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
          const { type = null } = streamInfo
          peer.send(JSON.stringify({
            action: 'stream-info',
            nonce,
            type
          }))
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
              resolve(json.type)
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
        const type = await promise
        this.emit('stream', { peer, stream, metadata: { ...metadata, type } })
      } catch (e) {
        this.emit('error', e)
      }
    })

    const clonedStreams = this.cloneAllStreams()
    this.registerClonedStreams(clonedStreams, peer._id)
    for (const entry of clonedStreams) {
      peer.addStream(entry.stream)
    }
    // console.log(`peer: ${peer._id} has been set up`)
  }

  async sendStream (newStream, oldStream, type) {
    if (this.signalClient) {
      for (const peer of Object.values(this.signalClient.peers())) {
        const peerStreams = this.gainMap[peer._id]

        const oldClonedStream = peerStreams.find(e => e.type === type)
        if (oldClonedStream) {
          peerStreams.splice(peerStreams.indexOf(oldClonedStream), 1)
          delete this.streamInfo[oldClonedStream.stream.id]
          peer.removeStream(oldClonedStream.stream)
        }

        const clonedStreamWithGain = this.cloneStreamWithGain(newStream, type)
        peerStreams.push(clonedStreamWithGain)
        if (clonedStreamWithGain.stream) {
          // We need to add data to streamInfo before we call addStream
          // This is so that we have the necessary information to respond to the get-stream-info request
          // that we will receive shortly
          this.streamInfo[clonedStreamWithGain.stream.id] = { type, stream: clonedStreamWithGain.stream }
          peer.addStream(clonedStreamWithGain.stream)
        }
        if (!newStream || newStream.getTracks().length === 0) {
          peer.send(JSON.stringify({
            action: 'no-stream'
          }))
        }
      }
    }
    if (newStream) {
      this.streams.push(newStream)
    }
    if (oldStream) {
      const oldStreamIndex = this.streams.indexOf(oldStream)
      if (oldStreamIndex >= 0) {
        this.streams.splice(oldStreamIndex, 1)
      }
    }
  }

  async sendScreen (newStream, oldStream) {
    this.sendStream(newStream, oldStream, 'screen')
  }

  async sendWebcam (newStream, oldStream) {
    this.sendStream(newStream, oldStream, 'webcam')
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
    gainNode.gain.value = 0.5;
    [src, gainNode, dst].reduce((a, b) => a && a.connect(b))
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
