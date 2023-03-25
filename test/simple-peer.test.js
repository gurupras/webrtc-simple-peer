import Emittery from 'emittery'
import { nanoid } from 'nanoid'
import { testForEvent, FakeAudioContext, FakeMediaStream, FakeAudioWorkletNode } from '@gurupras/test-helpers'
import { SimplePeer, wrapSocketForSignalClient, BadDataError, RequestTimedOutError } from '../index'
import testImplementation from '@gurupras/abstract-webrtc/test/test-implementation'

beforeAll(() => {
  global.AudioContext = FakeAudioContext
  global.AudioWorkletNode = FakeAudioWorkletNode
})

const rtcConfig = {
  iceServers: [
    {
      urls: [
        'stun:dummy:4558'
      ]
    },
    {
      urls: [
        'turn:dummy:4558?transport=udp',
        'turn:dummy:4558?transport=tcp'
      ],
      username: 'dummy',
      credential: 'dummy'
    }
  ]
}

function mockGetRTCConfig (sp) {
  sp.getRTCConfig = jest.fn().mockReturnValue(rtcConfig)
}

class FakePeer {
  constructor (_id = nanoid(), peerID = nanoid()) {
    new Emittery().bindMethods(this)
    this._id = _id
    this.peerID = peerID
    this.streamMap = new Map()
    this._backendID = nanoid()
    this._remoteStreams = []
  }

  addStream (stream) {
    this._remoteStreams.push(stream)
  }
}

function generateFakeMetadata (userIdentifier = nanoid()) {
  return {
    userIdentifier
  }
}

function generateFakeSimpleSignalPeer (id = nanoid(), userIdentifier = nanoid()) {
  return {
    peer: new FakePeer(id, userIdentifier),
    metadata: generateFakeMetadata(userIdentifier)
  }
}

function mockSimpleSignalClient (sp) {
  Object.assign(sp.signalClient, {
    connect: jest.fn().mockImplementation(async (peerID, metadata, opts) => {
      return generateFakeSimpleSignalPeer()
    }),
    discover: jest.fn(),
    peers: jest.fn().mockReturnValue(Object.values(sp.signalClient.peers))
  })
}

function mockRequest (peer = new FakePeer(), metadata = generateFakeMetadata()) {
  return {
    initiator: peer._backendID,
    accept: jest.fn().mockReturnValue({ peer, metadata }),
    reject: jest.fn(),
    metadata
  }
}

function create (opts = {}, socket = new Emittery(), userIdentifier = nanoid()) {
  const simplePeer = new SimplePeer(opts, socket, userIdentifier)
  mockGetRTCConfig(simplePeer)
  return simplePeer
}

