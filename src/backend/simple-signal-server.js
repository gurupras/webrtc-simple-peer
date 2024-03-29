const SignalServer = require('@gurupras/simple-signal-server')
const debugLogger = require('debug-logger')

class SimpleSignalServer {
  constructor (options, SignalServerImpl = SignalServer) {
    const { getPeersOfSocket, getPeerIDFromSocket = socket => socket.id, log = debugLogger('simple-signal-server') } = options
    if (!getPeersOfSocket || typeof getPeersOfSocket !== 'function') {
      throw new Error('Required argument getPeersOfSocket not provided.')
    }
    if (!getPeerIDFromSocket || typeof getPeerIDFromSocket !== 'function') {
      throw new Error('Must provide a way to get peer-id from socket')
    }

    Object.assign(this, {
      getPeersOfSocket,
      getPeerIDFromSocket,
      log,
      SignalServerImpl
    })
  }

  async initialize (io) {
    const { SignalServerImpl } = this
    const signalServer = new SignalServerImpl(io)
    signalServer.on('discover', async (request) => {
      const { log, getPeersOfSocket, getPeerIDFromSocket } = this
      const { socket } = request
      const peerID = await getPeerIDFromSocket(socket)
      const peers = await getPeersOfSocket(socket)
      log.info(`Sending discovery to: ${peerID} with peers=${JSON.stringify(peers)}`)
      request.discover(peers)
    })
    signalServer.on('disconnect', () => {
    })
    signalServer.on('request', (request) => request.forward())
    this.signalServer = signalServer
  }
}

module.exports = SimpleSignalServer
