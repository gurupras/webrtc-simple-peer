import Emittery from 'emittery'
import SimpleSignalServer from '../src/backend/simple-signal-server'
import { nanoid } from 'nanoid'
import { testForEvent } from '@gurupras/test-helpers'

const dummyFn = () => {}

const createMockRequest = () => {
  const result = {
    socket: new Emittery(),
    forward: jest.fn(),
    discover: jest.fn().mockImplementation(() => result.socket.emit('discover'))
  }
  result.socket.id = nanoid()
  return result
}

let mockSignalServer
beforeEach(() => {
  mockSignalServer = new Emittery()
})

describe('SimpleSignalServer', () => {
  describe('Constructor', () => {
    const badArgs = [undefined, null, '', 'string', 5]
    test.each(badArgs)('Throws error on bad getPeersOfSocket (%p)', async (arg) => {
      expect(() => new SimpleSignalServer({ getPeersOfSocket: arg })).toThrow()
    })
    test('Passes when getPeersOfSocket is a function', async () => {
      expect(() => new SimpleSignalServer({ getPeersOfSocket: dummyFn })).not.toThrow()
    })

    // getPeerIDFromSocket will pass if undefined. So skip undefined
    test.each(badArgs.slice(1))('Throws error on bad getPeerIDFromSocket (%p)', async (arg) => {
      expect(() => new SimpleSignalServer({ getPeersOfSocket: dummyFn, getPeerIDFromSocket: arg })).toThrow()
    })
    test('Passes when getPeerIDFromSocket is a function', async () => {
      expect(() => new SimpleSignalServer({ getPeersOfSocket: dummyFn, getPeerIDFromSocket: dummyFn })).not.toThrow()
    })

    test('Has inbuilt socket-id logic', async () => {
      const request = createMockRequest()
      const server = new SimpleSignalServer({ getPeersOfSocket: jest.fn().mockReturnValue(request.socket.id) })
      expect(server.getPeerIDFromSocket(request.socket)).toEqual(request.socket.id)
    })
  })

  describe('initialize', () => {
    let server
    let peers
    let selfID
    beforeEach(() => {
      peers = [...Array(5)].map(x => nanoid())
      selfID = nanoid()
      server = new SimpleSignalServer({
        getPeerIDFromSocket: jest.fn().mockImplementation(async () => selfID),
        getPeersOfSocket: jest.fn().mockImplementation(async () => peers)
      }, () => mockSignalServer)
      server.initialize()
    })

    describe('Event: discover', () => {
      test('Discovers peers of socket', async () => {
        const request = createMockRequest()
        expect(() => mockSignalServer.emit('discover', request)).not.toThrow()
        await testForEvent(request.socket, 'discover')
        expect(server.getPeerIDFromSocket).toHaveBeenCalledWith(request.socket)
        expect(server.getPeersOfSocket).toHaveBeenCalledWith(request.socket)
        expect(request.discover).toHaveBeenCalledWith(selfID, peers)
      })
      test('Properly filters out caller\'s peerID from peers', async () => {
        const request = createMockRequest()
        const badPeers = [...peers, selfID]
        server.getPeersOfSocket = jest.fn().mockImplementation(async () => badPeers)
        expect(() => mockSignalServer.emit('discover', request)).not.toThrow()
        await testForEvent(request.socket, 'discover')
        expect(server.getPeerIDFromSocket).toHaveBeenCalledWith(request.socket)
        expect(server.getPeersOfSocket).toHaveBeenCalledWith(request.socket)
        expect(request.discover).toHaveBeenCalledWith(selfID, peers)
      })
    })
    describe('Event: disconnect', () => {
      test('Does not throw', async () => {
        await expect(mockSignalServer.emitSerial('disconnect')).toResolve()
      })
    })
    describe('Event: request', () => {
      let request
      beforeEach(() => {
        request = createMockRequest()
      })
      test('Does not throw', async () => {
        await expect(mockSignalServer.emitSerial('request', request)).toResolve()
      })
      test('Forwards incoming requests', async () => {
        await expect(mockSignalServer.emitSerial('request', request)).toResolve()
        expect(request.forward).toHaveBeenCalled()
      })
    })
  })
})