describe('SimplePeer', () => {
  testImplementation(() => create())

  test('Calls setupPeer for every discovered peer', async () => {
    const simplePeer = create()
    await simplePeer.setup()
    simplePeer.setupPeer = jest.fn()
    mockSimpleSignalClient(simplePeer)
    await simplePeer.signalClient.emit('discover', [nanoid(), nanoid()])
    await new Promise(resolve => setTimeout(resolve, 0))
    await simplePeer.lock.acquire('discoveryIDToPeer', async () => {
      expect(simplePeer.signalClient.connect).toHaveBeenCalledTimes(2)
      expect(simplePeer.setupPeer).toHaveBeenCalledTimes(2)
    })
  })

  test('Calling discovery runs signalClient discovery', async () => {
    const simplePeer = create()
    await simplePeer.setup()
    mockSimpleSignalClient(simplePeer)
    simplePeer.discover()
    expect(simplePeer.signalClient.discover).toHaveBeenCalledTimes(1)
  })

  test('Reconnects to an already connected peer', async () => {
    const simplePeer = create()
    await simplePeer.setup()
    simplePeer.setupPeer = jest.fn()
    mockSimpleSignalClient(simplePeer)
    const peers = [nanoid(), nanoid()]
    // Pretend to have connected to peers[1]
    simplePeer.discoveryIDToPeer[peers[1]] = {}
    await simplePeer.signalClient.emit('discover', peers)
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(simplePeer.signalClient.connect).toHaveBeenCalledTimes(2)
    await expect(simplePeer.signalClient.connect).toHaveBeenCalledWith(peers[0], { userIdentifier: simplePeer.userIdentifier }, simplePeer.options.peerOpts)
    await expect(simplePeer.setupPeer).toHaveBeenCalledTimes(2)
  })

  test('Calls setupPeer for every request', async () => {
    const simplePeer = create()
    await simplePeer.setup()
    simplePeer.setupPeer = jest.fn().mockImplementation((peer, metadata, discoveryID) => {
      simplePeer.discoveryIDToPeer[discoveryID] = peer
    })

    const request1 = mockRequest()
    const request2 = mockRequest()
    const requests = [request1, request2, request1]
    for (const req of requests) {
      await simplePeer.signalClient.emit('request', req)
    }
    await simplePeer.lock.acquire('discoveryIDToPeer', async () => {
      expect(request1.accept).toHaveBeenCalledTimes(2)
      expect(request2.accept).toHaveBeenCalledTimes(1)
      expect(request1.reject).toHaveBeenCalledTimes(0)
      expect(simplePeer.setupPeer).toHaveBeenCalledTimes(3)
    })
  })

  describe('setupPeer', () => {
    let peer
    /** @type SimplePeer */
    let simplePeer
    beforeEach(async () => {
      simplePeer = create({ requestTimeoutMS: 50 })
      await simplePeer.setup()
      peer = new FakePeer()
    })

    describe('signals', () => {
      beforeEach(async () => {
        await simplePeer.setupPeer(peer, generateFakeMetadata(), peer.peerID)
      })
      test('Emits error on non-JSON input', async () => {
        const promise = testForEvent(simplePeer, 'error')
        peer.emit('data', 'test')
        await expect(promise).resolves.toEqual(new BadDataError('', peer.peerID, 'test'))
      })
      describe('no-stream', () => {
        test('Clears out all of the peer\'s remote streams', async () => {
          const type = 'webcam'
          const streams = [...Array(3)].map(x => {
            const stream = new FakeMediaStream()
            simplePeer.remoteStreamInfo[stream.id] = { peer, type, stream, videoPaused: false, audioPaused: false }
            return stream
          })
          const lastStream = streams[streams.length - 1]
          // Tweak the last stream to be of a different type
          simplePeer.remoteStreamInfo[lastStream.id].type = 'screen'

          peer._remoteStreams = streams
          await peer.emit('data', JSON.stringify({
            action: 'no-stream',
            type
          }))
          expect(peer._remoteStreams).toBeArrayOfSize(0)
          const keys = Object.keys(simplePeer.remoteStreamInfo)
          expect(keys).toBeArrayOfSize(1)
          expect(keys).toIncludeSameMembers([lastStream.id])
        })

        test('Emits \'no-stream\' event upwards', async () => {
          const promise = testForEvent(simplePeer, 'no-stream', { timeout: 250 })
          await peer.emit('data', JSON.stringify({
            action: 'no-stream'
          }))
          await expect(promise).toResolve()
        })
      })

      describe('destroy', () => {
        test('Removes entry from \'peers\'', async () => {
          const promise = testForEvent(simplePeer, 'destroy')
          await peer.emit('destroy')
          await expect(promise).toResolve()
          expect(simplePeer.peers[peer.peerID]).toBeUndefined()
        })
      })

      describe('get-stream-info', () => {
        let streamID
        let nonce
        let type
        let expectedResult
        beforeEach(async () => {
          nonce = nanoid()
          type = 'dummy'
          const stream = new FakeMediaStream(null, { numVideoTracks: 1, numAudioTracks: 1 })
          stream.getVideoTracks()[0].enabled = false
          simplePeer.streamInfo[stream.id] = { type, stream, videoPaused: true, audioPaused: false }
          streamID = stream.id

          expectedResult = {
            action: 'stream-info',
            nonce,
            type,
            videoPaused: true,
            audioPaused: false
          }
        })
        test('Returns stream info for valid streamID', async () => {
          peer.send = jest.fn()
          await peer.emit('data', JSON.stringify({
            action: 'get-stream-info',
            nonce,
            streamID
          }))
          expect(peer.send).toHaveBeenCalledTimes(1)
          expect(peer.send).toHaveBeenCalledWith(JSON.stringify(expectedResult))
        })

        test('Returns proper nonce', async () => {
          peer.send = jest.fn()
          await peer.emit('data', JSON.stringify({
            action: 'get-stream-info',
            nonce,
            streamID
          }))
          expect(peer.send).toHaveBeenCalledTimes(1)
          expect(peer.send).toHaveBeenCalledWith(JSON.stringify(expectedResult))

          // Now, try a different nonce to make sure it works
          peer.send.mockClear()
          nonce = nanoid()
          await peer.emit('data', JSON.stringify({
            action: 'get-stream-info',
            nonce,
            streamID
          }))
          expect(peer.send).toHaveBeenCalledTimes(1)
          expect(peer.send).toHaveBeenCalledWith(JSON.stringify({
            ...expectedResult,
            nonce
          }))
        })

        test('Returns null for invalid streamID', async () => {
          peer.send = jest.fn()
          await peer.emit('data', JSON.stringify({
            action: 'get-stream-info',
            nonce,
            streamID: 'does-not-exist'
          }))
          expect(peer.send).toHaveBeenCalledTimes(1)
          expect(peer.send).toHaveBeenCalledWith(JSON.stringify({
            ...expectedResult,
            type: null,
            videoPaused: undefined,
            audioPaused: undefined
          }))
        })
      })
      describe('stream', () => {
        test('Does not emit \'stream\' event if stream-info request times out', async () => {
          peer.send = jest.fn()
          peer.emit('stream', new FakeMediaStream())
          const promise = testForEvent(simplePeer, 'error')
          await expect(promise).resolves.toEqual(new RequestTimedOutError('get-stream-info', peer.peerID))
        })
        test('Emits \'stream\' event once stream information is received', async () => {
          peer.send = jest.fn().mockImplementation(async str => {
            const data = JSON.parse(str)
            const { nonce } = data
            // First, send some garbage data
            const promise = testForEvent(simplePeer, 'error')
            peer.emit('data', 'garbage-data')
            await expect(promise).resolves.toEqual(new BadDataError('', peer.peerID, 'garbage-data'))

            // Now, send data, but with bad nonce
            peer.emit('data', JSON.stringify({
              action: 'stream-info',
              nonce: nanoid(),
              type: 'bad-type'
            }))

            // Now, send real data
            peer.emit('data', JSON.stringify({
              action: 'stream-info',
              nonce,
              type: 'screen'
            }))
          })
          const streamPromise = testForEvent(simplePeer, 'stream')
          const dataPromise = testForEvent(peer, 'data')
          const stream = new FakeMediaStream()
          peer.emit('stream', stream)
          await expect(dataPromise).toResolve()
          expect(peer.send).toHaveBeenCalledTimes(1)

          await expect(streamPromise).resolves.toMatchObject({
            peer,
            stream
          })
        })
      })
    })

    test('Sends all local streams to peers', async () => {
      simplePeer.streams = [...Array(5)].map(x => new FakeMediaStream())
      simplePeer.streams.forEach(({ id }, idx) => {
        simplePeer.streamInfo[id] = { type: idx % 2 ? 'audio' : 'video' }
      })
      peer.addStream = jest.fn()
      peer.send = jest.fn()
      await simplePeer.setupPeer(peer, generateFakeMetadata(), peer.peerID)
      expect(peer.addStream).toHaveBeenCalledTimes(simplePeer.streams.length)
    })
  })

  describe('destroy', () => {
    let simplePeer
    beforeEach(async () => {
      simplePeer = create()
      await simplePeer.setup()
      simplePeer.streams = [...Array(5)].map(x => new FakeMediaStream(null, { numVideoTracks: 2, numAudioTracks: 2 }))
      simplePeer.streams.forEach(({ id }, idx) => {
        simplePeer.streamInfo[id] = { type: idx % 2 ? 'screen' : 'webcam' }
      })
    })

    test('Clears out data even if signalClient is not initialized', async () => {
      simplePeer.signalClient = undefined
      await simplePeer.destroy()
      expect(simplePeer.streams).toBeArrayOfSize(0)
      expect(simplePeer.streamInfo).toEqual({})
    })

    test('Clears out all streams', async () => {
      await simplePeer.destroy()
      expect(simplePeer.streams).toBeArrayOfSize(0)
    })

    test('Clears out all streamInfo', async () => {
      await simplePeer.destroy()
      expect(simplePeer.streamInfo).toEqual({})
    })

    test('Disconnects from all peers', async () => {
      const peers = {}
      const peersArray = [...Array(3)].map(x => new FakePeer())
      peersArray.forEach(peer => {
        peer.destroy = jest.fn()
        peers[peer.peerID] = peer
      })

      simplePeer.signalClient.peers = jest.fn().mockReturnValue(peersArray)
      await simplePeer.destroy()
      for (const peer of peersArray) {
        expect(peer.destroy).toHaveBeenCalledTimes(1)
      }
    })
  })

  describe('sendStream', () => {
    let simplePeer
    beforeEach(async () => {
      simplePeer = create()
      await simplePeer.setup()
    })

    test('New stream is still saved if signalClient is uninitialized', async () => {
      simplePeer.signalClient = undefined
      const newStream = new FakeMediaStream()
      simplePeer.sendStream(newStream, new FakeMediaStream(), 'screen')
      expect(simplePeer.streams).toIncludeSameMembers([newStream])
    })

    test('Everything works fine if newStream is null/undefined', async () => {
      simplePeer.signalClient = undefined
      const oldStream = new FakeMediaStream()
      simplePeer.streams.push(oldStream)
      simplePeer.sendStream(null, oldStream, 'screen')
      expect(simplePeer.streams).toBeArrayOfSize(0)
    })

    test('Everything works fine if oldStream is null/undefined', async () => {
      simplePeer.signalClient = undefined
      const newStream = new FakeMediaStream()
      simplePeer.sendStream(newStream, null, 'screen')
      expect(simplePeer.streams).toIncludeSameMembers([newStream])
    })

    test('oldStream (if specified) is removed from streams', async () => {
      simplePeer.signalClient = undefined
      const oldStream = new FakeMediaStream()
      simplePeer.streams.push(oldStream)
      const newStream = new FakeMediaStream()
      simplePeer.sendStream(newStream, oldStream, 'screen')
      expect(simplePeer.streams).toIncludeSameMembers([newStream])
    })

    test('Non-existent oldStream is ignored without errors', async () => {
      simplePeer.signalClient = undefined
      const oldStream = new FakeMediaStream()
      const newStream = new FakeMediaStream()
      simplePeer.sendStream(newStream, oldStream, 'screen')
      expect(simplePeer.streams).toIncludeSameMembers([newStream])
    })

    describe('With connected peers', () => {
      let peers
      let newStream
      let oldStream

      function addPeers (count) {
        const ret = []
        ;[...Array(3)].forEach(x => {
          const peer = new FakePeer()
          peer.peerID = nanoid()
          ret.push(peer)
          peers[peer.peerID] = peer
          // Mocks
          peer.addStream = jest.fn()
          peer.send = jest.fn()
          peer.removeStream = jest.fn()
        })
        return ret
      }

      beforeEach(() => {
        peers = {}
        newStream = new FakeMediaStream()
        oldStream = new FakeMediaStream()
        simplePeer.peers = peers
      })
      test('Sends newStream to all peers', async () => {
        const peers = addPeers(3)
        newStream = new FakeMediaStream(null, { numVideoTracks: 2, numAudioTracks: 2 })
        await simplePeer.sendStream(newStream, oldStream, 'screen')
        for (const peer of peers) {
          expect(peer.addStream).toHaveBeenCalledTimes(1)
        }
      })
      test('Removes oldStream from all peers', async () => {
        // Send a stream to all peers
        const peers = addPeers(3)
        await simplePeer.sendStream(newStream, null, 'screen')
        for (const peer of peers) {
          expect(peer.addStream).toHaveBeenCalledTimes(1)
        }
        // Now, remove it and ensure that removeStream was called
        await simplePeer.sendStream(new FakeMediaStream(), newStream, 'screen')
        for (const peer of peers) {
          expect(peer.removeStream).toHaveBeenCalledTimes(1)
          expect(peer.removeStream).toHaveBeenCalledWith(peer.streamMap.get(newStream))
        }
      })
      test('Sends \'no-stream\' signal if there are no tracks/streams available', async () => {
        const peers = addPeers(3)
        const type = 'screen'
        await simplePeer.sendStream(newStream, oldStream, type)
        for (const peer of peers) {
          expect(peer.send).toHaveBeenCalledTimes(1)
          expect(peer.send).toHaveBeenCalledWith(JSON.stringify({
            action: 'no-stream',
            type
          }))
          peer.send.mockClear()
        }
        // Now, check when newStream is null
        await simplePeer.sendStream(null, newStream, 'screen')
        for (const peer of peers) {
          expect(peer.send).toHaveBeenCalledTimes(1)
          expect(peer.send).toHaveBeenCalledWith(JSON.stringify({
            action: 'no-stream',
            type
          }))
          peer.send.mockClear()
        }
      })

      test('Removes oldStream from streams and streamInfo', async () => {
        addPeers(3)
        oldStream = new FakeMediaStream()
        await simplePeer.sendStream(oldStream, null, 'screen')
        expect(simplePeer.streams).toBeArrayOfSize(1)
        expect(Object.values(simplePeer.streamInfo)).toBeArrayOfSize(4) // one for  each peer, and one for the new stream itself

        // Now, remove this stream
        await simplePeer.sendStream(null, oldStream, 'screen')
        expect(simplePeer.streams).toBeArrayOfSize(0)
        expect(simplePeer.streamInfo).toEqual({})
      })

      test('sendScreen', async () => {
        simplePeer.sendStream = jest.fn()
        simplePeer.sendScreen(newStream, oldStream)
        expect(simplePeer.sendStream).toHaveBeenCalledWith(newStream, oldStream, 'screen')
      })

      test('sendWebcam', async () => {
        simplePeer.sendStream = jest.fn()
        simplePeer.sendWebcam(newStream, oldStream)
        expect(simplePeer.sendStream).toHaveBeenCalledWith(newStream, oldStream, 'webcam')
      })

      test('stopScreen', () => {
        expect(() => simplePeer.stopScreen()).not.toThrow()
      })
    })
  })

  describe('updateVolume', () => {
    let simplePeer
    let peer
    beforeEach(async () => {
      peer = new FakePeer()
      simplePeer = create({ requestTimeoutMS: 50 })
      await simplePeer.setup()
      await simplePeer.setupPeer(peer, generateFakeMetadata(), peer.peerID)
    })
    test('Throw error if no peer found', async () => {
      expect(() => simplePeer.updateVolume(0.3, 'bad')).toThrow()
    })
    test('Throw error if no stream type specified', async () => {
      expect(() => simplePeer.updateVolume(0.3, peer.peerID)).toThrow()
    })
    test('Updates volume of stream', async () => {
      const volume = 0.3
      const type = 'screen'
      // Create a fake stream
      const stream = new FakeMediaStream(null, { numAudioTracks: 1 })
      // Mock the stream.volume function
      stream.volume = jest.fn()
      // Set up the remoteStreamInfo so the updateVolume method finds this stream
      simplePeer.remoteStreamInfo[stream.id] = { peer, type, stream }

      simplePeer.updateVolume(volume, peer.peerID, type)
      expect(stream.volume).toHaveBeenCalledWith(volume)
    })
  })

  describe('_getRemoteStreamInfo', () => {
    test('Removes existing info if any', async () => {
      const simplePeer = create()
      const peer = new FakePeer()
      const type = 'screen'
      const fakeStreams = [new FakeMediaStream(), new FakeMediaStream()]
      fakeStreams.forEach(stream => {
        simplePeer.remoteStreamInfo[stream.id] = { peer, stream, type }
      })
      const newStream = new FakeMediaStream()
      peer.send = jest.fn().mockImplementation((data) => {
        const json = JSON.parse(data)
        peer.emit('data', JSON.stringify({
          action: 'stream-info',
          nonce: json.nonce,
          streamID: json.streamID,
          type
        }))
      })
      await simplePeer._getRemoteStreamInfo(peer, newStream)
      fakeStreams.forEach(stream => {
        expect(simplePeer.remoteStreamInfo[stream.id]).toBeUndefined()
      })
      expect(simplePeer.remoteStreamInfo[newStream.id]).toBeTruthy()
    })
  })

  describe.each([
    ['webcam', 'video', 'videoPaused', 'consumerVideoPaused'],
    ['webcam', 'audio', 'audioPaused', 'consumerAudioPaused']
  ])('Pause/Resume (%s-%s)', (type, kind, field, consumerField) => {
    let simplePeer
    let peers
    let stream
    beforeEach(async () => {
      peers = [...Array(5)].map(x => {
        const peer = new FakePeer()
        peer.send = jest.fn()
        return peer
      })
      simplePeer = create({ requestTimeoutMS: 50 })
      await simplePeer.setup()
      simplePeer.signalClient.peers = jest.fn().mockReturnValue(peers)
      await Promise.all(peers.map(peer => simplePeer.setupPeer(peer, generateFakeMetadata(), peer.peerID)))
    })

    describe('Producer', () => {
      beforeEach(async () => {
        stream = new FakeMediaStream(null, { numVideoTracks: 1, numAudioTracks: 1 })
        await simplePeer.sendWebcam(stream)
      })

      describe('pauseProducer', () => {
        test('Pausing producer sends \'pauseProducer\' event to all peers', async () => {
          peers.forEach(peer => {
            peer.send = jest.fn()
          })
          await simplePeer.pauseProducer(type, kind)
          for (const peer of peers) {
            expect(peer.send).toHaveBeenCalledTimes(1)
            expect(peer.send).toHaveBeenCalledWith(JSON.stringify({
              action: 'pauseProducer',
              kind,
              type
            }))
          }
        })

        test('Pausing non-existent producer throws error', async () => {
          expect(() => simplePeer.pauseProducer('dummy', kind)).toThrow()
        })

        test(`Pausing producer stores '${field}=true' in streamInfo`, async () => {
          await simplePeer.pauseProducer(type, kind)
          const infos = simplePeer._getStreamInfo(type)
          for (const info of infos) {
            expect(info[field]).toBeTrue()
          }
        })

        test('Peers emit \'stream-update\' event when they receive \'pauseProducer\'', async () => {
          for (const peer of peers) {
            let promise = new Promise(resolve => {
              peer.send = jest.fn().mockImplementation((data) => {
                const json = JSON.parse(data)
                const { nonce } = json
                peer.emit('data', JSON.stringify({
                  action: 'stream-info',
                  nonce,
                  type,
                  kind,
                  videoPaused: false,
                  audioPaused: false
                }))
                resolve()
              })
            })
            const stream = new FakeMediaStream(null, { numVideoTracks: 1, numAudioTracks: 1 })
            peer.emit('stream', stream)
            await expect(promise).toResolve()
            promise = testForEvent(simplePeer, 'stream-update', { timeout: 100 })
            peer.emit('data', JSON.stringify({
              action: 'pauseProducer',
              kind,
              type
            }))
            await expect(promise).toResolve()
            const data = await promise
            expect(data.data.type).toEqual(type)
            expect(data.data[field]).toBeTrue()
            expect(simplePeer.remoteStreamInfo[stream.id][field]).toBeTrue()
          }
        })
      })

      describe('resumeProducer', () => {
        test('Resuming producer sends \'resumeProducer\' event to all peers', async () => {
          peers.forEach(peer => {
            peer.send = jest.fn()
          })
          await simplePeer.resumeProducer(type, kind)
          for (const peer of peers) {
            expect(peer.send).toHaveBeenCalledTimes(1)
            expect(peer.send).toHaveBeenCalledWith(JSON.stringify({
              action: 'resumeProducer',
              kind,
              type
            }))
          }
        })

        test('Resuming non-existent producer throws error', async () => {
          expect(() => simplePeer.resumeProducer('dummy', kind)).toThrow()
        })

        test(`Resuming producer stores '${field}=false' in streamInfo`, async () => {
          await simplePeer.resumeProducer(type, kind)
          const infos = simplePeer._getStreamInfo(type)
          for (const info of infos) {
            expect(info[field]).toBeFalse()
          }
        })

        test('Peers emit \'stream-update\' event when they receive \'resumeProducer\'', async () => {
          for (const peer of peers) {
            let promise = new Promise(resolve => {
              peer.send = jest.fn().mockImplementation((data) => {
                const json = JSON.parse(data)
                const { nonce } = json
                peer.emit('data', JSON.stringify({
                  action: 'stream-info',
                  nonce,
                  type,
                  kind,
                  videoPaused: true,
                  audioPaused: true
                }))
                resolve()
              })
            })
            const stream = new FakeMediaStream(null, { numVideoTracks: 1, numAudioTracks: 1 })
            peer.emit('stream', stream)
            await expect(promise).toResolve()
            promise = testForEvent(simplePeer, 'stream-update', { timeout: 100 })
            peer.emit('data', JSON.stringify({
              action: 'resumeProducer',
              kind,
              type
            }))
            await expect(promise).toResolve()
            const data = await promise
            expect(data.data.type).toEqual(type)
            expect(data.data[field]).toBeFalse()
            expect(simplePeer.remoteStreamInfo[stream.id][field]).toBeFalse()
          }
        })
      })
    })

    describe('Consumer', () => {
      let peer
      beforeEach(async () => {
        peer = peers[1]
        peer._remoteStreams = [...Array(2)].map(x => {
          const stream = new FakeMediaStream({ numVideoTracks: 1, numAudioTracks: 1 })
          simplePeer.remoteStreamInfo[stream.id] = { peer, stream, type, videoPaused: false, audioPaused: false }
          return stream
        })
      })
      describe('pauseConsumer', () => {
        test('Pausing consumer sends \'pauseConsumer\' event to relevant peer', async () => {
          peers.forEach(peer => {
            peer.send = jest.fn()
          })
          await simplePeer.pauseConsumer(type, kind, peer.peerID)
          expect(peer.send).toHaveBeenCalledTimes(1)
          expect(peer.send).toHaveBeenCalledWith(JSON.stringify({
            action: 'pauseConsumer',
            kind,
            type
          }))
        })

        test('Pausing non-existent consumer throws error', async () => {
          await expect(simplePeer.pauseConsumer('dummy', kind)).rejects.toThrow()
        })

        test(`Pausing consumer stores '${field}=true' in streamInfo`, async () => {
          await simplePeer.pauseConsumer(type, kind, peer.peerID)
          const infos = simplePeer._getStreamInfo(type)
          for (const info of infos) {
            expect(info[field]).toBeTrue()
          }
        })

        test('Peers emit \'stream-update\' event when they receive \'pauseConsumer\'', async () => {
          let promise = new Promise(resolve => {
            peer.send = jest.fn().mockImplementation((data) => {
              const json = JSON.parse(data)
              const { nonce } = json
              peer.emit('data', JSON.stringify({
                action: 'stream-info',
                nonce,
                type,
                kind,
                videoPaused: false,
                audioPaused: false
              }))
              resolve()
            })
          })
          const stream = new FakeMediaStream(null, { numVideoTracks: 1, numAudioTracks: 1 })
          await simplePeer.sendWebcam(stream)
          promise = testForEvent(simplePeer, 'stream-update', { timeout: 100 })
          peer.emit('data', JSON.stringify({
            action: 'pauseConsumer',
            kind,
            type
          }))
          await expect(promise).toResolve()
          const data = await promise
          expect(data.data.type).toEqual(type)
          expect(data.data[consumerField]).toBeTrue()
          const info = simplePeer._getStreamInfo({ type, peer })[0]
          expect(info[consumerField]).toBeTrue()
        })
      })

      describe('resumeConsumer', () => {
        test('Resuming consumer sends \'resumeConsumer\' event to relevant peer', async () => {
          peers.forEach(peer => {
            peer.send = jest.fn()
          })
          await simplePeer.resumeConsumer(type, kind, peer.peerID)
          expect(peer.send).toHaveBeenCalledTimes(1)
          expect(peer.send).toHaveBeenCalledWith(JSON.stringify({
            action: 'resumeConsumer',
            kind,
            type
          }))
        })

        test('Resuming non-existent consumer throws error', async () => {
          await expect(simplePeer.resumeConsumer('dummy', kind)).rejects.toThrow()
        })

        test(`Resuming consumer stores '${field}=false' in streamInfo`, async () => {
          await simplePeer.resumeConsumer(type, kind, peer.peerID)
          const infos = simplePeer._getStreamInfo(type)
          for (const info of infos) {
            expect(info[field]).toBeFalse()
          }
        })

        test('Peers emit \'stream-update\' event when they receive \'resumeConsumer\'', async () => {
          let promise = new Promise(resolve => {
            peer.send = jest.fn().mockImplementation((data) => {
              const json = JSON.parse(data)
              const { nonce } = json
              peer.emit('data', JSON.stringify({
                action: 'stream-info',
                nonce,
                type,
                kind,
                videoPaused: false,
                audioPaused: false
              }))
              resolve()
            })
          })
          const stream = new FakeMediaStream(null, { numVideoTracks: 1, numAudioTracks: 1 })
          await simplePeer.sendWebcam(stream)
          promise = testForEvent(simplePeer, 'stream-update', { timeout: 100 })
          peer.emit('data', JSON.stringify({
            action: 'resumeConsumer',
            kind,
            type
          }))
          await expect(promise).toResolve()
          const data = await promise
          expect(data.data.type).toEqual(type)
          expect(data.data[consumerField]).toBeFalse()
          const info = simplePeer._getStreamInfo({ type, peer })[0]
          expect(info[consumerField]).toBeFalse()
        })
      })
    })
  })

  test('\'volume\' event updates remoteStreamInfo volume', async () => {
    const simplePeer = create()
    const streamID = nanoid()
    const volume = 0.4
    simplePeer.remoteStreamInfo[streamID] = {}
    const peer = new FakePeer()
    await simplePeer.setupPeer(peer, generateFakeMetadata(), peer.peerID)
    await peer.emit('data', JSON.stringify({
      action: 'volume',
      data: { streamID, volume }
    }))
    expect(simplePeer.remoteStreamInfo[streamID].volume).toEqual(volume)
  })
})

