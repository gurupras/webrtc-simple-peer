import Emittery from 'emittery'
import { nanoid } from 'nanoid'
import { testForEvent, testForNoEvent, FakeAudioContext, FakeMediaStream } from '@gurupras/test-helpers'
import { SimplePeer, BadDataError, RequestTimedOutError } from '../index'
import testImplementation from '@gurupras/abstract-webrtc/test/test-implementation'

beforeAll(() => {
  global.AudioContext = FakeAudioContext
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
  constructor (_id = nanoid()) {
    new Emittery().bindMethods(this)
    this._id = _id
    this._backendID = nanoid()
    this._remoteStreams = []
  }
}

function generateFakeMetadata (userIdentifier = nanoid()) {
  return {
    userIdentifier
  }
}

function generateFakeSimpleSignalPeer (id = nanoid(), userIdentifier = nanoid()) {
  return {
    peer: new FakePeer(id),
    metadata: generateFakeMetadata(userIdentifier)
  }
}

function mockSimpleSignalClient (sp) {
  sp.signalClient.connect = jest.fn().mockImplementation(async (peerID, metadata, opts) => {
    return generateFakeSimpleSignalPeer()
  })
}

function mockRequest (peer = new FakePeer(), metadata = generateFakeMetadata()) {
  return {
    initiator: peer._backendID,
    accept: jest.fn().mockReturnValue({ peer, metadata }),
    reject: jest.fn()
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
    await expect(simplePeer.signalClient.connect).toHaveBeenCalledTimes(2)
    await expect(simplePeer.setupPeer).toHaveBeenCalledTimes(2)
  })

  test('Does not connect to an already connected peer', async () => {
    const simplePeer = create()
    await simplePeer.setup()
    simplePeer.setupPeer = jest.fn()
    mockSimpleSignalClient(simplePeer)
    const peers = [nanoid(), nanoid()]
    // Pretend to have connected to peers[1]
    simplePeer.discoveryIDToPeer[peers[1]] = {}
    await simplePeer.signalClient.emit('discover', peers)
    await expect(simplePeer.signalClient.connect).toHaveBeenCalledTimes(1)
    await expect(simplePeer.signalClient.connect).toHaveBeenCalledWith(peers[0], { userIdentifier: simplePeer.userIdentifier }, {})
    await expect(simplePeer.setupPeer).toHaveBeenCalledTimes(1)
  })

  test('Calls setupPeer for every unique request', async () => {
    const simplePeer = create()
    await simplePeer.setup()
    simplePeer.setupPeer = jest.fn()

    const request1 = mockRequest()
    const request2 = mockRequest()
    const requests = [request1, request2, request1]
    for (const req of requests) {
      await simplePeer.signalClient.emit('request', req)
    }
    expect(request1.accept).toHaveBeenCalledTimes(1)
    expect(request2.accept).toHaveBeenCalledTimes(1)
    expect(request1.reject).toHaveBeenCalledTimes(1)
    expect(simplePeer.setupPeer).toHaveBeenCalledTimes(2)
  })

  describe('setupPeer', () => {
    let peer
    let simplePeer
    beforeEach(async () => {
      simplePeer = create({ requestTimeoutMS: 50 })
      await simplePeer.setup()
      peer = new FakePeer()
    })

    describe('signals', () => {
      beforeEach(async () => {
        await simplePeer.setupPeer(peer, generateFakeMetadata())
      })
      test('Emits error on non-JSON input', async () => {
        const promise = testForEvent(simplePeer, 'error')
        peer.emit('data', 'test')
        await expect(promise).resolves.toEqual(new BadDataError('', peer._id, 'test'))
      })
      describe('volume-control', () => {
        test('Emits error on no gainMap entry', async () => {
          delete simplePeer.gainMap[peer._id]
          const promise = testForEvent(simplePeer, 'error')
          peer.emit('data', JSON.stringify({
            action: 'volume-control'
          }))
          await expect(promise).resolves.toEqual(new BadDataError('volume-control', peer._id))
        })
        test('Silently ignores request to invalid streams', async () => {
          simplePeer.gainMap[peer._id] = [{ type: 'screen', gainNode: { gain: { value: 1.0 } } }]
          let promise = testForNoEvent(simplePeer, 'error', { timeout: 100 })
          await peer.emit('data', JSON.stringify({
            action: 'volume-control',
            type: 'display',
            volume: 0.3
          }))
          await expect(promise).toResolve()
          expect(simplePeer.gainMap[peer._id][0].gainNode.gain.value).toEqual(1.0)

          // Now, try a stream with no gainNode
          simplePeer.gainMap[peer._id] = [{ type: 'screen' }]
          promise = testForNoEvent(simplePeer, 'error')
          await peer.emit('data', JSON.stringify({
            action: 'volume-control',
            type: 'screen',
            volume: 0.3
          }))
          await expect(promise).toResolve()
        })
        test('Properly changes gain value on valid request', async () => {
          simplePeer.gainMap[peer._id] = [{ type: 'screen', gainNode: { gain: { value: 1.0 } } }]
          await peer.emit('data', JSON.stringify({
            action: 'volume-control',
            type: 'screen',
            volume: 0.3
          }))
          expect(simplePeer.gainMap[peer._id][0].gainNode.gain.value).toEqual(0.3)
        })
      })
      describe('no-stream', () => {
        test('Clears out all of the peer\'s remote streams', async () => {
          peer._remoteStreams = [...Array(3)].map(x => new FakeMediaStream())
          await peer.emit('data', JSON.stringify({
            action: 'no-stream'
          }))
          expect(peer._remoteStreams).toBeArrayOfSize(0)
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
          simplePeer.gainMap[peer._id] = [{ type: 'screen', gainNode: { gain: { value: 1.0 } } }]
          const promise = testForEvent(simplePeer, 'destroy')
          await peer.emit('destroy')
          await expect(promise).toResolve()
          expect(simplePeer.peers[peer._id]).toBeUndefined()
          expect(simplePeer.gainMap[peer._id]).toBeUndefined()
        })
      })

      describe('get-stream-info', () => {
        let streamID
        let nonce
        let type
        beforeEach(async () => {
          streamID = 'dummy'
          nonce = nanoid()
          type = 'dummy'
          simplePeer.streamInfo[streamID] = { type }
        })
        test('Returns stream info for valid streamID', async () => {
          peer.send = jest.fn()
          await peer.emit('data', JSON.stringify({
            action: 'get-stream-info',
            nonce,
            streamID
          }))
          expect(peer.send).toHaveBeenCalledTimes(1)
          expect(peer.send).toHaveBeenCalledWith(JSON.stringify({
            action: 'stream-info',
            nonce,
            type
          }))
        })

        test('Returns proper nonce', async () => {
          peer.send = jest.fn()
          await peer.emit('data', JSON.stringify({
            action: 'get-stream-info',
            nonce,
            streamID
          }))
          expect(peer.send).toHaveBeenCalledTimes(1)
          expect(peer.send).toHaveBeenCalledWith(JSON.stringify({
            action: 'stream-info',
            nonce,
            type
          }))

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
            action: 'stream-info',
            nonce,
            type
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
            action: 'stream-info',
            nonce,
            type: null
          }))
        })
      })
      describe('stream', () => {
        test('Does not emit \'stream\' event if stream-info request times out', async () => {
          peer.send = jest.fn()
          peer.emit('stream', new FakeMediaStream())
          const promise = testForEvent(simplePeer, 'error')
          await expect(promise).resolves.toEqual(new RequestTimedOutError('get-stream-info', peer._id))
        })
        test('Emits \'stream\' event once stream information is received', async () => {
          peer.send = jest.fn().mockImplementation(async str => {
            const data = JSON.parse(str)
            const { nonce } = data
            // First, send some garbage data
            const promise = testForEvent(simplePeer, 'error')
            peer.emit('data', 'garbage-data')
            await expect(promise).resolves.toEqual(new BadDataError('', peer._id, 'garbage-data'))

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
      await simplePeer.setupPeer(peer, generateFakeMetadata())
      expect(peer.addStream).toHaveBeenCalledTimes(simplePeer.streams.length)
    })

    test('Creates gainMap entry for every peer', async () => {
      const peers = [...Array(5)].map(x => new FakePeer())
      for (const peer of peers) {
        await simplePeer.setupPeer(peer, generateFakeMetadata())
        expect(simplePeer.gainMap[peer._id]).toBeArrayOfSize(0)
      }
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
      const streams = [...simplePeer.streams]
      await simplePeer.destroy()
      for (const stream of streams) {
        const tracks = stream.getTracks()
        for (const track of tracks) {
          expect(track.stop).toHaveBeenCalledTimes(1)
        }
      }
      expect(simplePeer.streams).toBeArrayOfSize(0)
      expect(simplePeer.streamInfo).toEqual({})
    })

    test('Stops all streams', async () => {
      const streams = [...Array(5)].map(x => new FakeMediaStream(null, { numVideoTracks: 10, numAudioTracks: 10 }))
      simplePeer.streams = streams
      await simplePeer.destroy()
      for (const stream of streams) {
        const tracks = stream.getTracks()
        for (const track of tracks) {
          expect(track.stop).toHaveBeenCalledTimes(1)
        }
      }
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
        peers[peer._id] = peer
      })

      simplePeer.signalClient.peers = jest.fn().mockReturnValue(peers)
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

    test('newStream is still saved if signalClient is uninitialized', async () => {
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
          ret.push(peer)
          peers[peer._id] = peer
          simplePeer.gainMap[peer._id] = []
          // Mocks
          peer.addStream = jest.fn()
          peer.send = jest.fn()
          peer.removeStream = jest.fn()
        })
        return ret
      }

      function copyGainMap () {
        const result = {}
        for (const entry of Object.entries(simplePeer.gainMap)) {
          const [key, value] = entry
          result[key] = [...value]
        }
        return result
      }

      beforeEach(() => {
        peers = {}
        newStream = new FakeMediaStream()
        oldStream = new FakeMediaStream()
        simplePeer.signalClient.peers = jest.fn().mockReturnValue(peers)
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
        // We need to create a copy of the current gainMap since sendStream will modify it in-place
        const gainMap = copyGainMap()
        // Now, remove it and ensure that removeStream was called
        await simplePeer.sendStream(new FakeMediaStream(), newStream, 'screen')
        for (const peer of peers) {
          expect(peer.removeStream).toHaveBeenCalledTimes(1)
          expect(peer.removeStream).toHaveBeenCalledWith(gainMap[peer._id][0].stream)
        }
      })
      test('Sends \'no-stream\' signal if there are no tracks/streams available', async () => {
        const peers = addPeers(3)
        await simplePeer.sendStream(newStream, oldStream, 'screen')
        for (const peer of peers) {
          expect(peer.send).toHaveBeenCalledTimes(1)
          expect(peer.send).toHaveBeenCalledWith(JSON.stringify({
            action: 'no-stream'
          }))
          peer.send.mockClear()
        }
        // Now, check when newStream is null
        await simplePeer.sendStream(null, newStream, 'screen')
        for (const peer of peers) {
          expect(peer.send).toHaveBeenCalledTimes(1)
          expect(peer.send).toHaveBeenCalledWith(JSON.stringify({
            action: 'no-stream'
          }))
          peer.send.mockClear()
        }
      })

      test('Removes oldStream from streams and streamInfo', async () => {
        addPeers(3)
        oldStream = new FakeMediaStream()
        await simplePeer.sendStream(oldStream, null, 'screen')
        expect(simplePeer.streams).toBeArrayOfSize(1)
        expect(Object.values(simplePeer.streamInfo)).toBeArrayOfSize(3)

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
})