describe('wrapSocketForSignalClient', () => {
  let socket
  /** @type {ReturnType<typeof wrapSocketForSignalClient>} */
  let wrapped
  beforeEach(() => {
    const emitter = new Emittery()
    socket = {
      on: jest.fn().mockImplementation((...args) => emitter.on(...args)),
      emit: jest.fn().mockImplementation((...args) => emitter.emit(...args)),
      off: jest.fn().mockImplementation((...args) => emitter.off(...args)),
      close: jest.fn()
    }
    wrapped = wrapSocketForSignalClient(socket)
  })

  describe('on', () => {
    test('Sets up event listeners on underlying socket', async () => {
      const cb = jest.fn()
      const event = 'test'
      wrapped.on(event, cb)
      expect(socket.on).toHaveBeenCalledWith(event, cb)
    })

    test('Able to set up multiple listeners for same event', async () => {
      const data = 'foo'
      const event1 = 'test1'
      const cb1 = jest.fn()
      const cb2 = jest.fn()
      wrapped.on(event1, cb1)
      wrapped.on(event1, cb2)
      await socket.emit(event1, data)
      expect(cb1).toHaveBeenCalledWith(data)
      expect(cb2).toHaveBeenCalledWith(data)
    })

    test('Can set up multiple, independent event listeners', async () => {
      const data = 'foo'
      const event1 = 'test1'
      const cb1 = jest.fn()
      const event2 = 'test2'
      const cb2 = jest.fn()
      wrapped.on(event1, cb1)
      wrapped.on(event2, cb2)

      await socket.emit(event1, data)
      expect(cb1).toHaveBeenCalledWith(data)
      expect(cb2).not.toHaveBeenCalled()

      cb1.mockClear()
      cb2.mockClear()

      await socket.emit(event2, data)
      expect(cb2).toHaveBeenCalledWith(data)
      expect(cb1).not.toHaveBeenCalled()
    })
  })

  describe('emit', () => {
    test('Emits event on underlying socket', async () => {
      const data = 'foo'
      const event = 'test'
      wrapped.emit(event, data)
      expect(socket.emit).toHaveBeenCalledWith(event, data)
    })
  })

  describe('off', () => {
    test('Removes event listener from underlying socket', async () => {
      const data = 'foo'
      const event1 = 'test1'
      const cb1 = jest.fn()
      const cb2 = jest.fn()
      socket.on(event1, cb1)
      socket.on(event1, cb2)
      wrapped.off(event1, cb1)
      await socket.emit(event1, data)
      expect(cb2).toHaveBeenCalledWith(data)
      expect(cb1).not.toHaveBeenCalled()
    })
    test('Calls socket.off for unregistered event', async () => {
      const event1 = 'test1'
      const cb1 = jest.fn()
      socket.on(event1, cb1)
      wrapped.off('bad', cb1)
      expect(socket.off).toHaveBeenCalled()
    })
    test('Removes entry from map', async () => {
      const event1 = 'test1'
      const cb1 = jest.fn()
      const cb2 = jest.fn()
      wrapped.listeners.set(event1, new Set([cb1, cb2]))
      wrapped.off(event1, cb1)
      expect(wrapped.listeners.get(event1).size).toBe(1)
    })
    test('Deletes map entry if all callbacks are removed for an event', async () => {
      const event1 = 'test1'
      const cb1 = jest.fn()
      const cb2 = jest.fn()
      wrapped.listeners.set(event1, new Set([cb1, cb2]))
      wrapped.off(event1, cb1)
      wrapped.off(event1, cb2)
      expect(wrapped.listeners.has(event1)).toBeFalse()
    })
  })
  describe('close', () => {
    let event1
    let cb1
    let event2
    let cb2
    beforeEach(() => {
      event1 = 'test1'
      cb1 = jest.fn()
      event2 = 'test2'
      cb2 = jest.fn()
      wrapped.listeners.set(event1, new Set([cb1]))
      wrapped.listeners.set(event2, new Set([cb2]))
    })
    test('Removes all event listeners from underlying socket', async () => {
      wrapped.close()
      expect(socket.off).toHaveBeenNthCalledWith(1, event1, cb1)
      expect(socket.off).toHaveBeenNthCalledWith(2, event2, cb2)
    })
    test('Does not close the socket', async () => {
      wrapped.close()
      expect(socket.close).not.toHaveBeenCalled()
    })
  })
})
